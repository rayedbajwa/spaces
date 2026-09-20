#!/usr/bin/env bun
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { assertEnvOrExit } from './lib/env'
import { closeDb, getDb, ignoreShutdownDbErrors } from './lib/db'
import { getOrchestrator } from './lib/dispatcher'
import { log } from './lib/logger'
import { listLiveWorkers, pruneDeadWorkers } from './lib/worker-registry'

assertEnvOrExit('supervisor')

const supLog = log.child({ mod: 'supervisor' })

/**
 * Worker supervisor: one worker process per active project.
 *
 *   - Watches project_jobs (NOTIFY + poll). A project with queued/claimed/running
 *     jobs and no live worker gets a dedicated worker spawned with
 *     WORKER_PROJECT_ID, so it only claims that project's jobs. Its concurrency
 *     is the project's max_concurrent.
 *   - Workers exit on their own after WORKER_IDLE_EXIT_SECONDS of idleness (no
 *     jobs, no paused engines). The supervisor notices and simply respawns when
 *     work shows up again — "warm" while alive-and-idle, "hot" while running.
 *   - Crashed workers are respawned (with backoff) while their project still has
 *     work. Total workers are capped by SUPERVISOR_MAX_WORKERS.
 *
 * Run alongside the server instead of `bun run src/worker.ts`:
 *   bun run src/supervisor.ts
 */

// Each per-project worker is a Bun process holding live agent sessions (a few
// hundred MB each); default to 4 so a laptop under memory pressure doesn't get
// the whole fleet killed. Raise SUPERVISOR_MAX_WORKERS on a bigger host.
const MAX_WORKERS = Math.max(1, Number(process.env.SUPERVISOR_MAX_WORKERS ?? '4') || 4)
const IDLE_EXIT_SECONDS = Math.max(30, Number(process.env.WORKER_IDLE_EXIT_SECONDS ?? '300') || 300)
const POLL_MS = 5_000
const RESPAWN_BACKOFF_MS = 15_000

const workerScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker.ts')

interface ManagedWorker {
  projectId: string
  slug: string
  workerId: string
  child: ChildProcess
  startedAt: number
  exited?: { code: number | null; at: number }
}

const managed = new Map<string, ManagedWorker>() // projectId → worker
const lastExitAt = new Map<string, number>() // projectId → ms, for backoff
const waitingSince = new Map<string, number>() // projectId → ms it first waited for a slot
const rotatedAt = new Map<string, number>() // projectId → ms its worker was last rotated out
let shuttingDown = false

/** A project waiting this long for a slot takes one from a worker that is holding it without running anything. */
const STARVATION_MS = 60_000
/** Never rotate the same project's worker out more often than this. */
const ROTATE_COOLDOWN_MS = 5 * 60_000
/** How often the same waiting project is reported, so a full fleet does not flood the log. */
const WAIT_LOG_MS = 60_000
const lastWaitLogAt = new Map<string, number>()

async function projectsWithWork(): Promise<Array<{ projectId: string; slug: string; queued: number; inFlight: number }>> {
  const sql = getDb()
  return await sql<Array<{ projectId: string; slug: string; queued: number; inFlight: number }>>`
    SELECT p.project_id AS "projectId", p.slug,
           COUNT(*) FILTER (WHERE j.status = 'queued')::int AS queued,
           COUNT(*) FILTER (WHERE j.status IN ('claimed','running'))::int AS "inFlight"
      FROM project_jobs j
      JOIN projects p ON p.project_id = j.project_id
     WHERE j.status IN ('queued','claimed','running')
       -- An archived project must not hold a worker slot; archiving is how a
       -- stuck project is taken out of the way.
       AND p.archived_at IS NULL
     GROUP BY p.project_id, p.slug
     ORDER BY MIN(j.created_at)
  `
}

