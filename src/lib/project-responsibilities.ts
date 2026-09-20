import { randomUUID } from 'node:crypto'
import { getDb } from './db'

export const STANDARD_RESPONSIBILITIES = [
  { key: 'owner', name: 'Owner' },
  { key: 'product-owner', name: 'Product Owner' },
  { key: 'lead-engineer', name: 'Lead Engineer' },
  { key: 'designer', name: 'Designer' },
  { key: 'qa', name: 'QA' },
  { key: 'release-manager', name: 'Release Manager' },
] as const

export type StandardResponsibilityKey = typeof STANDARD_RESPONSIBILITIES[number]['key']
export type ResponsibilityKind = 'standard' | 'custom'
export type ResolutionStatus = 'explicit' | 'owner-fallback' | 'unresolved'

/** Advisory routing only: assignments never confer approval or access authority. */
export const STAGE_RESPONSIBILITY_KEYS: Record<string, StandardResponsibilityKey> = {
  specify: 'product-owner',
  review: 'product-owner',
  plan: 'lead-engineer',
  implement: 'lead-engineer',
  design: 'designer',
  verify: 'qa',
  release: 'release-manager',
  deliver: 'release-manager',
}

export function responsibilityKeyForStage(stage: string): StandardResponsibilityKey {
  return STAGE_RESPONSIBILITY_KEYS[stage] ?? 'owner'
}

export interface ResponsibilityAssignment {
  assignmentId: string
  userId: string
  name: string
  email: string
  active: boolean
  primary: boolean
  ordinal: number
}

export interface ResponsibilityResolution {
  projectId: string
  responsibilityId: string
  responsibilityKey?: string
  status: ResolutionStatus
  repairNeeded: boolean
  assignees: Array<{ userId: string; name: string; email: string; primary: boolean }>
}

export interface ResponsibilityView {
  responsibilityId: string
  projectId: string
  name: string
  normalizedName: string
  standardKey?: string | null
  kind: ResponsibilityKind
  active: boolean
  displayOrder: number
  assignments: ResponsibilityAssignment[]
  resolution: ResponsibilityResolution
}

export class ResponsibilityError extends Error {
  constructor(public readonly code: 'invalid' | 'not_found' | 'conflict' | 'ineligible', message: string) {
    super(message)
    this.name = 'ResponsibilityError'
  }
}

export function normalizeResponsibilityName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase()
}

async function audit(tx: any, input: {
  projectId: string
  responsibilityId?: string
  actorUserId?: string
  action: string
  before?: unknown
  after?: unknown
}): Promise<void> {
  await tx`
    INSERT INTO responsibility_audit
      (audit_id, project_id, responsibility_id, actor_user_id, action, before_json, after_json)
    VALUES
      (${randomUUID()}, ${input.projectId}, ${input.responsibilityId ?? null}, ${input.actorUserId ?? null},
       ${input.action}, ${tx.json((input.before ?? {}) as never)}, ${tx.json((input.after ?? {}) as never)})
  `
}

