/**
 * Moving an existing project onto its own worker, one project at a time
 * (specs/014-project-workers, phase 5; FR-008).
 *
 * A project's files are its repositories (the governing workspace and clones),
 * their worktrees and its agent session files — the same set deleting a project
 * removes. They keep the same absolute paths on the worker's volume (both mount
 * /data), so nothing in the database is rewritten.
 *
 * Copying is a pull: the receiving side fetches a manifest (files and bytes per
 * path) and a tar stream from the sending side's internal API, replaces its own
 * copy of those paths, and checks its files against the manifest.
 *
 * - Copy (dry run): create the worker (inactive), copy, verify. The shared
 *   service keeps serving the project.
 * - Move: hold the project's jobs, copy again (anything since the dry run),
 *   verify, then activate the worker — it serves the project's requests and
 *   jobs from then on, and the shared service stops claiming them.
 * - Move back: hold, copy from the worker to the shared service, verify,
 *   deactivate the worker.
 */

import { lstat, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { getDb } from './db'
import { governancePathFor } from './governance'
import { log } from './logger'
import { listRepos } from './project-registry'
import { worktreeRoot } from './pull-requests'
import { INTERNAL_TOKEN_HEADER, internalToken } from './role'
import { getProjectWorker, provisionProjectWorker } from './worker-provisioner'

const migrateLog = log.child({ mod: 'project-migration' })

// ---------------------------------------------------------------------------
// What a project owns on disk
// ---------------------------------------------------------------------------

/** The project's paths that exist on this disk, outermost only. */
export async function projectPaths(projectId: string): Promise<string[]> {
  const sql = getDb()
  const [project] = await sql<Array<{ slug: string }>>`SELECT slug FROM projects WHERE project_id = ${projectId}`
  if (!project) return []
  const candidates = new Set<string>()
  for (const repo of await listRepos(projectId)) {
    if (!repo.localPath) continue
    candidates.add(path.resolve(repo.localPath))
    candidates.add(path.resolve(worktreeRoot(repo.localPath)))
  }
  candidates.add(path.resolve(governancePathFor(project.slug)))
  const sessions = await sql<Array<{ file: string | null }>>`
    SELECT session_file AS file FROM pipeline_runs WHERE (project_namespace = ${project.slug} OR project_id = ${projectId}) AND session_file IS NOT NULL
    UNION SELECT session_file FROM project_agents WHERE project_id = ${projectId} AND session_file IS NOT NULL
  `
  for (const row of sessions) if (row.file) candidates.add(path.resolve(row.file))
  const existing: string[] = []
  for (const candidate of candidates) {
    if (await lstat(candidate).then(() => true, () => false)) existing.push(candidate)
  }
  // Drop paths inside another listed path (a worktree root inside its repository).
  return existing.sort().filter((p, i, all) => !all.slice(0, i).some((outer) => p.startsWith(`${outer}${path.sep}`)))
}

export interface PathSummary { path: string; files: number; bytes: number }
export interface Manifest { paths: PathSummary[]; files: number; bytes: number }

async function summarize(root: string): Promise<PathSummary> {
  let files = 0
  let bytes = 0
  const walk = async (target: string): Promise<void> => {
    const info = await lstat(target).catch(() => undefined)
    if (!info) return
    if (info.isDirectory()) {
      for (const entry of await readdir(target).catch(() => [] as string[])) await walk(path.join(target, entry))
      return
    }
    files += 1
    // A symlink counts as one entry; its target's size is not ours.
    if (!info.isSymbolicLink()) bytes += info.size
  }
  await walk(root)
  return { path: root, files, bytes }
}

export async function manifestFor(paths: string[]): Promise<Manifest> {
  const summaries = await Promise.all(paths.map(summarize))
  return { paths: summaries, files: summaries.reduce((n, s) => n + s.files, 0), bytes: summaries.reduce((n, s) => n + s.bytes, 0) }
}

/** A gzipped tar of the paths (absolute, as they are), streamed. */
export function archiveStream(paths: string[]): ReadableStream<Uint8Array> {
  const child = Bun.spawn(['tar', '-czf', '-', '-C', '/', ...paths.map((p) => p.replace(/^\/+/, ''))], { stdout: 'pipe', stderr: 'pipe' })
  void child.exited.then(async (code) => {
    if (code !== 0) migrateLog.warn('archive failed', { code, error: (await new Response(child.stderr).text()).slice(0, 300) })
  })
  return child.stdout
}

// ---------------------------------------------------------------------------
// Pulling a copy from the other side
// ---------------------------------------------------------------------------

export interface PullResult {
  ok: boolean
  source: Manifest
  local?: Manifest
  error?: string
}

async function internalFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const token = internalToken()
  if (!token) throw new Error('SPACES_INTERNAL_TOKEN is not set.')
  const res = await fetch(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), [INTERNAL_TOKEN_HEADER]: token } })
  if (!res.ok) throw new Error(`${url} answered ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res
}

/**
 * Replace this disk's copy of the project with the one at `sourceUrl`, then
 * check every path has the same number of files and bytes.
 */
export async function pullProject(projectId: string, sourceUrl: string, fetchImpl = internalFetch): Promise<PullResult> {
  const base = sourceUrl.replace(/\/+$/, '')
  const source = (await (await fetchImpl(`${base}/internal/migrate/${projectId}/manifest`)).json()) as Manifest
  // Replace, not merge: files deleted on the other side must not survive here.
  for (const summary of source.paths) await rm(summary.path, { recursive: true, force: true })
  const archive = await fetchImpl(`${base}/internal/migrate/${projectId}/archive`)
  const tar = Bun.spawn(['tar', '-xzf', '-', '-C', '/'], { stdin: archive.body!, stdout: 'ignore', stderr: 'pipe' })
  const code = await tar.exited
  if (code !== 0) return { ok: false, source, error: `tar failed (${code}): ${(await new Response(tar.stderr).text()).slice(0, 300)}` }
  const local = await manifestFor(source.paths.map((p) => p.path))
  const mismatch = source.paths.find((p, i) => p.files !== local.paths[i]!.files || p.bytes !== local.paths[i]!.bytes)
  if (mismatch) {
    const got = local.paths.find((p) => p.path === mismatch.path)!
    return { ok: false, source, local, error: `${mismatch.path}: expected ${mismatch.files} files / ${mismatch.bytes} bytes, got ${got.files} / ${got.bytes}` }
  }
  return { ok: true, source, local }
}

// ---------------------------------------------------------------------------
// Moving a project
// ---------------------------------------------------------------------------

export type MigrationState = 'copying' | 'syncing' | 'verified' | 'moved' | 'moving_back' | 'failed'

async function setMigration(projectId: string, state: MigrationState, detail: Record<string, unknown> = {}): Promise<void> {
  await getDb()`
    UPDATE project_workers SET migration_state = ${state}, migration_json = ${getDb().json(detail as never)}, migration_at = now(), updated_at = now()
     WHERE project_id = ${projectId}
  `
}

/** The address the other side pulls from: this service on the private network. */
export function selfPrivateUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = env.MIGRATION_SOURCE_URL?.trim()
  if (configured) return configured.replace(/\/+$/, '')
  const domain = env.RAILWAY_PRIVATE_DOMAIN?.trim()
  return domain ? `http://${domain}:${env.PORT ?? '3000'}` : undefined
}

