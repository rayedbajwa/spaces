import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { closeDb, getDb } from '../src/lib/db'
import { createProject } from '../src/lib/project-registry'
import { upsertAppIntegration, getAppIntegration, getAppIntegrationCredentials, disconnectAppIntegration, listAppIntegrations } from '../src/lib/app-integrations'
import {
  buildDeploymentTools,
  decideRelease,
  getDeploymentTarget,
  getProjectDeployment,
  linkDeploymentTarget,
  listAccessibleTargets,
  refreshDeploymentStatus,
  releaseAuthorityFor,
  unlinkDeploymentTarget,
} from '../src/lib/deployment'
import { listResponsibilities, replaceAssignments } from '../src/lib/project-responsibilities'
import { defaultMockRailway, startMockRailway, type MockRailwayServer } from './helpers/mock-railway'

async function databaseReachable(): Promise<boolean> {
  try {
    await getDb()`SELECT 1 FROM project_deployment_targets LIMIT 1`
    return true
  } catch (error) {
    const message = String(error)
    if (/project_deployment_targets/.test(message) && /does not exist/i.test(message)) {
      throw new Error('project_deployment_targets is missing; run `bun run db:migrate` before this suite.')
    }
    return false
  }
}

const live = await databaseReachable()
const suite = live ? describe : describe.skip
if (!live) test.skip('deployment integration tests skipped: DATABASE_URL is not reachable', () => {})

const TOKEN = '<SECRET_16>'