export async function seedProjectResponsibilitiesInTransaction(tx: any, projectId: string, createdBy?: string, actorUserId?: string): Promise<void> {
    const [project] = await tx<Array<{ teamId: string | null }>>`SELECT team_id AS "teamId" FROM projects WHERE project_id = ${projectId}`
    if (!project) throw new ResponsibilityError('not_found', 'Project not found.')

    for (let i = 0; i < STANDARD_RESPONSIBILITIES.length; i += 1) {
      const standard = STANDARD_RESPONSIBILITIES[i]!
      const [existing] = await tx<Array<{ responsibilityId: string }>>`
        SELECT responsibility_id AS "responsibilityId"
          FROM project_responsibilities
         WHERE project_id = ${projectId} AND standard_key = ${standard.key}
      `
      if (!existing) {
        const responsibilityId = randomUUID()
        await tx`
          INSERT INTO project_responsibilities
            (responsibility_id, project_id, name, normalized_name, kind, standard_key, display_order)
          VALUES
            (${responsibilityId}, ${projectId}, ${standard.name}, ${standard.key}, 'standard', ${standard.key}, ${i})
        `
        await audit(tx, { projectId, responsibilityId, actorUserId, action: 'seed-standard', after: { standardKey: standard.key } })
      }
    }

    const [owner] = await tx<Array<{ responsibilityId: string }>>`
      SELECT responsibility_id AS "responsibilityId"
        FROM project_responsibilities
       WHERE project_id = ${projectId} AND standard_key = 'owner'
       FOR UPDATE
    `
    if (!owner || !project.teamId) return

    const [activeOwner] = await tx<Array<{ n: number }>>`
      SELECT count(*)::int AS n
        FROM responsibility_assignments a
        JOIN team_members m ON m.user_id = a.user_id
       WHERE a.responsibility_id = ${owner.responsibilityId}
         AND a.is_active AND m.team_id = ${project.teamId}
    `
    if ((activeOwner?.n ?? 0) > 0) return

    const [candidate] = await tx<Array<{ userId: string }>>`
      SELECT m.user_id AS "userId"
        FROM team_members m
       WHERE m.team_id = ${project.teamId}
         AND (${createdBy ?? null}::uuid IS NOT NULL AND m.user_id = ${createdBy ?? null} OR ${createdBy ?? null}::uuid IS NULL OR m.user_id <> ${createdBy ?? null})
       ORDER BY CASE WHEN m.user_id = ${createdBy ?? null} THEN 0 ELSE 1 END, m.user_id
       LIMIT 1
    `
    if (!candidate) return
    await tx`
      INSERT INTO responsibility_assignments
        (assignment_id, responsibility_id, user_id, ordinal, assigned_by)
      VALUES (${randomUUID()}, ${owner.responsibilityId}, ${candidate.userId}, 0, ${actorUserId ?? createdBy ?? null})
      ON CONFLICT (responsibility_id, user_id) WHERE is_active
      DO UPDATE SET is_active = true, updated_at = now(), assigned_by = EXCLUDED.assigned_by
    `
    await audit(tx, { projectId, responsibilityId: owner.responsibilityId, actorUserId: actorUserId ?? createdBy, action: 'seed-owner', after: { userId: candidate.userId } })
}

export async function seedProjectResponsibilities(projectId: string, createdBy?: string, actorUserId?: string): Promise<void> {
  const sql = getDb()
  await sql.begin((tx) => seedProjectResponsibilitiesInTransaction(tx, projectId, createdBy, actorUserId))
}

/**
 * Deactivate active assignments whose user is no longer an active member of the
 * project's owning team. Used when a project is moved between teams so that no
 * ineligible assignment survives the move. A no-team (legacy) project has no
 * eligibility boundary, so nothing is reconciled until it is adopted.
 *
 * This is idempotent: once the ineligible rows are inactive there is nothing to
 * update and no audit event is written on a repeated call.
 */
async function reconcileIneligibleAssignmentsInTransaction(tx: any, projectId: string, actorUserId?: string): Promise<void> {
  const [project] = await tx<Array<{ teamId: string | null }>>`SELECT team_id AS "teamId" FROM projects WHERE project_id = ${projectId} FOR UPDATE`
  if (!project) throw new ResponsibilityError('not_found', 'Project not found.')
  if (!project.teamId) return

  const affected = await tx<Array<{ projectId: string; responsibilityId: string; userIds: string[] }>>`
    SELECT r.project_id AS "projectId", r.responsibility_id AS "responsibilityId",
           array_agg(a.user_id::text ORDER BY a.ordinal, a.user_id) AS "userIds"
      FROM responsibility_assignments a
      JOIN project_responsibilities r ON r.responsibility_id = a.responsibility_id
     WHERE r.project_id = ${projectId}
       AND a.is_active
       AND NOT EXISTS (
         SELECT 1 FROM team_members m
          WHERE m.team_id = ${project.teamId} AND m.user_id = a.user_id
       )
     GROUP BY r.project_id, r.responsibility_id
  `
  if (!affected.length) return

  await tx`
    UPDATE responsibility_assignments a
       SET is_active = false, updated_at = now(), assigned_by = ${actorUserId ?? null}
      FROM project_responsibilities r
     WHERE a.responsibility_id = r.responsibility_id
       AND r.project_id = ${projectId}
       AND a.is_active
       AND NOT EXISTS (
         SELECT 1 FROM team_members m
          WHERE m.team_id = ${project.teamId} AND m.user_id = a.user_id
       )
  `
  for (const item of affected) {
    await audit(tx, {
      projectId: item.projectId,
      responsibilityId: item.responsibilityId,
      actorUserId,
      action: 'reconcile-ineligible',
      before: { userIds: item.userIds },
      after: { userIds: [] },
    })
  }
}

