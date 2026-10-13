/**
 * Waking project workers for queued work, within the awake cap
 * (specs/014-project-workers, phase 3; FR-006, FR-013).
 *
 * In the `web` role nothing runs a project's jobs but that project's worker,
 * and a sleeping worker cannot hear a NOTIFY. Every job insert notifies
 * `project_job` with its project id, whichever code path queued it (a run, an
 * approval link, a Slack answer, an intake conversion), so the web service
 * listens there and wakes the worker. A sweep catches anything missed.
 *
 * At most PROJECT_WORKERS_MAX_AWAKE (default 5) workers run jobs at once.
 * Beyond that the job stays queued until one goes idle, and the super admin is
 * told the first time the cap is hit, then at most once an hour while it is.
 */

import { getDb } from './db'
import { log } from './logger'
import { callProjectWorker } from './project-forward'
import { isWebRole } from './role'
import { getProjectWorker, provisionProjectWorker, workerPlatform } from './worker-provisioner'

const wakeLog = log.child({ mod: 'worker-wake' })

/** A worker process that heartbeated this recently is awake (workers heartbeat every 5 s). */
const AWAKE_WINDOW_SECONDS = 30
const NOTIFY_EVERY_MS = 60 * 60_000

export function maxAwakeWorkers(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(1, Number(env.PROJECT_WORKERS_MAX_AWAKE ?? '5') || 5)
}

/** Projects whose worker process is running now. */
export async function awakeProjects(): Promise<string[]> {
  const rows = await getDb()<Array<{ projectId: string }>>`
    SELECT DISTINCT w.project_id AS "projectId"
      FROM workers w JOIN project_workers pw ON pw.project_id = w.project_id
     WHERE w.last_heartbeat_at > now() - make_interval(secs => ${AWAKE_WINDOW_SECONDS})
  `
  return rows.map((r) => r.projectId)
}

/** Projects with runnable queued jobs and a dedicated worker that is not running. */
export async function projectsWaitingForWorker(): Promise<string[]> {
  const rows = await getDb()<Array<{ projectId: string }>>`
    SELECT DISTINCT j.project_id AS "projectId"
      FROM project_jobs j JOIN projects p ON p.project_id = j.project_id
      JOIN project_workers pw ON pw.project_id = j.project_id AND pw.active AND pw.migration_state IS DISTINCT FROM 'syncing'
     WHERE j.status = 'queued' AND p.paused_at IS NULL AND p.archived_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM workers w
          WHERE w.project_id = j.project_id AND w.last_heartbeat_at > now() - make_interval(secs => ${AWAKE_WINDOW_SECONDS}))
  `
  return rows.map((r) => r.projectId)
}

export interface WakeDeps {
  awake: () => Promise<string[]>
  getWorker: typeof getProjectWorker
  provision: (projectId: string) => Promise<unknown>
  wake: (projectId: string) => Promise<boolean>
  hasPlatform: () => boolean
  /** Create workers for projects without one (the web role); otherwise wake only moved projects' workers. */
  provisionMissing: () => boolean
  capHit: (projectId: string, awake: number, cap: number) => Promise<void>
  cap: () => number
}

export type WakeOutcome = 'running' | 'woken' | 'provisioning' | 'at_cap' | 'unavailable'

const defaultDeps: WakeDeps = {
  awake: awakeProjects,
  getWorker: getProjectWorker,
  provision: (projectId) => provisionProjectWorker(projectId),
  wake: async (projectId) => Boolean(await callProjectWorker<{ ok: boolean }>(projectId, '/internal/wake', { method: 'POST', body: {}, timeoutMs: 10_000, wakeTimeoutMs: 60_000 })),
  hasPlatform: () => Boolean(workerPlatform()),
  provisionMissing: () => isWebRole(),
  capHit: recordCapHit,
  cap: () => maxAwakeWorkers(),
}

const inFlight = new Map<string, Promise<WakeOutcome>>()

/** Start the project's worker for its queued work, if the cap allows. */
export function wakeProjectWorker(projectId: string, deps: WakeDeps = defaultDeps): Promise<WakeOutcome> {
  const existing = inFlight.get(projectId)
  if (existing) return existing
  const attempt = doWake(projectId, deps).finally(() => inFlight.delete(projectId))
  inFlight.set(projectId, attempt)
  return attempt
}

