/**
 * Keeping the workspace volume from filling up.
 *
 * Every project clones its repositories, installs their dependencies and keeps
 * a governing workspace, and agents create git worktrees for parallel
 * workstreams. None of that is ever reclaimed on its own, so a small volume
 * fills silently and the next run dies with ENOSPC in the middle of a stage —
 * usually while writing an artifact, which is the worst moment.
 *
 * This sweep removes what is safe to remove, in order of how little it costs
 * to recreate: abandoned git worktrees first, then the workspaces of projects
 * that no longer exist or are archived, then dependency directories in
 * checkouts nothing has touched for a while (an agent reinstalls them when it
 * next needs them), and finally a git garbage collection.
 */

import { execFile } from 'node:child_process'
import { readdir, rm, stat, statfs } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { getDb } from './db'
import { log } from './logger'

const run = promisify(execFile)
const diskLog = log.child({ mod: 'disk' })

/** Below this share of free space the sweep gets aggressive (dependencies, git gc). */
const LOW_FREE_RATIO = 0.2
/** Dependency directories untouched for this long are removed when space is short. */
const STALE_DEPENDENCY_DAYS = 7
const DEPENDENCY_DIRS = ['node_modules', '.venv', 'target', 'vendor']

export interface DiskUsage {
  totalBytes: number
  freeBytes: number
  freeRatio: number
}

export async function diskUsage(target: string): Promise<DiskUsage | undefined> {
  try {
    const stats = await statfs(target)
    const totalBytes = Number(stats.blocks) * Number(stats.bsize)
    const freeBytes = Number(stats.bavail) * Number(stats.bsize)
    return { totalBytes, freeBytes, freeRatio: totalBytes > 0 ? freeBytes / totalBytes : 1 }
  } catch {
    return undefined
  }
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`
  return `${Math.round(bytes / 1024)} KB`
}

async function directories(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name))
  } catch {
    return []
  }
}

/** Checkouts and governing workspaces, two levels deep (<root>/<owner>/<repo> and <root>/_governance/<project>). */
async function checkouts(root: string): Promise<string[]> {
  const found: string[] = []
  for (const owner of await directories(root)) {
    const children = await directories(owner)
    if (children.length === 0) found.push(owner)
    else found.push(...children)
  }
  return found
}

async function isGitRepo(dir: string): Promise<boolean> {
  return await stat(path.join(dir, '.git')).then(() => true).catch(() => false)
}

async function olderThanDays(target: string, days: number): Promise<boolean> {
  const info = await stat(target).catch(() => undefined)
  if (!info) return false
  return Date.now() - info.mtimeMs > days * 24 * 60 * 60_000
}

export interface SweepResult {
  worktreesPruned: number
  workspacesRemoved: string[]
  dependenciesRemoved: string[]
  reposCollected: number
  before?: DiskUsage
  after?: DiskUsage
}

/**
 * Reclaim space under the workspace root. `aggressive` removes dependency
 * directories and runs git's garbage collector; without it only abandoned
 * worktrees and the workspaces of gone projects are removed.
 */
export async function sweepWorkspaces(options: { root: string; aggressive?: boolean }): Promise<SweepResult> {
  const result: SweepResult = { worktreesPruned: 0, workspacesRemoved: [], dependenciesRemoved: [], reposCollected: 0 }
  result.before = await diskUsage(options.root)

  const all = await checkouts(options.root)

  // 1. Worktrees whose directory is gone still hold objects; pruning is always safe.
  for (const dir of all) {
    if (!(await isGitRepo(dir))) continue
    const pruned = await run('git', ['-C', dir, 'worktree', 'prune'], { timeout: 30_000 }).then(() => true).catch(() => false)
    if (pruned) result.worktreesPruned += 1
  }

  // 2. Governing workspaces of projects that no longer exist or are archived.
  const governance = path.join(options.root, '_governance')
  const live = await getDb()<Array<{ slug: string }>>`SELECT slug FROM projects WHERE archived_at IS NULL`.catch(() => [])
  const liveSlugs = new Set(live.map((row) => row.slug))
  if (live.length > 0) {
    for (const dir of await directories(governance)) {
      const slug = path.basename(dir)
      if (liveSlugs.has(slug)) continue
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
      result.workspacesRemoved.push(slug)
    }
  }

  if (options.aggressive) {
    // 3. Dependencies nothing has touched lately: an agent reinstalls them on demand.
    for (const dir of all) {
      for (const name of DEPENDENCY_DIRS) {
        const target = path.join(dir, name)
        if (!(await stat(target).then(() => true).catch(() => false))) continue
        if (!(await olderThanDays(target, STALE_DEPENDENCY_DAYS))) continue
        await rm(target, { recursive: true, force: true }).catch(() => undefined)
        result.dependenciesRemoved.push(path.relative(options.root, target))
      }
    }

    // 4. Loose git objects, which a long-lived clone accumulates.
    for (const dir of all) {
      if (!(await isGitRepo(dir))) continue
      const collected = await run('git', ['-C', dir, 'gc', '--quiet', '--prune=now'], { timeout: 120_000 }).then(() => true).catch(() => false)
      if (collected) result.reposCollected += 1
    }
  }

  result.after = await diskUsage(options.root)
  const freed = result.before && result.after ? result.after.freeBytes - result.before.freeBytes : 0
  if (result.workspacesRemoved.length || result.dependenciesRemoved.length || freed > 0) {
    diskLog.info('workspace sweep finished', {
      freed: formatBytes(Math.max(0, freed)),
      free: result.after ? formatBytes(result.after.freeBytes) : undefined,
      workspaces: result.workspacesRemoved.length,
      dependencies: result.dependenciesRemoved.length,
      worktrees: result.worktreesPruned,
      repos: result.reposCollected,
    })
  }
  return result
}

/**
 * Sweep when space is short. Returns the usage afterwards so a caller can
 * refuse to start work that is bound to fail.
 */
export async function ensureDiskSpace(root: string): Promise<DiskUsage | undefined> {
  const usage = await diskUsage(root)
  if (!usage) return undefined
  if (usage.freeRatio > LOW_FREE_RATIO) return usage
  diskLog.warn('workspace volume is low on space; sweeping', { free: formatBytes(usage.freeBytes), total: formatBytes(usage.totalBytes) })
  const swept = await sweepWorkspaces({ root, aggressive: true }).catch((error) => {
    diskLog.warn('workspace sweep failed', { error: error instanceof Error ? error.message : String(error) })
    return undefined
  })
  const after = swept?.after ?? (await diskUsage(root))
  if (after && after.freeRatio <= LOW_FREE_RATIO) {
    diskLog.warn('workspace volume is still low after sweeping; grow it or remove projects', { free: formatBytes(after.freeBytes), total: formatBytes(after.totalBytes) })
  }
  return after
}
