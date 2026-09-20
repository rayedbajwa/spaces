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
      `- **Postgres for tests**: \`${env.testDatabaseUrl}\` — already running and yours to use. It is written into the checkout's \`.env\` as \`DATABASE_URL\` when the project declares that variable; check it before you migrate. The \`DATABASE_URL\` in your shell is the application's own and must never be migrated, seeded or tested against.`,
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

/**
 * Put the assigned environment into the checkout before an agent touches it.
 *
 * Agents inherit the environment of the process running them, whose
 * `DATABASE_URL` is the application's own database. A verify run discovered
 * this the hard way: its migration went to the live database until the agent
 * noticed and overrode the variable by hand. The fix is not to ask agents to
 * remember — it is to write the assigned values into the checkout's own
 * environment file, so the project's ordinary tooling picks them up.
 *
 * Only variables the project already declares in its example file are set, so
 * nothing invents configuration a project does not use. An existing `.env` is
 * respected except for values that are empty or point at the application's own
 * database.
 */
export async function prepareCheckoutEnvironment(cwd: string, env: AgentEnvironment): Promise<string[]> {
  const { readFile, writeFile } = await import('node:fs/promises')
  const { join } = await import('node:path')

  const example = await Promise.all(['.env.example', '.env.sample', '.env.template'].map((name) =>
    readFile(join(cwd, name), 'utf8').then((text) => ({ name, text })).catch(() => undefined),
  )).then((found) => found.find(Boolean))
  if (!example) return []

  const envPath = join(cwd, '.env')
  const current = await readFile(envPath, 'utf8').catch(() => undefined)
  const declared = new Set(
    example.text.split('\n')
      .map((line) => /^\s*#?\s*([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
      .filter((name): name is string => Boolean(name)),
  )

  const assignments: Record<string, string> = {}
  if (env.testDatabaseUrl && declared.has('DATABASE_URL')) assignments.DATABASE_URL = env.testDatabaseUrl
  if (declared.has('PORT')) assignments.PORT = String(env.testPort)
  // A stable key means anything sealed with it stays readable across stages and runs.
  if (declared.has('ENCRYPTION_KEY')) assignments.ENCRYPTION_KEY = 'aidlc-agent-checkout-key-not-a-production-secret'
  if (Object.keys(assignments).length === 0) return []

  const lines = (current ?? example.text).split('\n')
  const applied: string[] = []
  for (const [name, value] of Object.entries(assignments)) {
    const index = lines.findIndex((line) => new RegExp(`^\\s*#?\\s*${name}=`).test(line))
    const existing = index >= 0 ? /=(.*)$/.exec(lines[index]!)?.[1]?.trim() ?? '' : ''
    const isCommented = index >= 0 && /^\s*#/.test(lines[index]!)
    // Keep a value the project already has, unless it is empty or points at the
    // database this application itself runs on.
    const pointsAtLiveDatabase = name === 'DATABASE_URL' && existing !== '' && existing === process.env.DATABASE_URL?.trim()
    // Values in an example file are placeholders, so a fresh .env takes the assigned
    // ones; a file the project already had keeps what it says, unless it is empty or
    // points at the application's own database.
    const keepExisting = current !== undefined && index >= 0 && existing !== '' && !isCommented && !pointsAtLiveDatabase
    if (keepExisting) continue
    const assignment = `${name}=${value}`
    if (index >= 0) lines[index] = assignment
    else lines.push(assignment)
    applied.push(name)
  }
  if (applied.length === 0) return []
  await writeFile(envPath, `${lines.join('\n').replace(/\n+$/, '')}\n`)
  envLog.info('checkout environment prepared', { cwd, applied })
  return applied
}

/**
 * Rules for a stage whose output is evidence someone else will act on.
 *
 * A verification report is only worth the evidence behind it, and a review of
 * one found the recurring ways that evidence goes soft: results produced
 * against the wrong database, probes written to a temporary file and deleted,
 * identifiers in a table that map to nothing, tasks ticked off when only part
 * of them ran, and a delivery record left describing an earlier cycle.
 */
export function evidenceRules(env: AgentEnvironment): string {
  return [
    '## Evidence rules',
    '',
    `- Run everything against the environment above. The \`DATABASE_URL\` in your shell belongs to the application running you${env.testDatabaseUrl ? ` — the database for this checkout is \`${env.testDatabaseUrl}\`` : ''}. Never migrate, seed or test against the application's own database, and say which database produced a result when you report it.`,
    '- Evidence has to be reproducible by someone else. A probe or script you relied on is committed with the work; if you will not commit it, mark what it showed as unverified rather than passing.',
    '- Every identifier in a results table maps to a real test name somewhere in the report. Remove legend entries you did not use.',
    '- Tick a task off only when all of it is done. If part of it ran, leave it unticked and say which part.',
    '- Keep test data separate per run and clean up what you create. Leaving rows behind makes the next run\'s results untrustworthy.',
    '- Refresh the delivery record in the same cycle so it describes this run, not an earlier one.',
  ].join('\n')
}
