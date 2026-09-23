import { lstat, readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'

/**
 * An intent's documents and the repositories that implement it.
 *
 * Implementation repositories carry only their repo-local change
 * (lib/repo-change.ts: change.yaml, the tasks they own, their delta spec);
 * the plan, test plan, research, contracts, reviews and reports stay in the
 * governing workspace and in Spaces. An earlier version mirrored the whole
 * intent directory into them; removeMirroredIntentDir takes such a copy away.
 */

const DOCUMENT = /\.(md|json|ya?ml|txt)$/i
const MAX_DEPTH = 3

/**
 * The intent's documents under `dir` (relative paths). A directory that does
 * not exist has none; any other read error is thrown — an unreadable source
 * must never look empty, or the sync would delete the copies.
 */
export async function listIntentDocuments(dir: string, relative = '', depth = 0): Promise<string[]> {
  const out: string[] = []
  let entries
  try {
    entries = await readdir(path.join(dir, relative), { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && relative === '') return out
    throw error
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const rel = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (depth < MAX_DEPTH) out.push(...await listIntentDocuments(dir, rel, depth + 1))
    } else if (entry.isFile() && DOCUMENT.test(entry.name)) {
      out.push(rel)
    }
  }
  return out
}

/** Whether every existing folder from `root` down to `dir` is a real directory (missing ones will be created as such). */
async function plainPath(root: string, dir: string): Promise<boolean> {
  let current = root
  for (const part of path.relative(root, dir).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    const info = await lstat(current).catch(() => undefined)
    if (!info) return true
    if (info.isSymbolicLink() || !info.isDirectory()) return false
  }
  return true
}

/** What an implementation repository's change directory holds (lib/repo-change.ts). */
export const REPO_CHANGE_FILES = new Set(['change.yaml', 'tasks.md', 'spec.md'])

/**
 * Prune what an earlier version mirrored into an implementation checkout's
 * `specs/<NNN-intent>/` (the plan, test plan, research, contracts, reports),
 * leaving only its repo-local change. A document is removed only when it is an
 * exact copy of the governing one — anything written in this repository stays
 * — and folders left empty go too. Nothing is removed through a symbolic link.
 * Returns the documents removed.
 */
export async function pruneMirroredDocuments(input: { governingFeatureDir: string; targetRoot: string; changeDir: string }): Promise<string[]> {
  const dir = path.join(input.targetRoot, input.changeDir)
  // Never the intent itself: its own directory, or any checkout of the
  // repository that holds it, would have every document "match" and be deleted.
  if (path.resolve(dir) === path.resolve(input.governingFeatureDir)) return []
  const { sameRepository } = await import('./repo-change')
  if (sameRepository(input.targetRoot, input.governingFeatureDir)) return []
  if (!(await plainPath(input.targetRoot, dir))) return []
  const docs = await listIntentDocuments(dir).catch(() => undefined)
  if (!docs) return []
  const removed: string[] = []
  for (const rel of docs) {
    if (REPO_CHANGE_FILES.has(rel)) continue
    const file = path.join(dir, rel)
    if (!(await plainPath(input.targetRoot, path.dirname(file)))) continue
    if ((await lstat(file).catch(() => undefined))?.isSymbolicLink()) continue
    const here = await readFile(file, 'utf8').catch(() => undefined)
    const there = await readFile(path.join(input.governingFeatureDir, rel), 'utf8').catch(() => undefined)
    if (here === undefined || here !== there) continue
    await rm(file, { force: true })
    removed.push(rel)
  }
  // Folders the copy left empty (contracts/, checklists/ …).
  for (const folder of [...new Set(removed.map((r) => path.dirname(r)).filter((d) => d !== '.'))].sort((a, b) => b.length - a.length)) {
    const full = path.join(dir, folder)
    if ((await readdir(full).catch(() => ['x'])).length === 0) await rm(full, { recursive: true, force: true })
  }
  return removed
}
