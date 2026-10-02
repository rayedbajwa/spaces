import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { closeDb, getDb } from '../src/lib/db'
import { createProject } from '../src/lib/project-registry'
import { upsertAppIntegration } from '../src/lib/app-integrations'
import { getDeploymentRecord, linkDeploymentTarget, reconcileDeployment, refreshDeploymentStatus } from '../src/lib/deployment'
import { defaultMockRailway, startMockRailway, type MockRailwayServer } from './helpers/mock-railway'

async function databaseReachable(): Promise<boolean> {
  try {
    await getDb()`SELECT 1 FROM deployment_records LIMIT 1`
    return true
  } catch (error) {
    const message = String(error)
    if (/deployment_records/.test(message) && /does not exist/i.test(message)) throw new Error('deployment_records is missing; run `bun run db:migrate` before this suite.')
    return false
  }
}

const live = await databaseReachable()
const suite = live ? describe : describe.skip
if (!live) test.skip('deployment status tests skipped: DATABASE_URL is not reachable', () => {})

const TOKEN = '<SECRET_17>'

suite('Deployment status and evidence', () => {
  const sql = getDb()
  const suffix = randomUUID().slice(0, 8)
  const orgId = randomUUID()
  const teamId = randomUUID()
  const ownerId = randomUUID()
  let projectId = ''
  let featureDir = ''
  let mock: MockRailwayServer
  const originalUrl = process.env.RAILWAY_API_URL

  beforeAll(async () => {
    await sql`INSERT INTO organizations (org_id, name, slug) VALUES (${orgId}, ${`Status test ${suffix}`}, ${`status-test-${suffix}`})`
    await sql`INSERT INTO users (user_id, email, name) VALUES (${ownerId}, ${`status-owner-${suffix}@example.test`}, 'Owner')`
    await sql`INSERT INTO teams (team_id, org_id, name, slug, created_by) VALUES (${teamId}, ${orgId}, ${`Status team ${suffix}`}, ${`status-team-${suffix}`}, ${ownerId})`
    await sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}, ${ownerId}, 'owner')`
    const project = await createProject({ name: `Status project ${suffix}`, slug: `status-project-${suffix}`, teamId, createdBy: ownerId })
    projectId = project.projectId
    featureDir = await mkdtemp(path.join(tmpdir(), 'spaces-deploy-status-'))
    mock = startMockRailway(defaultMockRailway({ token: TOKEN }))
    process.env.RAILWAY_API_URL = mock.url
    await upsertAppIntegration({ orgId, kind: 'railway', status: 'connected', config: { tokenType: 'workspace' }, credentials: { access_token: TOKEN, isPat: true } })
  })

  afterAll(async () => {
    await mock.stop()
    if (originalUrl === undefined) delete process.env.RAILWAY_API_URL
    else process.env.RAILWAY_API_URL = originalUrl
    if (featureDir) await rm(featureDir, { recursive: true, force: true })
    if (projectId) {
      await sql`DELETE FROM deployment_records WHERE project_id = ${projectId}`.catch(() => undefined)
      await sql`DELETE FROM deployment_approvals WHERE project_id = ${projectId}`.catch(() => undefined)
      await sql`DELETE FROM project_deployment_targets WHERE project_id = ${projectId}`.catch(() => undefined)
      await sql`DELETE FROM projects WHERE project_id = ${projectId}`
    }
    await sql`DELETE FROM app_integrations WHERE org_id = ${orgId}`
    await sql`DELETE FROM teams WHERE team_id = ${teamId}`
    await sql`DELETE FROM organizations WHERE org_id = ${orgId}`
    await sql`DELETE FROM users WHERE user_id = ${ownerId}`
    await closeDb()
  })

  beforeEach(async () => {
    await sql`DELETE FROM deployment_records WHERE project_id = ${projectId}`.catch(() => undefined)
    await sql`DELETE FROM deployment_approvals WHERE project_id = ${projectId}`.catch(() => undefined)
    await sql`DELETE FROM project_deployment_targets WHERE project_id = ${projectId}`.catch(() => undefined)
    mock.state.deployments = { 'svc-1:env-1': { id: 'dep-1', status: 'SUCCESS', createdAt: '2026-10-01T10:00:00.000Z', staticUrl: 'https://acme-web.up.railway.app' } }
  })

  test('TC-DSTAT-001: an unlinked project writes an explicit NO_TARGET artifact', async () => {
    const snapshot = await refreshDeploymentStatus(projectId, { featureDirAbs: featureDir })
    const markdown = await readFile(path.join(featureDir, 'deployment-status.md'), 'utf8')
    expect(markdown).toContain('Deployment Status: NO_TARGET')
    expect(markdown).toContain('No deployment performed')
    expect(snapshot.markdown).toBe(markdown.trim())
  })

  test('TC-DSTAT-002: refresh distinguishes confirmed success from in-flight and updates last_checked_at', async () => {
    await linkDeploymentTarget({ projectId, orgId, workspaceId: 'ws-1', railwayProjectId: 'proj-1', serviceId: 'svc-1', environmentId: 'env-1', actorUserId: ownerId })
    const confirmed = await refreshDeploymentStatus(projectId, { featureDirAbs: featureDir })
    expect(confirmed.status.state).toBe('success')
    expect(confirmed.status.serviceUrl).toBe('https://acme-web.up.railway.app')
    expect(confirmed.target?.lastCheckedAt).toBeTruthy()
    const markdown = await readFile(path.join(featureDir, 'deployment-status.md'), 'utf8')
    expect(markdown).toContain('Deployment Status: SUCCESS')
    expect(markdown).toContain('web @ production')

    mock.state.deployments['svc-1:env-1'] = { id: 'dep-2', status: 'BUILDING', createdAt: '2026-10-02T10:00:00.000Z' }
    const building = await refreshDeploymentStatus(projectId)
    expect(building.status.state).toBe('building')
    expect(building.status.state).not.toBe('success')
  })

  test('TC-DSTAT-003: the provider map covers every normalized state', async () => {
    await linkDeploymentTarget({ projectId, orgId, workspaceId: 'ws-1', railwayProjectId: 'proj-1', serviceId: 'svc-1', environmentId: 'env-1', actorUserId: ownerId })
    const cases: Array<[string, string]> = [['QUEUED', 'queued'], ['DEPLOYING', 'deploying'], ['WAITING', 'in_progress'], ['FAILED', 'failed'], ['CRASHED', 'failed'], ['SLEEPING', 'sleeping'], ['REMOVED', 'unknown']]
    for (const [railway, expected] of cases) {
      mock.state.deployments['svc-1:env-1'] = { id: `dep-${railway}`, status: railway, createdAt: '2026-10-02T10:00:00.000Z' }
      const snapshot = await refreshDeploymentStatus(projectId)
      expect(snapshot.status.state).toBe(expected)
    }
  })

  test('TC-DSTAT-004: an inaccessible target is invalid, never stale-current, with re-link guidance', async () => {
    await linkDeploymentTarget({ projectId, orgId, workspaceId: 'ws-1', railwayProjectId: 'proj-1', serviceId: 'svc-1', environmentId: 'env-1', actorUserId: ownerId })
    await refreshDeploymentStatus(projectId)
    await sql`UPDATE project_deployment_targets SET environment_id = 'env-gone' WHERE project_id = ${projectId}`
    const snapshot = await refreshDeploymentStatus(projectId, { featureDirAbs: featureDir })
    expect(snapshot.target?.linkState).toBe('invalid')
    expect(snapshot.target?.linkError).toContain('Re-link')
    expect(snapshot.status.state).toBe('unknown')
    const markdown = await readFile(path.join(featureDir, 'deployment-status.md'), 'utf8')
    expect(markdown).toContain('Link: invalid')
  })

  test('TC-DSTAT-005: an in-progress release that times out reconciles to unconfirmed, not success', async () => {
    await linkDeploymentTarget({ projectId, orgId, workspaceId: 'ws-1', railwayProjectId: 'proj-1', serviceId: 'svc-1', environmentId: 'env-1', actorUserId: ownerId })
    const deploymentId = randomUUID()
    await sql`INSERT INTO deployment_records (deployment_id, project_id, target_id, status, triggered_at)
      SELECT ${deploymentId}, ${projectId}, target_id, 'in_progress', now() - interval '2 hours' FROM project_deployment_targets WHERE project_id = ${projectId}`
    const result = await reconcileDeployment(deploymentId)
    expect(result?.changed).toBe(true)
    expect(result?.record.status).toBe('unconfirmed')
    const stored = await getDeploymentRecord(deploymentId)
    expect(stored?.status).toBe('unconfirmed')
  })

  test('TC-DSTAT-006: a successful Railway deployment reconciles an in-progress record to success', async () => {
    await linkDeploymentTarget({ projectId, orgId, workspaceId: 'ws-1', railwayProjectId: 'proj-1', serviceId: 'svc-1', environmentId: 'env-1', actorUserId: ownerId })
    const deploymentId = randomUUID()
    await sql`INSERT INTO deployment_records (deployment_id, project_id, target_id, status, triggered_at)
      SELECT ${deploymentId}, ${projectId}, target_id, 'in_progress', now() FROM project_deployment_targets WHERE project_id = ${projectId}`
    const result = await reconcileDeployment(deploymentId)
    expect(result?.record.status).toBe('success')
    expect(result?.record.serviceUrl).toBe('https://acme-web.up.railway.app')
  })
})
