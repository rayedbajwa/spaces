/**
 * What the machine an agent works on can actually do.
 *
 * Agents prepare a checkout, build it and run its tests. When they cannot tell
 * what the environment offers they guess, and the guesses are pessimistic: a
 * container with no Docker daemon makes them skip every test that wants a
 * database, and a port already taken by Spaces itself makes them skip the
 * smoke suite. Both were reported as "PARTIAL" when the work was in fact
 * verifiable.
 *
 * This module probes the environment once and states the result plainly for
 * the agent: whether Docker is usable, whether psql is present, where Chromium
 * lives, which port is free for an application under test, and — most
 * usefully — a ready-made Postgres database the checkout's tests can point at
 * instead of starting their own.
 */

import { execFile } from 'node:child_process'
import { createServer } from 'node:net'
import { promisify } from 'node:util'
import { resolveBrowserExecutable } from './browser-tools'
import { getDb } from './db'
import { log } from './logger'

const run = promisify(execFile)
const envLog = log.child({ mod: 'agent-environment' })

export interface AgentEnvironment {
  /** `docker` is installed and a daemon answers. */
  docker: boolean
  /** `docker compose` is available (only useful when `docker` is true). */
  dockerCompose: boolean
  /** Why Docker cannot be used, when it cannot. */
  dockerDetail?: string
  /** `psql` is installed. */
  psql: boolean
  /** The Chromium the agent's browser tools will launch, when one is installed. */
  browser?: string
  /** A Postgres database the checkout's tests may use, created on demand. */
  testDatabaseUrl?: string
  /** A port nothing is listening on, for an application under test. */
  testPort: number
}

let cached: { at: number; value: AgentEnvironment } | undefined
const CACHE_MS = 60_000

async function commandWorks(command: string, args: string[]): Promise<boolean> {
  return await run(command, args, { timeout: 10_000 }).then(() => true).catch(() => false)
}

async function portIsFree(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}

/** The first free port at or after `from`, so an app under test never fights the one serving Spaces. */
async function freePort(from = 3100, attempts = 40): Promise<number> {
  for (let port = from; port < from + attempts; port += 1) {
    if (await portIsFree(port)) return port
  }
  return from
}

/**
 * A database for a checkout's tests, on the same server Spaces uses.
 *
 * Created once per label and reused; tests are free to drop and recreate their
 * own schema inside it. Returns undefined when the connection has no rights to
 * create databases, in which case the agent is told so rather than left to
 * discover it.
 */
export async function provisionTestDatabase(label: string): Promise<string | undefined> {
  // A deployment can point agents at a separate server with AGENT_DATABASE_URL,
  // which is the right thing when the main one holds data agents should not
  // reach. Otherwise the database is created beside Spaces' own, on the
  // connection the agent's shell can already read from its environment.
  const source = process.env.AGENT_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim()
  if (!source) return undefined
  let url: URL
  try { url = new URL(source) } catch { return undefined }

  const name = `agent_${label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'tests'}`
  try {
    const sql = getDb()
    const [exists] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pg_database WHERE datname = ${name}`
    // The name is derived from a sanitized label (letters, digits and underscores only).
    // template0 avoids the collation-version mismatch template1 can carry after an upgrade.
    if (!exists?.n) await sql.unsafe(`CREATE DATABASE "${name}" TEMPLATE template0`)
    const testUrl = new URL(url.toString())
    testUrl.pathname = `/${name}`
    return testUrl.toString()
  } catch (error) {
    envLog.info('no test database for agents on this deployment', { error: error instanceof Error ? error.message : String(error) })
    return undefined
  }
}

/** Probe the environment (cached for a minute — the answers do not change often). */
export async function describeAgentEnvironment(options: { label?: string } = {}): Promise<AgentEnvironment> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value

  const dockerInstalled = await commandWorks('docker', ['--version'])
  const dockerUsable = dockerInstalled && (await commandWorks('docker', ['info', '--format', '{{.ServerVersion}}']))
  const value: AgentEnvironment = {
    docker: dockerUsable,
    dockerCompose: dockerInstalled && (await commandWorks('docker', ['compose', 'version'])),
    dockerDetail: dockerUsable
      ? undefined
      : dockerInstalled
        ? 'the docker command is installed but no daemon answers (set DOCKER_HOST, or mount /var/run/docker.sock, to use one)'
        : 'docker is not installed here',
    psql: await commandWorks('psql', ['--version']),
    browser: resolveBrowserExecutable() ?? (process.env.PLAYWRIGHT_BROWSERS_PATH?.trim() || undefined),
    testDatabaseUrl: await provisionTestDatabase(options.label ?? 'tests'),
    testPort: await freePort(),
  }
  cached = { at: Date.now(), value }
  envLog.info('agent environment probed', { docker: value.docker, compose: value.dockerCompose, psql: value.psql, browser: Boolean(value.browser), testDatabase: Boolean(value.testDatabaseUrl), testPort: value.testPort })
  return value
}

/** Forget the probe (after installing something, or in tests). */
export function forgetAgentEnvironment(): void {
  cached = undefined
}

/** The environment written for an agent to read, as markdown. */
export function renderAgentEnvironment(env: AgentEnvironment): string {
  const lines: string[] = ['## This machine', '']

  lines.push(env.docker
    ? `- **Docker**: available${env.dockerCompose ? ' with `docker compose`' : ' (no compose plugin)'} — containers for tests may be started.`
    : `- **Docker**: not usable${env.dockerDetail ? ` — ${env.dockerDetail}` : ''}. Do not try \`docker compose up\`; use the database below instead, and record any test that genuinely needs containers as skipped with the reason.`)

  if (env.testDatabaseUrl) {
    lines.push(
      `- **Postgres for tests**: \`${env.testDatabaseUrl}\` — already running and yours to use. Put it in the checkout's \`.env\` as \`DATABASE_URL\` (and \`TEST_DATABASE_URL\` if the project uses one), then run the project's migration/schema step before the tests that need it. Never point tests at a production database.`,
      `- **psql**: ${env.psql ? 'installed' : 'not installed — connect from the project\'s own tooling instead'}.`,
    )
  } else {
    lines.push(`- **Postgres for tests**: none provided here${env.psql ? ' (psql is installed if the project brings its own server)' : ''}. Tests needing a database are expected to skip; say so rather than reporting failure.`)
  }

  lines.push(
    `- **Free port**: ${env.testPort} — start any server under test on it (\`PORT=${env.testPort}\`) and point smoke tests at \`http://127.0.0.1:${env.testPort}\`. Port 3000 is taken by the application serving this agent; never use it.`,
    env.browser
      ? `- **Headless browser**: Chromium is installed at \`${env.browser}\`, so Playwright runs headless without downloading anything. Browser tests are expected to run, and the browser_* tools use the same binary.`
      : '- **Headless browser**: none found. Install one with `npx playwright install chromium` if the project needs it; otherwise browser tests are expected to skip.',
  )
  return lines.join('\n')
}

/** One call: probe and render. Empty string if probing fails entirely. */
export async function agentEnvironmentSection(label?: string): Promise<string> {
  try {
    return renderAgentEnvironment(await describeAgentEnvironment({ label }))
  } catch (error) {
    envLog.warn('environment probe failed', { error: error instanceof Error ? error.message : String(error) })
    return ''
  }
}
