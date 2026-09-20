import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { closeDb, getDb } from '../src/lib/db'
import { createProject } from '../src/lib/project-registry'
import { migrateProjectResponsibilities, listResponsibilities, replaceAssignments, resolveResponsibility, responsibilityContextForStage, responsibilityKeyForStage, ResponsibilityError } from '../src/lib/project-responsibilities'

/**
 * Advisory workflow context (FR-017, FR-018, SC-006). The context must use
 * explicit assignees before Owner fallback, surface unresolved state as a
 * repair condition, and never claim approval authority.
 */
async function databaseReachable(): Promise<boolean> {
  try {
    await getDb()`SELECT 1 FROM project_responsibilities LIMIT 1`
    return true
  } catch (error) {
    const message = String(error)
    if (/project_responsibilities/.test(message) && /does not exist/i.test(message)) {
      throw new Error('project_responsibilities is missing; run `bun run db:migrate` before this suite.')
    }
    return false
  }
}

const live = await databaseReachable()
const suite = live ? describe : describe.skip
if (!live) test.skip('workflow context tests skipped: DATABASE_URL is not reachable', () => {})

suite('advisory responsibility workflow context', () => {
  const sql = getDb()
  const suffix = randomUUID().slice(0, 8)
  const orgId = randomUUID()
  const teamId = randomUUID()
  const emptyTeamId = randomUUID()
  const ownerId = randomUUID()
  const memberId = randomUUID()
  let projectId = ''
  let emptyProjectId = ''

  beforeAll(async () => {
    await sql`INSERT INTO organizations (org_id, name, slug) VALUES (${orgId}, ${`Workflow ${suffix}`}, ${`workflow-${suffix}`})`
    await sql`INSERT INTO users (user_id, email, name) VALUES
      (${ownerId}, ${`workflow-owner-${suffix}@example.test`}, 'Workflow Owner'),
      (${memberId}, ${`workflow-member-${suffix}@example.test`}, 'Workflow Member')`
    await sql`INSERT INTO teams (team_id, org_id, name, slug, created_by) VALUES
      (${teamId}, ${orgId}, ${`Workflow team ${suffix}`}, ${`workflow-team-${suffix}`}, ${ownerId}),
      (${emptyTeamId}, ${orgId}, ${`Empty team ${suffix}`}, ${`empty-team-${suffix}`}, ${ownerId})`
    await sql`INSERT INTO team_members (team_id, user_id, role) VALUES
      (${teamId}, ${ownerId}, 'owner'),
      (${teamId}, ${memberId}, 'member')`

    projectId = (await createProject({ name: `Workflow project ${suffix}`, slug: `workflow-project-${suffix}`, teamId, createdBy: ownerId })).projectId
    emptyProjectId = randomUUID()
    await sql`INSERT INTO projects (project_id, name, slug, team_id) VALUES (${emptyProjectId}, ${`Empty project ${suffix}`}, ${`empty-project-${suffix}`}, ${emptyTeamId})`
    await migrateProjectResponsibilities(emptyProjectId, ownerId)
  })

  afterAll(async () => {
    await sql`DELETE FROM projects WHERE project_id IN (${projectId}, ${emptyProjectId})`
    await sql`DELETE FROM teams WHERE team_id IN (${teamId}, ${emptyTeamId})`
    await sql`DELETE FROM organizations WHERE org_id = ${orgId}`
    await sql`DELETE FROM users WHERE user_id IN (${ownerId}, ${memberId})`
    await closeDb()
  })

  async function assign(key: string, userIds: string[]) {
    const responsibilities = await listResponsibilities(projectId)
    const target = responsibilities.find((item) => item.standardKey === key)!
    return replaceAssignments(projectId, target.responsibilityId, userIds, ownerId)
  }

  test('explicit assignment is used first and is labelled', async () => {
    await assign('product-owner', [memberId])
    const context = await responsibilityContextForStage(projectId, 'specify')
    expect(context).toContain('Product Owner')
    expect(context).toContain('Workflow Member')
    expect(context).toContain('explicit assignment')
    expect(context).not.toContain('Owner fallback')
  })

  test('repeated stage names map to the same advisory responsibility', async () => {
    expect(responsibilityKeyForStage('review')).toBe(responsibilityKeyForStage('specify'))
    expect(responsibilityKeyForStage('plan')).toBe(responsibilityKeyForStage('implement'))
    expect(responsibilityKeyForStage('release')).toBe(responsibilityKeyForStage('deliver'))
  })

  test('an unassigned responsibility falls back to the active Owner and says so', async () => {
    const context = await responsibilityContextForStage(projectId, 'verify')
    expect(context).toContain('QA')
    expect(context).toContain('Owner fallback')
    expect(context).toContain('Workflow Owner')
  })

  test('multiple assignees expose the primary first and keep backups', async () => {
    await assign('lead-engineer', [memberId, ownerId])
    const context = await responsibilityContextForStage(projectId, 'implement')
    expect(context).toContain('Lead Engineer')
    const memberIndex = context.indexOf('Workflow Member')
    const ownerIndex = context.indexOf('Workflow Owner')
    expect(memberIndex).toBeGreaterThanOrEqual(0)
    expect(ownerIndex).toBeGreaterThan(memberIndex)
    expect(context).toContain('(primary)')
  })

  test('an unresolved project reports repair-needed instead of guessing a contact', async () => {
    const responsibilities = await listResponsibilities(emptyProjectId)
    expect(responsibilities.find((item) => item.standardKey === 'owner')!.resolution.status).toBe('unresolved')
    const context = await responsibilityContextForStage(emptyProjectId, 'verify')
    expect(context.toLowerCase()).toContain('repair')
    expect(context).not.toContain('@')
  })

  test('every context disclaims approval authority and preserves human gates', async () => {
    for (const stage of ['specify', 'plan', 'design', 'verify', 'release', 'unknown-stage']) {
      const context = await responsibilityContextForStage(projectId, stage)
      const lower = context.toLowerCase()
      expect(lower).toContain('advisory')
      expect(lower).toContain('approval')
      expect(lower).not.toContain('bypass')
      expect(lower).not.toContain('grants approval')
    }
  })

  test('resolving an unknown responsibility id fails as not found', async () => {
    await expect(resolveResponsibility(projectId, 'not-a-role')).rejects.toMatchObject({ code: 'not_found' } satisfies Partial<ResponsibilityError>)
  })
})
