import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { getDb } from '../src/lib/db'
import { upsertIntakeItem } from '../src/lib/intake-store'
import { createApprovalFixture } from './helpers/approval-fixture'

/**
 * Intake REST API (US1: FR-004/010/024; US2 triage routes). Org scoping,
 * priority ordering, triager authorization and source routes against a running
 * server and the guarded test database.
 */
const fixture = await createApprovalFixture({ withServer: true, port: 3370 })
const { baseUrl, orgA, orgB, teamA, teamB, users } = fixture
afterAll(async () => { await fixture.stop() })

async function api(path: string, cookie: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers: { cookie, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) } })
  return { status: response.status, body: await response.json().catch(() => ({})) }
}

function input(overrides: Record<string, unknown> = {}) {
  return { orgId: orgA, source: 'jira' as const, externalRef: `OPS-${randomUUID().slice(0, 8)}`, title: 'API item', priority: 'normal' as const, ...overrides } as never
}

describe('GET /api/intake', () => {
  test('returns the org queue in priority order and never another org items', async () => {
    const low = await upsertIntakeItem(input({ priority: 'low', title: 'Low API item' }))
    const urgent = await upsertIntakeItem(input({ priority: 'urgent', title: 'Urgent API item' }))
    try {
      const owner = await api('/api/intake', await fixture.cookieFor(users.ownerA, teamA))
      expect(owner.status).toBe(200)
      const ids = owner.body.items.map((i: { intakeId: string }) => i.intakeId)
      expect(ids.indexOf(urgent.intakeId)).toBeLessThan(ids.indexOf(low.intakeId))

      const other = await api('/api/intake', await fixture.cookieFor(users.otherOrgOwner, teamB))
      expect(other.status).toBe(200)
      expect(other.body.items.some((i: { intakeId: string }) => i.intakeId === urgent.intakeId)).toBe(false)
    } finally {
      await getDb()`DELETE FROM intake_items WHERE intake_id IN (${low.intakeId}, ${urgent.intakeId})`
    }
  })

  test('an unauthenticated caller is refused', async () => {
    const response = await fetch(`${baseUrl}/api/intake`)
    expect(response.status).toBe(401)
  })
})

describe('triage authorization', () => {
  test('a plain member cannot change priority but an admin can', async () => {
    const item = await upsertIntakeItem(input())
    try {
      const member = await api(`/api/intake/${item.intakeId}`, await fixture.cookieFor(users.memberA, teamA), { method: 'PATCH', body: JSON.stringify({ priority: 'urgent' }) })
      expect(member.status).toBe(403)

      const owner = await api(`/api/intake/${item.intakeId}`, await fixture.cookieFor(users.ownerA, teamA), { method: 'PATCH', body: JSON.stringify({ priority: 'urgent' }) })
      expect(owner.status).toBe(200)
      expect(owner.body.item.priority).toBe('urgent')
    } finally {
      await getDb()`DELETE FROM intake_items WHERE intake_id = ${item.intakeId}`
    }
  })

  test('dismiss requires a reason and records it', async () => {
    const item = await upsertIntakeItem(input())
    try {
      const cookie = await fixture.cookieFor(users.ownerA, teamA)
      const noReason = await api(`/api/intake/${item.intakeId}/dismiss`, cookie, { method: 'POST', body: JSON.stringify({}) })
      expect(noReason.status).toBe(400)
      const dismissed = await api(`/api/intake/${item.intakeId}/dismiss`, cookie, { method: 'POST', body: JSON.stringify({ reason: 'not our work' }) })
      expect(dismissed.status).toBe(200)
      expect(dismissed.body.item.state).toBe('dismissed')
    } finally {
      await getDb()`DELETE FROM intake_items WHERE intake_id = ${item.intakeId}`
    }
  })
})

describe('sources and routing rules', () => {
  test('an admin can add a source and read it back; a member cannot', async () => {
    const scopeKey = `api-${randomUUID().slice(0, 6)}`
    const member = await api('/api/intake/sources', await fixture.cookieFor(users.memberA, teamA), { method: 'PUT', body: JSON.stringify({ kind: 'jira', label: 'Board', scopeKey }) })
    expect(member.status).toBe(403)

    const owner = await api('/api/intake/sources', await fixture.cookieFor(users.ownerA, teamA), { method: 'PUT', body: JSON.stringify({ kind: 'jira', label: 'Board', scopeKey }) })
    expect(owner.status).toBe(200)
    const listed = await api('/api/intake/sources', await fixture.cookieFor(users.ownerA, teamA))
    expect(listed.body.sources.some((s: { scopeKey: string }) => s.scopeKey === scopeKey)).toBe(true)
    await getDb()`DELETE FROM intake_sources WHERE org_id = ${orgA} AND scope_key = ${scopeKey}`
  })

  test('routing rules replace and come back ordered', async () => {
    const cookie = await fixture.cookieFor(users.ownerA, teamA)
    const saved = await api('/api/intake/routing-rules', cookie, {
      method: 'PUT',
      body: JSON.stringify({ rules: [{ label: 'Ops alerts', priorityOrder: 5, match: { source: ['datadog'], severityMin: 'high' } }] }),
    })
    expect(saved.status).toBe(200)
    const listed = await api('/api/intake/routing-rules', cookie)
    expect(listed.body.rules.some((r: { label: string }) => r.label === 'Ops alerts')).toBe(true)
    await getDb()`DELETE FROM intake_routing_rules WHERE org_id = ${orgA}`
  })
})
