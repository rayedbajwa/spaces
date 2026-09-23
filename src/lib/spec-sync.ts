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

/**
 * Remove the full copy of the intent directory (`specs/<NNN-intent>/`) an
 * earlier version mirrored into an implementation checkout — only when it is a
 * real directory and every document in it is an exact copy of the governing
 * one, so nothing a person or agent wrote there is lost. Returns the removed
 * path, relative to the checkout.
 */
export async function removeMirroredIntentDir(input: { governingFeatureDir: string; targetRoot: string; keep: string }): Promise<string | undefined> {
  const relative = path.join('specs', path.basename(input.governingFeatureDir))
  if (path.normalize(relative) === path.normalize(input.keep)) return undefined
  const dir = path.join(input.targetRoot, relative)
  const info = await lstat(dir).catch(() => undefined)
  if (!info || info.isSymbolicLink() || !info.isDirectory()) return undefined
  if (!(await plainPath(input.targetRoot, dir))) return undefined
  const docs = await listIntentDocuments(dir).catch(() => undefined)
  if (!docs) return undefined
  const everything = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => undefined)
  // Anything other than a mirrored document (another file type, a hidden file) means it is not only our copy.
  const files = (everything ?? []).filter((e) => !e.isDirectory())
  if (files.length !== docs.length) return undefined
  for (const rel of docs) {
    const here = await readFile(path.join(dir, rel), 'utf8').catch(() => undefined)
    const there = await readFile(path.join(input.governingFeatureDir, rel), 'utf8').catch(() => undefined)
    if (here === undefined || here !== there) return undefined
  }
  await rm(dir, { recursive: true, force: true })
  return relative
}
