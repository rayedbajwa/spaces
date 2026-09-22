import { randomUUID } from 'node:crypto'
import { getDb } from './db'
import type { FlowOptions, PauseKind, StageName } from './aidlc'
import type { PipelineTemplate } from './pipeline-template'

export type RunStatus = 'queued' | 'running' | 'paused' | 'completed' | 'error' | 'cancelled'

export interface RunRow {
  runId: string
  projectNamespace: string
  projectLabel: string
  projectPath: string
  pipelineName: string
  feature?: string
  status: RunStatus
  pauseKind?: PauseKind
  currentStage?: StageName
  sessionFile?: string
  errorMessage?: string
  optionsJson: FlowOptions
  templateJson: PipelineTemplate
  retryCount: number
  owningWorkerId?: string
  projectId?: string
  repoId?: string
  createdAt: string
  updatedAt: string
}

export async function createRun(input: {
  projectNamespace: string
  projectLabel: string
  projectPath: string
  pipelineName: string
  feature?: string
  options: FlowOptions
  template: PipelineTemplate
  projectId?: string
  repoId?: string
}): Promise<RunRow> {
  const sql = getDb()
  const runId = randomUUID()

  const [row] = await sql<RunRow[]>`
    INSERT INTO pipeline_runs (
      run_id, project_namespace, project_label, project_path,
      pipeline_name, feature, status, options_json, template_json,
      project_id, repo_id
    ) VALUES (
      ${runId}, ${input.projectNamespace}, ${input.projectLabel}, ${input.projectPath},
      ${input.pipelineName}, ${input.feature ?? null}, 'queued',
      ${sql.json(input.options as never)},
      ${sql.json(input.template as never)},
      ${input.projectId ?? null}, ${input.repoId ?? null}
    )
    RETURNING
      run_id            AS "runId",
      project_namespace AS "projectNamespace",
      project_label     AS "projectLabel",
      project_path      AS "projectPath",
      pipeline_name     AS "pipelineName",
      feature           AS "feature",
      status            AS "status",
      pause_kind        AS "pauseKind",
      current_stage     AS "currentStage",
      session_file      AS "sessionFile",
      error_message     AS "errorMessage",
      options_json      AS "optionsJson",
      template_json     AS "templateJson",
      retry_count       AS "retryCount",
      owning_worker_id  AS "owningWorkerId",
      project_id        AS "projectId",
      repo_id           AS "repoId",
      created_at        AS "createdAt",
      updated_at        AS "updatedAt"
  `
  return row
}

export async function getRun(runId: string): Promise<RunRow | undefined> {
  const sql = getDb()
  const [row] = await sql<RunRow[]>`
    SELECT
      run_id            AS "runId",
      project_namespace AS "projectNamespace",
      project_label     AS "projectLabel",
      project_path      AS "projectPath",
      pipeline_name     AS "pipelineName",
      feature           AS "feature",
      status            AS "status",
      pause_kind        AS "pauseKind",
      current_stage     AS "currentStage",
      session_file      AS "sessionFile",
      error_message     AS "errorMessage",
      options_json      AS "optionsJson",
      template_json     AS "templateJson",
      retry_count       AS "retryCount",
      owning_worker_id  AS "owningWorkerId",
      project_id        AS "projectId",
      repo_id           AS "repoId",
      created_at        AS "createdAt",
      updated_at        AS "updatedAt"
    FROM pipeline_runs WHERE run_id = ${runId}
  `
  return row
}

export async function updateRunStatus(runId: string, patch: {
  status: RunStatus
  pauseKind?: PauseKind | null
  currentStage?: StageName | null
  sessionFile?: string | null
  errorMessage?: string | null
}): Promise<void> {
  const sql = getDb()
  await sql`
    UPDATE pipeline_runs SET
      status        = ${patch.status},
      pause_kind    = ${patch.pauseKind ?? null},
      current_stage = ${patch.currentStage ?? null},
      session_file  = COALESCE(${patch.sessionFile ?? null}, session_file),
      error_message = ${patch.errorMessage ?? null}
    WHERE run_id = ${runId}
  `
}

export async function appendEvent(input: {
  runId: string
  stepIndex?: number
  kind: string
  payload: unknown
}): Promise<void> {
  const sql = getDb()
  await sql`
    INSERT INTO pipeline_events (run_id, step_index, kind, payload)
    VALUES (${input.runId}, ${input.stepIndex ?? null}, ${input.kind}, ${sql.json(input.payload as never)})
  `
}

export interface EventRow {
  eventId: number
  runId: string
  stepIndex: number | null
  kind: string
  payload: unknown
  createdAt: string
}

export async function listEvents(runId: string, sinceEventId = 0): Promise<EventRow[]> {
  const sql = getDb()
  return await sql<EventRow[]>`
    SELECT
      event_id   AS "eventId",
      run_id     AS "runId",
      step_index AS "stepIndex",
      kind       AS "kind",
      payload    AS "payload",
      created_at AS "createdAt"
    FROM pipeline_events
    WHERE run_id = ${runId} AND event_id > ${sinceEventId}
    ORDER BY event_id ASC
  `
}

