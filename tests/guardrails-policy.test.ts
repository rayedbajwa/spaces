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

describe('the run vault writer', () => {
  test('saves one at a time, always ending with the latest vault', async () => {
    const { createVaultWriter } = await import('../src/lib/guardrails-policy')
    let vault: Record<string, string> = {}
    const saved: Array<Record<string, string>> = []
    let inFlight = 0
    let maxInFlight = 0
    const store = {
      load: async () => undefined,
      save: async (v: Record<string, string>) => {
        inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((r) => setTimeout(r, 5))
        saved.push(v); inFlight -= 1
      },
    }
    const writer = createVaultWriter(store, () => ({ ...vault }))
    for (let i = 1; i <= 5; i++) { vault = { ...vault, [`<EMAIL_${i}>`]: `u${i}@acme.io` }; writer.schedule() }
    await writer.flush()
    expect(maxInFlight).toBe(1)
    expect(Object.keys(saved.at(-1)!)).toHaveLength(5)
  })
})
