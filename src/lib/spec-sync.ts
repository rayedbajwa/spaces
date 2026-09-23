import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * An intent's documents in the repositories that implement it.
 *
 * Spec Kit writes an intent's spec, plan, tasks and reports in the governing
 * workspace (the project's primary repository). When the code lives in other
 * repositories, their branches and pull requests carried the code but not the
 * spec it implements or the tasks it completes. Each implementation checkout
 * working on the intent gets a copy of `specs/<intent>/`, mirrored at every code
 * stage and committed with that stage's changes, so its pull request shows
 * what was asked, planned and verified next to the change itself.
 */

const DOCUMENT = /\.(md|json|ya?ml|txt)$/i
const MAX_DEPTH = 3

async function listDocuments(dir: string, relative = '', depth = 0): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(path.join(dir, relative), { withFileTypes: true }).catch(() => [])) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const rel = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (depth < MAX_DEPTH) out.push(...await listDocuments(dir, rel, depth + 1))
    } else if (entry.isFile() && DOCUMENT.test(entry.name)) {
      out.push(rel)
    }
  }
  return out
}

export interface SpecSyncResult {
  /** Documents written (new or changed). */
  written: string[]
  /** Documents removed because they no longer exist in the governing workspace. */
  removed: string[]
}

/**
 * Mirror the intent's directory from the governing workspace into one
 * implementation checkout (same relative path, `specs/<intent>/`). Only that
 * directory is touched; nothing is written through a symbolic link.
 */
export async function syncIntentDocuments(input: { governingRoot: string; featureDirAbs: string; targetRoot: string }): Promise<SpecSyncResult> {
  const result: SpecSyncResult = { written: [], removed: [] }
  const governing = path.resolve(input.governingRoot)
  const target = path.resolve(input.targetRoot)
  const source = path.resolve(input.featureDirAbs)
  if (governing === target || !source.startsWith(`${governing}${path.sep}`)) return result
  const relativeDir = path.relative(governing, source) // specs/<intent>
  const destination = path.join(target, relativeDir)
  // The folders on the way must be real directories in the implementation checkout.
  let current = target
  for (const part of relativeDir.split(path.sep)) {
    current = path.join(current, part)
    const info = await lstat(current).catch(() => undefined)
    if (!info) break
    if (info.isSymbolicLink() || !info.isDirectory()) return result
  }

  const wanted = await listDocuments(source)
  for (const rel of wanted) {
    const content = await readFile(path.join(source, rel), 'utf8').catch(() => undefined)
    if (content === undefined) continue
    const file = path.join(destination, rel)
    const existing = await lstat(file).catch(() => undefined)
    if (existing?.isSymbolicLink()) continue
    if (existing && (await readFile(file, 'utf8').catch(() => undefined)) === content) continue
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, content)
    result.written.push(rel)
  }
  const keep = new Set(wanted)
  for (const rel of await listDocuments(destination)) {
    if (keep.has(rel)) continue
    await rm(path.join(destination, rel), { force: true })
    result.removed.push(rel)
  }
  return result
}