async function busy(projectId: string): Promise<boolean> {
  const [row] = await getDb()<Array<{ n: number }>>`SELECT count(*)::int AS n FROM project_jobs WHERE project_id = ${projectId} AND status IN ('claimed', 'running')`
  return Number(row?.n ?? 0) > 0
}

async function waitFor<T>(check: () => Promise<T | undefined>, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`)
    await new Promise((resolve) => setTimeout(resolve, 3_000))
  }
}

export interface MigrationDeps {
  provision: (projectId: string) => Promise<unknown>
  /** Ask the worker to pull from `sourceUrl`; resolves with its result. */
  workerPull: (projectId: string, sourceUrl: string) => Promise<PullResult>
  /** This service pulls from the worker (move back). */
  selfPull: (projectId: string, workerUrl: string) => Promise<PullResult>
  sourceUrl: () => string | undefined
  readyTimeoutMs: number
}

const defaultDeps: MigrationDeps = {
  provision: (projectId) => provisionProjectWorker(projectId, { active: false }),
  workerPull: async (projectId, sourceUrl) => {
    const worker = await getProjectWorker(projectId)
    const res = await internalFetch(`${worker!.internalUrl}/internal/migrate/pull`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceUrl }), signal: AbortSignal.timeout(60 * 60_000) })
    return (await res.json()) as PullResult
  },
  selfPull: (projectId, workerUrl) => pullProject(projectId, workerUrl),
  sourceUrl: () => selfPrivateUrl(),
  readyTimeoutMs: 20 * 60_000,
}

/**
 * Copy a project to its own worker; with `activate`, hand the project over.
 * Runs in the shared service (role `all`), which holds the project's files.
 */
export async function moveProjectToWorker(projectId: string, options: { activate: boolean }, deps: MigrationDeps = defaultDeps): Promise<PullResult> {
  const sql = getDb()
  const sourceUrl = deps.sourceUrl()
  if (!sourceUrl) throw new Error('This service does not know its private address: set MIGRATION_SOURCE_URL (Railway sets RAILWAY_PRIVATE_DOMAIN).')
  const existing = await getProjectWorker(projectId)
  if (existing?.active) throw new Error('This project already runs on its own worker.')
  if (options.activate && await busy(projectId)) throw new Error('A stage is running for this project. Move it once the stage ends.')

  await sql`INSERT INTO project_workers (project_id, active) VALUES (${projectId}, false) ON CONFLICT (project_id) DO NOTHING`
  await setMigration(projectId, options.activate ? 'syncing' : 'copying', { startedAt: new Date().toISOString() })
  try {
    await deps.provision(projectId)
    // The worker reports its version once it is up.
    await waitFor(async () => {
      const worker = await getProjectWorker(projectId)
      if (worker?.state === 'failed') throw new Error(worker.lastError ?? 'The worker could not be created.')
      return worker?.state === 'ready' && worker.lastSeenAt ? worker : undefined
    }, deps.readyTimeoutMs, "the project's worker to start")
    // Moving: no stage may start on either side while the final copy is made.
    if (options.activate && await busy(projectId)) throw new Error('A stage started meanwhile. Try again once it ends.')
    const result = await deps.workerPull(projectId, sourceUrl)
    if (!result.ok) {
      await setMigration(projectId, 'failed', { error: result.error, source: result.source, local: result.local })
      return result
    }
    if (options.activate) {
      await sql`UPDATE project_workers SET active = true, updated_at = now() WHERE project_id = ${projectId}`
      await setMigration(projectId, 'moved', { files: result.source.files, bytes: result.source.bytes })
      migrateLog.info('project moved to its own worker', { projectId, files: result.source.files, bytes: result.source.bytes })
    } else {
      await setMigration(projectId, 'verified', { files: result.source.files, bytes: result.source.bytes })
      migrateLog.info('project copied to its worker (dry run)', { projectId, files: result.source.files })
    }
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await setMigration(projectId, 'failed', { error: message })
    throw error
  }
}

/** Hand a moved project back to the shared service, with the worker's latest files. */
export async function moveProjectBack(projectId: string, deps: MigrationDeps = defaultDeps): Promise<PullResult> {
  const worker = await getProjectWorker(projectId)
  if (!worker?.active || !worker.internalUrl) throw new Error('This project does not run on its own worker.')
  if (await busy(projectId)) throw new Error('A stage is running for this project. Move it back once the stage ends.')
  await setMigration(projectId, 'moving_back')
  try {
    const result = await deps.selfPull(projectId, worker.internalUrl)
    if (!result.ok) {
      await setMigration(projectId, 'failed', { error: result.error, direction: 'back' })
      return result
    }
    await getDb()`UPDATE project_workers SET active = false, updated_at = now() WHERE project_id = ${projectId}`
    await setMigration(projectId, 'verified', { files: result.source.files, bytes: result.source.bytes, direction: 'back' })
    migrateLog.info('project moved back to the shared service', { projectId })
    return result
  } catch (error) {
    await setMigration(projectId, 'failed', { error: error instanceof Error ? error.message : String(error), direction: 'back' })
    throw error
  }
}
