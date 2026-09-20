import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { closeDb, getDb } from '../src/lib/db'
import { createProject } from '../src/lib/project-registry'
import {
  ResponsibilityError,
  listResponsibilities,
  migrateProjectResponsibilities,
  replaceAssignments,
} from '../src/lib/project-responsibilities'

async function databaseReachable(): Promise<boolean> {
  try {
    await getDb()`SELECT 1 FROM project_responsibilities LIMIT 1`
    return true
  } catch {
    return false
  }
}

const live = await databaseReachable()
const suite = live ? describe : describe.skip

if (!live) test.skip('project responsibility integration tests skipped: DATABASE_URL is not reachable', () => {})

suite('project responsibilities persistence', () => {
  const sql = getDb()
  const suffix = randomUUID().slice(0, 8)
  const orgId = randomUUID()
  const teamId = randomUUID()
  const ownerId = randomUUID()
  const memberId = randomUUID()
  let projectId = ''

  beforeAll(async () => {
    await sql`INSERT INTO organizations (org_id, name, slug) VALUES (${orgId}, ${`Responsibility test ${suffix}`}, ${`responsibility-test-${suffix}`})`
    await sql`INSERT INTO users (user_id, email, name) VALUES (${ownerId}, ${`owner-${suffix}@example.test`}, 'Owner'), (${memberId}, ${`member-${suffix}@example.test`}, 'Member')`
    await sql`INSERT INTO teams (team_id, org_id, name, slug, created_by) VALUES (${teamId}, ${orgId}, ${`Responsibility team ${suffix}`}, ${`responsibility-team-${suffix}`}, ${ownerId})`
    await sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}, ${ownerId}, 'owner'), (${teamId}, ${memberId}, 'member')`
    const project = await createProject({
      name: `Responsibility project ${suffix}`,
      slug: `responsibility-project-${suffix}`,
      teamId,
      createdBy: ownerId,
    })
    projectId = project.projectId
  })

  afterAll(async () => {
    if (projectId) await sql`DELETE FROM projects WHERE project_id = ${projectId}`
    await sql`DELETE FROM teams WHERE team_id = ${teamId}`
    await sql`DELETE FROM organizations WHERE org_id = ${orgId}`
    await sql`DELETE FROM users WHERE user_id IN (${ownerId}, ${memberId})`
    await closeDb()
  })

  test('seeds six standard responsibilities and assigns the eligible creator as Owner', async () => {
    const responsibilities = await listResponsibilities(projectId)
    expect(responsibilities.map((item) => item.standardKey)).toEqual([
      'owner', 'product-owner', 'lead-engineer', 'designer', 'qa', 'release-manager',
    ])
    const owner = responsibilities[0]!
    expect(owner.resolution.status).toBe('explicit')
    expect(owner.resolution.assignees).toEqual([
      { userId: ownerId, name: 'Owner', email: `owner-${suffix}@example.test`, primary: true },
    ])
  })

  test('preserves assignment order, resolves Owner fallback, and rejects final Owner removal', async () => {
    const initial = await listResponsibilities(projectId)
    const productOwner = initial.find((item) => item.standardKey === 'product-owner')!
    const owner = initial.find((item) => item.standardKey === 'owner')!

    const updated = await replaceAssignments(projectId, productOwner.responsibilityId, [memberId, ownerId], ownerId)
    expect(updated.resolution.status).toBe('explicit')
    expect(updated.resolution.assignees.map((item) => [item.userId, item.primary])).toEqual([[memberId, true], [ownerId, false]])

    await replaceAssignments(projectId, productOwner.responsibilityId, [], ownerId)
    const fallback = (await listResponsibilities(projectId)).find((item) => item.standardKey === 'product-owner')!
    expect(fallback.resolution.status).toBe('owner-fallback')
    expect(fallback.resolution.assignees[0]?.userId).toBe(ownerId)

    await expect(replaceAssignments(projectId, owner.responsibilityId, [], ownerId)).rejects.toMatchObject({
      code: 'conflict',
    } satisfies Partial<ResponsibilityError>)
    expect((await listResponsibilities(projectId)).find((item) => item.standardKey === 'owner')!.resolution.assignees[0]?.userId).toBe(ownerId)
  })

  test('repairs idempotently without emitting audit events for unchanged state', async () => {
    const [{ n: before }] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM responsibility_audit WHERE project_id = ${projectId}`
    const first = await migrateProjectResponsibilities(projectId, ownerId)
    const [{ n: afterFirst }] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM responsibility_audit WHERE project_id = ${projectId}`
    const second = await migrateProjectResponsibilities(projectId, ownerId)
    const [{ n: afterSecond }] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM responsibility_audit WHERE project_id = ${projectId}`

    expect(first.repairNeeded).toBe(false)
    expect(second.repairNeeded).toBe(false)
    expect(first.responsibilities).toHaveLength(6)
    expect(afterFirst).toBe(before)
    expect(afterSecond).toBe(afterFirst)
  })
})
