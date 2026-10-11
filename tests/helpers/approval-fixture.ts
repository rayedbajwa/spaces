import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { closeDb, getDb } from '../../src/lib/db'
import { createOrganization } from '../../src/lib/orgs'
import { createProject } from '../../src/lib/project-registry'
import { createSession, createUser, SESSION_COOKIE } from '../../src/lib/auth'
import { replaceAssignments } from '../../src/lib/project-responsibilities'
import { createRun, openGate } from '../../src/lib/run-store'
import type { FlowOptions } from '../../src/lib/aidlc'
import type { PipelineTemplate } from '../../src/lib/pipeline-template'

const ROOT = path.resolve(import.meta.dir, '..', '..')

export interface ApprovalProject {
  projectId: string
  slug: string
  code: string | null
}

export interface ApprovalFixture {
  baseUrl: string
  orgA: string
  orgB: string
  teamA: string
  teamB: string
  users: {
    ownerA: string
    productOwnerA: string
    secondProductOwnerA: string
    memberA: string
    outsiderA: string
    otherOrgOwner: string
  }
  projectA: ApprovalProject
  projectTeamB: ApprovalProject
  runA: string
  gateA: string
  cookieFor: (userId: string, activeTeamId?: string) => Promise<string>
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

async function startServer(portOverride?: number): Promise<{ baseUrl: string; stop: () => Promise<void> }> {
  const provided = process.env.APPROVAL_BASE_URL
  if (provided) {
    if (!(await waitForServer(provided))) throw new Error(`No approval server responding at ${provided}`)
    return { baseUrl: provided, stop: async () => {} }
  }
  const port = portOverride ?? Number(process.env.APPROVAL_PORT ?? '3124')
  const baseUrl = `http://127.0.0.1:${port}`
  const env: Record<string, string> = { ...(process.env as Record<string, string>) }
  delete env.AUTH_DISABLED
  env.PORT = String(port)
  env.ANTHROPIC_API_KEY = 'approval-test-dummy-key'
  const proc = Bun.spawn(['bun', 'run', 'src/server.ts'], { cwd: ROOT, env, stdout: 'pipe', stderr: 'pipe' })
  if (!(await waitForServer(baseUrl))) {
    proc.kill()
    throw new Error(`Approval server failed to start on ${baseUrl}`)
  }
  return { baseUrl, stop: async () => { proc.kill(); await proc.exited.catch(() => undefined) } }
}

/**
 * A tenant fixture for owner approval links: org A with team A (owner, two
 * product-owner assignees, a plain member), team B in the same org, and an org B
 * owner for isolation. It seeds one paused review gate on project A.
 */
export async function createApprovalFixture(options: { port?: number; withServer?: boolean } = {}): Promise<ApprovalFixture> {
  const server = options.withServer === false ? { baseUrl: '', stop: async () => {} } : await startServer(options.port)
  const sql = getDb()
  const suffix = randomUUID().slice(0, 8)
  const password = `approval-test-${suffix}`

  const ownerA = await createUser({ email: `approval-owner-${suffix}@example.test`, name: 'Approval Owner', password })
  const productOwnerA = await createUser({ email: `approval-po-${suffix}@example.test`, name: 'Product Owner A', password })
  const secondProductOwnerA = await createUser({ email: `approval-po2-${suffix}@example.test`, name: 'Product Owner B', password })
  const memberA = await createUser({ email: `approval-member-${suffix}@example.test`, name: 'Plain Member', password })
  const outsiderA = await createUser({ email: `approval-outsider-${suffix}@example.test`, name: 'Team B Member', password })
  const otherOrgOwner = await createUser({ email: `approval-other-${suffix}@example.test`, name: 'Other Org Owner', password })

  const orgA = (await createOrganization({ name: `Approval A ${suffix}`, createdBy: ownerA.userId })).orgId
  const orgB = (await createOrganization({ name: `Approval B ${suffix}`, createdBy: otherOrgOwner.userId })).orgId
  const teamA = randomUUID()
  const teamB = randomUUID()
  await sql`INSERT INTO teams (team_id, org_id, name, slug, created_by) VALUES
    (${teamA}, ${orgA}, ${`Approval A ${suffix}`}, ${`approval-a-${suffix}`}, ${ownerA.userId}),
    (${teamB}, ${orgB}, ${`Approval B ${suffix}`}, ${`approval-b-${suffix}`}, ${otherOrgOwner.userId})`
  await sql`INSERT INTO team_members (team_id, user_id, role) VALUES
    (${teamA}, ${ownerA.userId}, 'owner'),
    (${teamA}, ${productOwnerA.userId}, 'member'),
    (${teamA}, ${secondProductOwnerA.userId}, 'member'),
    (${teamA}, ${memberA.userId}, 'member'),
    (${teamA}, ${outsiderA.userId}, 'member'),
    (${teamB}, ${otherOrgOwner.userId}, 'owner')`

  const projectARow = await createProject({ name: `Approval Project ${suffix}`, slug: `approval-project-${suffix}`, teamId: teamA, createdBy: ownerA.userId })
  const projectBRow = await createProject({ name: `Approval Project B ${suffix}`, slug: `approval-project-b-${suffix}`, teamId: teamB, createdBy: otherOrgOwner.userId })
  const projectA: ApprovalProject = { projectId: projectARow.projectId, slug: projectARow.slug, code: projectARow.code ?? null }
  const projectTeamB: ApprovalProject = { projectId: projectBRow.projectId, slug: projectBRow.slug, code: projectBRow.code ?? null }

  // Assign the review-mapped responsibility (product-owner) to two people, and
  // leave project B with only its Owner (Owner fallback for review).
  const [po] = await sql<Array<{ responsibilityId: string }>>`
    SELECT responsibility_id AS "responsibilityId" FROM project_responsibilities
     WHERE project_id = ${projectA.projectId} AND standard_key = 'product-owner'
  `
  if (po) await replaceAssignments(projectA.projectId, po.responsibilityId, [productOwnerA.userId, secondProductOwnerA.userId], ownerA.userId)

  const run = await createRun({
    projectNamespace: projectARow.slug, projectLabel: projectARow.name, projectPath: '/tmp/approval-test',
    pipelineName: 'test', options: {} as FlowOptions, template: { stages: [] } as unknown as PipelineTemplate,
    projectId: projectA.projectId,
  })
  const gateId = await openGate({ runId: run.runId, stepIndex: 0, kind: 'review', prompt: 'review' })
  await sql`UPDATE pipeline_runs SET status = 'paused', pause_kind = 'review', current_stage = 'review' WHERE run_id = ${run.runId}`

  const tokenCache = new Map<string, string>()
  const sessionTokenFor = async (userId: string, activeTeamId?: string): Promise<string> => {
    const key = `${userId}:${activeTeamId ?? ''}`
    const cached = tokenCache.get(key)
    if (cached) return cached
    const { token } = await createSession(userId, new Request('http://127.0.0.1/api/me'), activeTeamId)
    tokenCache.set(key, token)
    return token
  }
  const cookieFor = async (userId: string, activeTeamId?: string): Promise<string> =>
    `${SESSION_COOKIE}=${encodeURIComponent(await sessionTokenFor(userId, activeTeamId))}`

  const userIds = [ownerA.userId, productOwnerA.userId, secondProductOwnerA.userId, memberA.userId, outsiderA.userId, otherOrgOwner.userId]
  const stop = async () => {
    await server.stop()
    try {
      await sql`DELETE FROM projects WHERE project_id IN (${projectA.projectId}, ${projectTeamB.projectId})`
      await sql`DELETE FROM teams WHERE team_id IN (${teamA}, ${teamB})`
      await sql`DELETE FROM organizations WHERE org_id IN (${orgA}, ${orgB})`
      await sql`DELETE FROM auth_sessions WHERE user_id IN ${sql(userIds)}`
      await sql`DELETE FROM users WHERE user_id IN ${sql(userIds)}`
    } catch {
      // best-effort teardown
    } finally {
      await closeDb()
    }
  }

  return {
    baseUrl: server.baseUrl, orgA, orgB, teamA, teamB,
    users: { ownerA: ownerA.userId, productOwnerA: productOwnerA.userId, secondProductOwnerA: secondProductOwnerA.userId, memberA: memberA.userId, outsiderA: outsiderA.userId, otherOrgOwner: otherOrgOwner.userId },
    projectA, projectTeamB, runA: run.runId, gateA: gateId,
    cookieFor, sessionTokenFor, stop,
  }
}
