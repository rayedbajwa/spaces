import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chromium, type Browser, type Page } from 'playwright'
import { SESSION_COOKIE } from '../src/lib/auth'
import { getDb } from '../src/lib/db'
import { createProject } from '../src/lib/project-registry'
import { verifyRailwayCredential } from '../src/lib/railway'
import { createGuardrailsPageFixture } from './helpers/guardrails-page'
import { defaultMockRailway, startMockRailway, type MockRailwayServer } from './helpers/mock-railway'

setDefaultTimeout(90_000)

if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync('/ms-playwright')) process.env.PLAYWRIGHT_BROWSERS_PATH = '/ms-playwright'

/**
 * End-to-end Railway deployment flow (010-railway-deployment), driven against a
 * local mock GraphQL server. Live cases are gated behind RAILWAY_TEST_TOKEN and
 * skip without one (organization memory: keyed E2E may be ignored).
 */
const TOKEN = '<SECRET_30>'

interface Fixture { baseUrl: string; orgId: string; teamId: string; users: { owner: string; member: string }; sessionTokenFor: (u: string, t?: string) => Promise<string>; stop: () => Promise<void> }

let fixture: Fixture
let mock: MockRailwayServer
let browser: Browser
let page: Page
let projectSlug = ''
let projectId = ''

