import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { getDb } from '../src/lib/db'
import { upsertAppIntegration } from '../src/lib/app-integrations'
import { fetchDatadogItems, fetchJiraItems, fetchLinearItems, runIntakeSync, syncIntakeSource } from '../src/lib/intake-connectors'
import { getIntakeSource, listIntake, upsertIntakeSource } from '../src/lib/intake-store'
import { createApprovalFixture } from './helpers/approval-fixture'

/**
 * Inbound connector fetch/normalize/cursor and source health (US1:
 * FR-001/002/003/024/029). Provider HTTP is stubbed at the fetch boundary.
 */
const fixture = await createApprovalFixture({ withServer: false })
const { orgA } = fixture
afterAll(async () => { await fixture.stop() })

const realFetch = globalThis.fetch
function stubFetch(handler: (url: string, init?: RequestInit) => Response): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init)) as typeof fetch
}
afterEach(() => { globalThis.fetch = realFetch })

async function connect(kind: 'jira' | 'linear' | 'datadog', credentials: Record<string, unknown>, config: Record<string, unknown> = {}): Promise<void> {
  await upsertAppIntegration({ orgId: orgA, kind, status: 'connected', config, credentials })
}

describe('Jira connector', () => {
  test('normalizes issues and returns a resume cursor', async () => {
    await connect('jira', { access_token: 'jira-token' }, { cloudId: 'cloud-1', siteUrl: 'https://acme.atlassian.net' })
    stubFetch(() => new Response(JSON.stringify({
      issues: [{ key: 'OPS-142', fields: { summary: 'Disk almost full', description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Volume /var at 92%' }] }] }, status: { name: 'In Progress' }, issuetype: { name: 'Bug' }, priority: { name: 'High' }, reporter: { displayName: 'Ada' }, updated: '2026-10-01T10:00:00.000+0000' } }],
    })), { status: 200, headers: { 'content-type': 'application/json' } })

    const result = await fetchJiraItems(orgA, { projects: ['OPS'] }, {})
    expect(result.items).toHaveLength(1)
    const item = result.items[0]!
    expect(item.source).toBe('jira')
    expect(item.externalRef).toBe('OPS-142')
    expect(item.externalUrl).toBe('https://acme.atlassian.net/browse/OPS-142')
    expect(item.title).toBe('Disk almost full')
    expect(item.summary).toContain('Volume /var')
    expect(item.priority).toBe('high')
    expect(item.requesterName).toBe('Ada')
    expect(result.nextCursor.updatedAt).toBe('2026-10-01T10:00:00.000+0000')
  })
})

describe('Linear connector', () => {
  test('normalizes issues and returns a resume cursor', async () => {
    await connect('linear', { access_token: 'linear-token' })
    stubFetch(() => new Response(JSON.stringify({
      data: { issues: { nodes: [{ id: 'uuid-1', identifier: 'ENG-7', title: 'Index slow', description: 'Queries take 4s', url: 'https://linear.app/acme/issue/ENG-7', updatedAt: '2026-10-02T10:00:00.000Z', priorityLabel: 'Urgent', state: { name: 'Todo' }, team: { key: 'ENG', name: 'Engineering' }, labels: { nodes: [{ name: 'perf' }] } }] } },
    })), { status: 200, headers: { 'content-type': 'application/json' } })

    const result = await fetchLinearItems(orgA, { teamKey: 'ENG' }, {})
    expect(result.items).toHaveLength(1)
    const item = result.items[0]!
    expect(item.externalRef).toBe('ENG-7')
    expect(item.priority).toBe('urgent')
    expect(item.sourceScope).toBe('ENG')
    expect(item.raw).toMatchObject({ labels: ['perf'] })
    expect(result.nextCursor.updatedAt).toBe('2026-10-02T10:00:00.000Z')
  })
})

describe('Datadog connector', () => {
  test('normalizes alerts with severity mapped to priority', async () => {
    await connect('datadog', { api_key: 'api', app_key: 'app', site: 'datadoghq.com' }, { tags: ['env:prod'] })
    stubFetch(() => new Response(JSON.stringify({
      events: [{ id: 9001, title: 'CPU high on web-1', text: 'CPU > 90% for 5m', alert_type: 'error', tags: ['service:web', 'env:prod', 'link:https://app.datadoghq.com/event/9001'], date_happened: 1700000000 }],
    })), { status: 200, headers: { 'content-type': 'application/json' } })

    const result = await fetchDatadogItems(orgA, { site: 'datadoghq.com' }, {})
    expect(result.items).toHaveLength(1)
    const item = result.items[0]!
    expect(item.externalRef).toBe('9001')
    expect(item.priority).toBe('high')
    expect(item.sourceScope).toBe('web')
    expect(item.externalUrl).toBe('https://app.datadoghq.com/event/9001')
    expect(result.nextCursor.since).toBe(1700000000)
  })
})

describe('source sync health and idempotency', () => {
  test('a successful sync upserts once, resumes from the cursor, and a failing sync goes unhealthy without deleting items', async () => {
    await connect('jira', { access_token: 'jira-token' }, { cloudId: 'cloud-2', siteUrl: 'https://acme.atlassian.net' })
    const scopeKey = `OPS-${randomUUID().slice(0, 6)}`
    const source = await upsertIntakeSource({ orgId: orgA, kind: 'jira', label: 'Ops board', scopeKey, config: { projects: ['OPS'] } })
    const issue = { key: 'OPS-777', fields: { summary: 'Queue backing up', status: { name: 'Open' }, priority: { name: 'Medium' }, updated: '2026-10-03T00:00:00.000+0000' } }
    stubFetch(() => new Response(JSON.stringify({ issues: [issue] }), { status: 200, headers: { 'content-type': 'application/json' } }))

    const first = await syncIntakeSource((await getIntakeSource(orgA, source.sourceId))!)
    expect(first.ok).toBe(true)
    expect(first.inserted).toBe(1)
    const second = await syncIntakeSource((await getIntakeSource(orgA, source.sourceId))!)
    expect(second.updated).toBe(1)
    const { items } = await listIntake(orgA, { limit: 500 })
    expect(items.filter((i) => i.externalRef === 'OPS-777')).toHaveLength(1)

    // A failing fetch marks the source unhealthy but keeps the queued item.
    stubFetch(() => { throw new Error('network down') })
    const failed = await syncIntakeSource((await getIntakeSource(orgA, source.sourceId))!)
    expect(failed.ok).toBe(false)
    const health = await getIntakeSource(orgA, source.sourceId)
    expect(health?.lastSyncStatus).toBe('error')
    expect(health?.lastSyncError).toContain('network down')
    const after = await listIntake(orgA, { limit: 500 })
    expect(after.items.some((i) => i.externalRef === 'OPS-777')).toBe(true)

    await getDb()`DELETE FROM intake_items WHERE org_id = ${orgA} AND external_ref = 'OPS-777'`
    await getDb()`DELETE FROM intake_sources WHERE source_id = ${source.sourceId}`
  })

  test('runIntakeSync drains due sources and never throws on a bad one', async () => {
    stubFetch(() => { throw new Error('datadog unreachable') })
    const source = await upsertIntakeSource({ orgId: orgA, kind: 'datadog', label: 'Alerts', scopeKey: `alerts-${randomUUID().slice(0, 6)}`, config: {} })
    const outcomes = await runIntakeSync(50)
    expect(outcomes.some((o) => o.sourceId === source.sourceId)).toBe(true)
    const ours = outcomes.find((o) => o.sourceId === source.sourceId)!
    // Connected Datadog fails at the fetch boundary: recorded as an error, not thrown.
    expect(ours.ok).toBe(false)
    await getDb()`DELETE FROM intake_sources WHERE source_id = ${source.sourceId}`
  })
})
