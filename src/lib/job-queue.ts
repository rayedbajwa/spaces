import { PgBoss } from 'pg-boss'
import type { Job } from 'pg-boss'
import { getDatabaseUrl } from './db'

export const RUN_QUEUE = 'pipeline.run'

export interface RunJobData {
  runId: string
}

let boss: PgBoss | undefined
let started = false

export async function startBoss(): Promise<PgBoss> {
  if (!boss) {
    boss = new PgBoss({
      connectionString: getDatabaseUrl(),
      useListenNotify: true,
    })
  }
  if (!started) {
    await boss.start()
    await boss.createQueue(RUN_QUEUE)
    started = true
  }
  return boss
}

export async function stopBoss(): Promise<void> {
  if (boss && started) {
    await boss.stop({ graceful: true, timeout: 5000, close: true })
    started = false
    boss = undefined
  }
}

export async function enqueueRun(data: RunJobData, options?: { startAfterSeconds?: number }): Promise<string | null> {
  const b = await startBoss()
  return await b.send(RUN_QUEUE, data, { startAfter: options?.startAfterSeconds ?? 0 })
}

export type RunJobHandler = (job: Job<RunJobData>) => Promise<void>

export async function subscribeRunWorker(handler: RunJobHandler): Promise<string> {
  const b = await startBoss()
  return await b.work<RunJobData>(RUN_QUEUE, { batchSize: 1 }, async (jobs: Job<RunJobData>[]) => {
    for (const job of jobs) {
      await handler(job)
    }
  })
}
