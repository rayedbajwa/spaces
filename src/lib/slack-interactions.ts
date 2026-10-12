/**
 * Signature-verified Slack inbound (012-inbound-outbound-slack, US3/R3/R12).
 *
 * Slack events, interactions and slash commands arrive on HTTP endpoints that
 * authenticate by signature, never by session. Each request verifies
 * `X-Slack-Signature` (HMAC-SHA256 over `v0:<timestamp>:<body>`) and the
 * timestamp window against the org's sealed signing secret before any side
 * effect; a forged/old request is refused and audited. Filing resolves the org
 * only when the workspace maps to exactly one org; a gate decision resolves it
 * from the org whose signing secret verified and then re-checks that the actor
 * is still an accountable recipient.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { getDb } from './db'
import { log } from './logger'
import { getSlackSigningSecret, listSlackSigningSecretOrgs } from './oauth-apps'
import { submitSlackDecision, type ApprovalOutcome } from './approval-store'
import { linkSlackIdentity, sendIdentityVerification, verifiedSlackUserId } from './slack-identity'
import { slackWorkspaceTeamId } from './slack'
import { upsertIntakeItem } from './intake-store'

const inboundLog = log.child({ mod: 'slack-interactions' })
const MAX_SKEW_SECONDS = 60 * 5

export interface SlackSignatureResult {
  ok: boolean
  orgId?: string
  reason?: 'not_configured' | 'bad_timestamp' | 'bad_signature'
}

/** Constant-time HMAC comparison, with a bounded timestamp window. */
export function verifySlackSignature(input: { secret: string; timestamp: string | null; signature: string | null; body: string }): boolean {
  if (!input.secret || !input.timestamp || !input.signature) return false
  const ts = Number(input.timestamp)
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > MAX_SKEW_SECONDS) return false
  const expected = `v0=${createHmac('sha256', input.secret).update(`v0:${input.timestamp}:${input.body}`).digest('hex')}`
  const a = Buffer.from(expected)
  const b = Buffer.from(input.signature)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Identify the org whose signing secret verifies this request. */
export async function authenticateSlackRequest(input: { timestamp: string | null; signature: string | null; body: string }): Promise<SlackSignatureResult> {
  const orgs = await listSlackSigningSecretOrgs()
  if (orgs.length === 0) return { ok: false, reason: 'not_configured' }
  for (const org of orgs) {
    if (verifySlackSignature({ secret: org.secret, timestamp: input.timestamp, signature: input.signature, body: input.body })) return { ok: true, orgId: org.orgId }
  }
  if (input.timestamp && Math.abs(Date.now() / 1000 - Number(input.timestamp)) > MAX_SKEW_SECONDS) return { ok: false, reason: 'bad_timestamp' }
  return { ok: false, reason: 'bad_signature' }
}

/** Orgs whose connected Slack workspace matches a team id. Never throws. */
export async function orgsForSlackTeam(teamId: string): Promise<string[]> {
  if (!teamId) return []
  const rows = await getDb()<Array<{ orgId: string }>>`
    SELECT org_id AS "orgId" FROM app_integrations WHERE kind = 'slack' AND status = 'connected'
  `.catch(() => [])
  const out: string[] = []
  for (const row of rows) {
    const workspace = await slackWorkspaceTeamId(row.orgId).catch(() => undefined)
    if (workspace === teamId) out.push(row.orgId)
  }
  return out
}

// ---------------------------------------------------------------------------
// Filing
// ---------------------------------------------------------------------------

export interface SlackFileResult {
  ok: boolean
  intakeId?: string
  state?: string
  reply: string
  code?: 'org_ambiguous' | 'identity_required' | 'bad_request'
}

async function memberEmail(orgId: string, userId: string): Promise<string | null> {
  const [row] = await getDb()<Array<{ email: string }>>`SELECT email FROM users WHERE user_id = ${userId}`
  return row?.email ?? null
}

/**
 * File a Slack request into the org's Intake queue, attributed to the verified
 * linked member. An unverified sender is asked to verify and no item is created.
 */
export async function fileSlackIntake(input: {
  orgId: string
  slackTeamId: string
  slackUserId: string
  text: string
  externalRef?: string
  email?: string | null
}): Promise<SlackFileResult> {
  const text = input.text?.trim()
  if (!text) return { ok: false, code: 'bad_request', reply: 'Tell me what to file, e.g. `/spaces Fix the flaky login test`.' }

  let userId = await verifiedSlackUserId(input.orgId, input.slackTeamId, input.slackUserId)
  if (!userId) {
    const linked = await linkSlackIdentity({ orgId: input.orgId, slackTeamId: input.slackTeamId, slackUserId: input.slackUserId, email: input.email })
    if (linked.token) void sendIdentityVerification({ orgId: input.orgId, slackUserId: input.slackUserId, token: linked.token }).catch(() => undefined)
    if (linked.link.state !== 'verified') {
      return { ok: false, code: 'identity_required', reply: 'Before you can file from Slack, verify your identity with Spaces. I have sent you a one-time link; open it signed in as your Spaces user.' }
    }
    userId = linked.link.userId ?? undefined
  }
  const item = await upsertIntakeItem({
    orgId: input.orgId,
    source: 'slack',
    externalRef: input.externalRef ?? `slack:${input.slackTeamId}:${input.slackUserId}:${Date.now()}`,
    title: text.slice(0, 200),
    summary: text,
    requesterName: null,
    requesterEmail: userId ? await memberEmail(input.orgId, userId) : null,
  })
  return { ok: true, intakeId: item.intakeId, state: item.state, reply: `Filed as an Intake item (${item.state}). A triager will route it into project work.` }
}