function spawnWorker(projectId: string, slug: string, maxConcurrent: number): ManagedWorker {
  const workerId = `proj-${slug}-${process.pid}-${Date.now().toString(36)}`
  const child = spawn(process.execPath, ['run', workerScript], {
    cwd: path.dirname(path.dirname(workerScript)),
    env: {
      ...process.env,
      WORKER_ID: workerId,
      WORKER_PROJECT_ID: projectId,
      WORKER_IDLE_EXIT_SECONDS: String(IDLE_EXIT_SECONDS),
      WORKER_MAX_CONCURRENT_JOBS: String(Math.max(1, maxConcurrent)),
      WORKER_SUPERVISED: '1',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  const record: ManagedWorker = { projectId, slug, workerId, child, startedAt: Date.now() }
  child.on('exit', (code) => {
    record.exited = { code, at: Date.now() }
    lastExitAt.set(projectId, Date.now())
    if (managed.get(projectId) === record) managed.delete(projectId)
    supLog.info('worker exited', { slug, workerId, code })
    if (!shuttingDown) void reconcile()
  })
  supLog.info('spawned per-project worker', { slug, workerId, pid: child.pid, maxConcurrent })
  return record
}

let reconciling = false
async function reconcile(): Promise<void> {
  if (reconciling || shuttingDown) return
  reconciling = true
  try {
    const work = await projectsWithWork()
    const live = await listLiveWorkers()

    for (const project of work) {
      if (managed.has(project.projectId)) continue
      // Another supervisor/host may already serve this project.
      const foreign = live.find((w) => w.projectId === project.projectId && w.state !== 'stale' && !managed.has(project.projectId))
      if (foreign) continue
      if (managed.size >= MAX_WORKERS) {
        const since = waitingSince.get(project.projectId) ?? Date.now()
        waitingSince.set(project.projectId, since)
        const waitedMs = Date.now() - since
        // A project must not starve behind workers that hold a slot without
        // running anything — a stuck or abandoned project would otherwise keep
        // the fleet full for ever. After a minute of waiting, the longest-held
        // idle slot is handed over; workers actually running jobs are left alone.
        if (waitedMs >= STARVATION_MS) {
          const idleHolder = [...managed.values()]
            .filter((w) => !w.exited)
            .filter((w) => (work.find((p) => p.projectId === w.projectId)?.inFlight ?? 0) === 0)
            .filter((w) => Date.now() - (rotatedAt.get(w.projectId) ?? 0) > ROTATE_COOLDOWN_MS)
            .sort((a, b) => a.startedAt - b.startedAt)[0]
          if (idleHolder) {
            rotatedAt.set(idleHolder.projectId, Date.now())
            supLog.warn('handing a worker slot to a waiting project', { waiting: project.slug, waitedSeconds: Math.round(waitedMs / 1000), stopping: idleHolder.slug, workerId: idleHolder.workerId })
            idleHolder.child.kill('SIGTERM')
            continue
          }
        }
        const lastLog = lastWaitLogAt.get(project.projectId) ?? 0
        if (Date.now() - lastLog > WAIT_LOG_MS) {
          lastWaitLogAt.set(project.projectId, Date.now())
          supLog.warn('worker cap reached; project waits', { slug: project.slug, cap: MAX_WORKERS, waitedSeconds: Math.round(waitedMs / 1000), busy: [...managed.values()].map((w) => w.slug) })
        }
        continue
      }
      waitingSince.delete(project.projectId)
      lastWaitLogAt.delete(project.projectId)
      const exitedAt = lastExitAt.get(project.projectId)
      if (exitedAt && Date.now() - exitedAt < RESPAWN_BACKOFF_MS && project.inFlight === 0 && project.queued === 0) continue
      if (exitedAt && Date.now() - exitedAt < 2_000) continue // let the idle exit settle
      const orchestrator = await getOrchestrator(project.projectId).catch(() => ({ maxConcurrent: 1 }))
      managed.set(project.projectId, spawnWorker(project.projectId, project.slug, orchestrator.maxConcurrent ?? 1))
    }
  } catch (error) {
    supLog.error('reconcile failed', error instanceof Error ? error : new Error(String(error)))
  } finally {
    reconciling = false
  }
}

async function main(): Promise<void> {
  supLog.info('supervisor starting', { maxWorkers: MAX_WORKERS, idleExitSeconds: IDLE_EXIT_SECONDS })
  const sql = getDb()
  // Provider keys are read per organization by each worker; nothing is placed in the environment.
  const { listenProviderKeys, scrubProviderKeysFromEnv } = await import('./lib/provider-keys')
  scrubProviderKeysFromEnv()
  await listenProviderKeys().catch(() => undefined)
  await sql.listen('project_job', () => { void reconcile() })
  setInterval(() => { void reconcile() }, POLL_MS)
  setInterval(() => {
    void pruneDeadWorkers().then((n) => { if (n > 0) supLog.info('pruned dead worker registrations', { count: n }) }).catch(() => undefined)
  }, 60_000)
  await reconcile()
  supLog.info('watching project_jobs; workers spawn per project on demand')
}

// Queries still in flight when the pool closes are part of shutting down, not a crash.
ignoreShutdownDbErrors((reason) => supLog.error('unhandled rejection', reason instanceof Error ? reason : new Error(String(reason))))

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  supLog.info('shutdown; stopping managed workers', { signal, count: managed.size })
  const children = [...managed.values()]
  for (const w of children) w.child.kill('SIGTERM')
  // Give workers a moment to re-queue/pause their runs cleanly.
  await Promise.all(children.map((w) => new Promise<void>((resolve) => {
    if (w.exited) return resolve()
    const timer = setTimeout(() => { w.child.kill('SIGKILL'); resolve() }, 15_000)
    w.child.once('exit', () => { clearTimeout(timer); resolve() })
  })))
  await closeDb()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

await main()