/** Deactivate assignments that are no longer eligible under the owning team. */
export async function reconcileProjectAssignments(projectId: string, actorUserId?: string): Promise<void> {
  const sql = getDb()
  await sql.begin((tx) => reconcileIneligibleAssignmentsInTransaction(tx, projectId, actorUserId))
}

export async function migrateProjectResponsibilities(projectId: string, actorUserId?: string): Promise<{ repairNeeded: boolean; responsibilities: ResponsibilityView[] }> {
  const sql = getDb()
  // Reconcile ineligible assignments first so a moved project does not keep
  // assigning work to people outside its current team, then seed any missing
  // standard definitions and an eligible Owner in the same transaction.
  await sql.begin(async (tx) => {
    await reconcileIneligibleAssignmentsInTransaction(tx, projectId, actorUserId)
    await seedProjectResponsibilitiesInTransaction(tx, projectId, undefined, actorUserId)
  })
  const responsibilities = await listResponsibilities(projectId)
  const owner = responsibilities.find((item) => item.standardKey === 'owner')
  return { repairNeeded: !owner?.resolution.assignees.length, responsibilities }
}

async function loadViews(projectId: string): Promise<ResponsibilityView[]> {
  const sql = getDb()
  const rows = await sql<Array<{
    responsibilityId: string; projectId: string; name: string; normalizedName: string; standardKey: string | null
    kind: ResponsibilityKind; active: boolean; displayOrder: number; assignmentId: string | null; userId: string | null
    userName: string | null; email: string | null; assignmentActive: boolean | null; ordinal: number | null; memberActive: boolean | null
  }>>`
    SELECT r.responsibility_id AS "responsibilityId", r.project_id AS "projectId", r.name,
           r.normalized_name AS "normalizedName", r.standard_key AS "standardKey", r.kind,
           r.is_active AS active, r.display_order AS "displayOrder",
           a.assignment_id AS "assignmentId", a.user_id AS "userId", u.name AS "userName", u.email,
           a.is_active AS "assignmentActive", a.ordinal, (m.user_id IS NOT NULL) AS "memberActive"
      FROM project_responsibilities r
      LEFT JOIN responsibility_assignments a ON a.responsibility_id = r.responsibility_id
      LEFT JOIN users u ON u.user_id = a.user_id
      LEFT JOIN projects p ON p.project_id = r.project_id
      LEFT JOIN team_members m ON m.team_id = p.team_id AND m.user_id = a.user_id
     WHERE r.project_id = ${projectId}
     ORDER BY r.display_order, r.responsibility_id, a.ordinal NULLS LAST, a.user_id NULLS LAST
  `
  const map = new Map<string, ResponsibilityView>()
  for (const row of rows) {
    let view = map.get(row.responsibilityId)
    if (!view) {
      view = {
        responsibilityId: row.responsibilityId, projectId: row.projectId, name: row.name, normalizedName: row.normalizedName,
        standardKey: row.standardKey, kind: row.kind, active: row.active, displayOrder: row.displayOrder, assignments: [],
        resolution: { projectId, responsibilityId: row.responsibilityId, responsibilityKey: row.standardKey ?? undefined, status: 'unresolved', repairNeeded: false, assignees: [] },
      }
      map.set(row.responsibilityId, view)
    }
    if (row.assignmentId && row.userId && row.userName && row.email) {
      const active = Boolean(row.assignmentActive && row.memberActive)
      view.assignments.push({ assignmentId: row.assignmentId, userId: row.userId, name: row.userName, email: row.email, active, primary: false, ordinal: row.ordinal ?? 0 })
    }
  }
  for (const view of map.values()) {
    const active = view.assignments.filter((item) => item.active).sort((a, b) => a.ordinal - b.ordinal || a.userId.localeCompare(b.userId))
    active.forEach((item, index) => { item.primary = index === 0 })
    if (active.length) view.resolution = { ...view.resolution, status: 'explicit', repairNeeded: false, assignees: active.map(({ userId, name, email, primary }) => ({ userId, name, email, primary })) }
  }
  return [...map.values()]
}

