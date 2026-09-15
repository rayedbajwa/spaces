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

export async function sendAnswerToOwner(runId: string, answer: string): Promise<{ delivered: boolean; workerId?: string; reason?: string }> {
  const sql = getDb()
  const [row] = await sql<Array<{ owningWorkerId: string | null }>>`
    SELECT owning_worker_id AS "owningWorkerId" FROM pipeline_runs WHERE run_id = ${runId}
  `
  const workerId = row?.owningWorkerId
  if (!workerId) {
    return { delivered: false, reason: 'no owning worker recorded' }
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
