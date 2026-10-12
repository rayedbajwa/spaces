import { afterAll, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { getDb } from '../src/lib/db'
import { saveSlackSigningSecret } from '../src/lib/oauth-apps'
import { authenticateSlackRequest, fileSlackIntake, handleSlackCommand, handleSlackEvent, handleSlackInteraction, verifySlackSignature } from '../src/lib/slack-interactions'
import { linkSlackIdentity } from '../src/lib/slack-identity'
import { renderGateActions, renderQuestionThread } from '../src/lib/slack'
import { createApprovalFixture } from './helpers/approval-fixture'

/**
 * Slack signature verification, filing and exactly-once gate decisions (US3:
 * FR-011/012/013/014/016). DB-backed; Slack HTTP is not called.
 */
const fixture = await createApprovalFixture({ withServer: false })
const { orgA, users, gateA, runA } = fixture
afterAll(async () => { await fixture.stop() })

async function emailFor(userId: string): Promise<string> {
  const [row] = await getDb()<Array<{ email: string }>>`SELECT email FROM users WHERE user_id = ${userId}`
  return row!.email
}

async function linkVerified(userId: string, team: string, slackUser: string): Promise<string> {
  const linked = await linkSlackIdentity({ orgId: orgA, slackTeamId: team, slackUserId: slackUser, email: await emailFor(userId) })
  return linked.link.linkId
}

describe('signature verification', () => {
  const secret = 'test-signing-secret'

  test('accepts a fresh correctly-signed body and rejects forgery or an old timestamp', () => {
    const timestamp = String(Math.floor(Date.now() / 1000))
    const body = '{"type":"event_callback"}'
    const signature = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`
    expect(verifySlackSignature({ secret, timestamp, signature, body })).toBe(true)
    expect(verifySlackSignature({ secret, timestamp, signature: 'v0=deadbeef', body })).toBe(false)
    expect(verifySlackSignature({ secret, timestamp: String(Math.floor(Date.now() / 1000) - 3600), signature, body })).toBe(false)
  })

  test('authenticateSlackRequest finds the org by its sealed signing secret and fails closed without one', async () => {
    const missing = await authenticateSlackRequest({ timestamp: '1', signature: 'v0=x', body: '{}' })
    expect(missing.reason === 'not_configured' || missing.reason === 'bad_signature').toBe(true)

    // The Slack app must be configured before its signing secret can be sealed.
    const { saveOAuthApp } = await import('../src/lib/oauth-apps')
    await saveOAuthApp(orgA, 'slack', { clientId: 'slack-client-id', clientSecret: 'slack-client-secret' })
    await saveSlackSigningSecret(orgA, secret)
    const timestamp = String(Math.floor(Date.now() / 1000))
    const body = '{"type":"event_callback"}'
    const signature = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`
    const found = await authenticateSlackRequest({ timestamp, signature, body })
    expect(found.ok).toBe(true)
    expect(found.orgId).toBe(orgA)
  })
})

describe('gate renderers', () => {
  test('interactive buttons carry only the gate id and the three decisions', () => {
    const { text, blocks } = renderGateActions({ gateId: 'gate-1', project: { name: 'Acme', code: 'ACM', slug: 'acme' }, stage: 'review', kind: 'review', summary: 'Looks good' })
    expect(text).toContain('Acme')
    const actions = blocks.find((block) => (block as { type?: string }).type === 'actions') as { elements: Array<{ action_id: string; value: string }> }
    expect(actions.elements.map((element) => element.action_id)).toEqual(['approve', 'approve_with_notes', 'request_changes'])
    expect(actions.elements.every((element) => element.value === 'gate-1')).toBe(true)
  })

  test('a clarification thread prompt carries the question and an in-app link', () => {
    const { blocks } = renderQuestionThread({ project: { name: 'Acme', code: null, slug: 'acme' }, stage: 'clarify', question: 'Which database?', link: 'https://spaces.dev/approvals/x' })
    const body = JSON.stringify(blocks)
    expect(body).toContain('Which database?')
    expect(body).toContain('https://spaces.dev/approvals/x')
  })
})

describe('slack events and commands', () => {
  test('url_verification echoes the challenge', async () => {
    const result = await handleSlackEvent(orgA, { type: 'url_verification', challenge: 'abc123' })
    expect(result.status).toBe(200)
    expect(result.body.challenge).toBe('abc123')
  })

  test('a verified command files an Intake item; an unlinked sender is asked to verify', async () => {
    const team = `T-${crypto.randomUUID().slice(0, 6)}`
    const linkedUser = `U-${crypto.randomUUID().slice(0, 6)}`
    const linkId = await linkVerified(users.memberA, team, linkedUser)
    try {
      const filed = await handleSlackCommand(orgA, { team_id: team, user_id: linkedUser, command: '/spaces', text: 'Fix the flaky login test' })
      expect(filed.status).toBe(200)
      expect(String(filed.body.text)).toContain('Intake item')
      const [row] = await getDb()<Array<{ n: number }>>`SELECT count(*)::int AS n FROM intake_items WHERE org_id = ${orgA} AND source = 'slack' AND title = 'Fix the flaky login test'`
      expect(row?.n).toBe(1)

      const unlinked = await handleSlackCommand(orgA, { team_id: team, user_id: 'U-unknown', command: '/spaces', text: 'Another thing' })
      expect(String(unlinked.body.text).toLowerCase()).toContain('verify')
    } finally {
      await getDb()`DELETE FROM intake_items WHERE org_id = ${orgA} AND source = 'slack'`
      await getDb()`DELETE FROM slack_identity_links WHERE link_id = ${linkId}`
    }
  })

  test('fileSlackIntake requires text', async () => {
    const result = await fileSlackIntake({ orgId: orgA, slackTeamId: 'T-x', slackUserId: 'U-x', text: '   ' })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('bad_request')
  })
})

describe('gate decisions are exactly once', () => {
  test('an unauthorized linked person changes nothing, then the accountable person decides once', async () => {
    const team = `T-${crypto.randomUUID().slice(0, 6)}`
    const outsiderSlack = `U-${crypto.randomUUID().slice(0, 6)}`
    const ownerSlack = `U-${crypto.randomUUID().slice(0, 6)}`
    const outsiderLink = await linkVerified(users.memberA, team, outsiderSlack)
    const poLink = await linkVerified(users.productOwnerA, team, ownerSlack)
    try {
      const refused = await handleSlackInteraction(orgA, { team_id: team, user: { id: outsiderSlack }, actions: [{ action_id: 'approve', value: gateA }] })
      expect(refused.body.ok).toBe(false)
      const [before] = await getDb()<Array<{ n: number }>>`SELECT count(*)::int AS n FROM approval_decisions WHERE gate_id = ${gateA}`
      expect(before?.n).toBe(0)

      const decided = await handleSlackInteraction(orgA, { team_id: team, user: { id: ownerSlack }, actions: [{ action_id: 'approve', value: gateA }] })
      expect(decided.body.replace_original).toBe(true)
      const [after] = await getDb()<Array<{ outcome: string; decidedBy: string; requestId: string | null; linkId: string | null }>>`
        SELECT outcome, decided_by AS "decidedBy", request_id AS "requestId", link_id AS "linkId" FROM approval_decisions WHERE gate_id = ${gateA}
      `
      expect(after?.outcome).toBe('approve')
      expect(after?.decidedBy).toBe(users.productOwnerA)
      expect(after?.requestId).toBeNull()
      expect(after?.linkId).toBeNull()
      const [run] = await getDb()<Array<{ status: string }>>`SELECT status FROM pipeline_runs WHERE run_id = ${runA}`
      expect(run?.status).toBe('queued')

      // A second action shows the winner and changes nothing.
      const second = await handleSlackInteraction(orgA, { team_id: team, user: { id: ownerSlack }, actions: [{ action_id: 'request_changes', value: gateA }] })
      expect(String(second.body.text)).toContain('Already decided')
      const [count] = await getDb()<Array<{ n: number }>>`SELECT count(*)::int AS n FROM approval_decisions WHERE gate_id = ${gateA}`
      expect(count?.n).toBe(1)
    } finally {
      await getDb()`DELETE FROM slack_identity_links WHERE link_id IN (${outsiderLink}, ${poLink})`
    }
  })
})
