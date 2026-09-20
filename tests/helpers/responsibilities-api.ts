import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { closeDb, getDb } from '../../src/lib/db'
import { createOrganization } from '../../src/lib/orgs'
import { createProject } from '../../src/lib/project-registry'
import { createSession, createUser, SESSION_COOKIE } from '../../src/lib/auth'

const ROOT = path.resolve(import.meta.dir, '..', '..')

export interface ProjectFixture {
  projectId: string
  slug: string
  code: string | null
}

export interface ResponsibilityApiFixture {
  baseUrl: string
  orgA: string
  orgB: string
  teamA: string
  teamB: string
  teamOtherOrg: string
  users: {
    ownerA: string
    adminA: string
    memberA: string
    viewerA: string
    teamBMember: string
    outsider: string
    otherOrgOwner: string
  }
  projectA: ProjectFixture
  projectLegacy: ProjectFixture
  projectLegacy2: ProjectFixture
  projectTeamless: ProjectFixture
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
 * Start the web server for responsibility HTTP tests, or reuse one the runner
 * already started via `RESPONSIBILITY_BASE_URL` (CI does this so the same
 * server is not spawned from inside the test process).
 */
async function startServer(portOverride?: number): Promise<{ baseUrl: string; stop: () => Promise<void> }> {
  const provided = process.env.RESPONSIBILITY_BASE_URL
  if (provided) {
    if (!(await waitForServer(provided))) throw new Error(`No responsibility server responding at ${provided}`)
    return { baseUrl: provided, stop: async () => {} }
  }

  const port = portOverride ?? Number(process.env.RESPONSIBILITY_PORT ?? '3100')
  const baseUrl = `http://127.0.0.1:${port}`
  const env: Record<string, string> = { ...(process.env as Record<string, string>) }
  delete env.AUTH_DISABLED
  env.PORT = String(port)
  env.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY || 'responsibility-test-dummy-key'
  const proc = Bun.spawn(['bun', 'run', 'src/server.ts'], {
    cwd: ROOT,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (!(await waitForServer(baseUrl))) {
    proc.kill()
    throw new Error(`Responsibility server failed to start on ${baseUrl}`)
  }
  return {
    baseUrl,
    stop: async () => {
      proc.kill()
      await proc.exited.catch(() => undefined)
    },
  }
}

async function insertProjectDirect(name: string, slug: string, teamId: string | null): Promise<string> {
  const sql = getDb()
  const projectId = randomUUID()
  await sql`INSERT INTO projects (project_id, name, slug, team_id) VALUES (${projectId}, ${name}, ${slug}, ${teamId})`
  return projectId
}

/**
 * Build a tenant fixture that exercises every responsibility role boundary:
 * org A with team A (all four roles) and team B (a same-org non-member of A),
 * org B with a separate tenant owner, and a legacy project with no owning team.
 */
export async function createResponsibilityApiFixture(options: { port?: number } = {}): Promise<ResponsibilityApiFixture> {
  const { baseUrl, stop } = await startServer(options.port)
  const sql = getDb()
  const suffix = randomUUID().slice(0, 8)
  const password = `test-password-${suffix}`

  const ownerA = await createUser({ email: `owner-a-${suffix}@example.test`, name: 'Owner A', password })
  const adminA = await createUser({ email: `admin-a-${suffix}@example.test`, name: 'Admin A', password })
  const memberA = await createUser({ email: `member-a-${suffix}@example.test`, name: 'Member A', password })
  const viewerA = await createUser({ email: `viewer-a-${suffix}@example.test`, name: 'Viewer A', password })
  const teamBMember = await createUser({ email: `team-b-${suffix}@example.test`, name: 'Team B Member', password })
  const outsider = await createUser({ email: `outsider-${suffix}@example.test`, name: 'Outsider', password })
  const otherOrgOwner = await createUser({ email: `other-org-${suffix}@example.test`, name: 'Other Org Owner', password })

  const orgA = (await createOrganization({ name: `Responsibilities A ${suffix}`, createdBy: ownerA.userId })).orgId
  const orgB = (await createOrganization({ name: `Responsibilities B ${suffix}`, createdBy: otherOrgOwner.userId })).orgId

  const teamA = randomUUID()
  const teamB = randomUUID()
  const teamOtherOrg = randomUUID()
  await sql`INSERT INTO teams (team_id, org_id, name, slug, created_by) VALUES
    (${teamA}, ${orgA}, ${`Team A ${suffix}`}, ${`team-a-${suffix}`}, ${ownerA.userId}),
    (${teamB}, ${orgA}, ${`Team B ${suffix}`}, ${`team-b-${suffix}`}, ${teamBMember.userId}),
    (${teamOtherOrg}, ${orgB}, ${`Team Other ${suffix}`}, ${`team-other-${suffix}`}, ${otherOrgOwner.userId})`
  await sql`INSERT INTO team_members (team_id, user_id, role) VALUES
    (${teamA}, ${ownerA.userId}, 'owner'),
    (${teamA}, ${adminA.userId}, 'admin'),
    (${teamA}, ${memberA.userId}, 'member'),
    (${teamA}, ${viewerA.userId}, 'viewer'),
    (${teamB}, ${teamBMember.userId}, 'owner'),
    (${teamOtherOrg}, ${otherOrgOwner.userId}, 'owner')`

  const created = await createProject({ name: `Responsibility API ${suffix}`, slug: `responsibility-api-${suffix}`, teamId: teamA, createdBy: ownerA.userId })
  const projectLegacyId = await insertProjectDirect(`Legacy project ${suffix}`, `legacy-project-${suffix}`, teamA)
  const projectLegacy2Id = await insertProjectDirect(`Legacy project 2 ${suffix}`, `legacy-project-2-${suffix}`, teamA)
  const projectTeamlessId = await insertProjectDirect(`Teamless project ${suffix}`, `teamless-project-${suffix}`, null)

  const cookieCache = new Map<string, string>()
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
    const key = `${userId}:${activeTeamId ?? ''}`
    const cached = cookieCache.get(key)
    if (cached) return cached
    const header = `${SESSION_COOKIE}=${encodeURIComponent(await sessionTokenFor(userId, activeTeamId))}`
    cookieCache.set(key, header)
    return header
  }

  const userIds = [ownerA.userId, adminA.userId, memberA.userId, viewerA.userId, teamBMember.userId, outsider.userId, otherOrgOwner.userId]

  const stopAll = async () => {
    await stop()
    await cleanupFixture({ teams: [teamA, teamB, teamOtherOrg], orgs: [orgA, orgB], projectTeamlessId, projectLegacyIds: [projectLegacyId, projectLegacy2Id], userIds })
  }

  return {
    baseUrl,
    orgA,
    orgB,
    teamA,
    teamB,
    teamOtherOrg,
    users: {
      ownerA: ownerA.userId,
      adminA: adminA.userId,
      memberA: memberA.userId,
      viewerA: viewerA.userId,
      teamBMember: teamBMember.userId,
      outsider: outsider.userId,
      otherOrgOwner: otherOrgOwner.userId,
    },
    projectA: { projectId: created.projectId, slug: created.slug, code: created.code ?? null },
    projectLegacy: { projectId: projectLegacyId, slug: `legacy-project-${suffix}`, code: null },
    projectLegacy2: { projectId: projectLegacy2Id, slug: `legacy-project-2-${suffix}`, code: null },
    projectTeamless: { projectId: projectTeamlessId, slug: `teamless-project-${suffix}`, code: null },
    cookieFor,
    sessionTokenFor,
    stop: stopAll,
  }
}

async function cleanupFixture(input: {
  teams: string[]
  orgs: string[]
  projectTeamlessId: string
  projectLegacyIds: string[]
  userIds: string[]
}): Promise<void> {
  const sql = getDb()
  try {
    const projectIds = [input.projectTeamlessId, ...input.projectLegacyIds]
    await sql`DELETE FROM projects WHERE team_id IN ${sql(input.teams)} OR project_id IN ${sql(projectIds)}`
    await sql`DELETE FROM team_members WHERE team_id IN ${sql(input.teams)}`
    await sql`DELETE FROM teams WHERE team_id IN ${sql(input.teams)}`
    await sql`DELETE FROM organizations WHERE org_id IN ${sql(input.orgs)}`
    await sql`DELETE FROM auth_sessions WHERE user_id IN ${sql(input.userIds)}`
    await sql`DELETE FROM users WHERE user_id IN ${sql(input.userIds)}`
  } catch {
    // best-effort teardown
  } finally {
    await closeDb()
  }
}
