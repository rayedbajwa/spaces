import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { removeMember } from '../src/lib/auth'
import { closeDb, getDb } from '../src/lib/db'
import { createProject } from '../src/lib/project-registry'
import {
  deactivateAssignmentsForMember,
  ResponsibilityError,
  listResponsibilities,
  migrateProjectResponsibilities,
  replaceAssignments,
  resolveResponsibility,
} from '../src/lib/project-responsibilities'

async function databaseReachable(): Promise<boolean> {
  try {
    await getDb()`SELECT 1 FROM project_responsibilities LIMIT 1`
    return true
  } catch (error) {
    const message = String(error)
    // A reachable database that is missing the feature schema is a hard failure,
    // not a reason to skip — otherwise a broken migration looks green.
    if (/project_responsibilities/.test(message) && /does not exist/i.test(message)) {
      throw new Error('project_responsibilities is missing; run `bun run db:migrate` before this suite.')
    }
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

// ---------------------------------------------------------------------------
// Domain safety: seeding, repair, resolution precedence, Owner protection,
// member deactivation, team reassignment and concurrency.
// ---------------------------------------------------------------------------
suite('project responsibilities domain safety', () => {
  let sql = getDb()
  const suffix = randomUUID().slice(0, 8)
  const orgId = randomUUID()
  const teamA = randomUUID()
  const teamB = randomUUID()
  const teamLifecycle = randomUUID()
  const teamConcurrent = randomUUID()
  const emptyTeam = randomUUID()
  const creatorOwner = randomUUID()
  const teammate = randomUUID()
  const outsider = randomUUID()
  const newMemberB = randomUUID()
  const lifecycleOwner = randomUUID()
  const lifecycleMember = randomUUID()
  const concurrentA = randomUUID()
  const concurrentB = randomUUID()

  let projectCreatorPreferred = ''
  let projectFallback = ''
  let projectLegacy = ''
  let projectNoMembers = ''
  let projectMove = ''
  let projectLifecycle = ''
  let projectConcurrent = ''

  async function insertRawProject(name: string, teamId: string | null): Promise<string> {
    const projectId = randomUUID()
    const slug = `${name}-${suffix}`.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    await sql`INSERT INTO projects (project_id, name, slug, team_id) VALUES (${projectId}, ${name}, ${slug}, ${teamId})`
    return projectId
  }

  beforeAll(async () => {
    // A fresh client: the previous suite's afterAll closed the shared pool.
    sql = getDb()
    await sql`INSERT INTO organizations (org_id, name, slug) VALUES (${orgId}, ${`Domain safety ${suffix}`}, ${`domain-safety-${suffix}`})`
    await sql`INSERT INTO users (user_id, email, name) VALUES
      (${creatorOwner}, ${`creator-${suffix}@example.test`}, 'Creator'),
      (${teammate}, ${`teammate-${suffix}@example.test`}, 'Teammate'),
      (${outsider}, ${`outsider-${suffix}@example.test`}, 'Outsider'),
      (${newMemberB}, ${`new-member-${suffix}@example.test`}, 'New Member'),
      (${lifecycleOwner}, ${`lifecycle-owner-${suffix}@example.test`}, 'Lifecycle Owner'),
      (${lifecycleMember}, ${`lifecycle-member-${suffix}@example.test`}, 'Lifecycle Member'),
      (${concurrentA}, ${`concurrent-a-${suffix}@example.test`}, 'Concurrent A'),
      (${concurrentB}, ${`concurrent-b-${suffix}@example.test`}, 'Concurrent B')`
    await sql`INSERT INTO teams (team_id, org_id, name, slug, created_by) VALUES
      (${teamA}, ${orgId}, ${`Team A ${suffix}`}, ${`team-a-${suffix}`}, ${creatorOwner}),
      (${teamB}, ${orgId}, ${`Team B ${suffix}`}, ${`team-b-${suffix}`}, ${newMemberB}),
      (${teamLifecycle}, ${orgId}, ${`Team L ${suffix}`}, ${`team-l-${suffix}`}, ${lifecycleOwner}),
      (${teamConcurrent}, ${orgId}, ${`Team C ${suffix}`}, ${`team-c-${suffix}`}, ${concurrentA}),
      (${emptyTeam}, ${orgId}, ${`Team E ${suffix}`}, ${`team-e-${suffix}`}, ${creatorOwner})`
    await sql`INSERT INTO team_members (team_id, user_id, role) VALUES
      (${teamA}, ${creatorOwner}, 'owner'),
      (${teamA}, ${teammate}, 'member'),
      (${teamB}, ${newMemberB}, 'owner'),
      (${teamLifecycle}, ${lifecycleOwner}, 'owner'),
      (${teamLifecycle}, ${lifecycleMember}, 'member'),
      (${teamConcurrent}, ${concurrentA}, 'owner'),
      (${teamConcurrent}, ${concurrentB}, 'member')`

    projectCreatorPreferred = (await createProject({ name: `Creator preferred ${suffix}`, slug: `creator-preferred-${suffix}`, teamId: teamA, createdBy: teammate })).projectId
    projectFallback = (await createProject({ name: `Fallback ${suffix}`, slug: `fallback-${suffix}`, teamId: teamA, createdBy: outsider })).projectId
    projectLegacy = await insertRawProject('Legacy', teamA)
    projectNoMembers = await insertRawProject('No members', emptyTeam)
    projectMove = await insertRawProject('Move', teamA)
    projectLifecycle = await insertRawProject('Lifecycle', teamLifecycle)
    projectConcurrent = await insertRawProject('Concurrent', teamConcurrent)
  })

  afterAll(async () => {
    await sql`DELETE FROM projects WHERE project_id = ANY(${[projectCreatorPreferred, projectFallback, projectLegacy, projectNoMembers, projectMove, projectLifecycle, projectConcurrent]}::uuid[])`
    await sql`DELETE FROM teams WHERE team_id = ANY(${[teamA, teamB, teamLifecycle, teamConcurrent, emptyTeam]}::uuid[])`
    await sql`DELETE FROM organizations WHERE org_id = ${orgId}`
    await sql`DELETE FROM users WHERE user_id = ANY(${[creatorOwner, teammate, outsider, newMemberB, lifecycleOwner, lifecycleMember, concurrentA, concurrentB]}::uuid[])`
    await closeDb()
  })

  test('prefers the eligible creator as Owner over other team members (FR-004)', async () => {
    const owner = (await listResponsibilities(projectCreatorPreferred)).find((item) => item.standardKey === 'owner')!
    expect(owner.resolution.status).toBe('explicit')
    expect(owner.resolution.assignees[0]?.userId).toBe(teammate)
  })

  test('chooses a deterministic eligible member when the creator is ineligible (FR-004)', async () => {
    const owner = (await listResponsibilities(projectFallback)).find((item) => item.standardKey === 'owner')!
    const expected = [creatorOwner, teammate].sort()[0]
    expect(owner.resolution.status).toBe('explicit')
    expect(owner.resolution.assignees[0]?.userId).toBe(expected)
    await migrateProjectResponsibilities(projectFallback, creatorOwner)
    const again = (await listResponsibilities(projectFallback)).find((item) => item.standardKey === 'owner')!
    expect(again.resolution.assignees[0]?.userId).toBe(expected)
  })

  test('repairs a legacy project with no responsibilities exactly once (FR-002, SC-002)', async () => {
    const first = await migrateProjectResponsibilities(projectLegacy, creatorOwner)
    expect(first.repairNeeded).toBe(false)
    expect(first.responsibilities.map((item) => item.standardKey)).toEqual([
      'owner', 'product-owner', 'lead-engineer', 'designer', 'qa', 'release-manager',
    ])
    const ids = first.responsibilities.map((item) => item.responsibilityId)
    const [{ n: auditAfterFirst }] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM responsibility_audit WHERE project_id = ${projectLegacy}`
    expect(auditAfterFirst).toBeGreaterThan(0)

    const second = await migrateProjectResponsibilities(projectLegacy, creatorOwner)
    expect(second.responsibilities.map((item) => item.responsibilityId)).toEqual(ids)
    const [{ n: auditAfterSecond }] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM responsibility_audit WHERE project_id = ${projectLegacy}`
    expect(auditAfterSecond).toBe(auditAfterFirst)
  })

  test('marks a legacy project with no eligible member as repair-needed without inventing an owner (FR-009)', async () => {
    const first = await migrateProjectResponsibilities(projectNoMembers, creatorOwner)
    expect(first.repairNeeded).toBe(true)
    expect(first.responsibilities).toHaveLength(6)
    const owner = first.responsibilities.find((item) => item.standardKey === 'owner')!
    expect(owner.resolution.status).toBe('unresolved')
    expect(owner.resolution.repairNeeded).toBe(true)
    expect(owner.resolution.assignees).toHaveLength(0)
    const [{ n }] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM responsibility_assignments a
        JOIN project_responsibilities r USING (responsibility_id)
       WHERE r.project_id = ${projectNoMembers}
    `
    expect(n).toBe(0)
    const second = await migrateProjectResponsibilities(projectNoMembers, creatorOwner)
    expect(second.repairNeeded).toBe(true)
  })

  test('rejects an ineligible assignee without a partial write (FR-010)', async () => {
    await migrateProjectResponsibilities(projectLegacy, creatorOwner)
    const productOwner = (await listResponsibilities(projectLegacy)).find((item) => item.standardKey === 'product-owner')!
    const [{ n: before }] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM responsibility_audit WHERE project_id = ${projectLegacy}`
    await expect(replaceAssignments(projectLegacy, productOwner.responsibilityId, [outsider], creatorOwner)).rejects.toMatchObject({
      code: 'ineligible',
    } satisfies Partial<ResponsibilityError>)
    const [{ n: after }] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM responsibility_audit WHERE project_id = ${projectLegacy}`
    expect(after).toBe(before)
    const [{ n: activeAssignments }] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM responsibility_assignments WHERE responsibility_id = ${productOwner.responsibilityId} AND is_active`
    expect(activeAssignments).toBe(0)
    const unchanged = (await listResponsibilities(projectLegacy)).find((item) => item.standardKey === 'product-owner')!
    expect(unchanged.resolution.status).toBe('owner-fallback')
  })

  test('resolves explicit assignees before Owner fallback and reinstates fallback after clearing (FR-007, FR-008)', async () => {
    const productOwner = (await listResponsibilities(projectLegacy)).find((item) => item.standardKey === 'product-owner')!
    const updated = await replaceAssignments(projectLegacy, productOwner.responsibilityId, [teammate, creatorOwner], creatorOwner)
    expect(updated.resolution.status).toBe('explicit')
    expect(updated.resolution.assignees.map((item) => [item.userId, item.primary])).toEqual([[teammate, true], [creatorOwner, false]])

    const explicit = await resolveResponsibility(projectLegacy, 'product-owner')
    expect(explicit.status).toBe('explicit')
    expect(explicit.assignees[0]?.userId).toBe(teammate)

    const cleared = await replaceAssignments(projectLegacy, productOwner.responsibilityId, [], creatorOwner)
    expect(cleared.resolution.status).toBe('owner-fallback')
    expect(cleared.resolution.repairNeeded).toBe(false)

    const owner = (await listResponsibilities(projectLegacy)).find((item) => item.standardKey === 'owner')!
    const fallback = await resolveResponsibility(projectLegacy, 'product-owner')
    expect(fallback.status).toBe('owner-fallback')
    expect(fallback.assignees[0]?.userId).toBe(owner.resolution.assignees[0]?.userId)
  })

  test('retains a member across multiple responsibilities with ordered backups (FR-005, FR-006)', async () => {
    const before = await listResponsibilities(projectLegacy)
    const productOwner = before.find((item) => item.standardKey === 'product-owner')!
    const leadEngineer = before.find((item) => item.standardKey === 'lead-engineer')!
    await replaceAssignments(projectLegacy, productOwner.responsibilityId, [teammate], creatorOwner)
    await replaceAssignments(projectLegacy, leadEngineer.responsibilityId, [teammate, creatorOwner], creatorOwner)
    const after = await listResponsibilities(projectLegacy)
    expect(after.find((item) => item.standardKey === 'product-owner')!.resolution.assignees.map((item) => item.userId)).toEqual([teammate])
    expect(after.find((item) => item.standardKey === 'lead-engineer')!.resolution.assignees.map((item) => item.userId)).toEqual([teammate, creatorOwner])
  })

  test('excludes a deactivated member from resolution and records the change (FR-014, SC-007)', async () => {
    const migrated = await migrateProjectResponsibilities(projectLifecycle, lifecycleOwner)
    const owner = migrated.responsibilities.find((item) => item.standardKey === 'owner')!
    await replaceAssignments(projectLifecycle, owner.responsibilityId, [lifecycleOwner], lifecycleOwner)
    const productOwner = migrated.responsibilities.find((item) => item.standardKey === 'product-owner')!
    await replaceAssignments(projectLifecycle, productOwner.responsibilityId, [lifecycleMember], lifecycleOwner)

    await removeMember(teamLifecycle, lifecycleMember, lifecycleOwner)

    const after = (await listResponsibilities(projectLifecycle)).find((item) => item.standardKey === 'product-owner')!
    expect(after.resolution.status).toBe('owner-fallback')
    expect(after.resolution.assignees.some((item) => item.userId === lifecycleMember)).toBe(false)
    const [audit] = await sql<Array<{ before: { userIds?: string[] } }>>`
      SELECT before_json AS "before" FROM responsibility_audit
       WHERE project_id = ${projectLifecycle} AND action = 'deactivate-member'
       ORDER BY created_at DESC LIMIT 1
    `
    expect(audit?.before.userIds).toContain(lifecycleMember)
  })

  test('refuses to deactivate the final active Owner (FR-011)', async () => {
    const owner = (await listResponsibilities(projectLifecycle)).find((item) => item.standardKey === 'owner')!
    await expect(deactivateAssignmentsForMember(teamLifecycle, lifecycleOwner, lifecycleOwner)).rejects.toMatchObject({
      code: 'conflict',
    } satisfies Partial<ResponsibilityError>)
    const after = (await listResponsibilities(projectLifecycle)).find((item) => item.standardKey === 'owner')!
    expect(after.resolution.assignees[0]?.userId).toBe(lifecycleOwner)
  })

  test('reconciles a project moved to another team and stays idempotent (FR-019, SC-002)', async () => {
    await migrateProjectResponsibilities(projectMove, creatorOwner)
    const owner = (await listResponsibilities(projectMove)).find((item) => item.standardKey === 'owner')!
    await replaceAssignments(projectMove, owner.responsibilityId, [creatorOwner], creatorOwner)
    const productOwner = (await listResponsibilities(projectMove)).find((item) => item.standardKey === 'product-owner')!
    await replaceAssignments(projectMove, productOwner.responsibilityId, [teammate], creatorOwner)

    await sql`UPDATE projects SET team_id = ${teamB} WHERE project_id = ${projectMove}`

    const repaired = await migrateProjectResponsibilities(projectMove, creatorOwner)
    expect(repaired.repairNeeded).toBe(false)
    expect(repaired.responsibilities.find((item) => item.standardKey === 'owner')!.resolution.assignees[0]?.userId).toBe(newMemberB)
    const movedProductOwner = repaired.responsibilities.find((item) => item.standardKey === 'product-owner')!
    expect(movedProductOwner.resolution.status).toBe('owner-fallback')
    expect(movedProductOwner.resolution.assignees[0]?.userId).toBe(newMemberB)

    const [{ n: afterFirst }] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM responsibility_audit WHERE project_id = ${projectMove} AND action = 'reconcile-ineligible'`
    expect(afterFirst).toBeGreaterThan(0)
    await migrateProjectResponsibilities(projectMove, creatorOwner)
    const [{ n: afterSecond }] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM responsibility_audit WHERE project_id = ${projectMove} AND action = 'reconcile-ineligible'`
    expect(afterSecond).toBe(afterFirst)
  })

  test('keeps at least one Owner under concurrent deactivation of the final Owners (FR-011)', async () => {
    await migrateProjectResponsibilities(projectConcurrent, concurrentA)
    const owner = (await listResponsibilities(projectConcurrent)).find((item) => item.standardKey === 'owner')!
    await replaceAssignments(projectConcurrent, owner.responsibilityId, [concurrentA, concurrentB], concurrentA)

    const results = await Promise.allSettled([
      deactivateAssignmentsForMember(teamConcurrent, concurrentA, concurrentA),
      deactivateAssignmentsForMember(teamConcurrent, concurrentB, concurrentA),
    ])
    const rejected = results.filter((result) => result.status === 'rejected')
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'conflict' } satisfies Partial<ResponsibilityError>)

    const resolved = (await listResponsibilities(projectConcurrent)).find((item) => item.standardKey === 'owner')!
    expect(resolved.resolution.status).toBe('explicit')
    expect(resolved.resolution.assignees.length).toBeGreaterThanOrEqual(1)
    const [{ n }] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM responsibility_assignments a
        JOIN project_responsibilities r USING (responsibility_id)
       WHERE r.project_id = ${projectConcurrent} AND r.standard_key = 'owner' AND a.is_active
    `
    expect(n).toBe(1)
  })

  test('records seed, replacement, and repair audit context (FR-016, SC-007)', async () => {
    const [seed] = await sql<Array<{ after: { standardKey?: string } }>>`
      SELECT after_json AS "after" FROM responsibility_audit
       WHERE project_id = ${projectLegacy} AND action = 'seed-standard' AND after_json->>'standardKey' = 'owner' LIMIT 1
    `
    expect(seed?.after.standardKey).toBe('owner')
    const [seedOwner] = await sql<Array<{ after: { userId?: string } }>>`
      SELECT after_json AS "after" FROM responsibility_audit
       WHERE project_id = ${projectLegacy} AND action = 'seed-owner' ORDER BY created_at, audit_id LIMIT 1
    `
    expect(typeof seedOwner?.after.userId).toBe('string')
    const [replace] = await sql<Array<{ before: { userIds?: string[] }; after: { userIds?: string[] } }>>`
      SELECT before_json AS "before", after_json AS "after" FROM responsibility_audit
       WHERE project_id = ${projectLegacy} AND action = 'replace-assignments'
       ORDER BY created_at DESC, audit_id LIMIT 1
    `
    expect(Array.isArray(replace?.after.userIds)).toBe(true)
    expect(Array.isArray(replace?.before.userIds)).toBe(true)
  })
})
