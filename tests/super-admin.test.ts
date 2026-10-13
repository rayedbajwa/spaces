import { afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { isSuperAdmin } from '../src/lib/auth'
import { getDb } from '../src/lib/db'

/** The waitlist belongs to the deployment's super admin, not to organization admins. */
const dbSuite = process.env.DATABASE_URL ? describe : describe.skip

dbSuite('super admin', () => {
  const saved = process.env.SUPERADMIN_EMAILS
  afterEach(() => { if (saved === undefined) delete process.env.SUPERADMIN_EMAILS; else process.env.SUPERADMIN_EMAILS = saved })

  test('SUPERADMIN_EMAILS decides when it is set, ignoring case', async () => {
    process.env.SUPERADMIN_EMAILS = 'Owner@Example.test, ops@example.test'
    expect(await isSuperAdmin({ userId: randomUUID(), email: 'owner@example.test' })).toBe(true)
    expect(await isSuperAdmin({ userId: randomUUID(), email: 'someone@example.test' })).toBe(false)
  })

  test('otherwise only the first registered account is the super admin', async () => {
    delete process.env.SUPERADMIN_EMAILS
    const [first] = await getDb()<Array<{ userId: string; email: string }>>`SELECT user_id AS "userId", email FROM users ORDER BY created_at, user_id LIMIT 1`
    if (first) expect(await isSuperAdmin(first)).toBe(true)
    expect(await isSuperAdmin({ userId: randomUUID(), email: 'later@example.test' })).toBe(false)
  })
})
