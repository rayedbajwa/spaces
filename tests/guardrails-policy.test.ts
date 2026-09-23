import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { getDb } from '../src/lib/db'
import { loadGuardPolicy, normalizePolicy, saveGuardPolicy } from '../src/lib/guardrails-policy'

describe('guardrail policy', () => {
  test('normalizes input: unknown modes fall back to mask; the allowlist keeps non-empty strings', () => {
    expect(normalizePolicy(undefined)).toEqual({ mode: 'mask', allow: [] })
    expect(normalizePolicy({ mode: 'bogus', allow: [' a@b.io ', '', 3] })).toEqual({ mode: 'mask', allow: ['a@b.io'] })
    expect(normalizePolicy({ mode: 'strict' })).toEqual({ mode: 'strict', allow: [] })
  })

  test('an organization without a setting (or none at all) gets mask', async () => {
    expect(await loadGuardPolicy(undefined)).toEqual({ mode: 'mask', allow: [] })
    expect(await loadGuardPolicy(randomUUID())).toEqual({ mode: 'mask', allow: [] })
  })

  test('saved per organization and read back', async () => {
    const sql = getDb()
    const reachable = await sql`SELECT 1 FROM organizations LIMIT 0`.then(() => true, () => false)
    if (!reachable) return
    const orgId = randomUUID()
    await sql`INSERT INTO organizations (org_id, name, slug) VALUES (${orgId}, 'Guard test', ${`guard-${orgId.slice(0, 8)}`})`
    try {
      expect(await saveGuardPolicy(orgId, { mode: 'strict', allow: ['support@acme.io'] })).toEqual({ mode: 'strict', allow: ['support@acme.io'] })
      expect(await loadGuardPolicy(orgId)).toEqual({ mode: 'strict', allow: ['support@acme.io'] })
      const [row] = await sql`SELECT ai_guardrails FROM organizations WHERE org_id = ${orgId}`
      expect(row?.ai_guardrails).toEqual({ mode: 'strict', allow: ['support@acme.io'] })
    } finally {
      await sql`DELETE FROM organizations WHERE org_id = ${orgId}`
    }
  })
})
