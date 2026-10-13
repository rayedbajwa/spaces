/**
 * Moving project workers to a new Spaces version only while they are idle
 * (specs/014-project-workers, phase 4; FR-007).
 *
 * The web service is the version every worker should run. Every minute it
 * looks for workers on another version and updates those with nothing running
 * (no job claimed or running, no job process busy), at most two at a time. A worker marked
 * `updating` is not woken; work queued meanwhile runs on the new version, whose
 * job process starts at boot. The worker reports its version when it starts,
 * which returns it to `ready`.
 */

import { getDb } from './db'
import { log } from './logger'
import { runningVersion, type WorkerPlatform } from './worker-platform'
import { workerPlatform, workerSpec, type ProjectWorkerRow } from './worker-provisioner'

const rolloutLog = log.child({ mod: 'worker-rollout' })

/** An update that has not been reported back within this long is retried. */
const STALE_UPDATE_MINUTES = 20
const PER_CYCLE = 2

export interface RolloutDeps {
  desired: () => string
  platform: () => WorkerPlatform | undefined
  busy: () => Promise<string[]>
}

/** Projects with a job claimed or running, or a job process working on one. */
export async function busyProjects(): Promise<string[]> {
  const rows = await getDb()<Array<{ projectId: string }>>`
    SELECT project_id AS "projectId" FROM project_jobs WHERE status IN ('claimed', 'running')
    UNION
    SELECT project_id FROM workers WHERE project_id IS NOT NULL AND active_jobs > 0 AND last_heartbeat_at > now() - interval '30 seconds'
  `
  return rows.map((r) => r.projectId)
}

const defaultDeps: RolloutDeps = { desired: () => runningVersion(), platform: () => workerPlatform(), busy: busyProjects }

export interface RolloutResult {
  desired: string
  updated: string[]
  deferred: string[]
  failed: string[]
}

/** One pass: update idle workers that run another version. */
export async function rolloutOnce(deps: RolloutDeps = defaultDeps): Promise<RolloutResult> {
  const desired = deps.desired()
  const result: RolloutResult = { desired, updated: [], deferred: [], failed: [] }
  const platform = deps.platform()
  // An unknown version (a local build without GIT_COMMIT) cannot be compared.
  if (!platform || desired === 'unknown') return result
  const sql = getDb()
  await sql`
    UPDATE project_workers SET state = 'ready', last_error = 'The update was not reported back; it will be retried.', updated_at = now()
     WHERE state = 'updating' AND updated_at < now() - make_interval(mins => ${STALE_UPDATE_MINUTES})
  `
  const candidates = await sql<Array<ProjectWorkerRow & { code: string | null; slug: string }>>`
    SELECT w.project_id AS "projectId", w.service_ref AS "serviceRef", w.volume_ref AS "volumeRef", w.version, p.code, p.slug
      FROM project_workers w JOIN projects p ON p.project_id = w.project_id
     WHERE w.state = 'ready' AND w.platform = ${platform.kind} AND w.service_ref IS NOT NULL
       AND w.version IS DISTINCT FROM ${desired}
     ORDER BY w.updated_at
  `
  // A prebuilt image for this version may not be pushed yet: wait for it.
  if (platform.versionAvailable && !(await platform.versionAvailable(desired))) {
    rolloutLog.info('waiting for the worker image of this version', { version: desired })
    return result
  }
  const busy = new Set(await deps.busy())
  for (const worker of candidates) {
    if (result.updated.length >= PER_CYCLE) break
    // A stage is running: leave the worker on its version until it ends.
    if (busy.has(worker.projectId)) { result.deferred.push(worker.projectId); continue }
    const [claimed] = await sql<Array<{ projectId: string }>>`
      UPDATE project_workers SET state = 'updating', last_error = NULL, updated_at = now()
       WHERE project_id = ${worker.projectId} AND state = 'ready' AND version IS DISTINCT FROM ${desired}
      RETURNING project_id AS "projectId"
    `
    if (!claimed) continue
    try {
      const spec = { ...workerSpec(worker.projectId, worker), version: desired }
      await platform.update(spec, { serviceRef: worker.serviceRef, volumeRef: worker.volumeRef })
      result.updated.push(worker.projectId)
      rolloutLog.info('project worker updating', { projectId: worker.projectId, from: worker.version, to: desired })
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500)
      await sql`UPDATE project_workers SET state = 'ready', last_error = ${message}, updated_at = now() WHERE project_id = ${worker.projectId}`
      result.failed.push(worker.projectId)
      rolloutLog.warn('project worker update failed', { projectId: worker.projectId, error: message })
    }
  }
  return result
}

/** A project worker says which version it runs when it starts (it is ready again). */
export async function reportWorkerVersion(projectId: string, version: string = runningVersion()): Promise<void> {
  await getDb()`
    UPDATE project_workers SET version = ${version}, last_seen_at = now(),
           state = CASE WHEN state IN ('updating', 'provisioning') THEN 'ready' ELSE state END, updated_at = now()
     WHERE project_id = ${projectId}
  `
}

let started = false

/** Web role: a rollout pass every minute. */
export function startRolloutLoop(): void {
  if (started) return
  started = true
  const pass = () => rolloutOnce().catch((error) => rolloutLog.warn('rollout pass failed', { error: error instanceof Error ? error.message : String(error) }))
  setInterval(() => { void pass() }, 60_000)
  setTimeout(() => { void pass() }, 15_000)
  rolloutLog.info('updating project workers when idle', { version: runningVersion() })
}