export async function listResponsibilities(projectId: string): Promise<ResponsibilityView[]> {
  const views = await loadViews(projectId)
  const owner = views.find((item) => item.standardKey === 'owner')
  const ownerAssignees = owner?.resolution.assignees ?? []
  for (const view of views) {
    if (!view.active) continue
    if (view.standardKey !== 'owner' && view.resolution.status !== 'explicit') {
      view.resolution = ownerAssignees.length
        ? { ...view.resolution, status: 'owner-fallback', repairNeeded: false, assignees: ownerAssignees.map((item, index) => ({ ...item, primary: index === 0 })) }
        : { ...view.resolution, status: 'unresolved', repairNeeded: true, assignees: [] }
    }
    if (view.standardKey === 'owner' && !ownerAssignees.length) view.resolution = { ...view.resolution, status: 'unresolved', repairNeeded: true, assignees: [] }
  }
  return views
}

export async function resolveResponsibility(projectId: string, keyOrId: string): Promise<ResponsibilityResolution> {
  const views = await listResponsibilities(projectId)
  const view = views.find((item) => item.responsibilityId === keyOrId || item.standardKey === keyOrId || item.normalizedName === normalizeResponsibilityName(keyOrId))
  if (!view) throw new ResponsibilityError('not_found', 'Responsibility not found.')
  return view.resolution
}

/** Render a stage-specific contact note without changing existing gate authority. */
export async function responsibilityContextForStage(projectId: string, stage: string): Promise<string> {
  const key = responsibilityKeyForStage(stage)
  const resolution = await resolveResponsibility(projectId, key)
  const role = STANDARD_RESPONSIBILITIES.find((item) => item.key === key)?.name ?? 'Owner'
  if (resolution.status === 'unresolved') {
    return `# Advisory responsibility contact\n\n${role} is unresolved for this project. Do not guess a contact; flag that responsibility repair is needed. This is advisory only and does not change approval or access rules.`
  }
  const contacts = resolution.assignees.map((assignee) => `${assignee.name} <${assignee.email}>${assignee.primary ? ' (primary)' : ''}`).join(', ')
  const source = resolution.status === 'owner-fallback' ? 'Owner fallback' : 'explicit assignment'
  return `# Advisory responsibility contact\n\n${role}: ${contacts} (${source}). Use this only as delivery context; existing human gates, team-role authorization, and approval authority are unchanged.`
}

export async function createCustomResponsibility(projectId: string, name: string, actorUserId: string): Promise<ResponsibilityView> {
  const normalizedName = normalizeResponsibilityName(name)
  if (!normalizedName) throw new ResponsibilityError('invalid', 'Responsibility name is required.')
  if (STANDARD_RESPONSIBILITIES.some((item) => normalizeResponsibilityName(item.name) === normalizedName || item.key === normalizedName)) throw new ResponsibilityError('invalid', 'That name is reserved for a standard responsibility.')
  const sql = getDb()
  const id = randomUUID()
  try {
    await sql`
      INSERT INTO project_responsibilities (responsibility_id, project_id, name, normalized_name, kind, display_order)
      VALUES (${id}, ${projectId}, ${name.trim().replace(/\s+/g, ' ')}, ${normalizedName}, 'custom',
        COALESCE((SELECT max(display_order) + 1 FROM project_responsibilities WHERE project_id = ${projectId}), 0))
    `
  } catch (error) {
    if (String(error).includes('project_responsibilities_active_name_idx')) throw new ResponsibilityError('conflict', 'A responsibility with that name already exists.')
    throw error
  }
  await sql`INSERT INTO responsibility_audit (audit_id, project_id, responsibility_id, actor_user_id, action, after_json) VALUES (${randomUUID()}, ${projectId}, ${id}, ${actorUserId}, 'create', ${sql.json({ name } as never)})`
  return (await listResponsibilities(projectId)).find((item) => item.responsibilityId === id)!
}

