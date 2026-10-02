/**
 * Deployment orchestration (010-railway-deployment).
 *
 * Targets, status, the release decision and the read-only agent tool. This is
 * the deterministic layer between the existing delivery human gate and the
 * Railway client: agents can read deployment state, but only an authorized
 * person's gate decision triggers a release, and exactly one per
 * `(run_id, target_id)`.
 */

import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { getDb } from './db'
import { authDisabled, getMembership, roleAtLeast, type TeamRole } from './auth'
import { getDefaultOrgId, orgIdForProject } from './orgs'
import { resolveResponsibility } from './project-responsibilities'
import { listAppIntegrations } from './app-integrations'
import {
  getLatestDeployment,
  listRailwayTargets,
  normalizeRailwayStatus,
  triggerDeployment,
  targetRef,
  RailwayError,
  type NormalizedDeploymentStatus,
  type RailwayTargetRef,
  type RailwayWorkspaceTargets,
} from './railway'
import { log } from './logger'

const deploymentLog = log.child({ mod: 'deployment' })

/** A release that never reaches a terminal Railway state within this window is unconfirmed, not delivered. */
const DEPLOYMENT_TIMEOUT_MS = 30 * 60_000

export type DeploymentRecordStatus = 'pending_approval' | 'in_progress' | 'success' | 'failed' | 'unconfirmed' | 'rejected'
export type DeploymentUiState = NormalizedDeploymentStatus | 'unconfirmed'
export type LinkState = 'valid' | 'invalid'

export interface DeploymentTargetRow {
  targetId: string
  projectId: string
  orgId: string
  workspaceId: string
  railwayProjectId: string
  railwayProjectName: string
  serviceId: string
  serviceName: string
  environmentId: string
  environmentName: string
  serviceUrl: string | null
  linkState: LinkState
  lastStatus: string | null
  lastRailwayStatus: string | null
  lastDeploymentId: string | null
  lastDeployedAt: string | null
  lastCheckedAt: string | null
  linkError: string | null
  statusError: string | null
  linkedBy: string | null
  createdAt: string
  updatedAt: string
}

