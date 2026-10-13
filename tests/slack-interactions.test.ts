import { afterAll, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { getDb } from '../src/lib/db'
import { upsertAppIntegration, disconnectAppIntegration } from '../src/lib/app-integrations'
import { saveSlackSigningSecret } from '../src/lib/oauth-apps'
import { authenticateSlackRequest, fileSlackIntake, handleSlackCommand, handleSlackEvent, handleSlackInteraction, verifySlackSignature } from '../src/lib/slack-interactions'
import { submitSlackClarification } from '../src/lib/approval-store'
import { linkSlackIdentity } from '../src/lib/slack-identity'
import { renderGateActions, renderQuestionThread } from '../src/lib/slack'
import { saveSlackGatePrompt, markSlackGatePromptsDecided } from '../src/lib/slack-gate-prompts'
import { answerPausedRun, openGate } from '../src/lib/run-store'
import { createApprovalFixture } from './helpers/approval-fixture'

/**
 * Slack signature verification, filing and exactly-once gate decisions (US3:
 * FR-011/012/013/014/016). DB-backed; Slack HTTP is not called.
 */
const fixture = await createApprovalFixture({ withServer: false })
const { orgA, orgB, users, gateA, runA, projectA } = fixture
afterAll(async () => { await fixture.stop() })

async function emailFor(userId: string): Promise<string> {
  const [row] = await getDb()<Array<{ email: string }>>`SELECT email FROM users WHERE user_id = ${userId}`
  return row!.email
}

async function linkVerified(userId: string, team: string, slackUser: string): Promise<string> {
  const linked = await linkSlackIdentity({ orgId: orgA, slackTeamId: team, slackUserId: slackUser, email: await emailFor(userId) })
  return linked.link.linkId
}

async function linkVerifiedIn(orgId: string, userId: string, team: string, slackUser: string): Promise<string> {
  const linked = await linkSlackIdentity({ orgId, slackTeamId: team, slackUserId: slackUser, email: await emailFor(userId) })
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

  test('fails closed when a workspace maps to several organizations (R12)', async () => {
    // The same Slack app (secret) connected to two orgs makes the request
    // unattributable by signature alone.
    const { saveOAuthApp, deleteOAuthApp } = await import('../src/lib/oauth-apps')
    await saveOAuthApp(orgB, 'slack', { clientId: 'slack-client-id', clientSecret: 'slack-client-secret' })
    await saveSlackSigningSecret(orgA, secret)
    await saveSlackSigningSecret(orgB, secret)
    const timestamp = String(Math.floor(Date.now() / 1000))
    const body = '{"type":"event_callback"}'
    const signature = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`
    try {
      const found = await authenticateSlackRequest({ timestamp, signature, body })
      expect(found.ok).toBe(false)
      expect(found.reason).toBe('org_ambiguous')
    } finally {
      await deleteOAuthApp(orgB, 'slack')
    }
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

  test('an unlinked person acting on a gate is asked to verify and gets a one-time link', async () => {
    const team = `T-${crypto.randomUUID().slice(0, 6)}`
    const slackUser = `U-${crypto.randomUUID().slice(0, 6)}`
    const gateId = await openGate({ runId: runA, stepIndex: 0, kind: 'review', prompt: 'review' })
    try {
      const result = await handleSlackInteraction(orgA, { team_id: team, user: { id: slackUser }, actions: [{ action_id: 'approve', value: gateId }] })
      expect(result.body.ok).toBe(false)
      expect(String(result.body.reply).toLowerCase()).toContain('verify')
      const [link] = await getDb()<Array<{ state: string; tokenHash: string | null }>>`
        SELECT state, token_hash AS "tokenHash" FROM slack_identity_links
         WHERE org_id = ${orgA} AND slack_team_id = ${team} AND slack_user_id = ${slackUser}
      `
      expect(link?.state).toBe('pending')
      expect(link?.tokenHash).not.toBeNull()
      const [decision] = await getDb()<Array<{ n: number }>>`SELECT count(*)::int AS n FROM approval_decisions WHERE gate_id = ${gateId}`
      expect(decision?.n).toBe(0)
    } finally {
      await getDb()`DELETE FROM slack_identity_links WHERE org_id = ${orgA} AND slack_team_id = ${team} AND slack_user_id = ${slackUser}`
      await getDb()`DELETE FROM pipeline_gates WHERE gate_id = ${gateId}`
    }
  })
})

describe('feedback decisions and clarification answers from Slack', () => {
  test('a modal submission delivers feedback verbatim as a request-changes decision', async () => {
    const team = `T-${crypto.randomUUID().slice(0, 6)}`
    const slackUser = `U-${crypto.randomUUID().slice(0, 6)}`
    const linkId = await linkVerified(users.productOwnerA, team, slackUser)
    const gateId = await openGate({ runId: runA, stepIndex: 0, kind: 'review', prompt: 'review' })
    await getDb()`UPDATE pipeline_runs SET status = 'paused', pause_kind = 'review', current_stage = 'review' WHERE run_id = ${runA}`
    try {
      const result = await handleSlackInteraction(orgA, {
        type: 'view_submission',
        team_id: team,
        user: { id: slackUser },
        view: {
          private_metadata: JSON.stringify({ gateId, outcome: 'request_changes' }),
          state: { values: { feedback: { value: { value: 'Use the v2 endpoint instead' } } } },
        },
      })
      expect(result.status).toBe(200)
      expect(result.body.response_action).toBe('clear')
      const [decision] = await getDb()<Array<{ outcome: string; feedback: string | null }>>`
        SELECT outcome, feedback FROM approval_decisions WHERE gate_id = ${gateId}
      `
      expect(decision?.outcome).toBe('request_changes')
      expect(decision?.feedback).toBe('Use the v2 endpoint instead')
    } finally {
      await getDb()`DELETE FROM approval_decisions WHERE gate_id = ${gateId}`
      await getDb()`DELETE FROM pipeline_gates WHERE gate_id = ${gateId}`
      await getDb()`DELETE FROM slack_identity_links WHERE link_id = ${linkId}`
    }
  })

  test('marking a decided gate closes its prompt rows so a stale prompt cannot be reused', async () => {
    const gateId = await openGate({ runId: runA, stepIndex: 0, kind: 'review', prompt: 'review' })
    await saveSlackGatePrompt({ orgId: orgA, gateId, slackUserId: 'U-prompt', channelId: 'D-PROMPT', messageTs: '1700.200', promptKind: 'review' })
    try {
      await markSlackGatePromptsDecided(gateId, 'Decision recorded: approve.')
      const [row] = await getDb()<Array<{ decidedAt: string | null }>>`
        SELECT decided_at AS "decidedAt" FROM slack_gate_prompts WHERE gate_id = ${gateId}
      `
      expect(row?.decidedAt).not.toBeNull()
    } finally {
      await getDb()`DELETE FROM slack_gate_prompts WHERE gate_id = ${gateId}`
      await getDb()`DELETE FROM pipeline_gates WHERE gate_id = ${gateId}`
    }
  })

  test('an in-app answer closes the Slack prompt posted for the gate', async () => {
    const gateId = await openGate({ runId: runA, stepIndex: 0, kind: 'review', prompt: 'review' })
    await getDb()`UPDATE pipeline_runs SET status = 'paused', pause_kind = 'review', current_stage = 'review' WHERE run_id = ${runA}`
    await saveSlackGatePrompt({ orgId: orgA, gateId, slackUserId: 'U-inapp', channelId: 'D-INAPP', messageTs: '1800.100', promptKind: 'review' })
    try {
      const answered = await answerPausedRun({ runId: runA, projectId: projectA.projectId, answer: 'approve' })
      expect(answered.ok).toBe(true)
      const [prompt] = await getDb()<Array<{ decidedAt: string | null }>>`SELECT decided_at AS "decidedAt" FROM slack_gate_prompts WHERE gate_id = ${gateId}`
      expect(prompt?.decidedAt).not.toBeNull()
    } finally {
      const gateText = `"${gateId}"`
      await getDb()`DELETE FROM slack_gate_prompts WHERE gate_id = ${gateId}`
      await getDb()`DELETE FROM project_jobs WHERE run_id = ${runA}`
      await getDb()`DELETE FROM pipeline_events WHERE run_id = ${runA} AND kind = 'gate_resolved' AND (payload->'gateId')::text = ${gateText}`
      await getDb()`DELETE FROM pipeline_gates WHERE gate_id = ${gateId}`
    }
  })

  test('a reply in a clarification prompt thread is delivered verbatim', async () => {
    const team = `T-${crypto.randomUUID().slice(0, 6)}`
    const slackUser = `U-${crypto.randomUUID().slice(0, 6)}`
    const linkId = await linkVerified(users.ownerA, team, slackUser)
    const gateId = await openGate({ runId: runA, stepIndex: 0, kind: 'clarification', prompt: 'clarify' })
    await getDb()`UPDATE pipeline_runs SET status = 'paused', pause_kind = 'clarification', current_stage = 'clarify' WHERE run_id = ${runA}`
    await saveSlackGatePrompt({ orgId: orgA, gateId, slackUserId: slackUser, channelId: 'D-CLARIFY', messageTs: '1700.100', promptKind: 'clarification' })
    try {
      const result = await handleSlackEvent(orgA, {
        team_id: team,
        event: { type: 'message', user: slackUser, channel: 'D-CLARIFY', thread_ts: '1700.100', text: 'Use Postgres, not SQLite' },
      })
      expect(result.body.ok).toBe(true)
      const [gate] = await getDb()<Array<{ response: string | null }>>`SELECT response FROM pipeline_gates WHERE gate_id = ${gateId}`
      expect(gate?.response).toBe('Use Postgres, not SQLite')
    } finally {
      await getDb()`DELETE FROM slack_gate_prompts WHERE gate_id = ${gateId}`
      await getDb()`DELETE FROM approval_decisions WHERE gate_id = ${gateId}`
      await getDb()`DELETE FROM pipeline_gates WHERE gate_id = ${gateId}`
      await getDb()`DELETE FROM slack_identity_links WHERE link_id = ${linkId}`
    }
  })

  test('a plain DM reply with no thread ts answers the open clarification', async () => {
    const team = `T-${crypto.randomUUID().slice(0, 6)}`
    const slackUser = `U-${crypto.randomUUID().slice(0, 6)}`
    const linkId = await linkVerified(users.ownerA, team, slackUser)
    const gateId = await openGate({ runId: runA, stepIndex: 0, kind: 'clarification', prompt: 'clarify' })
    await getDb()`UPDATE pipeline_runs SET status = 'paused', pause_kind = 'clarification', current_stage = 'clarify' WHERE run_id = ${runA}`
    await saveSlackGatePrompt({ orgId: orgA, gateId, slackUserId: slackUser, channelId: 'D-DM-PLAIN', messageTs: '1700.500', promptKind: 'clarification' })
    try {
      const result = await handleSlackEvent(orgA, {
        team_id: team,
        event: { type: 'message', user: slackUser, channel: 'D-DM-PLAIN', text: 'Use Postgres, not SQLite' },
      })
      expect(result.body.ok).toBe(true)
      const [gate] = await getDb()<Array<{ response: string | null }>>`SELECT response FROM pipeline_gates WHERE gate_id = ${gateId}`
      expect(gate?.response).toBe('Use Postgres, not SQLite')
    } finally {
      await getDb()`DELETE FROM slack_gate_prompts WHERE gate_id = ${gateId}`
      await getDb()`DELETE FROM approval_decisions WHERE gate_id = ${gateId}`
      await getDb()`DELETE FROM pipeline_gates WHERE gate_id = ${gateId}`
      await getDb()`DELETE FROM slack_identity_links WHERE link_id = ${linkId}`
    }
  })

  test('a clarification reply from a different team of the same org cannot answer', async () => {
    const teamA = `T-${crypto.randomUUID().slice(0, 6)}`
    const teamB = `T-${crypto.randomUUID().slice(0, 6)}`
    const slackUser = `U-${crypto.randomUUID().slice(0, 6)}`
    const linkId = await linkVerified(users.ownerA, teamA, slackUser)
    const gateId = await openGate({ runId: runA, stepIndex: 0, kind: 'clarification', prompt: 'clarify' })
    await getDb()`UPDATE pipeline_runs SET status = 'paused', pause_kind = 'clarification', current_stage = 'clarify' WHERE run_id = ${runA}`
    await saveSlackGatePrompt({ orgId: orgA, gateId, slackUserId: slackUser, channelId: 'D-TEAM-SCOPE', messageTs: '1700.600', promptKind: 'clarification' })
    try {
      const result = await handleSlackEvent(orgA, {
        team_id: teamB,
        event: { type: 'message', user: slackUser, channel: 'D-TEAM-SCOPE', thread_ts: '1700.600', text: 'Use Postgres' },
      })
      // The team-B event must not fall back to the person's team-A link.
      expect(result.body.ok).toBe(false)
      const [gate] = await getDb()<Array<{ response: string | null }>>`SELECT response FROM pipeline_gates WHERE gate_id = ${gateId}`
      expect(gate?.response).toBeNull()
    } finally {
      await getDb()`DELETE FROM slack_gate_prompts WHERE gate_id = ${gateId}`
      await getDb()`DELETE FROM approval_decisions WHERE gate_id = ${gateId}`
      await getDb()`DELETE FROM pipeline_gates WHERE gate_id = ${gateId}`
      await getDb()`DELETE FROM slack_identity_links WHERE link_id = ${linkId}`
    }
  })
})

describe('slack identity resolution and message shortcuts', () => {
  test('a message shortcut files the message it was invoked on', async () => {
    const team = `T-${crypto.randomUUID().slice(0, 6)}`
    const slackUser = `U-${crypto.randomUUID().slice(0, 6)}`
    const linkId = await linkVerified(users.memberA, team, slackUser)
    const externalRef = `slack:${team}:1700.900`
    try {
      const result = await handleSlackInteraction(orgA, {
        type: 'message_action',
        team_id: team,
        callback_id: 'spaces_file_intake',
        user: { id: slackUser },
        message: { ts: '1700.900', text: 'Shortcut request' },
      })
      expect(String(result.body.text)).toContain('Intake item')
      const [row] = await getDb()<Array<{ n: number }>>`SELECT count(*)::int AS n FROM intake_items WHERE org_id = ${orgA} AND source = 'slack' AND external_ref = ${externalRef}`
      expect(row?.n).toBe(1)
    } finally {
      await getDb()`DELETE FROM intake_items WHERE org_id = ${orgA} AND external_ref = ${externalRef}`
      await getDb()`DELETE FROM slack_identity_links WHERE link_id = ${linkId}`
    }
  })

  test('a Slack profile email verifies the identity immediately', async () => {
    const team = `T-${crypto.randomUUID().slice(0, 6)}`
    const slackUser = `U-${crypto.randomUUID().slice(0, 6)}`
    const email = await emailFor(users.memberA)
    const realFetch = globalThis.fetch
    await upsertAppIntegration({ orgId: orgA, kind: 'slack', status: 'connected', displayName: 'Slack', credentials: { access_token: 'xoxb-test' } })
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/users.info')) return new Response(JSON.stringify({ ok: true, user: { profile: { email } } }), { status: 200, headers: { 'content-type': 'application/json' } })
      return new Response(JSON.stringify({ ok: false, error: 'unexpected_call' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    try {
      const result = await fileSlackIntake({ orgId: orgA, slackTeamId: team, slackUserId: slackUser, text: 'Profile-verified request' })
      expect(result.ok).toBe(true)
      expect(result.code).toBeUndefined()
      const [link] = await getDb()<Array<{ state: string }>>`SELECT state FROM slack_identity_links WHERE org_id = ${orgA} AND slack_team_id = ${team} AND slack_user_id = ${slackUser}`
      expect(link?.state).toBe('verified')
    } finally {
      globalThis.fetch = realFetch
      await getDb()`DELETE FROM intake_items WHERE org_id = ${orgA} AND source = 'slack' AND title = 'Profile-verified request'`
      await getDb()`DELETE FROM slack_identity_links WHERE org_id = ${orgA} AND slack_team_id = ${team} AND slack_user_id = ${slackUser}`
      await disconnectAppIntegration(orgA, 'slack')
    }
  })
  test('a foreign message shortcut callback is ignored', async () => {
    const team = `T-${crypto.randomUUID().slice(0, 6)}`
    const slackUser = `U-${crypto.randomUUID().slice(0, 6)}`
    const linkId = await linkVerified(users.memberA, team, slackUser)
    const externalRef = `slack:${team}:1800.100`
    try {
      const result = await handleSlackInteraction(orgA, {
        type: 'message_action',
        team_id: team,
        callback_id: 'some_other_shortcut',
        user: { id: slackUser },
        message: { ts: '1800.100', text: 'Not ours' },
      })
      expect(result.body.ok).toBe(true)
      const [row] = await getDb()<Array<{ n: number }>>`SELECT count(*)::int AS n FROM intake_items WHERE org_id = ${orgA} AND external_ref = ${externalRef}`
      expect(row?.n).toBe(0)
    } finally {
      await getDb()`DELETE FROM intake_items WHERE org_id = ${orgA} AND external_ref = ${externalRef}`
      await getDb()`DELETE FROM slack_identity_links WHERE link_id = ${linkId}`
    }
  })

  test('the event endpoint ignores a message shortcut payload', async () => {
    const team = `T-${crypto.randomUUID().slice(0, 6)}`
    const slackUser = `U-${crypto.randomUUID().slice(0, 6)}`
    const linkId = await linkVerified(users.memberA, team, slackUser)
    const externalRef = `slack:${team}:1800.200`
    try {
      const result = await handleSlackEvent(orgA, {
        type: 'message_action',
        team_id: team,
        user: { id: slackUser },
        message: { ts: '1800.200', text: 'Should not file' },
      })
      expect(result.body.ok).toBe(true)
      const [row] = await getDb()<Array<{ n: number }>>`SELECT count(*)::int AS n FROM intake_items WHERE org_id = ${orgA} AND external_ref = ${externalRef}`
      expect(row?.n).toBe(0)
    } finally {
      await getDb()`DELETE FROM intake_items WHERE org_id = ${orgA} AND external_ref = ${externalRef}`
      await getDb()`DELETE FROM slack_identity_links WHERE link_id = ${linkId}`
    }
  })
})

describe('a shared workspace fails closed across organizations', () => {
  test('an org-B actor cannot decide or answer an org-A gate', async () => {
    const team = `T-${crypto.randomUUID().slice(0, 6)}`
    const slackUser = `U-${crypto.randomUUID().slice(0, 6)}`
    const linkId = await linkVerifiedIn(orgB, users.otherOrgOwner, team, slackUser)
    const gateId = await openGate({ runId: runA, stepIndex: 0, kind: 'review', prompt: 'review' })
    try {
      const result = await handleSlackInteraction(orgB, { team_id: team, user: { id: slackUser }, actions: [{ action_id: 'approve', value: gateId }] })
      expect(result.body.ok).toBe(false)
      const [count] = await getDb()<Array<{ n: number }>>`SELECT count(*)::int AS n FROM approval_decisions WHERE gate_id = ${gateId}`
      expect(count?.n).toBe(0)

      const answer = await submitSlackClarification({ gateId, actorUserId: users.ownerA, answer: 'Use Postgres', orgId: orgB })
      expect(answer.ok).toBe(false)
    } finally {
      await getDb()`DELETE FROM slack_identity_links WHERE link_id = ${linkId}`
      await getDb()`DELETE FROM approval_decisions WHERE gate_id = ${gateId}`
      await getDb()`DELETE FROM pipeline_gates WHERE gate_id = ${gateId}`
    }
  })
})

describe('a retried Slack event does not duplicate intake', () => {
  test('the same event ts files exactly one Intake item', async () => {
    const team = `T-${crypto.randomUUID().slice(0, 6)}`
    const slackUser = `U-${crypto.randomUUID().slice(0, 6)}`
    const linkId = await linkVerified(users.memberA, team, slackUser)
    const ts = `${Date.now()}.000100`
    const externalRef = `slack:${team}:${ts}`
    const payload = { team_id: team, event: { type: 'message', user: slackUser, channel: 'C-RETRY', ts, text: 'Retried event' } }
    try {
      await handleSlackEvent(orgA, payload)
      await handleSlackEvent(orgA, payload)
      const [row] = await getDb()<Array<{ n: number }>>`SELECT count(*)::int AS n FROM intake_items WHERE org_id = ${orgA} AND source = 'slack' AND external_ref = ${externalRef}`
      expect(row?.n).toBe(1)
    } finally {
      await getDb()`DELETE FROM intake_items WHERE org_id = ${orgA} AND external_ref = ${externalRef}`
      await getDb()`DELETE FROM slack_identity_links WHERE link_id = ${linkId}`
    }
  })
})

describe('a competing second decision leaves the stale prompt closed', () => {
  test('the second action reads the winner and the first prompt is marked decided', async () => {
    const team = `T-${crypto.randomUUID().slice(0, 6)}`
    const slackUser = `U-${crypto.randomUUID().slice(0, 6)}`
    const linkId = await linkVerified(users.productOwnerA, team, slackUser)
    const gateId = await openGate({ runId: runA, stepIndex: 0, kind: 'review', prompt: 'review' })
    await getDb()`UPDATE pipeline_runs SET status = 'paused', pause_kind = 'review', current_stage = 'review' WHERE run_id = ${runA}`
    await saveSlackGatePrompt({ orgId: orgA, gateId, slackUserId: slackUser, channelId: 'D-COMPETE', messageTs: '1700.300', promptKind: 'review' })
    try {
      const first = await handleSlackInteraction(orgA, { team_id: team, user: { id: slackUser }, actions: [{ action_id: 'approve', value: gateId }] })
      expect(first.body.replace_original).toBe(true)
      const second = await handleSlackInteraction(orgA, { team_id: team, user: { id: slackUser }, actions: [{ action_id: 'request_changes', value: gateId }] })
      expect(String(second.body.text)).toContain('Already decided')
      const [prompt] = await getDb()<Array<{ decidedAt: string | null }>>`SELECT decided_at AS "decidedAt" FROM slack_gate_prompts WHERE gate_id = ${gateId}`
      expect(prompt?.decidedAt).not.toBeNull()
      const [decisions] = await getDb()<Array<{ n: number; outcome: string }>>`SELECT count(*)::int AS n, min(outcome) AS outcome FROM approval_decisions WHERE gate_id = ${gateId}`
      expect(decisions?.n).toBe(1)
      expect(decisions?.outcome).toBe('approve')
    } finally {
      await getDb()`DELETE FROM slack_gate_prompts WHERE gate_id = ${gateId}`
      await getDb()`DELETE FROM approval_decisions WHERE gate_id = ${gateId}`
      await getDb()`DELETE FROM pipeline_gates WHERE gate_id = ${gateId}`
      await getDb()`DELETE FROM slack_identity_links WHERE link_id = ${linkId}`
    }
  })
})
