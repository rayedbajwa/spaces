import { randomUUID } from 'node:crypto'
import { getDb } from './db'
import type { FlowOptions, PauseKind, StageName } from './aidlc'
import type { PipelineTemplate } from './pipeline-template'

export type RunStatus = 'queued' | 'running' | 'paused' | 'completed' | 'error'

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

export async function getLatestRunForProject(projectNamespace: string): Promise<RunRow | undefined> {
  const [row] = await listRunsForProject(projectNamespace, 1)
  return row
}
