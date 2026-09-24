import { existsSync } from 'node:fs'
import { copyFile, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Spaces' own, shorter versions of the Spec Kit stage skills and templates
 * (data/speckit/), used ahead of the ones in @the-agency/pi-spec-kit.
 *
 * The package is written for any Spec Kit host: extension-hook checks, steps
 * Spaces already does (branching, init checks), long example and anti-example
 * lists, and templates full of sample content that agents copy into every
 * spec, plan and task list, which every later stage then reads again. These
 * keep each skill's steps, output formats and quality gates, and the formats
 * Spaces parses (`## Question N:`, `- [ ] T001 …`, `[NEEDS CLARIFICATION: …]`).
 * A skill or template missing here falls back to the package's.
 */

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const LEAN_SPECKIT_DIR = path.join(rootDir, 'data', 'speckit')

/** The SKILL.md a stage runs: Spaces' own when there is one, else the package's. */
export function skillPathFor(speckitRoot: string, skill: string, leanDir = LEAN_SPECKIT_DIR): string {
  const lean = path.join(leanDir, 'skills', skill, 'SKILL.md')
  return existsSync(lean) ? lean : path.join(speckitRoot, 'skills', skill, 'SKILL.md')
}

/**
 * Put the shorter templates into a repository's `.specify/templates/`. A
 * template is replaced only while it is still the package's original, byte for
 * byte (or missing): one the project has edited is its own and stays. Returns
 * the names replaced. Safe to call on every run; it does nothing once done.
 */
export async function installLeanTemplates(specifyDir: string, speckitRoot: string, leanDir = LEAN_SPECKIT_DIR): Promise<string[]> {
  const source = path.join(leanDir, 'templates')
  const target = path.join(specifyDir, 'templates')
  if (!existsSync(source) || !existsSync(target)) return []
  const replaced: string[] = []
  for (const name of (await readdir(source)).filter((n) => n.endsWith('.md')).sort()) {
    const lean = await readFile(path.join(source, name), 'utf8')
    const current = await readFile(path.join(target, name), 'utf8').catch(() => undefined)
    if (current === lean) continue
    const original = await readFile(path.join(speckitRoot, 'specify-templates', 'templates', name), 'utf8').catch(() => undefined)
    if (current !== undefined && current !== original) continue
    await copyFile(path.join(source, name), path.join(target, name))
    replaced.push(name)
  }
  return replaced
}
