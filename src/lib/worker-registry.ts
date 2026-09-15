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

export function channelForWorker(workerId: string): string {
  const sanitized = workerId.replace(/[^a-z0-9_-]/gi, '_')
  return `worker_${sanitized}`
}

export interface AnswerNotification {
  runId: string
  answer: string
}

/** Heartbeat window after which a worker is considered gone. */
export const WORKER_ALIVE_WINDOW_SECONDS = 30

/** Register this worker (or refresh its heartbeat). Called on start and every few seconds. */
export async function heartbeatWorker(workerId: string): Promise<void> {
  const sql = getDb()
  await sql`
    INSERT INTO workers (worker_id, started_at, last_heartbeat_at)
    VALUES (${workerId}, now(), now())
    ON CONFLICT (worker_id) DO UPDATE SET last_heartbeat_at = now()
  `
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

export async function sendAnswerToOwner(runId: string, answer: string): Promise<{ delivered: boolean; workerId?: string; reason?: string }> {
  const sql = getDb()
  const [row] = await sql<Array<{ owningWorkerId: string | null }>>`
    SELECT owning_worker_id AS "owningWorkerId" FROM pipeline_runs WHERE run_id = ${runId}
  `
  const workerId = row?.owningWorkerId
  if (!workerId) {
    return { delivered: false, reason: 'no owning worker recorded' }
  }
  // NOTIFY succeeds even when nobody listens, so check the owner is actually
  // alive first; a restarted worker has a new id and never receives this.
  if (!(await isWorkerAlive(workerId))) {
    return { delivered: false, workerId, reason: 'owning worker is no longer running' }
  }
  const payload: AnswerNotification = { runId, answer }
  const channel = channelForWorker(workerId)
  await sql.notify(channel, JSON.stringify(payload))
  return { delivered: true, workerId }
}

export async function subscribeAsWorker(workerId: string, handler: (payload: AnswerNotification) => Promise<void> | void): Promise<void> {
  const sql = getDb()
  const channel = channelForWorker(workerId)
  await sql.listen(channel, (raw) => {
    if (!raw) return
    let parsed: AnswerNotification
    try {
      parsed = JSON.parse(raw) as AnswerNotification
    } catch {
      return
    }
    void handler(parsed)
  })
}
