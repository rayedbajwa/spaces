import { afterAll, describe, expect, test } from 'bun:test'
import { getDb } from '../src/lib/db'
import { confirmSlackIdentity, linkSlackIdentity, revokeSlackIdentity, verifiedSlackUserId, verifySlackIdentityToken } from '../src/lib/slack-identity'
import { createApprovalFixture } from './helpers/approval-fixture'

/**
 * Slack identity link/verify/revoke (US3: FR-015, mismatched/revoked edges).
 * DB-backed against the guarded test database.
 */
const fixture = await createApprovalFixture({ withServer: false })
const { orgA, users } = fixture
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
})
