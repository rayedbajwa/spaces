import { randomUUID } from 'node:crypto'
import { getDb } from './db'

export type JobKind = 'pipeline_run' | 'task_run' | 'workstream_run' | 'verify_fix' | 'webhook'
export type JobStatus = 'queued' | 'claimed' | 'running' | 'completed' | 'error' | 'cancelled'
export type TriggerSource = 'user' | 'task_tracker' | 'verify_loop' | 'webhook' | 'api' | 'reaper'

export interface JobRow {
  jobId: string
  projectId: string
  kind: JobKind
  payloadJson: Record<string, unknown>
  priority: number
  status: JobStatus
  triggerSource: TriggerSource
  runId?: string
  claimedBy?: string
  startedAt?: string
  endedAt?: string
  errorMessage?: string
  createdAt: string
  updatedAt: string
}

export interface OrchestratorConfig {
  projectId: string
  autonomousMode: boolean
  maxConcurrent: number
  configJson: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

const JOB_COLS = `
  job_id         AS "jobId",
  project_id     AS "projectId",
  kind           AS "kind",
  payload_json   AS "payloadJson",
  priority       AS "priority",
  status         AS "status",
  trigger_source AS "triggerSource",
  run_id         AS "runId",
  claimed_by     AS "claimedBy",
  started_at     AS "startedAt",
  ended_at       AS "endedAt",
  error_message  AS "errorMessage",
  created_at     AS "createdAt",
  updated_at     AS "updatedAt"
`

const ORCH_COLS = `
  project_id      AS "projectId",
  autonomous_mode AS "autonomousMode",
  max_concurrent  AS "maxConcurrent",
  config_json     AS "configJson",
  created_at      AS "createdAt",
  updated_at      AS "updatedAt"
`

export async function enqueueJob(input: {
  projectId: string
  kind: JobKind
  triggerSource: TriggerSource
  payload?: Record<string, unknown>
  priority?: number
  runId?: string
}): Promise<JobRow> {
  const sql = getDb()
  // Archived projects are read-only: nothing new may be queued for them.
  const [archived] = await sql<Array<{ archivedAt: string | null }>>`SELECT archived_at AS "archivedAt" FROM projects WHERE project_id = ${input.projectId}`
  if (archived?.archivedAt) throw new Error('This project is archived. Unarchive it before starting new work.')
  const jobId = randomUUID()
  const [row] = await sql<JobRow[]>`
    INSERT INTO project_jobs (
      job_id, project_id, kind, payload_json, priority,
      status, trigger_source, run_id
    ) VALUES (
      ${jobId}, ${input.projectId}, ${input.kind},
      ${sql.json((input.payload ?? {}) as never)},
      ${input.priority ?? 0}, 'queued', ${input.triggerSource},
      ${input.runId ?? null}
    )
    RETURNING ${sql.unsafe(JOB_COLS)}
  `
  return row
}

/**
 * Atomically bump the retry counter on a pipeline_run AND enqueue the follow-up
 * project_job in a single transaction. This must never split — if we mark the
 * run 'queued' but the enqueue crashes (SIGTERM, connection drop, etc.), the
 * run becomes an orphan sitting in the DB forever with nothing to consume it.
 */
export async function retryRunAndEnqueue(input: {
  runId: string
  projectId: string
  triggerSource: TriggerSource
}): Promise<{ retryCount: number; jobId: string }> {
  const sql = getDb()
  return await sql.begin(async (tx) => {
    const [runRow] = await tx<Array<{ retryCount: number }>>`
      UPDATE pipeline_runs
         SET retry_count = retry_count + 1,
             status = 'queued',
             error_message = NULL,
             current_stage = NULL
       WHERE run_id = ${input.runId}
       RETURNING retry_count AS "retryCount"
    `
    if (!runRow) throw new Error(`retryRunAndEnqueue: run ${input.runId} not found`)

    const jobId = randomUUID()
    await tx`
      INSERT INTO project_jobs (
        job_id, project_id, kind, payload_json, priority,
        status, trigger_source, run_id
      ) VALUES (
        ${jobId}, ${input.projectId}, 'pipeline_run',
        ${tx.json({ runId: input.runId } as never)},
        0, 'queued', ${input.triggerSource}, ${input.runId}
      )
    `
    return { retryCount: runRow.retryCount, jobId }
  })
}

/**
 * Find and re-enqueue orphaned pipeline_runs — rows in `queued` status with no
 * corresponding `project_jobs` entry, older than `staleAfterMs`. Caused by a
 * process crashing between `pipeline_runs UPDATE` and `project_jobs INSERT`
 * (e.g. SIGTERM mid-retry). Without this reaper, an orphaned run sits forever.
 *
 * Runs without a projectId (adhoc CLI runs that never got wired to a project)
 * are marked 'error' rather than re-enqueued — the dispatcher can only serve
 * jobs that belong to a project.
 */
export async function reapOrphanedRuns(staleAfterMs = 30_000): Promise<{ reenqueued: number; failed: number }> {
  const sql = getDb()
  const cutoff = new Date(Date.now() - staleAfterMs)

  const orphans = await sql<Array<{ runId: string; projectId: string | null }>>`
    SELECT r.run_id     AS "runId",
           r.project_id AS "projectId"
      FROM pipeline_runs r
     WHERE r.status = 'queued'
       AND r.created_at < ${cutoff}
       AND NOT EXISTS (
         SELECT 1 FROM project_jobs j
          WHERE j.run_id = r.run_id
            AND j.status IN ('queued','claimed','running')
       )
  `

  let reenqueued = 0
  let failed = 0
  for (const o of orphans) {
    if (o.projectId) {
      await enqueueJob({
        projectId: o.projectId,
        kind: 'pipeline_run',
        triggerSource: 'reaper',
        payload: { runId: o.runId, reason: 'orphaned_run_recovery' },
        runId: o.runId,
      })
      reenqueued++
    } else {
      await sql`
        UPDATE pipeline_runs
           SET status = 'error',
               error_message = 'Orphaned queued run with no projectId — reaper cannot re-enqueue.'
         WHERE run_id = ${o.runId}
      `
      failed++
    }
  }
  return { reenqueued, failed }
}

/**
 * Atomically claim the next runnable job across all projects, respecting each
 * project's max_concurrent limit.
 *
 * Two layers of protection against concurrent workers:
 *
 *  1. `FOR UPDATE OF j SKIP LOCKED` — prevents the SAME job from being
 *     claimed by two workers. (Cheap, per-row lock.)
 *
 *  2. `pg_try_advisory_xact_lock(NS, hashtext(project_id))` — prevents two
 *     workers from BOTH bypassing max_concurrent for the SAME PROJECT.
 *     The in_flight COUNT read is a snapshot; without this lock, worker A
 *     and worker B could both see `in_flight = 0`, both pass the
 *     `< max_concurrent` check, and both claim their own (different) job,
 *     briefly exceeding the limit. The advisory lock is non-blocking (try_
 *     variant), auto-released at transaction commit, and scoped per project
 *     so unrelated projects don't serialize.
 *
 * We use a two-phase transaction rather than putting `pg_try_advisory_xact_lock`
 * in a WHERE clause: putting it in WHERE causes Postgres to evaluate the
 * function against every candidate row it scans, accumulating advisory
 * locks on many projects and starving other workers.
 *
 * Advisory-lock namespace is 8140 (arbitrary) to avoid colliding with any
 * other advisory locks anyone might introduce in this DB.
 */
const ADVISORY_LOCK_NS = 8140

/**
 * Claim the next runnable job. `projectId` restricts the claim to one project —
 * used by per-project workers spawned by the supervisor; a general worker
 * passes nothing and serves every project.
 */
export async function claimNextJob(workerId: string, projectId?: string): Promise<JobRow | undefined> {
  const sql = getDb()
  const projectFilter = projectId ?? null

  const result = await sql.begin(async (tx) => {
    // Phase 1: pick a candidate job that's currently under the concurrency
    // limit from a snapshot view. SKIP LOCKED lets multiple workers scan the
    // queue simultaneously without stepping on the same row.
    const [candidate] = await tx<Array<{ jobId: string; projectId: string; maxConcurrent: number | null }>>`
      SELECT j.job_id      AS "jobId",
             j.project_id  AS "projectId",
             o.max_concurrent AS "maxConcurrent"
        FROM project_jobs j
        JOIN projects p ON p.project_id = j.project_id
        LEFT JOIN project_orchestrators o ON o.project_id = j.project_id
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS in_flight
            FROM project_jobs r
           WHERE r.project_id = j.project_id AND r.status IN ('claimed','running')
        ) inflight ON true
       WHERE j.status = 'queued'
         AND p.paused_at IS NULL
         AND (${projectFilter}::uuid IS NULL OR j.project_id = ${projectFilter}::uuid)
         AND inflight.in_flight < COALESCE(o.max_concurrent, 1)
       ORDER BY j.priority DESC, j.created_at ASC
       FOR UPDATE OF j SKIP LOCKED
       LIMIT 1
    `

    if (!candidate) return undefined

    // Phase 2: try to acquire the per-project advisory lock. Non-blocking —
    // if another worker is mid-claim for this project, we bail out and let
    // them finish. Caller will retry on the next dispatch tick.
    const [{ locked }] = await tx<Array<{ locked: boolean }>>`
      SELECT pg_try_advisory_xact_lock(
        ${ADVISORY_LOCK_NS}::int,
        hashtext(${candidate.projectId}::text)
      ) AS locked
    `
    if (!locked) return undefined

    // Phase 3: with the lock held, re-verify the concurrency limit. A prior
    // claim from another worker may have committed between Phase 1 and here;
    // the snapshot we read in Phase 1 wouldn't see it.
    const limit = candidate.maxConcurrent ?? 1
    const [{ inFlight }] = await tx<Array<{ inFlight: number }>>`
      SELECT COUNT(*)::int AS "inFlight"
        FROM project_jobs
       WHERE project_id = ${candidate.projectId}
         AND status IN ('claimed','running')
    `
    if (inFlight >= limit) return undefined

    // Phase 4: claim the row we already have locked from Phase 1.
    const [row] = await tx<JobRow[]>`
      UPDATE project_jobs
         SET status = 'claimed', claimed_by = ${workerId}, started_at = now()
       WHERE job_id = ${candidate.jobId}
       RETURNING ${sql.unsafe(JOB_COLS)}
    `
    return row
  })

  return result ?? undefined
}

export async function markJobRunning(jobId: string): Promise<void> {
  const sql = getDb()
  await sql`UPDATE project_jobs SET status = 'running' WHERE job_id = ${jobId} AND status = 'claimed'`
}

/** A job cancelled from outside (project archived) keeps that status; only live jobs complete. */
export async function completeJob(jobId: string): Promise<void> {
  const sql = getDb()
  await sql`UPDATE project_jobs SET status = 'completed', ended_at = now() WHERE job_id = ${jobId} AND status IN ('claimed', 'running')`
}

export async function failJob(jobId: string, error: string): Promise<void> {
  const sql = getDb()
  await sql`UPDATE project_jobs SET status = 'error', ended_at = now(), error_message = ${error} WHERE job_id = ${jobId} AND status IN ('claimed', 'running')`
}

export async function cancelJob(jobId: string): Promise<void> {
  const sql = getDb()
  await sql`UPDATE project_jobs SET status = 'cancelled', ended_at = now() WHERE job_id = ${jobId} AND status IN ('queued','claimed')`
}

export async function getJob(jobId: string): Promise<JobRow | undefined> {
  const sql = getDb()
  const [row] = await sql<JobRow[]>`SELECT ${sql.unsafe(JOB_COLS)} FROM project_jobs WHERE job_id = ${jobId}`
  return row
}

/**
 * A job plus the live state of the run it drives. Job status is about queue
 * mechanics (a job "completes" when the engine pauses for review; a stale job
 * is "error" even if the run later finished), so the UI shows `displayStatus`,
 * which follows the run whenever there is one.
 */
export interface JobWithRun extends JobRow {
  runStatus?: 'queued' | 'running' | 'paused' | 'completed' | 'error' | 'cancelled'
  runStage?: string
  runPauseKind?: 'clarification' | 'review'
  runError?: string
  runPipeline?: string
  displayStatus: 'queued' | 'running' | 'paused' | 'completed' | 'error' | 'cancelled' | 'claimed'
}

export async function listJobsForProject(projectId: string, limit = 50): Promise<JobWithRun[]> {
  const sql = getDb()
  const rows = await sql<Array<JobRow & { runStatus?: JobWithRun['runStatus']; runStage?: string; runPauseKind?: JobWithRun['runPauseKind']; runError?: string; runPipeline?: string }>>`
    SELECT ${sql.unsafe(JOB_COLS.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => `j.${l}`).join('\n  '))},
           r.status        AS "runStatus",
           r.current_stage AS "runStage",
           r.pause_kind    AS "runPauseKind",
           r.error_message AS "runError",
           r.pipeline_name AS "runPipeline"
      FROM project_jobs j
      LEFT JOIN pipeline_runs r ON r.run_id = j.run_id
     WHERE j.project_id = ${projectId}
     ORDER BY j.created_at DESC
     LIMIT ${limit}
  `
  // Only the newest job for a run speaks for that run; jobs superseded by a
  // rerun keep their own terminal state (rows arrive newest first).
  const latestJobForRun = new Map<string, string>()
  for (const row of rows) {
    if (row.runId && !latestJobForRun.has(row.runId)) latestJobForRun.set(row.runId, row.jobId)
  }
  return rows.map((row) => {
    const speaksForRun = row.runId ? latestJobForRun.get(row.runId) === row.jobId : false
    return { ...row, displayStatus: deriveDisplayStatus(row.status, speaksForRun ? row.runStatus : undefined) }
  })
}

/**
 * What a job row should read as in the UI.
 *  - An active job (queued/claimed/running) shows its run's live state.
 *  - A finished job keeps its own terminal state unless the run it drove ended
 *    in a state the queue could not know about: the engine pausing for review
 *    ("completed" job, paused run) or a stale-reaped job whose run still
 *    finished. A finished job never borrows a *later* job's "running" — that is
 *    what made re-run projects look like they had several jobs in flight.
 */
export function deriveDisplayStatus(jobStatus: JobStatus, runStatus?: JobWithRun['runStatus']): JobWithRun['displayStatus'] {
  const jobActive = jobStatus === 'queued' || jobStatus === 'claimed' || jobStatus === 'running'
  if (jobActive) return runStatus ?? jobStatus
  if (runStatus === 'paused' || runStatus === 'completed' || runStatus === 'error') return runStatus
  return jobStatus
}

export async function countInFlightForProject(projectId: string): Promise<number> {
  const sql = getDb()
  const [row] = await sql<Array<{ n: number }>>`
    SELECT COUNT(*)::int AS n FROM project_jobs
     WHERE project_id = ${projectId} AND status IN ('claimed','running')
  `
  return row?.n ?? 0
}

// ---- Orchestrator config ----

export async function getOrchestrator(projectId: string): Promise<OrchestratorConfig> {
  const sql = getDb()
  const [row] = await sql<OrchestratorConfig[]>`
    SELECT ${sql.unsafe(ORCH_COLS)} FROM project_orchestrators WHERE project_id = ${projectId}
  `
  if (row) return row
  const now = new Date().toISOString()
  return {
    projectId,
    autonomousMode: false,
    maxConcurrent: 1,
    configJson: {},
    createdAt: now,
    updatedAt: now,
  }
}

export async function upsertOrchestrator(input: {
  projectId: string
  autonomousMode?: boolean
  maxConcurrent?: number
  config?: Record<string, unknown>
}): Promise<OrchestratorConfig> {
  const sql = getDb()
  const [row] = await sql<OrchestratorConfig[]>`
    INSERT INTO project_orchestrators (project_id, autonomous_mode, max_concurrent, config_json)
    VALUES (${input.projectId}, ${input.autonomousMode ?? false}, ${input.maxConcurrent ?? 1}, ${sql.json((input.config ?? {}) as never)})
    ON CONFLICT (project_id) DO UPDATE SET
      autonomous_mode = COALESCE(${input.autonomousMode ?? null}, project_orchestrators.autonomous_mode),
      max_concurrent  = COALESCE(${input.maxConcurrent ?? null}, project_orchestrators.max_concurrent),
      config_json     = project_orchestrators.config_json || EXCLUDED.config_json,
      updated_at      = now()
    RETURNING ${sql.unsafe(ORCH_COLS)}
  `
  return row
}
