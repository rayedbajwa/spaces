/**
 * Resource loader for agent sessions: the SDK's defaults (the user's
 * ~/.pi/agent packages, skills and prompt templates) plus the skills Spaces
 * ships with — today the `playwright-browser` skill from the pi-playwright
 * package, so implement and QA agents can drive the app in a real browser
 * through the Playwright CLI.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { DefaultResourceLoader, getAgentDir } from '@earendil-works/pi-coding-agent'
import { log } from './logger'

const resLog = log.child({ mod: 'agent-resources' })
const require = createRequire(import.meta.url)

/** Skill directories bundled with Spaces (each holds `<skill>/SKILL.md`). */
export function bundledSkillPaths(): string[] {
  const paths: string[] = []
  try {
    const dir = path.join(path.dirname(require.resolve('pi-playwright/package.json')), 'skills')
    if (existsSync(dir)) paths.push(dir)
  } catch (error) {
    resLog.warn('pi-playwright skills not found; browser skill unavailable', { error: error instanceof Error ? error.message : String(error) })
  }
  return paths
}

/**
 * A loaded resource loader for a session working in `cwd`.
 *
 * `appendSystemPrompt` carries the instructions that hold for the whole
 * session — what the machine provides, and the rules for evidence — the way
 * Pi itself does it, instead of repeating them on top of every stage prompt.
 * They then apply to every turn, survive compaction, and stay out of the
 * conversation the agent is reasoning about.
 */
export async function createAgentResourceLoader(cwd: string, options: { appendSystemPrompt?: string[] } = {}): Promise<DefaultResourceLoader> {
  const appendSystemPrompt = (options.appendSystemPrompt ?? []).map((text) => text.trim()).filter(Boolean)
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    additionalSkillPaths: bundledSkillPaths(),
    ...(appendSystemPrompt.length ? { appendSystemPrompt } : {}),
  })
  await loader.reload()
  return loader
}
