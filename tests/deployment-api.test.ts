import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { getDb } from '../src/lib/db'
import { createProject } from '../src/lib/project-registry'
import { getAppIntegration, upsertAppIntegration } from '../src/lib/app-integrations'
import { saveOAuthApp } from '../src/lib/oauth-apps'
import { listResponsibilities, replaceAssignments } from '../src/lib/project-responsibilities'
import { defaultMockRailway, startMockRailway, type MockRailwayServer } from './helpers/mock-railway'
import { createGuardrailsPageFixture, type GuardrailsPageFixture } from './helpers/guardrails-page'

setDefaultTimeout(90_000)

/**
 * HTTP contract tests for the Railway deployment routes (010-railway-deployment).
 *
 * These cover the authorization boundaries the library tests cannot: org-admin
 * gating of credential management (FR-002), link/unlink/refresh project
 * authority (FR-009, FR-012), the delivery-gate approve/reject route (FR-016)
 * and the OAuth authorize → callback path (FR-003 / US1.8–9). Runs against the
 * checkout's own test database; the server is started on port 3369 with
 * `RAILWAY_API_URL` and `OAUTH_RAILWAY_TOKEN_URL` pointed at a local mock.
 */
const TOKEN = '{app.provider}'

let fixture: GuardrailsPageFixture
let mock: MockRailwayServer
let projectId = ''
let projectSlug = ''
let ownerCookie = ''
let memberCookie = ''
const runIds: string[] = []