export async function openGate(input: {
  runId: string
  stepIndex: number
  kind: PauseKind
  prompt?: string
}): Promise<string> {
  const sql = getDb()
  const gateId = randomUUID()
  await sql`
    INSERT INTO pipeline_gates (gate_id, run_id, step_index, kind, status, prompt)
    VALUES (${gateId}, ${input.runId}, ${input.stepIndex}, ${input.kind}, 'open', ${input.prompt ?? null})
  `
  return gateId
}

export async function resolveOpenGate(runId: string, response: string): Promise<{ gateId: string; kind: PauseKind } | undefined> {
  const sql = getDb()
  const [row] = await sql<Array<{ gateId: string; kind: PauseKind }>>`
    UPDATE pipeline_gates
       SET status = 'resolved', response = ${response}, resolved_at = now()
     WHERE gate_id = (
       SELECT gate_id FROM pipeline_gates
        WHERE run_id = ${runId} AND status = 'open'
        ORDER BY opened_at DESC LIMIT 1
     )
     RETURNING gate_id AS "gateId", kind AS "kind"
  `
  return row
}

export async function incrementRetryAndRequeue(runId: string): Promise<number> {
  const sql = getDb()
  const [row] = await sql<Array<{ retryCount: number }>>`
    UPDATE pipeline_runs
       SET retry_count = retry_count + 1,
           status = 'queued',
           error_message = NULL,
           current_stage = NULL
     WHERE run_id = ${runId}
     RETURNING retry_count AS "retryCount"
  `
  return row?.retryCount ?? 0
}

/**
 * Put a run back on the queue so a worker restarts it at `fromStage` (or the
 * first stage when null). Used for reruns of failed runs and for runs that a
 * worker restart interrupted. `note` is kept in error_message so the UI can
 * explain why the run is queued again; the worker clears it when it starts.
 */
/** Remember an approval note so a restarted run still applies it (options_json.reviewerNotes). */
export async function appendReviewerNote(runId: string, stage: string | null, note: string): Promise<void> {
  const sql = getDb()
  const entry = { stage, note, at: new Date().toISOString() }
  await sql`
    UPDATE pipeline_runs
       SET options_json = jsonb_set(options_json, '{reviewerNotes}', coalesce(options_json->'reviewerNotes', '[]'::jsonb) || ${sql.json(entry as never)}::jsonb, true)
     WHERE run_id = ${runId}
  `
}

export async function requeueRunFromStage(runId: string, fromStage: StageName | null, note: string | null): Promise<number> {
  const sql = getDb()
  const [row] = await sql<Array<{ retryCount: number }>>`
    UPDATE pipeline_runs
       SET retry_count   = retry_count + 1,
           status        = 'queued',
           pause_kind    = NULL,
           current_stage = ${fromStage},
           error_message = ${note}
     WHERE run_id = ${runId}
     RETURNING retry_count AS "retryCount"
  `
  return row?.retryCount ?? 0
}

/**
 * Take a person's answer to a run paused at a gate, in one transaction: the run
 * leaves 'paused' (only one answer wins), the open gate is resolved, the event
 * is recorded and the job that resumes the run is queued with the answer. If
 * any step fails, none of it happened and the run is still waiting — the answer
 * can never be lost between "no longer paused" and "a job carries it".
 *
 * Unlike a re-queue after a failure it does not count as a retry, and the stage
 * stays the one that paused: the worker reopens the conversation there. Only
 * review and clarification pauses take answers; a run a person paused is
 * resumed, not answered.
 */
export async function answerPausedRun(input: {
  runId: string
  projectId: string
  answer: string
}): Promise<{ ok: true; stage: StageName | null; pauseKind: 'review' | 'clarification' } | { ok: false; reason: 'not_waiting' | 'archived' }> {
  const sql = getDb()
  return await sql.begin(async (tx) => {
    const [project] = await tx<Array<{ archivedAt: string | null }>>`SELECT archived_at AS "archivedAt" FROM projects WHERE project_id = ${input.projectId}`
    if (project?.archivedAt) return { ok: false as const, reason: 'archived' as const }
    // Locked, so two answers arriving together cannot both pass this check.
    const [run] = await tx<Array<{ stage: StageName | null; pauseKind: 'review' | 'clarification' }>>`
      SELECT current_stage AS stage, pause_kind AS "pauseKind" FROM pipeline_runs
       WHERE run_id = ${input.runId} AND status = 'paused' AND pause_kind IN ('review', 'clarification')
       FOR UPDATE
    `
    if (!run) return { ok: false as const, reason: 'not_waiting' as const }
    await tx`
      UPDATE pipeline_runs
         SET status = 'queued', pause_kind = NULL, error_message = NULL, owning_worker_id = NULL, updated_at = now()
       WHERE run_id = ${input.runId}
    `
    const [gate] = await tx<Array<{ gateId: string; kind: string }>>`
      UPDATE pipeline_gates
         SET status = 'resolved', response = ${input.answer}, resolved_at = now()
       WHERE gate_id = (SELECT gate_id FROM pipeline_gates WHERE run_id = ${input.runId} AND status = 'open' ORDER BY opened_at DESC LIMIT 1)
       RETURNING gate_id AS "gateId", kind
    `
    await tx`
      INSERT INTO pipeline_events (run_id, kind, payload)
      VALUES (${input.runId}, 'gate_resolved', ${tx.json({ gateId: gate?.gateId, kind: gate?.kind, response: input.answer } as never)})
    `
    const payload = { runId: input.runId, ...(run.stage ? { fromStage: run.stage } : {}), answer: { text: input.answer, pauseKind: run.pauseKind } }
    await tx`
      INSERT INTO project_jobs (job_id, project_id, kind, payload_json, priority, status, trigger_source, run_id)
      VALUES (${randomUUID()}, ${input.projectId}, 'pipeline_run', ${tx.json(payload as never)}, 0, 'queued', 'user', ${input.runId})
    `
    return { ok: true as const, stage: run.stage, pauseKind: run.pauseKind }
  })
}

