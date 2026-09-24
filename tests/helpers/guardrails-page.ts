import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { closeDb, getDb } from '../../src/lib/db'
import { createOrganization } from '../../src/lib/orgs'
import { createSession, createUser, SESSION_COOKIE } from '../../src/lib/auth'

const ROOT = path.resolve(import.meta.dir, '..', '..')

export interface GuardrailsPageFixture {
  baseUrl: string
  orgId: string
  teamId: string
  users: { owner: string; member: string }
  /** A `Cookie:` header value for the given user with the given active team. */
  cookieFor: (userId: string, activeTeamId?: string) => Promise<string>
  /** The raw session token for the given user (for browser cookie setup). */
  sessionTokenFor: (userId: string, activeTeamId?: string) => Promise<string>
  stop: () => Promise<void>
}

async function waitForServer(baseUrl: string, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/auth/status`, { signal: AbortSignal.timeout(2_000) })
      if (res.ok) return true
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  return false
}

/**
 * Build the SPA from source before its server starts, so the browser test never
 * asserts against a stale `public/` bundle (research R6). Skipped when an
 * already-running server is supplied — CI builds earlier in the job.
 */
async function buildFrontend(): Promise<void> {
  const proc = Bun.spawn(['bun', 'run', 'build:web'], {
    cwd: ROOT,
    env: { ...(process.env as Record<string, string>), NODE_ENV: 'development' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const code = await proc.exited
  if (code !== 0) {
    const err = await new Response(proc.stderr).text().catch(() => '')
    throw new Error(`build:web failed (exit ${code}): ${err.slice(-2000)}`)
  }
}

/**
 * Start the web server for the guardrails browser test, or reuse one the runner
 * already started via `SPACES_E2E_BASE_URL` (falling back to the CI
 * `RESPONSIBILITY_BASE_URL`) so the same server is not spawned twice.
 */
async function startServer(portOverride?: number): Promise<{ baseUrl: string; stop: () => Promise<void> }> {
  const provided = process.env.SPACES_E2E_BASE_URL ?? process.env.RESPONSIBILITY_BASE_URL
  if (provided) {
    if (!(await waitForServer(provided))) throw new Error(`No guardrails server responding at ${provided}`)
    return { baseUrl: provided, stop: async () => {} }
  }

  await buildFrontend()

  const port = portOverride ?? Number(process.env.SPACES_E2E_PORT ?? '3125')
  const baseUrl = `http://127.0.0.1:${port}`
  const env: Record<string, string> = { ...(process.env as Record<string, string>) }
  delete env.AUTH_DISABLED
  env.PORT = String(port)
  env.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY || 'guardrails-test-dummy-key'
  const proc = Bun.spawn(['bun', 'run', 'src/server.ts'], {
    cwd: ROOT,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (!(await waitForServer(baseUrl))) {
    proc.kill()
    throw new Error(`Guardrails server failed to start on ${baseUrl}`)
  }
  return {
    baseUrl,
    stop: async () => {
      proc.kill()
      await proc.exited.catch(() => undefined)
    },
  }
}

/**
 * Provision one organization, one team, an owner and a member, with sessions
 * that pin the active team so `/api/org/guardrails` resolves to this org.
 */
export async function createGuardrailsPageFixture(options: { port?: number } = {}): Promise<GuardrailsPageFixture> {
  const { baseUrl, stop } = await startServer(options.port)
  const sql = getDb()
  const suffix = randomUUID().slice(0, 8)
  const password = `test-password-${suffix}`

  const owner = await createUser({ email: `guard-owner-${suffix}@example.test`, name: 'Guard Owner', password })
  const member = await createUser({ email: `guard-member-${suffix}@example.test`, name: 'Guard Member', password })

  const orgId = (await createOrganization({ name: `Guardrails ${suffix}`, createdBy: owner.userId })).orgId
  const teamId = randomUUID()
  await sql`INSERT INTO teams (team_id, org_id, name, slug, created_by) VALUES (${teamId}, ${orgId}, ${`Guardrails team ${suffix}`}, ${`guardrails-team-${suffix}`}, ${owner.userId})`
  await sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}, ${owner.userId}, 'owner'), (${teamId}, ${member.userId}, 'member')`

  const tokenCache = new Map<string, string>()
  const sessionTokenFor = async (userId: string, activeTeamId?: string): Promise<string> => {
    const key = `${userId}:${activeTeamId ?? ''}`
    const cached = tokenCache.get(key)
    if (cached) return cached
    const { token } = await createSession(userId, new Request('http://127.0.0.1/api/me'), activeTeamId)
    tokenCache.set(key, token)
    return token
  }
  const cookieFor = async (userId: string, activeTeamId?: string): Promise<string> => {
    return `${SESSION_COOKIE}=${encodeURIComponent(await sessionTokenFor(userId, activeTeamId))}`
  }

  const userIds = [owner.userId, member.userId]

  const stopAll = async () => {
    await stop()
    try {
      await sql`DELETE FROM team_members WHERE team_id = ${teamId}`
      await sql`DELETE FROM teams WHERE team_id = ${teamId}`
      await sql`DELETE FROM organizations WHERE org_id = ${orgId}`
      await sql`DELETE FROM auth_sessions WHERE user_id IN ${sql(userIds)}`
      await sql`DELETE FROM users WHERE user_id IN ${sql(userIds)}`
    } catch {
      // best-effort teardown
    } finally {
      await closeDb()
    }
  }

  return {
    baseUrl,
    orgId,
    teamId,
    users: { owner: owner.userId, member: member.userId },
    cookieFor,
    sessionTokenFor,
    stop: stopAll,
  }
}