export async function replaceAssignments(projectId: string, responsibilityId: string, userIds: string[], actorUserId?: string): Promise<ResponsibilityView> {
  if (new Set(userIds).size !== userIds.length) throw new ResponsibilityError('invalid', 'Duplicate user IDs are not allowed.')
  const sql = getDb()
  await sql.begin(async (tx) => {
    const [responsibility] = await tx<Array<{ standardKey: string | null; teamId: string | null }>>`
      SELECT r.standard_key AS "standardKey", p.team_id AS "teamId"
        FROM project_responsibilities r JOIN projects p ON p.project_id = r.project_id
       WHERE r.responsibility_id = ${responsibilityId} AND r.project_id = ${projectId}
       FOR UPDATE
    `
    if (!responsibility) throw new ResponsibilityError('not_found', 'Responsibility not found.')
    if (responsibility.standardKey === 'owner' && userIds.length === 0) throw new ResponsibilityError('conflict', 'A project must retain at least one Owner.')
    if (!responsibility.teamId && userIds.length) throw new ResponsibilityError('ineligible', 'The project has no owning team.')
    if (userIds.length) {
      const members = await tx<Array<{ userId: string }>>`SELECT user_id AS "userId" FROM team_members WHERE team_id = ${responsibility.teamId} AND user_id IN ${tx(userIds)}`
      if (members.length !== userIds.length) throw new ResponsibilityError('ineligible', 'Every assignee must be an active member of the owning team.')
    }
    const before = await tx<Array<{ userId: string; ordinal: number }>>`
      SELECT user_id AS "userId", ordinal
        FROM responsibility_assignments
       WHERE responsibility_id = ${responsibilityId} AND is_active
       ORDER BY ordinal, user_id
    `
    await tx`UPDATE responsibility_assignments SET is_active = false, updated_at = now(), assigned_by = ${actorUserId ?? null} WHERE responsibility_id = ${responsibilityId} AND is_active`
    for (let ordinal = 0; ordinal < userIds.length; ordinal += 1) {
      await tx`
        INSERT INTO responsibility_assignments (assignment_id, responsibility_id, user_id, ordinal, is_active, assigned_by)
        VALUES (${randomUUID()}, ${responsibilityId}, ${userIds[ordinal]}, ${ordinal}, true, ${actorUserId ?? null})
        ON CONFLICT (responsibility_id, user_id) WHERE is_active
        DO UPDATE SET ordinal = EXCLUDED.ordinal, updated_at = now(), assigned_by = EXCLUDED.assigned_by
      `
    }
    await audit(tx, { projectId, responsibilityId, actorUserId, action: 'replace-assignments', before: { userIds: before.map((item) => item.userId) }, after: { userIds } })
  })
  return (await listResponsibilities(projectId)).find((item) => item.responsibilityId === responsibilityId)!
}

export async function deactivateAssignmentsForMember(teamId: string, userId: string, actorUserId?: string): Promise<void> {
  const sql = getDb()
  await sql.begin(async (tx) => {
    const owners = await tx<Array<{ projectId: string; responsibilityId: string }>>`
      SELECT r.project_id AS "projectId", r.responsibility_id AS "responsibilityId"
        FROM project_responsibilities r
        JOIN projects p ON p.project_id = r.project_id
       WHERE p.team_id = ${teamId} AND r.standard_key = 'owner'
       FOR UPDATE OF r
    `
    for (const owner of owners) {
      const active = await tx<Array<{ userId: string }>>`
        SELECT user_id AS "userId"
          FROM responsibility_assignments
         WHERE responsibility_id = ${owner.responsibilityId} AND is_active
      `
      const remaining = active.filter((item) => item.userId !== userId)
      if (active.some((item) => item.userId === userId) && remaining.length === 0) {
        throw new ResponsibilityError('conflict', 'The member is the final project Owner; assign another Owner before removing them.')
      }
    }
    const affected = await tx<Array<{ projectId: string; responsibilityId: string; userIds: string[] }>>`
      SELECT r.project_id AS "projectId", r.responsibility_id AS "responsibilityId",
             array_agg(a.user_id::text ORDER BY a.ordinal, a.user_id) AS "userIds"
        FROM responsibility_assignments a
        JOIN project_responsibilities r ON r.responsibility_id = a.responsibility_id
        JOIN projects p ON p.project_id = r.project_id
       WHERE p.team_id = ${teamId} AND a.user_id = ${userId} AND a.is_active
       GROUP BY r.project_id, r.responsibility_id
    `
    await tx`
      UPDATE responsibility_assignments a
         SET is_active = false, updated_at = now(), assigned_by = ${actorUserId ?? null}
        FROM project_responsibilities r JOIN projects p ON p.project_id = r.project_id
       WHERE a.responsibility_id = r.responsibility_id AND p.team_id = ${teamId} AND a.user_id = ${userId} AND a.is_active
    `
    for (const item of affected) {
      await audit(tx, { projectId: item.projectId, responsibilityId: item.responsibilityId, actorUserId, action: 'deactivate-member', before: { userIds: item.userIds }, after: { userIds: item.userIds.filter((id) => id !== userId) } })
    }
  })
}
