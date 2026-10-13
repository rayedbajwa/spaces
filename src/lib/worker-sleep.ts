/**
 * Idle project workers stopped, and started again for work, on platforms that
 * do not do it themselves (Kubernetes; specs/014-project-workers, FR-006).
 *
 * Railway puts a service to sleep after minutes without outbound traffic and
 * wakes it on a request. A Kubernetes Deployment runs its pod until told
 * otherwise: when a worker's job process exits idle, the pod keeps holding
 * its CPU and memory. So the web service scales a worker to 0 once it has been
 * quiet for PROJECT_WORKER_SLEEP_SECONDS (default 600: no job process
 * heartbeat, nothing queued or running, not being moved, not just started),
 * and marks it `sleeping`. The volume stays, so the files are there when it
 * starts again.
 *
 * Anything that needs the worker (queued work, a person opening the project,
 * an approval) goes through the forwarding layer, which starts a sleeping
 * worker first and waits for it. Reads that only decorate the board do not.
 */

import { getDb } from './db'
import { log } from './logger'
import type { WorkerPlatform } from './worker-platform'
import { workerPlatform, workerSpec, type ProjectWorkerRow } from './worker-provisioner'

const sleepLog = log.child({ mod: 'worker-sleep' })

export function sleepAfterSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.PROJECT_WORKER_SLEEP_SECONDS ?? '600')
  return Number.isFinite(value) && value >= 0 ? value : 600
}

type WorkerRow = ProjectWorkerRow & { code: string | null; slug: string }

/** Workers quiet for long enough to stop. */
export async function sleepCandidates(platform: WorkerPlatform, seconds: number): Promise<WorkerRow[]> {
  return getDb()<WorkerRow[]>`
    SELECT w.project_id AS "projectId", w.service_ref AS "serviceRef", w.volume_ref AS "volumeRef", w.version, p.code, p.slug
      FROM project_workers w JOIN projects p ON p.project_id = w.project_id
     WHERE w.state = 'ready' AND w.platform = ${platform.kind} AND w.service_ref IS NOT NULL AND w.active
       AND w.migration_state IS DISTINCT FROM 'copying' AND w.migration_state IS DISTINCT FROM 'syncing' AND w.migration_state IS DISTINCT FROM 'moving_back'
       AND w.updated_at < now() - make_interval(secs => ${seconds})
       AND coalesce(w.last_seen_at, w.updated_at) < now() - make_interval(secs => ${seconds})
       AND NOT EXISTS (SELECT 1 FROM workers k WHERE k.project_id = w.project_id AND k.last_heartbeat_at > now() - make_interval(secs => ${seconds}))
       AND NOT EXISTS (SELECT 1 FROM project_jobs j WHERE j.project_id = w.project_id AND j.status IN ('queued', 'claimed', 'running'))
  `
}

/** One pass: stop the workers that have been idle long enough. */
export async function sleepIdleWorkers(platform: WorkerPlatform | undefined = workerPlatform(), seconds = sleepAfterSeconds()): Promise<string[]> {
  if (!platform?.scale || seconds <= 0) return []
  const slept: string[] = []
  for (const worker of await sleepCandidates(platform, seconds)) {
    const sql = getDb()
    // Claimed first, so a wake arriving meanwhile sees `sleeping` and starts it again.
    const [claimed] = await sql<Array<{ projectId: string }>>`
      UPDATE project_workers SET state = 'sleeping', last_error = NULL, updated_at = now()
       WHERE project_id = ${worker.projectId} AND state = 'ready'
         AND NOT EXISTS (SELECT 1 FROM project_jobs j WHERE j.project_id = ${worker.projectId} AND j.status IN ('queued', 'claimed', 'running'))
      RETURNING project_id AS "projectId"
    `
    if (!claimed) continue
    try {
      await platform.scale(workerSpec(worker.projectId, worker), { serviceRef: worker.serviceRef, volumeRef: worker.volumeRef }, 0)
      slept.push(worker.projectId)
      sleepLog.info('project worker stopped while idle', { projectId: worker.projectId, idleSeconds: seconds })
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500)
      await sql`UPDATE project_workers SET state = 'ready', last_error = ${message}, updated_at = now() WHERE project_id = ${worker.projectId} AND state = 'sleeping'`
      sleepLog.warn('stopping an idle project worker failed', { projectId: worker.projectId, error: message })
    }
  }
  return slept
}

/**
 * Start a stopped worker. True when it was asleep and is now starting (the
 * caller should allow for the pod to come up); false when it was not asleep.
 */
export async function wakeIfSleeping(projectId: string, platform: WorkerPlatform | undefined = workerPlatform()): Promise<boolean> {
  if (!platform?.scale) return false
  const sql = getDb()
  const [worker] = await sql<WorkerRow[]>`
    UPDATE project_workers w SET state = 'ready', last_seen_at = now(), updated_at = now()
      FROM projects p
     WHERE w.project_id = ${projectId} AND p.project_id = w.project_id AND w.state = 'sleeping' AND w.platform = ${platform.kind}
    RETURNING w.project_id AS "projectId", w.service_ref AS "serviceRef", w.volume_ref AS "volumeRef", w.version, p.code, p.slug
  `
  if (!worker) return false
  try {
    await platform.scale(workerSpec(worker.projectId, worker), { serviceRef: worker.serviceRef, volumeRef: worker.volumeRef }, 1)
    sleepLog.info('project worker started for work', { projectId })
    return true
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500)
    await sql`UPDATE project_workers SET state = 'sleeping', last_error = ${message}, updated_at = now() WHERE project_id = ${projectId} AND state = 'ready'`
    sleepLog.warn('starting a stopped project worker failed', { projectId, error: message })
    return false
  }
}

let started = false

/** Every minute, on the web service: stop idle workers. */
export function startSleepLoop(): void {
  if (started) return
  const platform = workerPlatform()
  if (!platform?.scale || sleepAfterSeconds() <= 0) return
  started = true
  const pass = () => sleepIdleWorkers().catch((error) => sleepLog.warn('sleep pass failed', { error: error instanceof Error ? error.message : String(error) }))
  setInterval(() => { void pass() }, 60_000)
  sleepLog.info('stopping idle project workers', { platform: platform.kind, afterSeconds: sleepAfterSeconds() })
}
