import { randomUUID } from 'node:crypto'
import { getDb } from './db'

/**
 * Per-worker identity + NOTIFY-based answer routing.
 *
 * Design: each worker generates a UUID at startup and LISTENs on
 * `worker_<uuid>`. When a paused run's engine lives on that worker, the server
 * sends `{ runId, answer }` via pg_notify to the specific worker's channel
 * rather than through the shared answer queue. This preserves engine locality
 * across multiple worker instances.
 */

let cachedWorkerId: string | undefined

export function getWorkerId(): string {
  if (!cachedWorkerId) {
    cachedWorkerId = process.env.WORKER_ID || randomUUID()
  }
  return cachedWorkerId
}

/** Heartbeat window after which a worker is considered gone. */
export const WORKER_ALIVE_WINDOW_SECONDS = 30

export interface WorkerHeartbeatMeta {
  /** Set for per-project workers spawned by the supervisor. */
  projectId?: string
  pid?: number
  activeJobs?: number
  pausedRuns?: number
  supervised?: boolean
}

/** Register this worker (or refresh its heartbeat). Called on start and every few seconds. */
export async function heartbeatWorker(workerId: string, meta: WorkerHeartbeatMeta = {}): Promise<void> {
  const sql = getDb()
  await sql`
    INSERT INTO workers (worker_id, started_at, last_heartbeat_at, project_id, pid, active_jobs, paused_runs, supervised)
    VALUES (${workerId}, now(), now(), ${meta.projectId ?? null}, ${meta.pid ?? null}, ${meta.activeJobs ?? 0}, ${meta.pausedRuns ?? 0}, ${meta.supervised ?? false})
    ON CONFLICT (worker_id) DO UPDATE SET
      last_heartbeat_at = now(),
      project_id  = COALESCE(EXCLUDED.project_id, workers.project_id),
      pid         = COALESCE(EXCLUDED.pid, workers.pid),
      active_jobs = EXCLUDED.active_jobs,
      paused_runs = EXCLUDED.paused_runs,
      supervised  = EXCLUDED.supervised
  `
}

export interface LiveWorkerRow {
  workerId: string
  projectId?: string
  pid?: number
  activeJobs: number
  pausedRuns: number
  supervised: boolean
  startedAt: string
  lastHeartbeatAt: string
  /** 'hot' = running jobs, 'warm' = alive and idle (or holding paused runs), 'stale' = heartbeat missed. */
  state: 'hot' | 'warm' | 'stale'
}

/** Workers that have heartbeated recently (plus recently-stale ones, flagged), newest first. */
export async function listLiveWorkers(): Promise<LiveWorkerRow[]> {
  const sql = getDb()
  const rows = await sql<Array<Omit<LiveWorkerRow, 'state'> & { alive: boolean }>>`
    SELECT worker_id AS "workerId", project_id AS "projectId", pid, active_jobs AS "activeJobs",
           paused_runs AS "pausedRuns", supervised, started_at AS "startedAt", last_heartbeat_at AS "lastHeartbeatAt",
           (last_heartbeat_at > now() - make_interval(secs => ${WORKER_ALIVE_WINDOW_SECONDS})) AS alive
      FROM workers
     WHERE last_heartbeat_at > now() - interval '10 minutes'
     ORDER BY last_heartbeat_at DESC
  `
  return rows.map(({ alive, ...row }) => ({ ...row, state: !alive ? 'stale' : row.activeJobs > 0 ? 'hot' : 'warm' }))
}

/** Drop registrations that stopped heartbeating long ago (crashed workers). */
export async function pruneDeadWorkers(olderThanSeconds = 120): Promise<number> {
  const sql = getDb()
  const rows = await sql`DELETE FROM workers WHERE last_heartbeat_at < now() - make_interval(secs => ${olderThanSeconds}) RETURNING worker_id`
  return rows.length
}

export async function unregisterWorker(workerId: string): Promise<void> {
  const sql = getDb()
  await sql`DELETE FROM workers WHERE worker_id = ${workerId}`
}

export async function isWorkerAlive(workerId: string): Promise<boolean> {
  const sql = getDb()
  const [row] = await sql<Array<{ alive: boolean }>>`
    SELECT (last_heartbeat_at > now() - make_interval(secs => ${WORKER_ALIVE_WINDOW_SECONDS})) AS alive
      FROM workers WHERE worker_id = ${workerId}
  `
  return row?.alive === true
}