// ---------------------------------------------------------------------------
// Events / commands / interactions
// ---------------------------------------------------------------------------

export interface SlackPayload {
  type?: string
  challenge?: string
  team_id?: string
  team?: { id?: string }
  user?: { id?: string; name?: string }
  user_id?: string
  command?: string
  text?: string
  event?: { type?: string; text?: string; user?: string; channel?: string; ts?: string; team?: string; bot_id?: string }
  actions?: Array<{ action_id?: string; value?: string }>
  message?: { ts?: string }
  channel?: { id?: string }
  response_url?: string
}

export interface SlackHandleResult {
  status: number
  body: Record<string, unknown>
}

/** POST /api/slack/events. */
export async function handleSlackEvent(orgId: string, payload: SlackPayload): Promise<SlackHandleResult> {
  if (payload.type === 'url_verification') return { status: 200, body: { challenge: payload.challenge ?? '' } }
  const event = payload.event
  const teamId = payload.team_id ?? payload.team?.id ?? event?.team ?? ''
  const slackUserId = event?.user ?? payload.user?.id ?? ''
  const isMessage = event?.type === 'message' || event?.type === 'app_mention' || payload.type === 'message_action' || payload.type === 'shortcut'
  if (isMessage && event?.bot_id) return { status: 200, body: { ok: true } }
  if (isMessage && slackUserId) {
    const result = await fileSlackIntake({ orgId, slackTeamId: teamId, slackUserId, text: event?.text ?? payload.text ?? '', email: null })
    inboundLog.info('slack event filed', { orgId, ok: result.ok, code: result.code })
    return { status: 200, body: { ok: result.ok, reply: result.reply, intakeId: result.intakeId } }
  }
  return { status: 200, body: { ok: true } }
}

/** POST /api/slack/commands. */
export async function handleSlackCommand(orgId: string, payload: SlackPayload): Promise<SlackHandleResult> {
  const teamId = payload.team_id ?? payload.team?.id ?? ''
  const slackUserId = payload.user_id ?? payload.user?.id ?? ''
  if (!slackUserId) return { status: 200, body: { response_type: 'ephemeral', text: 'I could not identify you in this workspace.' } }
  const result = await fileSlackIntake({ orgId, slackTeamId: teamId, slackUserId, text: payload.text ?? '', email: null })
  return { status: 200, body: { response_type: 'ephemeral', text: result.reply } }
}

/** POST /api/slack/interactions (block actions → gate decisions). */
export async function handleSlackInteraction(orgId: string, payload: SlackPayload): Promise<SlackHandleResult> {
  const action = payload.actions?.[0]
  const slackUserId = payload.user?.id ?? ''
  const teamId = payload.team_id ?? payload.team?.id ?? ''
  const gateId = action?.value ?? ''
  const outcome = action?.action_id as ApprovalOutcome | undefined
  if (!action || !outcome || !['approve', 'approve_with_notes', 'request_changes'].includes(outcome) || !gateId) {
    return { status: 200, body: { ok: false, reply: 'I did not understand that action.' } }
  }
  const userId = await verifiedSlackUserId(orgId, teamId, slackUserId)
  if (!userId) return { status: 200, body: { ok: false, reply: 'Your Slack identity is not verified with Spaces, so I did not record a decision.' } }

  const result = await submitSlackDecision({ gateId, actorUserId: userId, outcome, feedback: null })
  if (result.ok) {
    return { status: 200, body: { replace_original: true, text: `Decision recorded: ${result.decision.outcome.replace(/_/g, ' ')}.` } }
  }
  if (result.decision) {
    return { status: 200, body: { replace_original: true, text: `Already decided: ${result.decision.outcome.replace(/_/g, ' ')}.` } }
  }
  const reason = result.reason === 'feedback_required' ? 'This decision needs notes; open the in-app gate to add them.' : 'This gate is no longer waiting for a decision.'
  return { status: 200, body: { ok: false, replace_original: false, text: reason } }
}

/** The signing secret for one org, if any (used by the setup panel health check). */
export async function slackInboundConfigured(orgId: string): Promise<boolean> {
  return Boolean(await getSlackSigningSecret(orgId))
}