/** Forget which worker owns a run (its engine is gone), so answers fall back to re-queueing. */
export async function clearRunOwner(runId: string): Promise<void> {
  const sql = getDb()
  await sql`UPDATE pipeline_runs SET owning_worker_id = NULL WHERE run_id = ${runId}`
}

export async function claimRunForWorker(runId: string, workerId: string): Promise<void> {
  const sql = getDb()
  await sql`UPDATE pipeline_runs SET owning_worker_id = ${workerId} WHERE run_id = ${runId}`
}

export async function listRunsForProject(projectNamespace: string, limit = 50): Promise<RunRow[]> {
  const sql = getDb()
  return await sql<RunRow[]>`
    SELECT
      run_id            AS "runId",
      project_namespace AS "projectNamespace",
      project_label     AS "projectLabel",
      project_path      AS "projectPath",
      pipeline_name     AS "pipelineName",
      feature           AS "feature",
      status            AS "status",
      pause_kind        AS "pauseKind",
      current_stage     AS "currentStage",
      session_file      AS "sessionFile",
      error_message     AS "errorMessage",
      options_json      AS "optionsJson",
      template_json     AS "templateJson",
      retry_count       AS "retryCount",
      owning_worker_id  AS "owningWorkerId",
      project_id        AS "projectId",
      repo_id           AS "repoId",
      created_at        AS "createdAt",
      updated_at        AS "updatedAt"
    FROM pipeline_runs
    WHERE project_namespace = ${projectNamespace}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `
}

/**
 * The run that speaks for each project on the board: its active run (queued,
 * running or paused) when it has one, else its most recently started run.
 */
export async function listBoardRuns(projectNamespaces: string[]): Promise<RunRow[]> {
  if (projectNamespaces.length === 0) return []
  const sql = getDb()
  return await sql<RunRow[]>`
    SELECT DISTINCT ON (project_namespace)
      run_id            AS "runId",
      project_namespace AS "projectNamespace",
      project_label     AS "projectLabel",
      project_path      AS "projectPath",
      pipeline_name     AS "pipelineName",
      feature           AS "feature",
      status            AS "status",
      pause_kind        AS "pauseKind",
      current_stage     AS "currentStage",
      session_file      AS "sessionFile",
      error_message     AS "errorMessage",
      options_json      AS "optionsJson",
      template_json     AS "templateJson",
      retry_count       AS "retryCount",
      owning_worker_id  AS "owningWorkerId",
      project_id        AS "projectId",
      repo_id           AS "repoId",
      created_at        AS "createdAt",
      updated_at        AS "updatedAt"
    FROM pipeline_runs
    WHERE project_namespace = ANY(${projectNamespaces})
    ORDER BY project_namespace, (status IN ('queued', 'running', 'paused')) DESC, created_at DESC
  `
}

export async function listAllRuns(limit = 100): Promise<RunRow[]> {
  const sql = getDb()
  return await sql<RunRow[]>`
    SELECT
      run_id            AS "runId",
      project_namespace AS "projectNamespace",
      project_label     AS "projectLabel",
      project_path      AS "projectPath",
      pipeline_name     AS "pipelineName",
      feature           AS "feature",
      status            AS "status",
      pause_kind        AS "pauseKind",
      current_stage     AS "currentStage",
      session_file      AS "sessionFile",
      error_message     AS "errorMessage",
      options_json      AS "optionsJson",
      template_json     AS "templateJson",
      retry_count       AS "retryCount",
      owning_worker_id  AS "owningWorkerId",
      project_id        AS "projectId",
      repo_id           AS "repoId",
      created_at        AS "createdAt",
      updated_at        AS "updatedAt"
    FROM pipeline_runs
    ORDER BY updated_at DESC
    LIMIT ${limit}
  `
}

/**
 * The run the project page should follow: a live one (running, paused,
 * queued) wins over anything finished, so a completed ad-hoc task run does
 * not hide the pipeline run that is still executing; otherwise the newest.
 */
export async function getLatestRunForProject(projectNamespace: string): Promise<RunRow | undefined> {
  const rows = await listRunsForProject(projectNamespace, 25)
  const live = rows.find((r) => r.status === 'running' || r.status === 'paused' || r.status === 'queued')
  return live ?? rows[0]
}
