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
import { DefaultResourceLoader, SettingsManager, getAgentDir } from '@earendil-works/pi-coding-agent'
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

/**
 * Spaces' own secrets, never seen by an agent's shell. The worker runs with
 * the application's DATABASE_URL, ENCRYPTION_KEY and provider keys, and
 * every command an agent ran inherited them: a `bun test` in a checkout of
 * Spaces itself then used production's database (Bun does not let a .env
 * override a variable already set), writing test projects and jobs there. The
 * checkout's own .env (pointed at the assigned test database) is what its
 * commands should see.
 */
export const HIDDEN_FROM_AGENTS = [
  'DATABASE_URL', 'DATABASE_PUBLIC_URL', 'DATABASE_PRIVATE_URL', 'AGENT_DATABASE_URL', 'TEST_DATABASE_URL',
  'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGDATA',
  'ENCRYPTION_KEY', 'SESSION_SECRET', 'RAILWAY_TOKEN', 'RAILWAY_API_TOKEN',
]

/** Run before every command in an agent's shell: removes the variables above, and any *_API_KEY or *_SECRET. */
export const AGENT_SHELL_PREFIX = [
  `unset ${HIDDEN_FROM_AGENTS.join(' ')} 2>/dev/null`,
  `for __v in $(env | sed -n 's/^\\([A-Za-z_][A-Za-z0-9_]*\\)=.*/\\1/p' | grep -E '(_API_KEY|_SECRET|_SECRET_KEY)$'); do unset "$__v"; done; unset __v`,
].join('\n')

/**
 * The settings an agent session runs with: the usual ones (files), plus the
 * shell prefix above — set in memory only, so nothing is written to the
 * settings files.
 */
export function createAgentSettings(cwd: string): SettingsManager {
  const settings = SettingsManager.create(cwd, getAgentDir())
  // On this instance only: the session reloads its settings, which would drop
  // a value set on the merged settings, and the setter writes to disk.
  const configured = settings.getShellCommandPrefix.bind(settings)
  settings.getShellCommandPrefix = () => [AGENT_SHELL_PREFIX, configured()].filter(Boolean).join('\n')
  return settings
}