async function api<T = any>(method: string, path: string, cookie?: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${fixture.baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: unknown = undefined
  try { parsed = text ? JSON.parse(text) : undefined } catch { parsed = text }
  return { status: res.status, body: parsed as T }
}

/** A paused delivery run for the linked project, with the open review gate the answer route resolves. */
async function pausedDeliverRun(): Promise<string> {
  const sql = getDb()
  const runId = randomUUID()
  runIds.push(runId)
  await sql`INSERT INTO pipeline_runs (run_id, project_id, project_namespace, project_label, project_path, pipeline_name, status, pause_kind, current_stage, options_json, template_json)
    VALUES (${runId}, ${projectId}, ${projectSlug}, 'Deployment API', '/tmp/deployment-api', 'aidlc-feature', 'paused', 'review', 'deliver', ${sql.json({} as never)}, ${sql.json({} as never)})`
  await sql`INSERT INTO pipeline_gates (gate_id, run_id, step_index, kind, status) VALUES (${randomUUID()}, ${runId}, 0, 'review', 'open')`
  return runId
}

async function connectToken(orgId: string, token = TOKEN): Promise<void> {
  await upsertAppIntegration({ orgId, kind: 'railway', status: 'connected', config: { authType: 'token', tokenType: 'workspace', workspaceName: 'Acme Workspace' }, credentials: { access_token: token, isPat: true, tokenType: 'workspace' } })
}

async function authorizeState(cookie: string): Promise<{ status: number; location: string | null; state: string | null }> {
  const res = await fetch(`${fixture.baseUrl}/api/oauth/railway/authorize`, { headers: { cookie }, redirect: 'manual' })
  const location = res.headers.get('location')
  const state = location ? new URL(location).searchParams.get('state') : null
  return { status: res.status, location, state }
}

describe('Railway deployment HTTP authorization', () => {
  beforeAll(async () => {
    mock = startMockRailway(defaultMockRailway({ token: TOKEN }))
    process.env.RAILWAY_API_URL = mock.url
    process.env.OAUTH_RAILWAY_TOKEN_URL = `${new URL(mock.url).origin}/oauth/token`
    fixture = await createGuardrailsPageFixture({ port: 3369 })
    const project = await createProject({ name: 'Deployment API project', slug: `deployment-api-${Date.now().toString(36)}`, teamId: fixture.teamId, createdBy: fixture.users.owner })
    projectId = project.projectId
    projectSlug = project.slug
    ownerCookie = await fixture.cookieFor(fixture.users.owner, fixture.teamId)
    memberCookie = await fixture.cookieFor(fixture.users.member, fixture.teamId)
  })

  afterAll(async () => {
    const sql = getDb()
    if (projectId) {
      await sql`DELETE FROM pipeline_events WHERE run_id IN ${sql(runIds)}`.catch(() => undefined)
      await sql`DELETE FROM pipeline_gates WHERE run_id IN ${sql(runIds)}`.catch(() => undefined)
      await sql`DELETE FROM project_jobs WHERE project_id = ${projectId}`.catch(() => undefined)
      await sql`DELETE FROM pipeline_runs WHERE project_id = ${projectId}`.catch(() => undefined)
      await sql`DELETE FROM deployment_records WHERE project_id = ${projectId}`.catch(() => undefined)
      await sql`DELETE FROM deployment_approvals WHERE project_id = ${projectId}`.catch(() => undefined)
      await sql`DELETE FROM project_deployment_targets WHERE project_id = ${projectId}`.catch(() => undefined)
      await sql`DELETE FROM projects WHERE project_id = ${projectId}`.catch(() => undefined)
    }
    await sql`DELETE FROM app_integrations WHERE org_id = ${fixture.orgId}`.catch(() => undefined)
    await sql`DELETE FROM oauth_apps WHERE org_id = ${fixture.orgId}`.catch(() => undefined)
    // The shared browser fixture does not always remove its users; do it here so
    // this run leaves no test accounts behind.
    await sql`DELETE FROM auth_sessions WHERE user_id IN (${fixture.users.owner}, ${fixture.users.member})`.catch(() => undefined)
    await sql`DELETE FROM team_members WHERE user_id IN (${fixture.users.owner}, ${fixture.users.member})`.catch(() => undefined)
    await sql`DELETE FROM users WHERE user_id IN (${fixture.users.owner}, ${fixture.users.member})`.catch(() => undefined)
    await fixture.stop()
    await mock.stop()
    delete process.env.RAILWAY_API_URL
    delete process.env.OAUTH_RAILWAY_TOKEN_URL
  })

  beforeEach(async () => {
    const sql = getDb()
    mock.state.triggerCount = 0
    mock.state.failNextTrigger = false
    mock.state.rejectAuth = false
    mock.state.oauthTokenError = false
    await sql`DELETE FROM deployment_records WHERE project_id = ${projectId}`.catch(() => undefined)
    await sql`DELETE FROM deployment_approvals WHERE project_id = ${projectId}`.catch(() => undefined)
    await sql`DELETE FROM project_deployment_targets WHERE project_id = ${projectId}`.catch(() => undefined)
    await sql`DELETE FROM app_integrations WHERE org_id = ${fixture.orgId} AND kind = 'railway'`.catch(() => undefined)
  })

  test('TC-API-001: only an org owner/admin can verify, connect or disconnect Railway (FR-002)', async () => {
    const verified = await api('POST', '/api/integrations/railway/verify', memberCookie, { token: TOKEN })
    expect(verified.status).toBe(403)
    const connected = await api('POST', '/api/integrations/railway/token', memberCookie, { token: TOKEN })
    expect(connected.status).toBe(403)
    const disconnected = await api('DELETE', '/api/integrations/railway', memberCookie)
    expect(disconnected.status).toBe(403)
    expect(await getAppIntegration(fixture.orgId, 'railway')).toBeUndefined()

    // The owner may do all three.
    expect((await api('POST', '/api/integrations/railway/verify', ownerCookie, { token: TOKEN })).status).toBe(200)
    const connectStartedAt = Date.now()
    const ownerConnect = await api('POST', '/api/integrations/railway/token', ownerCookie, { token: TOKEN })
    // SC-001: connecting and validating completes well inside the two-minute budget.
    expect(Date.now() - connectStartedAt).toBeLessThan(120_000)
    expect(ownerConnect.status).toBe(200)
    expect((await getAppIntegration(fixture.orgId, 'railway'))?.status).toBe('connected')

    // A member cannot destroy it afterwards.
    expect((await api('DELETE', '/api/integrations/railway', memberCookie)).status).toBe(403)
    expect((await getAppIntegration(fixture.orgId, 'railway'))?.status).toBe('connected')
  })

  test('TC-API-002: link, unlink, list and refresh require deployment management authority (FR-009, FR-012)', async () => {
    await connectToken(fixture.orgId)
    const body = { workspaceId: 'ws-1', railwayProjectId: 'proj-1', serviceId: 'svc-1', environmentId: 'env-1' }

    expect((await api('GET', `/api/projects/${projectSlug}/deployment/targets`, memberCookie)).status).toBe(403)
    expect((await api('POST', `/api/projects/${projectSlug}/deployment/target`, memberCookie, body)).status).toBe(403)
    expect((await api('DELETE', `/api/projects/${projectSlug}/deployment/target`, memberCookie)).status).toBe(403)
    expect((await api('POST', `/api/projects/${projectSlug}/deployment/refresh`, memberCookie)).status).toBe(403)

    const targets = await api<{ workspaces: Array<{ name: string }> }>('GET', `/api/projects/${projectSlug}/deployment/targets`, ownerCookie)
    expect(targets.status).toBe(200)
    expect(targets.body.workspaces.map((w) => w.name)).toEqual(['Acme Workspace'])

    expect((await api('POST', `/api/projects/${projectSlug}/deployment/target`, ownerCookie, body)).status).toBe(200)
    // The refresh route was viewer-gated before the fix; a plain member must be denied even with a link present.
    expect((await api('POST', `/api/projects/${projectSlug}/deployment/refresh`, memberCookie)).status).toBe(403)
    const refreshStartedAt = Date.now()
    const refreshed = await api<{ status: { state: string } }>('POST', `/api/projects/${projectSlug}/deployment/refresh`, ownerCookie)
    // SC-003: a view/refresh returns the status well inside the one-minute budget.
    expect(Date.now() - refreshStartedAt).toBeLessThan(60_000)
    expect(refreshed.status).toBe(200)
    expect(refreshed.body.status.state).toBe('success')

    expect((await api('DELETE', `/api/projects/${projectSlug}/deployment/target`, ownerCookie)).status).toBe(200)
  })

  test('TC-API-003: an assigned Release Manager may link through the route (FR-009)', async () => {
    await connectToken(fixture.orgId)
    const releaseManager = (await listResponsibilities(projectId)).find((item) => item.standardKey === 'release-manager')!
    await replaceAssignments(projectId, releaseManager.responsibilityId, [fixture.users.member], fixture.users.owner)
    try {
      const body = { workspaceId: 'ws-1', railwayProjectId: 'proj-1', serviceId: 'svc-1', environmentId: 'env-1' }
      expect((await api('POST', `/api/projects/${projectSlug}/deployment/target`, memberCookie, body)).status).toBe(200)
      expect((await api('DELETE', `/api/projects/${projectSlug}/deployment/target`, memberCookie)).status).toBe(200)
    } finally {
      await replaceAssignments(projectId, releaseManager.responsibilityId, [], fixture.users.owner)
    }
  })

  test('TC-API-004: an unauthorized member cannot answer the delivery gate; an owner can reject and approve (FR-016)', async () => {
    await connectToken(fixture.orgId)
    await api('POST', `/api/projects/${projectSlug}/deployment/target`, ownerCookie, { workspaceId: 'ws-1', railwayProjectId: 'proj-1', serviceId: 'svc-1', environmentId: 'env-1' })

    const deniedRun = await pausedDeliverRun()
    const denied = await api('POST', `/api/runs/${deniedRun}/answer`, memberCookie, { answer: 'approve' })
    expect(denied.status).toBe(403)
    const sql = getDb()
    expect((await sql<Array<{ status: string }>>`SELECT status FROM pipeline_runs WHERE run_id = ${deniedRun}`)[0]!.status).toBe('paused')
    expect(mock.state.triggerCount).toBe(0)

    // A rejection is authorized the same way and also leaves the run paused.
    const deniedReject = await pausedDeliverRun()
    expect((await api('POST', `/api/runs/${deniedReject}/answer`, memberCookie, { answer: 'reject' })).status).toBe(403)
    expect((await sql<Array<{ status: string }>>`SELECT status FROM pipeline_runs WHERE run_id = ${deniedReject}`)[0]!.status).toBe('paused')
    expect(mock.state.triggerCount).toBe(0)

    const rejectRun = await pausedDeliverRun()
    expect((await api('POST', `/api/runs/${rejectRun}/answer`, ownerCookie, { answer: 'reject' })).status).toBe(202)
    expect(mock.state.triggerCount).toBe(0)
    const [rejection] = await sql<Array<{ decision: string }>>`SELECT decision FROM deployment_approvals WHERE run_id = ${rejectRun}`
    expect(rejection?.decision).toBe('rejected')

    const approveRun = await pausedDeliverRun()
    expect((await api('POST', `/api/runs/${approveRun}/answer`, ownerCookie, { answer: 'approve' })).status).toBe(202)
    expect(mock.state.triggerCount).toBe(1)
    const [approval] = await sql<Array<{ decision: string }>>`SELECT decision FROM deployment_approvals WHERE run_id = ${approveRun}`
    expect(approval?.decision).toBe('approved')
  })

  test('TC-API-005: OAuth authorize redirects with viewer scopes; callback stores oauth or a reconnect-needed error (FR-003)', async () => {
    // No app credentials yet: the authorize route explains what to do.
    const missing = await fetch(`${fixture.baseUrl}/api/oauth/railway/authorize`, { headers: { cookie: ownerCookie }, redirect: 'manual' })
    expect(missing.status).toBe(400)
    expect(String((await missing.json() as { error?: string }).error)).toContain('app credentials')

    await saveOAuthApp(fixture.orgId, 'railway', { clientId: 'railway-client', clientSecret: 'railway-secret' })

    const authorized = await authorizeState(ownerCookie)
    expect(authorized.status).toBe(302)
    expect(authorized.location).toBeTruthy()
    const location = new URL(authorized.location!)
    expect(location.origin + location.pathname).toBe('https://backboard.railway.com/oauth/auth')
    const scope = location.searchParams.get('scope') ?? ''
    for (const expected of ['openid', 'email', 'profile', 'offline_access', 'workspace:viewer', 'project:viewer']) {
      expect(scope.split(' ')).toContain(expected)
    }
    expect(scope).not.toContain('workspace:admin')
    expect(location.searchParams.get('prompt')).toBe('consent')
    expect(authorized.state).toBeTruthy()

    // Missing/invalid state never reaches the token exchange.
    expect((await api('GET', '/api/oauth/railway/callback', ownerCookie)).status).toBe(400)
    expect((await api('GET', '/api/oauth/railway/callback?code=x&state=never-issued', ownerCookie)).status).toBe(400)

    // A failing token exchange stores nothing.
    mock.state.oauthTokenError = true
    const failedState = (await authorizeState(ownerCookie)).state!
    const failedExchange = await api('GET', `/api/oauth/railway/callback?code=abc&state=${failedState}`, ownerCookie)
    expect(failedExchange.status).toBe(500)
    expect(await getAppIntegration(fixture.orgId, 'railway')).toBeUndefined()

    // A successful exchange with a successful identity probe stores an observation-only oauth connection.
    mock.state.oauthTokenError = false
    const successState = (await authorizeState(ownerCookie)).state!
    expect((await api('GET', `/api/oauth/railway/callback?code=abc&state=${successState}`, ownerCookie)).status).toBe(200)
    const connected = await getAppIntegration(fixture.orgId, 'railway')
    expect(connected?.status).toBe('connected')
    expect(connected?.configJson.authType).toBe('oauth')

    // A failed identity probe is stored as `error` with reconnect guidance, not `connected`.
    const sql = getDb()
    await sql`DELETE FROM app_integrations WHERE org_id = ${fixture.orgId} AND kind = 'railway'`
    mock.state.rejectAuth = true
    const errorState = (await authorizeState(ownerCookie)).state!
    expect((await api('GET', `/api/oauth/railway/callback?code=abc&state=${errorState}`, ownerCookie)).status).toBe(200)
    const errored = await getAppIntegration(fixture.orgId, 'railway')
    expect(errored?.status).toBe('error')
    expect(errored?.configJson.authType).toBe('oauth')
  })
})
