import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { getDb } from '../src/lib/db'
import { upsertAppIntegration } from '../src/lib/app-integrations'
import { confirmSlackIdentity, linkSlackIdentity, revokeSlackIdentity, sendIdentityVerification, verifiedSlackUserId, verifySlackIdentityToken } from '../src/lib/slack-identity'
import { createApprovalFixture } from './helpers/approval-fixture'

/**
 * Slack identity link/verify/revoke (US3: FR-015, mismatched/revoked edges).
 * DB-backed against the guarded test database.
 */
const fixture = await createApprovalFixture({ withServer: false })
const { orgA, users } = fixture
const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })
afterAll(async () => { await fixture.stop() })

async function emailFor(userId: string): Promise<string> {
  const [row] = await getDb()<Array<{ email: string }>>`SELECT email FROM users WHERE user_id = ${userId}`
  return row!.email
}

describe('identity linking', () => {
  test('a unique active member email verifies immediately and authorizes actions', async () => {
    const email = await emailFor(users.productOwnerA)
    const team = `T-${crypto.randomUUID().slice(0, 6)}`
    const slackUser = `U-${crypto.randomUUID().slice(0, 6)}`
    const linked = await linkSlackIdentity({ orgId: orgA, slackTeamId: team, slackUserId: slackUser, email })
    expect(linked.link.state).toBe('verified')
    expect(linked.token).toBeUndefined()
    expect(await verifiedSlackUserId(orgA, team, slackUser)).toBe(users.productOwnerA)
    await getDb()`DELETE FROM slack_identity_links WHERE link_id = ${linked.link.linkId}`
  })

  test('an unknown email stays pending, gets a one-time token, and authorizes nothing', async () => {
    const team = `T-${crypto.randomUUID().slice(0, 6)}`
    const slackUser = `U-${crypto.randomUUID().slice(0, 6)}`
    const linked = await linkSlackIdentity({ orgId: orgA, slackTeamId: team, slackUserId: slackUser, email: `unknown-${crypto.randomUUID().slice(0, 6)}@example.test` })
    expect(linked.link.state).toBe('pending')
    expect(linked.token).toBeTruthy()
    expect(await verifiedSlackUserId(orgA, team, slackUser)).toBeUndefined()
    await getDb()`DELETE FROM slack_identity_links WHERE link_id = ${linked.link.linkId}`
  })

  test('revoking a link makes its token unusable and removes authorization', async () => {
    const team = `T-${crypto.randomUUID().slice(0, 6)}`
    const slackUser = `U-${crypto.randomUUID().slice(0, 6)}`
    const linked = await linkSlackIdentity({ orgId: orgA, slackTeamId: team, slackUserId: slackUser, email: `revoke-${crypto.randomUUID().slice(0, 6)}@example.test` })
    const token = linked.token!
    await revokeSlackIdentity(orgA, linked.link.linkId)
    expect((await verifySlackIdentityToken(token)).verdict).toBe('revoked')
    expect((await confirmSlackIdentity(token, users.memberA)).ok).toBe(false)
    await getDb()`DELETE FROM slack_identity_links WHERE link_id = ${linked.link.linkId}`
  })

  test('confirm marks a pending link verified for the session user', async () => {
    const team = `T-${crypto.randomUUID().slice(0, 6)}`
    const slackUser = `U-${crypto.randomUUID().slice(0, 6)}`
    const linked = await linkSlackIdentity({ orgId: orgA, slackTeamId: team, slackUserId: slackUser, email: `pending-${crypto.randomUUID().slice(0, 6)}@example.test` })
    const token = linked.token!
    expect((await confirmSlackIdentity(token, users.memberA)).ok).toBe(true)
    expect(await verifiedSlackUserId(orgA, team, slackUser)).toBe(users.memberA)
    expect((await confirmSlackIdentity(token, users.memberA)).ok).toBe(false)
    await getDb()`DELETE FROM slack_identity_links WHERE link_id = ${linked.link.linkId}`
  })

  test('an expired one-time token is refused (409 semantics) and changes nothing', async () => {
    const team = `T-${crypto.randomUUID().slice(0, 6)}`
    const slackUser = `U-${crypto.randomUUID().slice(0, 6)}`
    const linked = await linkSlackIdentity({ orgId: orgA, slackTeamId: team, slackUserId: slackUser, email: `expired-${crypto.randomUUID().slice(0, 6)}@example.test` })
    const token = linked.token!
    await getDb()`UPDATE slack_identity_links SET expires_at = now() - interval '1 minute' WHERE link_id = ${linked.link.linkId}`
    expect((await verifySlackIdentityToken(token)).verdict).toBe('expired')
    expect((await confirmSlackIdentity(token, users.memberA)).ok).toBe(false)
    expect(await verifiedSlackUserId(orgA, team, slackUser)).toBeUndefined()
    await getDb()`DELETE FROM slack_identity_links WHERE link_id = ${linked.link.linkId}`
  })

  test('re-linking an already-verified person preserves the verified state', async () => {
    const team = `T-${crypto.randomUUID().slice(0, 6)}`
    const slackUser = `U-${crypto.randomUUID().slice(0, 6)}`
    const email = `keep-${crypto.randomUUID().slice(0, 6)}@example.test`
    const first = await linkSlackIdentity({ orgId: orgA, slackTeamId: team, slackUserId: slackUser, email: `unknown-${crypto.randomUUID().slice(0, 6)}@example.test` })
    await confirmSlackIdentity(first.token!, users.memberA)
    const again = await linkSlackIdentity({ orgId: orgA, slackTeamId: team, slackUserId: slackUser, email })
    expect(again.link.state).toBe('verified')
    expect(again.link.userId).toBe(users.memberA)
    expect(await verifiedSlackUserId(orgA, team, slackUser)).toBe(users.memberA)
    await getDb()`DELETE FROM slack_identity_links WHERE link_id = ${first.link.linkId}`
  })

  test('the verification DM opens the conversation by Slack user id, never by email', async () => {
    await upsertAppIntegration({ orgId: orgA, kind: 'slack', status: 'connected', credentials: { access_token: 'xoxb-test' } })
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const raw = String(init?.body ?? '')
      const body = raw.startsWith('{') ? JSON.parse(raw) as Record<string, unknown> : Object.fromEntries(new URLSearchParams(raw))
      calls.push({ url, body })
      if (url.endsWith('conversations.open')) return new Response(JSON.stringify({ ok: true, channel: { id: 'D-VERIFY' } }), { status: 200 })
      return new Response(JSON.stringify({ ok: true, ts: '9.9' }), { status: 200 })
    }) as typeof fetch
    const sent = await sendIdentityVerification({ orgId: orgA, slackUserId: 'U-byid', token: 'tok-123' })
    expect(sent).toBe(true)
    expect(calls.some((c) => c.url.endsWith('users.lookupByEmail'))).toBe(false)
    const open = calls.find((c) => c.url.endsWith('conversations.open'))!
    expect(open.body.users).toBe('U-byid')
    const post = calls.find((c) => c.url.endsWith('chat.postMessage'))!
    expect(String(post.body.text)).toContain('/slack-link/tok-123')
  })
})
