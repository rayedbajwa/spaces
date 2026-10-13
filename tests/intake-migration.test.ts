import { afterAll, describe, expect, test } from 'bun:test'
import { applySchema, closeDb, getDb } from '../src/lib/db'

/**
 * Migration (US1 / FR-001..): the additive intake/outbound/Slack schema applies
 * twice as a no-op, creates the eight new tables, and the re-addable
 * app_integrations kind CHECK admits 'datadog'.
 */
afterAll(async () => { await closeDb() })

describe('intake/outbound schema migration', () => {
  test('applying the schema twice is a no-op and creates the new tables', async () => {
    await applySchema()
    await applySchema()

    const tables = await getDb()<Array<{ tableName: string }>>`
      SELECT tablename AS "tableName" FROM pg_tables
       WHERE schemaname = 'public'
         AND tablename IN (
           'intake_items','intake_transitions','intake_work_links','intake_routing_rules','intake_sources',
           'slack_identity_links','outbound_subscriptions','outbound_deliveries'
         )
       ORDER BY tablename
    `
    expect(tables.map((t) => t.tableName)).toEqual([
      'intake_items', 'intake_routing_rules', 'intake_sources', 'intake_transitions', 'intake_work_links',
      'outbound_deliveries', 'outbound_subscriptions', 'slack_identity_links',
    ])
  })

  test("app_integrations_kind_check accepts 'datadog'", async () => {
    const [constraint] = await getDb()<Array<{ def: string }>>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'app_integrations_kind_check'
    `
    expect(constraint?.def).toContain('datadog')

    const orgId = '00000000-0000-4000-8000-0000000000dd'
    const sql = getDb()
    await sql`INSERT INTO organizations (org_id, name, slug) VALUES (${orgId}, 'Intake migration probe', ${`intake-migration-${Date.now()}`}) ON CONFLICT (org_id) DO NOTHING`
    try {
      await sql`INSERT INTO app_integrations (org_id, kind, status) VALUES (${orgId}, 'datadog', 'not_connected') ON CONFLICT (org_id, kind) DO NOTHING`
      const [row] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM app_integrations WHERE org_id = ${orgId} AND kind = 'datadog'`
      expect(row?.n).toBe(1)
    } finally {
      await sql`DELETE FROM organizations WHERE org_id = ${orgId}`
    }
  })
})
