import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { closeDb, getDb } from '../src/lib/db'
import { createProject } from '../src/lib/project-registry'
import { upsertAppIntegration } from '../src/lib/app-integrations'
import { decideRelease, linkDeploymentTarget, reconcileDeployment, releaseAuthorityFor } from '../src/lib/deployment'
import { defaultMockRailway, startMockRailway, type MockRailwayServer } from './helpers/mock-railway'

async function databaseReachable(): Promise<boolean> {
  try {
    await getDb()`SELECT 1 FROM deployment_approvals LIMIT 1`
    return true
  } catch (error) {
    const message = String(error)
    if (/deployment_approvals/.test(message) && /does not exist/i.test(message)) throw new Error('deployment_approvals is missing; run `bun run db:migrate` before this suite.')
    return false
  }
}

const live = await databaseReachable()
const suite = live ? describe : describe.skip
if (!live) test.skip('deployment approval tests skipped: DATABASE_URL is not reachable', () => {})

const TOKEN = '<SECRET_18>'

suite('Release approval and exactly-once deployment', () => {
  const sql = getDb()
  const suffix = randomUUID().slice(0, 8)
  const orgId = randomUUID()
  const teamId = randomUUID()
  const ownerId = randomUUID()
  const memberId = randomUUID()
  let projectId = ''
  let mock: MockRailwayServer
  const originalUrl = process.env.RAILWAY_API_URL
  const runIds: string[] = []

  async function newRunId(): Promise<string> {
    const runId = randomUUID()
    runIds.push(runId)
    await sql`INSERT INTO pipeline_runs (run_id, project_namespace, project_label, project_path, pipeline_name, status, options_json, template_json)
      VALUES (${runId}, ${`approval-${suffix}`}, 'Approval project', '/tmp/approval-test', 'aidlc-feature', 'paused', ${sql.json({} as never)}, ${sql.json({} as never)})`
    return runId
  }

  beforeAll(async () => {
    await sql`INSERT INTO organizations (org_id, name, slug) VALUES (${orgId}, ${`Approval test ${suffix}`}, ${`approval-test-${suffix}`})`
    await sql`INSERT INTO users (user_id, email, name) VALUES
      (${ownerId}, ${`approval-owner-${suffix}@example.test`}, 'Owner'),
      (${memberId}, ${`approval-member-${suffix}@example.test`}, 'Member')`
    await sql`INSERT INTO teams (team_id, org_id, name, slug, created_by) VALUES (${teamId}, ${orgId}, ${`Approval team ${suffix}`}, ${`approval-team-${suffix}`}, ${ownerId})`
    await sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}, ${ownerId}, 'owner'), (${teamId}, ${memberId}, 'member')`
    const project = await createProject({ name: `Approval project ${suffix}`, slug: `approval-project-${suffix}`, teamId, createdBy: ownerId })
    projectId = project.projectId
    mock = startMockRailway(defaultMockRailway({ token: TOKEN }))
    process.env.RAILWAY_API_URL = mock.url
    await upsertAppIntegration({ orgId, kind: 'railway', status: 'connected', config: { tokenType: 'workspace' }, credentials: { access_token: TOKEN, isPat: true } })
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
    await sql`DELETE FROM app_integrations WHERE org_id = ${orgId}`
    await sql`DELETE FROM teams WHERE team_id = ${teamId}`
    await sql`DELETE FROM organizations WHERE org_id = ${orgId}`
    await sql`DELETE FROM users WHERE user_id IN (${ownerId}, ${memberId})`
    await closeDb()
  })

  beforeEach(async () => {
    mock.state.triggerCount = 0
    mock.state.failNextTrigger = false
    await sql`DELETE FROM deployment_records WHERE project_id = ${projectId}`.catch(() => undefined)
    await sql`DELETE FROM deployment_approvals WHERE project_id = ${projectId}`.catch(() => undefined)
    await sql`DELETE FROM project_deployment_targets WHERE project_id = ${projectId}`.catch(() => undefined)
    await linkDeploymentTarget({ projectId, orgId, workspaceId: 'ws-1', railwayProjectId: 'proj-1', serviceId: 'svc-1', environmentId: 'env-1', actorUserId: ownerId })
  })

  test('TC-APPR-001: no approval decision means zero records and zero Railway calls', async () => {
    const records = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM deployment_records WHERE project_id = ${projectId}`
    expect(records[0]!.n).toBe(0)
    expect(mock.state.triggerCount).toBe(0)
  })

  test('TC-APPR-002: one approval records approver, time and target and triggers once', async () => {
    const runId = await newRunId()
    const result = await decideRelease({ runId, projectId, decision: 'approved', actorUserId: ownerId })
    expect(result.ok).toBe(true)
    expect(mock.state.triggerCount).toBe(1)
    const [approval] = await sql<Array<{ approverUserId: string; decision: string; approverRole: string; decidedAt: string }>>`SELECT approver_user_id AS "approverUserId", decision, approver_role AS "approverRole", decided_at AS "decidedAt" FROM deployment_approvals WHERE run_id = ${runId}`
    expect(approval!.approverUserId).toBe(ownerId)
    expect(approval!.decision).toBe('approved')
    expect(approval!.decidedAt).toBeTruthy()
    const [record] = await sql<Array<{ targetId: string; status: string; requestedBy: string; triggeredAt: string }>>`SELECT target_id AS "targetId", status, requested_by AS "requestedBy", triggered_at AS "triggeredAt" FROM deployment_records WHERE run_id = ${runId}`
    expect(record!.targetId).toBeTruthy()
    expect(record!.requestedBy).toBe(ownerId)
    expect(record!.triggeredAt).toBeTruthy()
  })

  test('TC-APPR-003: a second approval for the same run+target is superseded, with no second trigger', async () => {
    const runId = await newRunId()
    await decideRelease({ runId, projectId, decision: 'approved', actorUserId: ownerId })
    const second = await decideRelease({ runId, projectId, decision: 'approved', actorUserId: ownerId })
    expect(second.ok).toBe(true)
    expect(mock.state.triggerCount).toBe(1)
    const [superseded] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM deployment_approvals WHERE run_id = ${runId} AND superseded = true`
    expect(superseded!.n).toBe(1)
    const [records] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM deployment_records WHERE run_id = ${runId} AND status <> 'rejected'`
    expect(records!.n).toBe(1)
  })

  test('TC-APPR-004: rejection records the reason, deploys nothing and is not delivered', async () => {
    const runId = await newRunId()
    const result = await decideRelease({ runId, projectId, decision: 'rejected', reason: 'QA incomplete', actorUserId: ownerId })
    expect(result.ok).toBe(true)
    expect(result.status).toBe('rejected')
    expect(mock.state.triggerCount).toBe(0)
    const [record] = await sql<Array<{ status: string; error: string }>>`SELECT status, error FROM deployment_records WHERE run_id = ${runId}`
    expect(record!.status).toBe('rejected')
    expect(record!.error).toBe('QA incomplete')
  })

  test('TC-APPR-005: an ordinary team member cannot approve; nothing is written', async () => {
    const runId = await newRunId()
    const denied = await decideRelease({ runId, projectId, decision: 'approved', actorUserId: memberId })
    expect(denied.ok).toBe(false)
    expect(denied.code).toBe('not_authorized')
    expect((await releaseAuthorityFor(projectId, memberId)).allowed).toBe(false)
    expect(mock.state.triggerCount).toBe(0)
    const [records] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM deployment_records WHERE run_id = ${runId}`
    expect(records!.n).toBe(0)
  })

  test('TC-APPR-006: a failed trigger fails closed with an actionable record and no success', async () => {
    const runId = await newRunId()
    mock.state.failNextTrigger = true
    const result = await decideRelease({ runId, projectId, decision: 'approved', actorUserId: ownerId })
    expect(result.ok).toBe(false)
    expect(result.record?.status).toBe('failed')
    expect(result.error).toBeTruthy()
  })

  test('TC-APPR-007: approval for a project with no target is blocked with guidance', async () => {
    await sql`DELETE FROM project_deployment_targets WHERE project_id = ${projectId}`
    const runId = await newRunId()
    const result = await decideRelease({ runId, projectId, decision: 'approved', actorUserId: ownerId })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('no_target')
    expect(result.error).toContain('Link a Railway service')
  })

  test('TC-APPR-008: a confirmed release reconciles to success and identifies who/when/target', async () => {
    const runId = await newRunId()
    const result = await decideRelease({ runId, projectId, decision: 'approved', actorUserId: ownerId })
    mock.state.deployments['svc-1:env-1'] = { id: 'dep-final', status: 'SUCCESS', createdAt: new Date().toISOString(), staticUrl: 'https://acme-web.up.railway.app' }
    const reconciled = await reconcileDeployment(result.record!.deploymentId)
    expect(reconciled?.record.status).toBe('success')
    const [row] = await sql<Array<{ completedAt: string; railwayDeploymentId: string }>>`SELECT completed_at AS "completedAt", railway_deployment_id AS "railwayDeploymentId" FROM deployment_records WHERE deployment_id = ${result.record!.deploymentId}`
    expect(row!.completedAt).toBeTruthy()
    expect(row!.railwayDeploymentId).toBeTruthy()
  })
})