export interface DeploymentRecordRow {
  deploymentId: string
  projectId: string
  /** Null once the project's target is unlinked; history is kept. */
  targetId: string | null
  runId: string | null
  approvalId: string | null
  railwayDeploymentId: string | null
  status: DeploymentRecordStatus
  railwayStatus: string | null
  serviceUrl: string | null
  deploymentUrl: string | null
  error: string | null
  requestedBy: string | null
  triggeredAt: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface DeploymentApprovalRow {
  approvalId: string
  projectId: string
  targetId: string
  runId: string | null
  approverUserId: string | null
  approverRole: string
  decision: 'approved' | 'rejected'
  reason: string | null
  superseded: boolean
  decidedAt: string
}

export interface DeploymentStatusView {
  state: DeploymentUiState
  railwayStatus: string | null
  serviceUrl: string | null
  lastDeployedAt: string | null
  deploymentUrl: string | null
  linkState: LinkState
  message?: string
  /** The last refresh could not reach Railway; the shown state is the last known one. */
  stale?: boolean
  lastCheckedAt?: string | null
  error?: string | null
}

export interface ProjectDeploymentView {
  connection: { status: string; reconnectNeeded: boolean; workspaceName?: string; workspaceId?: string }
  target?: {
    targetId: string
    workspaceId: string
    workspaceName?: string
    railwayProjectId: string
    railwayProjectName: string
    serviceId: string
    serviceName: string
    environmentId: string
    environmentName: string
    linkState: LinkState
    linkError?: string | null
  }
  status?: DeploymentStatusView
  history: Array<Pick<DeploymentRecordRow, 'deploymentId' | 'status' | 'railwayStatus' | 'serviceUrl' | 'deploymentUrl' | 'error' | 'triggeredAt' | 'completedAt' | 'createdAt'>>
}

const TARGET_COLS = `
  target_id AS "targetId", project_id AS "projectId", org_id AS "orgId",
  workspace_id AS "workspaceId", railway_project_id AS "railwayProjectId", railway_project_name AS "railwayProjectName",
  service_id AS "serviceId", service_name AS "serviceName",
  environment_id AS "environmentId", environment_name AS "environmentName",
  service_url AS "serviceUrl", link_state AS "linkState",
  last_status AS "lastStatus", last_railway_status AS "lastRailwayStatus", last_deployment_id AS "lastDeploymentId",
  last_deployed_at AS "lastDeployedAt", last_checked_at AS "lastCheckedAt", link_error AS "linkError",
  status_error AS "statusError", linked_by AS "linkedBy", created_at AS "createdAt", updated_at AS "updatedAt"
`

const RECORD_COLS = `
  deployment_id AS "deploymentId", project_id AS "projectId", target_id AS "targetId", run_id AS "runId",
  approval_id AS "approvalId", railway_deployment_id AS "railwayDeploymentId", status,
  railway_status AS "railwayStatus", service_url AS "serviceUrl", deployment_url AS "deploymentUrl", error,
  requested_by AS "requestedBy", triggered_at AS "triggeredAt", completed_at AS "completedAt",
  created_at AS "createdAt", updated_at AS "updatedAt"
`

// ---- targets ----

export async function getDeploymentTarget(projectId: string): Promise<DeploymentTargetRow | undefined> {
  const sql = getDb()
  const [row] = await sql<DeploymentTargetRow[]>`SELECT ${sql.unsafe(TARGET_COLS)} FROM project_deployment_targets WHERE project_id = ${projectId}`
  return row
}

/** Every service/environment the organization's Railway credential can see. */
export async function listAccessibleTargets(orgId: string): Promise<RailwayWorkspaceTargets[]> {
  return listRailwayTargets(orgId)
}

export class DeploymentTargetError extends Error {
  constructor(public readonly code: 'not_found' | 'inaccessible' | 'not_connected' | 'invalid', message: string) {
    super(message)
    this.name = 'DeploymentTargetError'
  }
}

/**
 * Link (or replace) the one deployment target for a project. The chosen
 * service + environment must exist in the credential's accessible set.
 */
export async function linkDeploymentTarget(input: {
  projectId: string
  orgId: string
  workspaceId: string
  railwayProjectId: string
  serviceId: string
  environmentId: string
  actorUserId?: string | null
}): Promise<DeploymentTargetRow> {
  const targets = await listRailwayTargets(input.orgId).catch((error) => {
    if (error instanceof RailwayError) throw new DeploymentTargetError('not_connected', error.message)
    throw error
  })
  const workspace = targets.find((w) => w.id === input.workspaceId || w.projects.some((p) => p.id === input.railwayProjectId))
  const project = workspace?.projects.find((p) => p.id === input.railwayProjectId)
  const service = project?.services.find((s) => s.id === input.serviceId)
  const environment = project?.environments.find((e) => e.id === input.environmentId)
  if (!workspace || !project || !service || !environment) {
    throw new DeploymentTargetError('inaccessible', 'That Railway service or environment is not in the connected credential\'s accessible set. Pick one from the list.')
  }

  const sql = getDb()
  const [row] = await sql<DeploymentTargetRow[]>`
    INSERT INTO project_deployment_targets
      (target_id, project_id, org_id, workspace_id, railway_project_id, railway_project_name,
       service_id, service_name, environment_id, environment_name, link_state, link_error, linked_by)
    VALUES
      (${randomUUID()}, ${input.projectId}, ${input.orgId}, ${workspace.id}, ${project.id}, ${project.name},
       ${service.id}, ${service.name}, ${environment.id}, ${environment.name}, 'valid', NULL, ${input.actorUserId ?? null})
    ON CONFLICT (project_id) DO UPDATE SET
      org_id = EXCLUDED.org_id,
      workspace_id = EXCLUDED.workspace_id,
      railway_project_id = EXCLUDED.railway_project_id,
      railway_project_name = EXCLUDED.railway_project_name,
      service_id = EXCLUDED.service_id,
      service_name = EXCLUDED.service_name,
      environment_id = EXCLUDED.environment_id,
      environment_name = EXCLUDED.environment_name,
      link_state = 'valid',
      link_error = NULL,
      status_error = NULL,
      last_status = NULL,
      last_railway_status = NULL,
      last_deployment_id = NULL,
      last_deployed_at = NULL,
      last_checked_at = NULL,
      linked_by = EXCLUDED.linked_by,
      updated_at = now()
    RETURNING ${sql.unsafe(TARGET_COLS)}
  `
  return row!
}

/** Remove the project's link. Deployment records remain as history. */
export async function unlinkDeploymentTarget(projectId: string): Promise<boolean> {
  const rows = await getDb()`DELETE FROM project_deployment_targets WHERE project_id = ${projectId} RETURNING target_id`
  return rows.length > 0
}

// ---- authorization ----

export type ReleaseAuthority = { allowed: boolean; role?: string; reason?: string }

/** Team owner/admin, or the project's assigned Release Manager or Owner. Never an agent. */
export async function releaseAuthorityFor(projectId: string, userId: string | null | undefined): Promise<ReleaseAuthority> {
  // Single-user local installs have no signed-in user; the same mode is authorized
  // for every other management action, so a release is allowed there too.
  if (authDisabled()) return { allowed: true, role: 'local' }
  if (!userId) return { allowed: false, reason: 'Sign in as a team owner/admin or the project\'s Release Manager to approve a release.' }
  const sql = getDb()
  const [project] = await sql<Array<{ teamId: string | null }>>`SELECT team_id AS "teamId" FROM projects WHERE project_id = ${projectId}`
  if (project?.teamId) {
    const role: TeamRole | undefined = await getMembership(project.teamId, userId)
    if (role && roleAtLeast(role, 'admin')) return { allowed: true, role }
  }
  for (const key of ['release-manager', 'owner']) {
    const resolution = await resolveResponsibility(projectId, key).catch(() => undefined)
    if (resolution?.assignees.some((a) => a.userId === userId)) return { allowed: true, role: key }
  }
  return { allowed: false, reason: 'Only a team owner/admin or the project\'s Release Manager/Owner can approve a release.' }
}

// ---- status ----

export interface RefreshOptions {
  /** Where to write the deterministic `deployment-status.md` when known. */
  featureDirAbs?: string
  /** Skip the live Railway call (still writes the artifact and returns stored state). */
  skipRemote?: boolean
}

export interface DeploymentSnapshot {
  target?: DeploymentTargetRow
  status: DeploymentStatusView
  history: DeploymentRecordRow[]
  markdown: string
  generatedAt: string
}

function statusFromTarget(target: DeploymentTargetRow): DeploymentStatusView {
  if (target.linkState === 'invalid') {
    return {
      state: 'unknown',
      railwayStatus: target.lastRailwayStatus,
      serviceUrl: null,
      lastDeployedAt: null,
      deploymentUrl: null,
      linkState: 'invalid',
      message: target.linkError ?? 'The linked Railway target is no longer reachable. Re-link the deployment target.',
    }
  }
  const normalized = normalizeRailwayStatus(target.lastRailwayStatus)
  const confirmed = target.lastStatus === 'success' && normalized === 'success'
  // A hand-edited or legacy row can carry `last_status = success` with a
  // non-SUCCESS Railway status; never report that mismatch as a current success.
  const state: DeploymentUiState = confirmed
    ? 'success'
    : target.lastStatus === 'success'
      ? 'unknown'
      : (target.lastStatus as DeploymentUiState | null) ?? 'unknown'
  return {
    state,
    railwayStatus: target.lastRailwayStatus,
    serviceUrl: target.serviceUrl,
    lastDeployedAt: target.lastDeployedAt,
    deploymentUrl: target.lastDeploymentId ? `https://railway.com/project/${target.railwayProjectId}/service/${target.serviceId}` : null,
    linkState: target.linkState,
    stale: Boolean(target.statusError),
    lastCheckedAt: target.lastCheckedAt,
    ...(target.statusError ? { error: target.statusError } : {}),
  }
}

/**
 * Refresh a project's deployment status from Railway, updating the target row
 * and (when a feature directory is known) writing `deployment-status.md`.
 * Inaccessible targets become `invalid` and never report stale data as current.
 */
export async function refreshDeploymentStatus(projectId: string, options: RefreshOptions = {}): Promise<DeploymentSnapshot> {
  const sql = getDb()
  let target = await getDeploymentTarget(projectId)
  if (!target) {
    const generatedAt = new Date().toISOString()
    const markdown = renderDeploymentMarkdown({ target: undefined, status: { state: 'unknown', railwayStatus: null, serviceUrl: null, lastDeployedAt: null, deploymentUrl: null, linkState: 'valid' }, history: [], generatedAt, noTarget: true })
    if (options.featureDirAbs) await writeFile(path.join(options.featureDirAbs, 'deployment-status.md'), `${markdown}\n`).catch(() => undefined)
    return { status: { state: 'unknown', railwayStatus: null, serviceUrl: null, lastDeployedAt: null, deploymentUrl: null, linkState: 'valid' }, history: [], markdown, generatedAt }
  }

  const history = await listDeploymentRecords(projectId)
  if (!options.skipRemote && target.linkState !== 'invalid') {
    try {
      const deployment = await getLatestDeployment(target.orgId, targetRef(target))
      const [updated] = await sql<DeploymentTargetRow[]>`
        UPDATE project_deployment_targets SET
          link_state = 'valid', link_error = NULL, status_error = NULL,
          last_status = ${deployment.status}, last_railway_status = ${deployment.railwayStatus},
          last_deployment_id = ${deployment.id}, last_deployed_at = ${deployment.createdAt},
          service_url = COALESCE(${deployment.serviceUrl}, service_url),
          last_checked_at = now(), updated_at = now()
        WHERE target_id = ${target.targetId}
        RETURNING ${sql.unsafe(TARGET_COLS)}
      `
      if (updated) target = updated
    } catch (error) {
      if (error instanceof RailwayError && (error.code === 'railway_target_missing' || error.code === 'railway_forbidden' || error.code === 'railway_auth')) {
        const [updated] = await sql<DeploymentTargetRow[]>`
          UPDATE project_deployment_targets SET
            link_state = 'invalid', link_error = ${error.message}, status_error = NULL, last_status = 'unknown',
            last_checked_at = now(), updated_at = now()
          WHERE target_id = ${target.targetId}
          RETURNING ${sql.unsafe(TARGET_COLS)}
        `
        if (updated) target = updated
      } else {
        // Transient (rate limit, 5xx, network): keep the link and the last known
        // state, but record the error so it is shown as stale, never current.
        const message = error instanceof RailwayError ? error.message : error instanceof Error ? error.message : 'Railway could not be reached.'
        deploymentLog.warn('deployment status refresh failed', { projectId, code: error instanceof RailwayError ? error.code : 'unknown', error: message })
        const [updated] = await sql<DeploymentTargetRow[]>`
          UPDATE project_deployment_targets SET last_checked_at = now(), status_error = ${message}, updated_at = now()
          WHERE target_id = ${target.targetId}
          RETURNING ${sql.unsafe(TARGET_COLS)}
        `.catch(() => [] as DeploymentTargetRow[])
        if (updated) target = updated
      }
    }
  }

  const status = statusFromTarget(target)
  const generatedAt = new Date().toISOString()
  const markdown = renderDeploymentMarkdown({ target, status, history, generatedAt })
  if (options.featureDirAbs) await writeFile(path.join(options.featureDirAbs, 'deployment-status.md'), `${markdown}\n`).catch(() => undefined)
  return { target, status, history, markdown, generatedAt }
}

/** The project deployment view for the API and board (stored state, no remote call). */
export async function getProjectDeployment(projectId: string): Promise<ProjectDeploymentView> {
  const sql = getDb()
  const target = await getDeploymentTarget(projectId)
  const history = await listDeploymentRecords(projectId)
  const orgId = target?.orgId ?? await orgIdForProject(projectId).catch(() => undefined)
  let connection: ProjectDeploymentView['connection'] = { status: 'not_connected', reconnectNeeded: false }
  if (orgId) {
    const integration = (await listAppIntegrations(orgId).catch(() => [])).find((row) => row.kind === 'railway')
    const reconnectNeeded = integration?.status === 'error' || (integration?.status === 'connected' && integration.credentialsOk === false)
    connection = {
      status: integration?.status ?? 'not_connected',
      reconnectNeeded,
      ...(integration?.configJson?.workspaceName ? { workspaceName: String(integration.configJson.workspaceName) } : {}),
      ...(integration?.configJson?.workspaceId ? { workspaceId: String(integration.configJson.workspaceId) } : {}),
    }
  }
  return {
    connection,
    ...(target ? {
      target: {
        targetId: target.targetId,
        workspaceId: target.workspaceId,
        railwayProjectId: target.railwayProjectId,
        railwayProjectName: target.railwayProjectName,
        serviceId: target.serviceId,
        serviceName: target.serviceName,
        environmentId: target.environmentId,
        environmentName: target.environmentName,
        linkState: target.linkState,
        linkError: target.linkError,
      },
    } : {}),
    status: target ? statusFromTarget(target) : undefined,
    history: history.map((r) => ({
      deploymentId: r.deploymentId, status: r.status, railwayStatus: r.railwayStatus,
      serviceUrl: r.serviceUrl, deploymentUrl: r.deploymentUrl, error: r.error,
      triggeredAt: r.triggeredAt, completedAt: r.completedAt, createdAt: r.createdAt,
    })),
  }
}

/**
 * Batch variant of `getProjectDeployment` for the board: targets, history and
 * Railway connections are fetched once for every card instead of once per card.
 */
export async function getProjectDeployments(projectIds: string[]): Promise<Map<string, ProjectDeploymentView>> {
  const views = new Map<string, ProjectDeploymentView>()
  if (!projectIds.length) return views
  const sql = getDb()
  const [targets, records] = await Promise.all([
    sql<DeploymentTargetRow[]>`SELECT ${sql.unsafe(TARGET_COLS)} FROM project_deployment_targets WHERE project_id IN ${sql(projectIds)}`,
    sql<DeploymentRecordRow[]>`SELECT ${sql.unsafe(RECORD_COLS)} FROM deployment_records WHERE project_id IN ${sql(projectIds)} ORDER BY created_at DESC`,
  ])
  const targetByProject = new Map(targets.map((target) => [target.projectId, target]))
  const historyByProject = new Map<string, DeploymentRecordRow[]>()
  for (const record of records) {
    const history = historyByProject.get(record.projectId) ?? []
    if (history.length < 20) history.push(record)
    historyByProject.set(record.projectId, history)
  }
  const orgByProject = new Map(targets.map((target) => [target.projectId, target.orgId]))
  const missing = projectIds.filter((projectId) => !orgByProject.has(projectId))
  if (missing.length) {
    const rows = await sql<Array<{ projectId: string; orgId: string | null }>>`
      SELECT p.project_id AS "projectId", t.org_id AS "orgId"
        FROM projects p LEFT JOIN teams t ON t.team_id = p.team_id
       WHERE p.project_id IN ${sql(missing)}`
    const defaultOrgId = rows.some((row) => !row.orgId) ? await getDefaultOrgId() : undefined
    for (const row of rows) orgByProject.set(row.projectId, row.orgId ?? defaultOrgId!)
  }
  const integrationsByOrg = new Map<string, Awaited<ReturnType<typeof listAppIntegrations>>>()
  await Promise.all([...new Set(orgByProject.values())].map(async (orgId) => {
    integrationsByOrg.set(orgId, await listAppIntegrations(orgId).catch(() => []))
  }))
  for (const projectId of projectIds) {
    const target = targetByProject.get(projectId)
    const integration = orgByProject.get(projectId)
      ? integrationsByOrg.get(orgByProject.get(projectId)!)?.find((row) => row.kind === 'railway')
      : undefined
    const reconnectNeeded = integration?.status === 'error' || (integration?.status === 'connected' && integration.credentialsOk === false)
    views.set(projectId, {
      connection: {
        status: integration?.status ?? 'not_connected',
        reconnectNeeded,
        ...(integration?.configJson?.workspaceName ? { workspaceName: String(integration.configJson.workspaceName) } : {}),
        ...(integration?.configJson?.workspaceId ? { workspaceId: String(integration.configJson.workspaceId) } : {}),
      },
      ...(target ? {
        target: {
          targetId: target.targetId,
          workspaceId: target.workspaceId,
          railwayProjectId: target.railwayProjectId,
          railwayProjectName: target.railwayProjectName,
          serviceId: target.serviceId,
          serviceName: target.serviceName,
          environmentId: target.environmentId,
          environmentName: target.environmentName,
          linkState: target.linkState,
          linkError: target.linkError,
        },
      } : {}),
      status: target ? statusFromTarget(target) : undefined,
      history: (historyByProject.get(projectId) ?? []).map((r) => ({
        deploymentId: r.deploymentId, status: r.status, railwayStatus: r.railwayStatus,
        serviceUrl: r.serviceUrl, deploymentUrl: r.deploymentUrl, error: r.error,
        triggeredAt: r.triggeredAt, completedAt: r.completedAt, createdAt: r.createdAt,
      })),
    })
  }
  return views
}

// ---- records ----

export async function listDeploymentRecords(projectId: string, limit = 20): Promise<DeploymentRecordRow[]> {
  const sql = getDb()
  return sql<DeploymentRecordRow[]>`SELECT ${sql.unsafe(RECORD_COLS)} FROM deployment_records WHERE project_id = ${projectId} ORDER BY created_at DESC LIMIT ${limit}`
}

export async function getDeploymentRecord(deploymentId: string): Promise<DeploymentRecordRow | undefined> {
  const sql = getDb()
  const [row] = await sql<DeploymentRecordRow[]>`SELECT ${sql.unsafe(RECORD_COLS)} FROM deployment_records WHERE deployment_id = ${deploymentId}`
  return row
}

/** The live (non-rejected) record for a run+target, if a release was already decided. */
export async function findLiveRecord(runId: string | null, targetId: string): Promise<DeploymentRecordRow | undefined> {
  if (!runId) return undefined
  const sql = getDb()
  const [row] = await sql<DeploymentRecordRow[]>`SELECT ${sql.unsafe(RECORD_COLS)} FROM deployment_records WHERE run_id = ${runId} AND target_id = ${targetId} AND status <> 'rejected' LIMIT 1`
  return row
}

// ---- release decision ----

export interface DecideReleaseInput {
  runId: string | null
  projectId: string
  decision: 'approved' | 'rejected'
  reason?: string
  actorUserId?: string | null
}

export interface DecideReleaseResult {
  ok: boolean
  decision: 'approved' | 'rejected'
  status: DeploymentRecordStatus | 'blocked'
  record?: DeploymentRecordRow
  approval?: DeploymentApprovalRow
  error?: string
  code?: string
}

/**
 * Resolve the delivery human gate for a linked project. This is the only path
 * that triggers a Railway deployment: exactly one record and one trigger per
 * approved `(run_id, target_id)`; rejection deploys nothing; anything uncertain
 * fails closed with an actionable reason.
 */
export async function decideRelease(input: DecideReleaseInput): Promise<DecideReleaseResult> {
  const sql = getDb()
  const target = await getDeploymentTarget(input.projectId)
  if (!target) {
    return { ok: false, decision: input.decision, status: 'blocked', code: 'no_target', error: 'No deployment target is linked. Link a Railway service and environment first.' }
  }
  if (target.linkState === 'invalid') {
    return { ok: false, decision: input.decision, status: 'blocked', code: 'invalid_target', error: target.linkError ?? 'The deployment target is invalid. Re-link it before releasing.' }
  }

  const authority = await releaseAuthorityFor(input.projectId, input.actorUserId)
  if (!authority.allowed) {
    return { ok: false, decision: input.decision, status: 'blocked', code: 'not_authorized', error: authority.reason ?? 'You are not authorized to approve a release.' }
  }

  // OAuth connections request only viewer scopes, so they can observe but never
  // release. Fail closed with guidance to reconnect with a deploy-capable token.
  const connection = (await listAppIntegrations(target.orgId).catch(() => [])).find((row) => row.kind === 'railway')
  if (connection?.configJson?.authType === 'oauth') {
    return {
      ok: false,
      decision: input.decision,
      status: 'blocked',
      code: 'oauth_observation_only',
      error: 'Railway was connected with OAuth, which is observation-only. Reconnect Railway with a workspace or project token to release.',
    }
  }

  if (input.decision === 'rejected') {
    const approval = await insertApproval(sql, { ...input, targetId: target.targetId, approverRole: authority.role ?? 'unknown' })
    const [record] = await sql<DeploymentRecordRow[]>`
      INSERT INTO deployment_records (deployment_id, project_id, target_id, run_id, approval_id, status, error, requested_by)
      VALUES (${randomUUID()}, ${input.projectId}, ${target.targetId}, ${input.runId}, ${approval.approvalId}, 'rejected', ${input.reason ?? null}, ${input.actorUserId ?? null})
      RETURNING ${sql.unsafe(RECORD_COLS)}
    `
    return { ok: true, decision: 'rejected', status: 'rejected', record: record!, approval }
  }

  // Idempotency: a live record for this run+target already exists — never deploy twice.
  const existing = await findLiveRecord(input.runId, target.targetId)
  if (existing) {
    const approval = await insertApproval(sql, { ...input, targetId: target.targetId, approverRole: authority.role ?? 'unknown', superseded: true })
    return { ok: true, decision: 'approved', status: existing.status, record: existing, approval }
  }

  const approval = await insertApproval(sql, { ...input, targetId: target.targetId, approverRole: authority.role ?? 'unknown' })
  const [record] = await sql<DeploymentRecordRow[]>`
    INSERT INTO deployment_records (deployment_id, project_id, target_id, run_id, approval_id, status, requested_by, triggered_at)
    VALUES (${randomUUID()}, ${input.projectId}, ${target.targetId}, ${input.runId}, ${approval.approvalId}, 'in_progress', ${input.actorUserId ?? null}, now())
    ON CONFLICT (run_id, target_id) WHERE status <> 'rejected' DO NOTHING
    RETURNING ${sql.unsafe(RECORD_COLS)}
  `
  if (!record) {
    // A concurrent approver won the race; their deployment stands.
    const live = await findLiveRecord(input.runId, target.targetId)
    return { ok: true, decision: 'approved', status: live?.status ?? 'in_progress', record: live, approval }
  }

  try {
    const { deploymentId } = await triggerDeployment(target.orgId, targetRef(target))
    const [updated] = await sql<DeploymentRecordRow[]>`
      UPDATE deployment_records SET railway_deployment_id = ${deploymentId}, updated_at = now()
      WHERE deployment_id = ${record.deploymentId}
      RETURNING ${sql.unsafe(RECORD_COLS)}
    `
    deploymentLog.info('release triggered', { projectId: input.projectId, targetId: target.targetId, hasDeploymentId: Boolean(deploymentId) })
    return { ok: true, decision: 'approved', status: 'in_progress', record: updated ?? record, approval }
  } catch (error) {
    const message = error instanceof RailwayError ? error.message : error instanceof Error ? error.message : 'Railway did not accept the deployment.'
    const [failed] = await sql<DeploymentRecordRow[]>`
      UPDATE deployment_records SET status = 'failed', error = ${message}, completed_at = now(), updated_at = now()
      WHERE deployment_id = ${record.deploymentId}
      RETURNING ${sql.unsafe(RECORD_COLS)}
    `
    deploymentLog.warn('release trigger failed closed', { projectId: input.projectId, code: error instanceof RailwayError ? error.code : 'unknown', error: message })
    return { ok: false, decision: 'approved', status: 'failed', record: failed ?? record, approval, code: error instanceof RailwayError ? error.code : 'railway_error', error: message }
  }
}

async function insertApproval(sql: ReturnType<typeof getDb>, input: DecideReleaseInput & { targetId: string; approverRole: string; superseded?: boolean }): Promise<DeploymentApprovalRow> {
  const [row] = await sql<DeploymentApprovalRow[]>`
    INSERT INTO deployment_approvals (approval_id, project_id, target_id, run_id, approver_user_id, approver_role, decision, reason, superseded)
    VALUES (${randomUUID()}, ${input.projectId}, ${input.targetId}, ${input.runId}, ${input.actorUserId ?? null}, ${input.approverRole}, ${input.decision}, ${input.reason ?? null}, ${input.superseded ?? false})
    RETURNING approval_id AS "approvalId", project_id AS "projectId", target_id AS "targetId", run_id AS "runId",
      approver_user_id AS "approverUserId", approver_role AS "approverRole", decision, reason, superseded, decided_at AS "decidedAt"
  `
  return row!
}

// ---- reconciliation ----

export interface ReconcileResult {
  record: DeploymentRecordRow
  changed: boolean
}

/**
 * Reconcile an in-progress release from Railway. A record that never reaches a
 * terminal state within the timeout becomes `unconfirmed` (never delivered).
 */
export async function reconcileDeployment(deploymentId: string): Promise<ReconcileResult | undefined> {
  const sql = getDb()
  const record = await getDeploymentRecord(deploymentId)
  if (!record || record.status !== 'in_progress') return record ? { record, changed: false } : undefined
  const target = await getDeploymentTarget(record.projectId)
  if (!target) return { record, changed: false }

  if (record.triggeredAt && Date.now() - Date.parse(record.triggeredAt) > DEPLOYMENT_TIMEOUT_MS) {
    const [updated] = await sql<DeploymentRecordRow[]>`
      UPDATE deployment_records SET status = 'unconfirmed', error = ${'The deployment did not reach a confirmed state in time. Check it in Railway, then refresh.'}, completed_at = now(), updated_at = now()
      WHERE deployment_id = ${deploymentId} RETURNING ${sql.unsafe(RECORD_COLS)}
    `
    return { record: updated ?? record, changed: true }
  }

  try {
    const deployment = await getLatestDeployment(target.orgId, targetRef(target))
    if (deployment.status === 'success') {
      const [updated] = await sql<DeploymentRecordRow[]>`
        UPDATE deployment_records SET status = 'success', railway_status = ${deployment.railwayStatus}, service_url = ${deployment.serviceUrl}, deployment_url = ${deployment.deploymentUrl}, railway_deployment_id = COALESCE(${deployment.id}, railway_deployment_id), completed_at = now(), updated_at = now()
        WHERE deployment_id = ${deploymentId} RETURNING ${sql.unsafe(RECORD_COLS)}
      `
      return { record: updated ?? record, changed: true }
    }
    if (deployment.status === 'failed') {
      const [updated] = await sql<DeploymentRecordRow[]>`
        UPDATE deployment_records SET status = 'failed', railway_status = ${deployment.railwayStatus}, error = ${'Railway reported the deployment failed. Check the build logs in Railway.'}, completed_at = now(), updated_at = now()
        WHERE deployment_id = ${deploymentId} RETURNING ${sql.unsafe(RECORD_COLS)}
      `
      return { record: updated ?? record, changed: true }
    }
    const [updated] = await sql<DeploymentRecordRow[]>`
      UPDATE deployment_records SET railway_status = ${deployment.railwayStatus}, railway_deployment_id = COALESCE(${deployment.id}, railway_deployment_id), updated_at = now()
      WHERE deployment_id = ${deploymentId} RETURNING ${sql.unsafe(RECORD_COLS)}
    `
    return { record: updated ?? record, changed: false }
  } catch (error) {
    deploymentLog.warn('deployment reconciliation failed', { deploymentId, error: error instanceof Error ? error.message : String(error) })
    return { record, changed: false }
  }
}

/** Reconcile every in-progress record for a project. */
export async function reconcileProjectDeployments(projectId: string): Promise<void> {
  const sql = getDb()
  const rows = await sql<Array<{ deploymentId: string }>>`SELECT deployment_id AS "deploymentId" FROM deployment_records WHERE project_id = ${projectId} AND status = 'in_progress'`
  for (const row of rows) await reconcileDeployment(row.deploymentId).catch(() => undefined)
}

// ---- deterministic markdown ----

const MARK_STATUS: Record<string, string> = {
  success: 'SUCCESS',
  failed: 'FAILED',
  rejected: 'REJECTED',
  unconfirmed: 'UNCONFIRMED',
  in_progress: 'IN_PROGRESS',
  pending_approval: 'IN_PROGRESS',
  unknown: 'UNKNOWN',
}

function renderDeploymentMarkdown(input: {
  target: DeploymentTargetRow | undefined
  status: DeploymentStatusView
  history: DeploymentRecordRow[]
  generatedAt: string
  noTarget?: boolean
}): string {
  const { target, status, history, generatedAt } = input
  const latest = history[0]
  const mapped = input.noTarget ? 'NO_TARGET' : latest ? MARK_STATUS[latest.status] ?? 'UNKNOWN' : status.state === 'success' ? 'SUCCESS' : status.state === 'failed' ? 'FAILED' : 'UNKNOWN'
  const lines: string[] = ['# Deployment status', `Deployment Status: ${mapped}`]
  if (target) {
    lines.push(`_Generated ${generatedAt} · Railway ${target.railwayProjectName} / ${target.serviceName} / ${target.environmentName}_`)
    lines.push('')
    lines.push(`Target: ${target.serviceName} @ ${target.environmentName} (Railway project ${target.railwayProjectName})`)
    lines.push(`Service URL: ${target.serviceUrl ?? '—'}`)
    lines.push(`Last deployment: ${status.state} at ${status.lastDeployedAt ?? '—'} — ${status.deploymentUrl ?? '—'}`)
    if (target.linkState === 'invalid') lines.push(`Link: invalid — ${target.linkError ?? 're-link the deployment target'}`)
  } else {
    lines.push(`_Generated ${generatedAt} · no Railway deployment target linked_`)
    lines.push('')
    lines.push('No deployment performed — this project delivers by merge only.')
  }
  lines.push('')
  lines.push('## History')
  if (!history.length) lines.push('- _No deployment attempts recorded._')
  for (const record of history) {
    lines.push(`- ${record.createdAt} ${record.status} ${record.deploymentUrl ?? '—'}${record.error ? ` — ${record.error}` : ''}`)
  }
  return lines.join('\n')
}

// ---- read-only agent tool ----

export interface DeploymentToolDefinition {
  name: string
  label: string
  description: string
  parameters: Record<string, unknown>
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }>; details: Record<string, unknown> }>
}