async function doWake(projectId: string, deps: WakeDeps): Promise<WakeOutcome> {
  const awake = await deps.awake()
  if (awake.includes(projectId)) return 'running'
  const cap = deps.cap()
  if (awake.length >= cap) {
    await deps.capHit(projectId, awake.length, cap)
    return 'at_cap'
  }
  const worker = await deps.getWorker(projectId)
  // Outside the web role only projects already moved to their own worker are woken.
  if (!deps.provisionMissing() && (!worker || !worker.active)) return 'unavailable'
  if (worker && !worker.active) return 'unavailable'
  if (!worker || worker.state === 'pending' || worker.state === 'failed') {
    if (!deps.hasPlatform()) return 'unavailable'
    // A worker that never finished provisioning is retried; its bootstrap starts the work.
    void Promise.resolve(deps.provision(projectId)).then(() => deps.wake(projectId)).catch((error) => wakeLog.warn('provisioning for queued work failed', { projectId, error: error instanceof Error ? error.message : String(error) }))
    return 'provisioning'
  }
  // Provisioning or being updated: the job process starts on its own when it boots.
  if (worker.state === 'provisioning' || worker.state === 'updating') return 'provisioning'
  const ok = await deps.wake(projectId)
  if (!ok) wakeLog.warn('project worker did not answer the wake call', { projectId })
  return ok ? 'woken' : 'unavailable'
}

/**
 * Remember that the cap held a project back, and tell the super admin: the
 * first time, then at most once an hour while it keeps happening.
 */
export async function recordCapHit(projectId: string, awake: number, cap: number): Promise<void> {
  const sql = getDb()
  const [state] = await sql<Array<{ lastNotifiedAt: string | null }>>`
    INSERT INTO worker_cap_hits (project_id, hit_at) VALUES (${projectId}, now())
    ON CONFLICT (project_id) DO UPDATE SET hit_at = now()
    RETURNING (SELECT max(notified_at) FROM worker_cap_hits) AS "lastNotifiedAt"
  `
  const last = state?.lastNotifiedAt ? Date.parse(state.lastNotifiedAt) : 0
  if (Date.now() - last < NOTIFY_EVERY_MS) return
  await sql`UPDATE worker_cap_hits SET notified_at = now() WHERE project_id = ${projectId}`
  wakeLog.warn('project worker cap reached; work is queued', { projectId, awake, cap })
  await notifySuperAdmins(projectId, awake, cap).catch((error) => wakeLog.warn('cap notification failed', { error: error instanceof Error ? error.message : String(error) }))
}

/** Projects the cap is holding back right now (for the Project workers page). */
export async function capWaiting(): Promise<Array<{ projectId: string; name: string; since: string }>> {
  return await getDb()<Array<{ projectId: string; name: string; since: string }>>`
    SELECT h.project_id AS "projectId", p.name, h.hit_at AS since
      FROM worker_cap_hits h JOIN projects p ON p.project_id = h.project_id
     WHERE h.hit_at > now() - interval '10 minutes'
       AND EXISTS (SELECT 1 FROM project_jobs j WHERE j.project_id = h.project_id AND j.status = 'queued')
     ORDER BY h.hit_at
  `
}

async function notifySuperAdmins(projectId: string, awake: number, cap: number): Promise<void> {
  const [{ superAdminEmails }, { sendDirectMessage }, { getDefaultOrgId }] = await Promise.all([import('./auth'), import('./slack'), import('./orgs')])
  const [project] = await getDb()<Array<{ name: string }>>`SELECT name FROM projects WHERE project_id = ${projectId}`
  const base = process.env.PUBLIC_URL?.trim().replace(/\/+$/, '')
  const text = `Project workers are at their limit (${awake}/${cap} awake). ${project?.name ?? 'A project'} has work waiting until one goes idle. Raise PROJECT_WORKERS_MAX_AWAKE or wait.`
  const blocks: unknown[] = [{ type: 'section', text: { type: 'mrkdwn', text: `⚠️ *Project workers are at their limit* (${awake}/${cap} awake).\n*${project?.name ?? 'A project'}* has work waiting until a worker goes idle.` } }]
  if (base) blocks.push({ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open project workers' }, url: `${base}/organization?section=workers` }] })
  const orgId = await getDefaultOrgId()
  for (const email of await superAdminEmails()) await sendDirectMessage({ orgId, email, text, blocks })
}

let started = false

/**
 * Web role: wake workers as jobs are queued, and sweep every 30 s for queued
 * work whose worker is not running (a missed NOTIFY, a worker that went idle
 * while the cap held others back).
 */
export async function startWakeScheduler(): Promise<void> {
  if (started) return
  started = true
  const wake = (projectId: string) => { void wakeProjectWorker(projectId).catch((error) => wakeLog.warn('wake failed', { projectId, error: error instanceof Error ? error.message : String(error) })) }
  await getDb().listen('project_job', (projectId) => { if (projectId) wake(projectId) })
  const sweep = async () => { for (const projectId of await projectsWaitingForWorker()) wake(projectId) }
  setInterval(() => { void sweep().catch(() => undefined) }, 30_000)
  void sweep().catch(() => undefined)
  wakeLog.info('waking project workers for queued work', { maxAwake: maxAwakeWorkers() })
}
