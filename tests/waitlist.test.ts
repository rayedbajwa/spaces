import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { applySchema, getDatabaseUrl, getDb } from '../src/lib/db'
import { createSignupLimiter, getWaitlistInvite, inviteFromWaitlist, joinWaitlist, listWaitlist, markWaitlistJoined, parseWaitlistInput, removeFromWaitlist } from '../src/lib/waitlist'

describe('parseWaitlistInput', () => {
  test('needs a valid email, lowercases it and trims the rest', () => {
    expect(parseWaitlistInput({ email: 'nope' })).toEqual({ ok: false, error: 'Enter a valid email address.' })
    const parsed = parseWaitlistInput({ email: '  Ada@Example.COM ', name: '  Ada   Lovelace ', company: '', teamSize: '2-10', note: '  hi ' })
    expect(parsed).toEqual({ ok: true, input: { email: 'ada@example.com', name: 'Ada Lovelace', company: undefined, teamSize: '2-10', note: 'hi' } })
  })

  test('drops an unknown team size and caps long fields', () => {
    const parsed = parseWaitlistInput({ email: 'a@b.co', teamSize: 'lots', name: 'x'.repeat(500) })
    expect(parsed.ok && parsed.input.teamSize).toBeUndefined()
    expect(parsed.ok && parsed.input.name?.length).toBe(120)
  })
})

describe('createSignupLimiter', () => {
  test('allows the limit per key in the window, then refuses until it passes', () => {
    const allow = createSignupLimiter(2, 1000)
    expect(allow('ip', 0)).toBe(true)
    expect(allow('ip', 10)).toBe(true)
    expect(allow('ip', 20)).toBe(false)
    expect(allow('other', 20)).toBe(true)
    expect(allow('ip', 1015)).toBe(true)
  })
})

async function isDbReachable(): Promise<boolean> {
  try { await getDb()`SELECT 1`; return true } catch { return false }
}
const dbAvailable = await isDbReachable()
const dbSuite = dbAvailable ? describe : describe.skip
if (!dbAvailable) test.skip(`waitlist DB tests skipped: DATABASE_URL not reachable (${getDatabaseUrl()})`, () => {})

dbSuite('waitlist storage', () => {
  const email = `waitlist-${randomUUID().slice(0, 8)}@example.test`
  const sql = getDb()
  beforeAll(async () => { await applySchema() })
  afterAll(async () => { await sql`DELETE FROM waitlist WHERE email = ${email}` })

  test('signing up twice keeps one entry', async () => {
    const first = await joinWaitlist({ email, name: 'Ada', teamSize: '2-10' })
    const again = await joinWaitlist({ email, name: 'Someone else' })
    expect(first.created).toBe(true)
    expect(again.created).toBe(false)
    expect(again.entry.entryId).toBe(first.entry.entryId)
    expect(again.entry.name).toBe('Ada')
    expect((await listWaitlist()).filter((e) => e.email === email)).toHaveLength(1)
  })

  test('a join link works once, a new one replaces the old, and joining ends it', async () => {
    const [entry] = await sql<Array<{ entryId: string }>>`SELECT entry_id AS "entryId" FROM waitlist WHERE email = ${email}`
    const firstLink = await inviteFromWaitlist(entry!.entryId, null)
    expect(firstLink?.entry.status).toBe('invited')
    expect((await getWaitlistInvite(firstLink!.token))?.email).toBe(email)

    const secondLink = await inviteFromWaitlist(entry!.entryId, null)
    expect(await getWaitlistInvite(firstLink!.token)).toBeUndefined()
    expect((await getWaitlistInvite(secondLink!.token))?.entryId).toBe(entry!.entryId)

    await markWaitlistJoined(entry!.entryId)
    expect(await getWaitlistInvite(secondLink!.token)).toBeUndefined()
    expect(await inviteFromWaitlist(entry!.entryId, null)).toBeUndefined()
  })

  test('an expired join link is refused', async () => {
    const other = `waitlist-${randomUUID().slice(0, 8)}@example.test`
    const { entry } = await joinWaitlist({ email: other })
    const link = await inviteFromWaitlist(entry.entryId, null)
    await sql`UPDATE waitlist SET expires_at = now() - interval '1 minute' WHERE entry_id = ${entry.entryId}`
    expect(await getWaitlistInvite(link!.token)).toBeUndefined()
    expect(await removeFromWaitlist(entry.entryId)).toBe(true)
    expect(await removeFromWaitlist(entry.entryId)).toBe(false)
  })
})