/**
 * The single read-only `deployment_status` tool, registered only for a linked
 * project. It exposes state and history and no way to deploy, cancel, roll back
 * or reconfigure Railway, and never a credential.
 */
export async function buildDeploymentTools(context: { projectId: string }): Promise<DeploymentToolDefinition[]> {
  const target = await getDeploymentTarget(context.projectId)
  if (!target) return []
  return [
    {
      name: 'deployment_status',
      label: 'Deployment status',
      description: 'Read the project\'s current Railway deployment state (target, normalized status, service URL, last deployment time, link validity) and recent deployment history. Read-only: it cannot deploy, cancel, roll back or reconfigure anything.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      async execute() {
        // Always the run's own project: an agent-supplied project id must never
        // reach another project or organization (FR-006/FR-026).
        const view = await getProjectDeployment(context.projectId)
        const lines = [
          `Deployment target: ${view.target ? `${view.target.serviceName} @ ${view.target.environmentName} (${view.target.railwayProjectName})` : 'none'}`,
          `Link state: ${view.target?.linkState ?? 'n/a'}`,
          `Current state: ${view.status?.state ?? 'unknown'}${view.status?.railwayStatus ? ` (Railway ${view.status.railwayStatus})` : ''}`,
          `Service URL: ${view.status?.serviceUrl ?? '—'}`,
          `Last deployment: ${view.status?.lastDeployedAt ?? '—'}`,
        ]
        if (view.status?.message) lines.push(`Note: ${view.status.message}`)
        lines.push('', 'Recent history:')
        if (!view.history.length) lines.push('- none')
        for (const record of view.history.slice(0, 10)) lines.push(`- ${record.createdAt} ${record.status}${record.error ? ` — ${record.error}` : ''}`)
        return { content: [{ type: 'text', text: lines.join('\n') }], details: {} }
      },
    },
  ]
}
