import { readdirSync, readFileSync, statSync } from 'node:fs'
import { rm, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Which feature a project is working on.
 *
 * Features are numbered directories under specs/ (`001-login`, `002-billing`).
 * The active one is normally the highest number — the newest. A person can
 * make an earlier, unfinished feature active again to continue it; that choice
 * is kept in `specs/.active-feature` (the directory name), and everything that
 * works on "the current feature" — stages, reports, the board, next steps —
 * resolves it through here. Starting a new feature clears the choice, so the
 * new one becomes active.
 */

export const ACTIVE_FEATURE_FILE = '.active-feature'

/** Feature directory names, newest (highest number) first. */
export function featureDirNames(root: string): string[] {
  try {
    return readdirSync(path.join(root, 'specs'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => b.localeCompare(a))
  } catch {
    return []
  }
}

/** A feature directory name as it may appear in a URL: no separators, no leading dot, no `..`. */
export function isFeatureId(id: string): boolean {
  return /^[\w.-]+$/.test(id) && !id.startsWith('.')
}

/** The feature a person chose to continue, when that choice is recorded and the feature still exists. */
export function chosenFeatureId(root: string): string | null {
  try {
    const chosen = readFileSync(path.join(root, 'specs', ACTIVE_FEATURE_FILE), 'utf8').trim()
    if (chosen && featureDirNames(root).includes(chosen) && statSync(path.join(root, 'specs', chosen)).isDirectory()) return chosen
  } catch {
    // no choice recorded
  }
  return null
}

/** The active feature's directory name: the chosen one when it still exists, else the newest. */
export function activeFeatureId(root: string): string | null {
  return chosenFeatureId(root) ?? featureDirNames(root)[0] ?? null
}

/** Absolute path of the active feature directory, or null when there is none. */
export function activeFeatureDir(root: string): string | null {
  const id = activeFeatureId(root)
  return id ? path.join(root, 'specs', id) : null
}

/** Make a feature active; `null` (or the newest) clears the choice so the newest is active. */
export async function setActiveFeature(root: string, id: string | null): Promise<void> {
  const file = path.join(root, 'specs', ACTIVE_FEATURE_FILE)
  if (!id || id === featureDirNames(root)[0]) {
    await unlink(file).catch(() => undefined)
    return
  }
  if (!featureDirNames(root).includes(id)) throw new Error(`Feature ${id} does not exist.`)
  await writeFile(file, `${id}\n`)
}

/** Remove a feature's directory; clears the active choice when it pointed at it. */
export async function removeFeatureDir(root: string, id: string): Promise<void> {
  if (!isFeatureId(id)) throw new Error('Invalid feature id.')
  if (!featureDirNames(root).includes(id)) throw new Error(`Feature ${id} does not exist.`)
  let chosen = ''
  try { chosen = readFileSync(path.join(root, 'specs', ACTIVE_FEATURE_FILE), 'utf8').trim() } catch { /* none */ }
  await rm(path.join(root, 'specs', id), { recursive: true, force: true })
  if (chosen === id) await unlink(path.join(root, 'specs', ACTIVE_FEATURE_FILE)).catch(() => undefined)
}