describe('Railway deployment E2E (mock)', () => {
  beforeAll(async () => {
    mock = startMockRailway(defaultMockRailway({ token: TOKEN }))
    process.env.RAILWAY_API_URL = mock.url
    fixture = await createGuardrailsPageFixture({ port: 3369 }) as unknown as Fixture
    const project = await createProject({ name: 'Deployment E2E project', slug: `deployment-e2e-${Date.now().toString(36)}`, teamId: fixture.teamId, createdBy: fixture.users.owner })
    projectSlug = project.slug
    projectId = project.projectId
    browser = await chromium.launch()
    page = await browser.newPage()
    const token = await fixture.sessionTokenFor(fixture.users.owner, fixture.teamId)
    await page.context().addCookies([{ name: SESSION_COOKIE, value: token, url: fixture.baseUrl }])
  })

  afterAll(async () => {
    await browser?.close().catch(() => undefined)
    await fixture?.stop().catch(() => undefined)
    await mock?.stop().catch(() => undefined)
    delete process.env.RAILWAY_API_URL
    // Clean up everything this run created, including the queued answer job the
    // gate resolution enqueues, so later suites see no stray work.
    const sql = getDb()
    if (projectId) {
      await sql`DELETE FROM project_jobs WHERE project_id = ${projectId}`.catch(() => undefined)
      await sql`DELETE FROM pipeline_runs WHERE project_id = ${projectId}`.catch(() => undefined)
      await sql`DELETE FROM deployment_records WHERE project_id = ${projectId}`.catch(() => undefined)
      await sql`DELETE FROM deployment_approvals WHERE project_id = ${projectId}`.catch(() => undefined)
      await sql`DELETE FROM project_deployment_targets WHERE project_id = ${projectId}`.catch(() => undefined)
      await sql`DELETE FROM projects WHERE project_id = ${projectId}`.catch(() => undefined)
    }
    if (fixture?.orgId) {
      await sql`DELETE FROM app_integrations WHERE org_id = ${fixture.orgId}`.catch(() => undefined)
      await sql`DELETE FROM oauth_apps WHERE org_id = ${fixture.orgId}`.catch(() => undefined)
      await sql`DELETE FROM teams WHERE org_id = ${fixture.orgId}`.catch(() => undefined)
      await sql`DELETE FROM organizations WHERE org_id = ${fixture.orgId}`.catch(() => undefined)
    }
    if (fixture?.users) {
      await sql`DELETE FROM users WHERE user_id IN (${fixture.users.owner}, ${fixture.users.member}) AND email LIKE '%@example.test'`.catch(() => undefined)
    }
  })

  test('TC-E2E-001: connect Railway with a workspace token from Organization → Integrations', async () => {
    await page.goto(`${fixture.baseUrl}/organization?section=integrations`)
    const card = page.locator('.integration', { hasText: 'Railway' }).first()
    await card.getByRole('button', { name: /Connect with Token|Reconnect with Token/ }).click()
    const modal = page.locator('.modal-shell', { hasText: 'Connect Railway' })
    await modal.locator('input[type=password]').fill(TOKEN)
    await modal.getByRole('button', { name: 'Test credential' }).click()
    await modal.getByText('✓ Valid Railway credential').waitFor({ state: 'visible' })
    await modal.getByRole('button', { name: 'Connect Railway' }).click()
    await page.getByText('Railway connected successfully.').waitFor({ state: 'visible' })
  })

  test('TC-E2E-002: a project links one target and shows a confirmed status', async () => {
    const link = await page.evaluate(async (slug) => {
      const res = await fetch(`/api/projects/${slug}/deployment/target`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: 'ws-1', railwayProjectId: 'proj-1', serviceId: 'svc-1', environmentId: 'env-1' }),
      })
      return { status: res.status, body: await res.json() }
    }, projectSlug)
    expect(link.status).toBe(200)
    expect(link.body.ok).toBe(true)

    const refreshed = await page.evaluate(async (slug) => {
      await fetch(`/api/projects/${slug}/deployment/refresh`, { method: 'POST' })
      const res = await fetch(`/api/projects/${slug}/deployment`)
      return res.json()
    }, projectSlug)
    expect(refreshed.target.serviceName).toBe('web')
    expect(refreshed.target.linkState).toBe('valid')
    expect(refreshed.status.state).toBe('success')
    expect(refreshed.status.serviceUrl).toBe('https://acme-web.up.railway.app')
  })

  test('TC-E2E-005: a linked project is not Done while its delivery is not merged', async () => {
    const board = await page.evaluate(async () => (await fetch('/api/board')).json()) as { columns: Array<{ cards: Array<{ projectNamespace: string; status: string }> }> }
    const cards = board.columns.flatMap((column) => column.cards)
    const card = cards.find((item) => item.projectNamespace === projectSlug)
    expect(card).toBeTruthy()
    // The deployment is confirmed, but no delivery report has merged, so it must not be Done.
    expect(card!.status).not.toBe('done')
  })

  test('TC-E2E-003: approving the delivery gate triggers exactly one deployment and records it', async () => {
    const sql = getDb()
    const runId = randomUUID()
    await sql`INSERT INTO pipeline_runs (run_id, project_id, project_namespace, project_label, project_path, pipeline_name, status, pause_kind, current_stage, options_json, template_json)
      VALUES (${runId}, ${projectId}, ${projectSlug}, 'Deployment E2E', '/tmp/deployment-e2e', 'aidlc-feature', 'paused', 'review', 'deliver', ${sql.json({} as never)}, ${sql.json({} as never)})`
    await sql`INSERT INTO pipeline_gates (gate_id, run_id, step_index, kind, status) VALUES (${randomUUID()}, ${runId}, 0, 'review', 'open')`

    const response = await page.evaluate(async (id) => {
      const res = await fetch(`/api/runs/${id}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answer: 'approve' }) })
      return res.status
    }, runId)
    expect(response).toBe(202)
    expect(mock.state.triggerCount).toBe(1)
    const [record] = await sql<Array<{ status: string; railwayDeploymentId: string }>>`SELECT status, railway_deployment_id AS "railwayDeploymentId" FROM deployment_records WHERE run_id = ${runId}`
    expect(record?.status).toBe('in_progress')
    expect(record?.railwayDeploymentId).toBeTruthy()

    // A repeat approval for the same run+target is idempotent: still one trigger.
    await sql`UPDATE pipeline_runs SET status = 'paused', pause_kind = 'review', current_stage = 'deliver' WHERE run_id = ${runId}`
    await sql`INSERT INTO pipeline_gates (gate_id, run_id, step_index, kind, status) VALUES (${randomUUID()}, ${runId}, 0, 'review', 'open')`
    await page.evaluate(async (id) => {
      await fetch(`/api/runs/${id}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answer: 'approve' }) })
    }, runId)
    expect(mock.state.triggerCount).toBe(1)

    await sql`DELETE FROM pipeline_runs WHERE run_id = ${runId}`
  })

  test('TC-E2E-004: an invalid link is surfaced, then unlinking restores merge-based delivery', async () => {
    const sql = getDb()
    await sql`UPDATE project_deployment_targets SET environment_id = 'env-gone' WHERE project_id = ${projectId}`
    const invalid = await page.evaluate(async (slug) => {
      await fetch(`/api/projects/${slug}/deployment/refresh`, { method: 'POST' })
      return (await fetch(`/api/projects/${slug}/deployment`)).json()
    }, projectSlug)
    expect(invalid.target.linkState).toBe('invalid')
    expect(invalid.status.state).toBe('unknown')

    const unlink = await page.evaluate(async (slug) => {
      const res = await fetch(`/api/projects/${slug}/deployment/target`, { method: 'DELETE' })
      return { status: res.status, body: await res.json() }
    }, projectSlug)
    expect(unlink.status).toBe(200)
    expect(unlink.body.ok).toBe(true)
    const after = await page.evaluate(async (slug) => (await fetch(`/api/projects/${slug}/deployment`)).json(), projectSlug)
    expect(after.target).toBeUndefined()
    expect(after.status).toBeUndefined()
  })

  test.skipIf(!process.env.RAILWAY_TEST_TOKEN)('TC-E2E-LIVE: a live Railway credential validates when provided', async () => {
    const result = await verifyRailwayCredential(process.env.RAILWAY_TEST_TOKEN!, 'workspace')
    expect(result.ok).toBe(true)
  })
})
