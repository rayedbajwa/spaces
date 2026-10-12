import { afterAll, describe, expect, test } from 'bun:test'
import { applySchema, closeDb, getDb } from '../src/lib/db'

/**
 * Migration (11): the additive approval schema is idempotent and the
 * app_integrations kind CHECK accepts the new 'email' value.
 */
afterAll(async () => { await closeDb() })

describe('approval schema migration', () => {
  test('applying the schema twice is a no-op and creates the approval tables', async () => {
    await applySchema()
    await applySchema()

    const tables = await getDb()<Array<{ tableName: string }>>`
      SELECT tablename AS "tableName" FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'approval_%' ORDER BY tablename
    `
    expect(tables.map((t) => t.tableName)).toEqual([
      'approval_decisions', 'approval_deliveries', 'approval_link_attempts', 'approval_links', 'approval_requests',
    ])
  })

  test("app_integrations_kind_check accepts 'email'", async () => {
    const [constraint] = await getDb()<Array<{ def: string }>>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'app_integrations_kind_check'
    `
    expect(constraint?.def).toContain('email')

    const orgId = '00000000-0000-4000-8000-0000000000ee'
    const sql = getDb()
    await sql`INSERT INTO organizations (org_id, name, slug) VALUES (${orgId}, 'Migration probe', ${`migration-probe-${Date.now()}`}) ON CONFLICT (org_id) DO NOTHING`
    try {
      await sql`INSERT INTO app_integrations (org_id, kind, status) VALUES (${orgId}, 'email', 'not_connected') ON CONFLICT (org_id, kind) DO NOTHING`
      const [row] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM app_integrations WHERE org_id = ${orgId} AND kind = 'email'`
      expect(row?.n).toBe(1)
    } finally {
      await sql`DELETE FROM organizations WHERE org_id = ${orgId}`
    }
  })
})