suite('Railway deployment integration', () => {
  const sql = getDb()
  const suffix = randomUUID().slice(0, 8)
  const orgId = randomUUID()
  const otherOrgId = randomUUID()
  const teamId = randomUUID()
  const otherTeamId = randomUUID()
  const ownerId = randomUUID()
  const releaseManagerId = randomUUID()
  const memberId = randomUUID()
  const outsiderId = randomUUID()
  let projectId = ''
  const runIds: string[] = []
  let mock: MockRailwayServer

  async function newRunId(): Promise<string> {
    const runId = randomUUID()
    runIds.push(runId)
    await sql`INSERT INTO pipeline_runs (run_id, project_namespace, project_label, project_path, pipeline_name, status, options_json, template_json)
      VALUES (${runId}, ${`deploy-project-${suffix}`}, 'Deploy project', '/tmp/deploy-test', 'aidlc-feature', 'paused', ${sql.json({} as never)}, ${sql.json({} as never)})`
    return runId
  }
  const originalUrl = process.env.RAILWAY_API_URL

  beforeAll(async () => {
    await sql`INSERT INTO organizations (org_id, name, slug) VALUES (${orgId}, ${`Deploy test ${suffix}`}, ${`deploy-test-${suffix}`}), (${otherOrgId}, ${`Deploy other ${suffix}`}, ${`deploy-other-${suffix}`})`
    await sql`INSERT INTO users (user_id, email, name) VALUES
      (${ownerId}, ${`owner-${suffix}@example.test`}, 'Owner'),
      (${releaseManagerId}, ${`release-${suffix}@example.test`}, 'Release Manager'),
      (${memberId}, ${`member-${suffix}@example.test`}, 'Member'),
      (${outsiderId}, ${`outsider-${suffix}@example.test`}, 'Outsider')`
    await sql`INSERT INTO teams (team_id, org_id, name, slug, created_by) VALUES
      (${teamId}, ${orgId}, ${`Deploy team ${suffix}`}, ${`deploy-team-${suffix}`}, ${ownerId}),
      (${otherTeamId}, ${otherOrgId}, ${`Other team ${suffix}`}, ${`deploy-other-team-${suffix}`}, ${ownerId})`
    await sql`INSERT INTO team_members (team_id, user_id, role) VALUES
      (${teamId}, ${ownerId}, 'owner'),
      (${teamId}, ${releaseManagerId}, 'member'),
      (${teamId}, ${memberId}, 'member')`
    const project = await createProject({ name: `Deploy project ${suffix}`, slug: `deploy-project-${suffix}`, teamId, createdBy: ownerId })
    projectId = project.projectId
    mock = startMockRailway(defaultMockRailway({ token: TOKEN }))
    process.env.RAILWAY_API_URL = mock.url
  })

  afterAll(async () => {
    await mock.stop()
    if (originalUrl === undefined) delete process.env.RAILWAY_API_URL
    else process.env.RAILWAY_API_URL = originalUrl
    await sql`DELETE FROM pipeline_runs WHERE run_id IN ${sql(runIds)}`.catch(() => undefined)
    if (projectId) {
      await sql`DELETE FROM deployment_records WHERE project_id = ${projectId}`.catch(() => undefined)
      await sql`DELETE FROM deployment_approvals WHERE project_id = ${projectId}`.catch(() => undefined)
      await sql`DELETE FROM project_deployment_targets WHERE project_id = ${projectId}`.catch(() => undefined)
      await sql`DELETE FROM projects WHERE project_id = ${projectId}`
    }
    await sql`DELETE FROM app_integrations WHERE org_id IN (${orgId}, ${otherOrgId})`
    await sql`DELETE FROM teams WHERE team_id IN (${teamId}, ${otherTeamId})`
    await sql`DELETE FROM organizations WHERE org_id IN (${orgId}, ${otherOrgId})`
    await sql`DELETE FROM users WHERE user_id IN (${ownerId}, ${releaseManagerId}, ${memberId}, ${outsiderId})`
    await closeDb()
  })

  beforeEach(async () => {
    mock.state.triggerCount = 0
    mock.state.failNextTrigger = false
    mock.state.rejectAuth = false
    await sql`DELETE FROM deployment_records WHERE project_id = ${projectId}`.catch(() => undefined)
    await sql`DELETE FROM deployment_approvals WHERE project_id = ${projectId}`.catch(() => undefined)
    await sql`DELETE FROM project_deployment_targets WHERE project_id = ${projectId}`.catch(() => undefined)
    // Delete rather than disconnect: upsert merges config, so a leftover
    // `authType: oauth` would leak into the next test.
    await sql`DELETE FROM app_integrations WHERE org_id = ${orgId} AND kind = 'railway'`.catch(() => undefined)
  })

  test('TC-DEP-001: a connected Railway token is sealed and never returned', async () => {
    await upsertAppIntegration({
      orgId,
      kind: 'railway',
      status: 'connected',
      displayName: 'Railway (Acme)',
      config: { authType: 'token', tokenType: 'workspace', workspaceId: 'ws-1', workspaceName: 'Acme Workspace' },
      credentials: { access_token: TOKEN, isPat: true, tokenType: 'workspace' },
    })
    const row = await getAppIntegration(orgId, 'railway')
    expect(row?.status).toBe('connected')
    const listed = await listAppIntegrations(orgId)
    const railway = listed.find((r) => r.kind === 'railway')!
    expect(railway.credentialsOk).toBe(true)
    expect(JSON.stringify(listed)).not.toContain(TOKEN)
    const stored = await sql<Array<{ credentialsJson: unknown }>>`SELECT credentials_json AS "credentialsJson" FROM app_integrations WHERE org_id = ${orgId} AND kind = 'railway'`
    expect(JSON.stringify(stored[0]?.credentialsJson)).not.toContain(TOKEN)
  })

  test('TC-DEP-002: a corrupted credential reports reconnect-needed, and disconnect destroys it', async () => {
    await upsertAppIntegration({ orgId, kind: 'railway', status: 'connected', config: { tokenType: 'workspace' }, credentials: { access_token: TOKEN, isPat: true } })
    expect((await listAppIntegrations(orgId)).find((r) => r.kind === 'railway')?.credentialsOk).toBe(true)
    await sql`UPDATE app_integrations SET credentials_json = ${sql.json({ ciphertext: 'not-decryptable' } as never)} WHERE org_id = ${orgId} AND kind = 'railway'`
    expect((await listAppIntegrations(orgId)).find((r) => r.kind === 'railway')?.credentialsOk).toBe(false)
    await disconnectAppIntegration(orgId, 'railway')
    expect(await getAppIntegrationCredentials(orgId, 'railway')).toBeUndefined()
    expect((await getAppIntegration(orgId, 'railway'))?.status).toBe('not_connected')
  })

  test('TC-DEP-003: accessible targets are the credential set only', async () => {
    await upsertAppIntegration({ orgId, kind: 'railway', status: 'connected', config: { tokenType: 'workspace' }, credentials: { access_token: TOKEN, isPat: true } })
    const targets = await listAccessibleTargets(orgId)
    expect(targets.map((w) => w.name)).toEqual(['Acme Workspace'])
    expect(targets[0]!.projects[0]!.services.map((s) => s.id)).toEqual(['svc-1', 'svc-2'])
  })

  test('TC-DEP-004: link, one target per project, invalid target rejected, unlink restores delivery', async () => {
    await upsertAppIntegration({ orgId, kind: 'railway', status: 'connected', config: { tokenType: 'workspace' }, credentials: { access_token: TOKEN, isPat: true } })
    const first = await linkDeploymentTarget({ projectId, orgId, workspaceId: 'ws-1', railwayProjectId: 'proj-1', serviceId: 'svc-1', environmentId: 'env-1', actorUserId: ownerId })
    expect(first.serviceName).toBe('web')
    expect(first.environmentName).toBe('production')

    await expect(linkDeploymentTarget({ projectId, orgId, workspaceId: 'ws-1', railwayProjectId: 'proj-1', serviceId: 'svc-999', environmentId: 'env-1' }))
      .rejects.toMatchObject({ code: 'inaccessible' })

    const second = await linkDeploymentTarget({ projectId, orgId, workspaceId: 'ws-1', railwayProjectId: 'proj-1', serviceId: 'svc-2', environmentId: 'env-2', actorUserId: ownerId })
    const all = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM project_deployment_targets WHERE project_id = ${projectId}`
    expect(all[0]!.n).toBe(1)
    expect(second.serviceId).toBe('svc-2')

    await unlinkDeploymentTarget(projectId)
    expect(await getDeploymentTarget(projectId)).toBeUndefined()
  })

  test('TC-DEP-005: refresh records status/URL/time and invalid link is marked with guidance', async () => {
    await upsertAppIntegration({ orgId, kind: 'railway', status: 'connected', config: { tokenType: 'workspace' }, credentials: { access_token: TOKEN, isPat: true } })
    await linkDeploymentTarget({ projectId, orgId, workspaceId: 'ws-1', railwayProjectId: 'proj-1', serviceId: 'svc-1', environmentId: 'env-1', actorUserId: ownerId })
    const snapshot = await refreshDeploymentStatus(projectId)
    expect(snapshot.status.state).toBe('success')
    expect(snapshot.status.serviceUrl).toBe('https://acme-web.up.railway.app')
    expect(snapshot.target?.lastDeployedAt).toBeTruthy()
    expect(snapshot.markdown).toContain('Deployment Status: SUCCESS')

    // Remove the target from Railway's answer: the link is invalid, not stale.
    await sql`UPDATE project_deployment_targets SET environment_id = 'env-gone' WHERE project_id = ${projectId}`
    const invalid = await refreshDeploymentStatus(projectId)
    expect(invalid.target?.linkState).toBe('invalid')
    expect(invalid.status.state).toBe('unknown')
    expect(invalid.status.message).toContain('Re-link')
  })

  test('TC-DEP-006: release authority is team owner/admin or the project Release Manager/Owner', async () => {
    expect((await releaseAuthorityFor(projectId, ownerId)).allowed).toBe(true)
    expect((await releaseAuthorityFor(projectId, memberId)).allowed).toBe(false)
    expect((await releaseAuthorityFor(projectId, outsiderId)).allowed).toBe(false)
    expect((await releaseAuthorityFor(projectId, null)).allowed).toBe(false)

    // A regular team member explicitly assigned the Release Manager responsibility may approve.
    const releaseManager = (await listResponsibilities(projectId)).find((item) => item.standardKey === 'release-manager')!
    expect(releaseManager).toBeTruthy()
    await replaceAssignments(projectId, releaseManager.responsibilityId, [releaseManagerId], ownerId)
    const positive = await releaseAuthorityFor(projectId, releaseManagerId)
    expect(positive.allowed).toBe(true)
    expect(positive.role).toBe('release-manager')
    // An ordinary member who is not assigned it still cannot approve.
    expect((await releaseAuthorityFor(projectId, memberId)).allowed).toBe(false)
    await replaceAssignments(projectId, releaseManager.responsibilityId, [], ownerId)
  })

  test('TC-DEP-015: AUTH_DISABLED single-user mode may release', async () => {
    const previous = process.env.AUTH_DISABLED
    process.env.AUTH_DISABLED = '1'
    try {
      await upsertAppIntegration({ orgId, kind: 'railway', status: 'connected', config: { tokenType: 'workspace' }, credentials: { access_token: TOKEN, isPat: true } })
      await linkDeploymentTarget({ projectId, orgId, workspaceId: 'ws-1', railwayProjectId: 'proj-1', serviceId: 'svc-1', environmentId: 'env-1', actorUserId: null })
      expect((await releaseAuthorityFor(projectId, null)).allowed).toBe(true)
      const result = await decideRelease({ runId: await newRunId(), projectId, decision: 'approved', actorUserId: null })
      expect(result.ok).toBe(true)
      expect(result.status).toBe('in_progress')
      expect(mock.state.triggerCount).toBe(1)
    } finally {
      if (previous === undefined) delete process.env.AUTH_DISABLED
      else process.env.AUTH_DISABLED = previous
    }
  })

  test('TC-DEP-016: an OAuth observation-only connection cannot release', async () => {
    await upsertAppIntegration({ orgId, kind: 'railway', status: 'connected', config: { authType: 'oauth', tokenType: 'workspace' }, credentials: { access_token: TOKEN } })
    await linkDeploymentTarget({ projectId, orgId, workspaceId: 'ws-1', railwayProjectId: 'proj-1', serviceId: 'svc-1', environmentId: 'env-1', actorUserId: ownerId })
    const result = await decideRelease({ runId: await newRunId(), projectId, decision: 'approved', actorUserId: ownerId })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('oauth_observation_only')
    expect(result.error).toContain('token')
    expect(mock.state.triggerCount).toBe(0)
  })

  test('TC-DEP-007: approval triggers exactly one deployment; a repeat decision is idempotent', async () => {
    await upsertAppIntegration({ orgId, kind: 'railway', status: 'connected', config: { tokenType: 'workspace' }, credentials: { access_token: TOKEN, isPat: true } })
    await linkDeploymentTarget({ projectId, orgId, workspaceId: 'ws-1', railwayProjectId: 'proj-1', serviceId: 'svc-1', environmentId: 'env-1', actorUserId: ownerId })
    const runId = await newRunId()
    const first = await decideRelease({ runId, projectId, decision: 'approved', actorUserId: ownerId })
    expect(first.ok).toBe(true)
    expect(first.status).toBe('in_progress')
    expect(first.record?.approvalId).toBeTruthy()
    expect(mock.state.triggerCount).toBe(1)

    const second = await decideRelease({ runId, projectId, decision: 'approved', actorUserId: ownerId })
    expect(second.record?.deploymentId).toBe(first.record?.deploymentId)
    expect(mock.state.triggerCount).toBe(1)
  })

  test('TC-DEP-008: rejection deploys nothing and an unauthorized approval fails closed', async () => {
    await upsertAppIntegration({ orgId, kind: 'railway', status: 'connected', config: { tokenType: 'workspace' }, credentials: { access_token: TOKEN, isPat: true } })
    await linkDeploymentTarget({ projectId, orgId, workspaceId: 'ws-1', railwayProjectId: 'proj-1', serviceId: 'svc-1', environmentId: 'env-1', actorUserId: ownerId })
    const rejected = await decideRelease({ runId: await newRunId(), projectId, decision: 'rejected', reason: 'not ready', actorUserId: ownerId })
    expect(rejected.ok).toBe(true)
    expect(rejected.status).toBe('rejected')
    expect(mock.state.triggerCount).toBe(0)

    const denied = await decideRelease({ runId: await newRunId(), projectId, decision: 'approved', actorUserId: memberId })
    expect(denied.ok).toBe(false)
    expect(denied.code).toBe('not_authorized')
    expect(mock.state.triggerCount).toBe(0)
  })

  test('TC-DEP-009: a viewer-only/denied credential fails a release closed', async () => {
    await upsertAppIntegration({ orgId, kind: 'railway', status: 'connected', config: { tokenType: 'workspace' }, credentials: { access_token: TOKEN, isPat: true } })
    await linkDeploymentTarget({ projectId, orgId, workspaceId: 'ws-1', railwayProjectId: 'proj-1', serviceId: 'svc-1', environmentId: 'env-1', actorUserId: ownerId })
    mock.state.failNextTrigger = true
    const result = await decideRelease({ runId: await newRunId(), projectId, decision: 'approved', actorUserId: ownerId })
    expect(result.ok).toBe(false)
    expect(result.status).toBe('failed')
    expect(result.record?.status).toBe('failed')
  })

  test('TC-DEP-010: cross-org targets are not reachable', async () => {
    await upsertAppIntegration({ orgId, kind: 'railway', status: 'connected', config: { tokenType: 'workspace' }, credentials: { access_token: TOKEN, isPat: true } })
    const targets = await listAccessibleTargets(otherOrgId).catch(() => [])
    expect(targets).toEqual([])
  })

  test('TC-DEP-011: the read-only tool exists only when linked and exposes no mutation or credential', async () => {
    expect(await buildDeploymentTools({ projectId })).toEqual([])
    await upsertAppIntegration({ orgId, kind: 'railway', status: 'connected', config: { tokenType: 'workspace' }, credentials: { access_token: TOKEN, isPat: true } })
    await linkDeploymentTarget({ projectId, orgId, workspaceId: 'ws-1', railwayProjectId: 'proj-1', serviceId: 'svc-1', environmentId: 'env-1', actorUserId: ownerId })
    const tools = await buildDeploymentTools({ projectId })
    expect(tools).toHaveLength(1)
    expect(tools[0]!.name).toBe('deployment_status')
    const serialized = JSON.stringify(tools)
    expect(serialized).not.toContain(TOKEN)
    for (const forbidden of ['trigger', 'cancel', 'rollback', 'mutation']) {
      expect(tools[0]!.name).not.toContain(forbidden)
    }
    expect(tools[0]!.description.toLowerCase()).toContain('read-only')
    const output = await tools[0]!.execute('call', { projectId })
    expect(output.content[0]!.text).toContain('Deployment target: web @ production')
    expect(output.content[0]!.text).not.toContain(TOKEN)
    // An arbitrary projectId is ignored: the tool always reads the run's project,
    // so it cannot cross a project or organization boundary (FR-006/FR-026).
    const ignored = await tools[0]!.execute('call', { projectId: randomUUID() })
    expect(ignored.content[0]!.text).toContain('Deployment target: web @ production')
    expect(JSON.stringify(tools[0]!.parameters)).not.toContain('projectId')
  })

  test('TC-DEP-013: the migration is idempotent and the Railway kind/provider are accepted', async () => {
    for (let i = 0; i < 2; i += 1) {
      const proc = Bun.spawn(['bun', 'run', 'db:migrate'], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe', env: { ...(process.env as Record<string, string>) } })
      const code = await proc.exited
      expect(code).toBe(0)
    }
    await upsertAppIntegration({ orgId, kind: 'railway', status: 'connected', config: { tokenType: 'workspace' }, credentials: { access_token: TOKEN, isPat: true } })
    const constraints = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name IN ('project_deployment_targets','deployment_records','deployment_approvals')`
    expect(constraints[0]!.n).toBe(3)
  })

  test('TC-DEP-014: no credential appears in API JSON, errors or generated markdown', async () => {
    await upsertAppIntegration({ orgId, kind: 'railway', status: 'connected', config: { tokenType: 'workspace', workspaceName: 'Acme Workspace' }, credentials: { access_token: TOKEN, isPat: true } })
    await linkDeploymentTarget({ projectId, orgId, workspaceId: 'ws-1', railwayProjectId: 'proj-1', serviceId: 'svc-1', environmentId: 'env-1', actorUserId: ownerId })
    const snapshot = await refreshDeploymentStatus(projectId)
    expect(snapshot.markdown).not.toContain(TOKEN)
    const view = await getProjectDeployment(projectId)
    expect(JSON.stringify(view)).not.toContain(TOKEN)
    mock.state.rejectAuth = true
    const invalid = await refreshDeploymentStatus(projectId)
    expect(JSON.stringify(invalid)).not.toContain(TOKEN)
    expect(invalid.target?.linkError).not.toContain(TOKEN)
  })

  test('TC-DEP-012: the project deployment view reports connection, target and history', async () => {
    await upsertAppIntegration({ orgId, kind: 'railway', status: 'connected', config: { tokenType: 'workspace', workspaceName: 'Acme Workspace' }, credentials: { access_token: TOKEN, isPat: true } })
    await linkDeploymentTarget({ projectId, orgId, workspaceId: 'ws-1', railwayProjectId: 'proj-1', serviceId: 'svc-1', environmentId: 'env-1', actorUserId: ownerId })
    const view = await getProjectDeployment(projectId)
    expect(view.connection.status).toBe('connected')
    expect(view.connection.workspaceName).toBe('Acme Workspace')
    expect(view.target?.serviceName).toBe('web')
    expect(view.target?.linkState).toBe('valid')
  })

  test('TC-DEP-017: unlinking keeps deployment history and removes the target', async () => {
    await upsertAppIntegration({ orgId, kind: 'railway', status: 'connected', config: { tokenType: 'workspace' }, credentials: { access_token: TOKEN, isPat: true } })
    await linkDeploymentTarget({ projectId, orgId, workspaceId: 'ws-1', railwayProjectId: 'proj-1', serviceId: 'svc-1', environmentId: 'env-1', actorUserId: ownerId })
    const release = await decideRelease({ runId: await newRunId(), projectId, decision: 'approved', actorUserId: ownerId })
    expect(release.ok).toBe(true)

    await unlinkDeploymentTarget(projectId)
    expect(await getDeploymentTarget(projectId)).toBeUndefined()
    const [record] = await sql<Array<{ targetId: string | null }>>`SELECT target_id AS "targetId" FROM deployment_records WHERE deployment_id = ${release.record!.deploymentId}`
    expect(record!.targetId).toBeNull()
    // The approval audit outlives the target it approved (FR-017/SC-008).
    const [approval] = await sql<Array<{ targetId: string | null; approverRole: string; decision: string; decidedAt: string | null }>>`
      SELECT target_id AS "targetId", approver_role AS "approverRole", decision, decided_at AS "decidedAt"
        FROM deployment_approvals WHERE approval_id = ${release.approval!.approvalId}`
    expect(approval).toBeTruthy()
    expect(approval!.targetId).toBeNull()
    expect(approval!.decision).toBe('approved')
    expect(approval!.approverRole).toBeTruthy()
    expect(approval!.decidedAt).toBeTruthy()
    const view = await getProjectDeployment(projectId)
    expect(view.target).toBeUndefined()
    expect(view.history.length).toBeGreaterThan(0)
  })
})
