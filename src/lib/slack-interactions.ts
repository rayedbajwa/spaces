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
import { listSlackSigningSecretOrgs } from './oauth-apps'
import { submitSlackClarification, submitSlackDecision, type ApprovalOutcome } from './approval-store'
import { linkSlackIdentity, sendIdentityVerification, verifiedSlackUserId } from './slack-identity'
import { slackBotToken, slackUserEmail } from './slack'
import { findSlackGatePromptByMessage, listOpenSlackGatePromptsForUser } from './slack-gate-prompts'
import { upsertIntakeItem } from './intake-store'

const inboundLog = log.child({ mod: 'slack-interactions' })
const MAX_SKEW_SECONDS = 60 * 5

export interface SlackSignatureResult {
  ok: boolean
  orgId?: string
  reason?: 'not_configured' | 'bad_timestamp' | 'bad_signature' | 'org_ambiguous'
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

/**
 * Identify the org whose signing secret verifies this request. A workspace that
 * maps to several orgs (the same Slack app connected to two tenants) cannot be
 * attributed by signature alone, so it fails closed (FR-027/R12).
 */
export async function authenticateSlackRequest(input: { timestamp: string | null; signature: string | null; body: string }): Promise<SlackSignatureResult> {
  const orgs = await listSlackSigningSecretOrgs()
  if (orgs.length === 0) return { ok: false, reason: 'not_configured' }
  const matched: string[] = []
  for (const org of orgs) {
    if (verifySlackSignature({ secret: org.secret, timestamp: input.timestamp, signature: input.signature, body: input.body })) matched.push(org.orgId)
  }
  if (matched.length > 1) return { ok: false, reason: 'org_ambiguous' }
  if (matched.length === 1) return { ok: true, orgId: matched[0]! }
  if (input.timestamp && Math.abs(Date.now() / 1000 - Number(input.timestamp)) > MAX_SKEW_SECONDS) return { ok: false, reason: 'bad_timestamp' }
  return { ok: false, reason: 'bad_signature' }
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
  eventTs?: string
  email?: string | null
}): Promise<SlackFileResult> {
  const text = input.text?.trim()
  if (!text) return { ok: false, code: 'bad_request', reply: 'Tell me what to file, e.g. `/spaces Fix the flaky login test`.' }

  let userId = await verifiedSlackUserId(input.orgId, input.slackTeamId, input.slackUserId)
  if (!userId) {
    // Slack's profile email is the link key; resolve it before creating the
    // link so a unique active member verifies immediately (FR-015/US3 #6).
    const email = input.email?.trim() || await slackUserEmail(input.orgId, input.slackUserId)
    const linked = await linkSlackIdentity({ orgId: input.orgId, slackTeamId: input.slackTeamId, slackUserId: input.slackUserId, email })
    if (linked.token) void sendIdentityVerification({ orgId: input.orgId, slackUserId: input.slackUserId, token: linked.token }).catch(() => undefined)
    if (linked.link.state !== 'verified') {
      return { ok: false, code: 'identity_required', reply: 'Before you can file from Slack, verify your identity with Spaces. I have sent you a one-time link; open it signed in as your Spaces user.' }
    }
    userId = linked.link.userId ?? undefined
  }
  const item = await upsertIntakeItem({
    orgId: input.orgId,
    source: 'slack',
    externalRef: input.externalRef ?? (input.eventTs
      ? `slack:${input.slackTeamId}:${input.eventTs}`
      : `slack:${input.slackTeamId}:${input.slackUserId}:${Date.now()}`),
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
  trigger_id?: string
  event?: { type?: string; text?: string; user?: string; channel?: string; ts?: string; thread_ts?: string; team?: string; bot_id?: string }
  actions?: Array<{ action_id?: string; value?: string }>
  message?: { ts?: string; thread_ts?: string; text?: string; user?: string }
  channel?: { id?: string }
  callback_id?: string
  response_url?: string
  view?: {
    private_metadata?: string
    state?: { values?: Record<string, Record<string, { value?: string }>> }
  }
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
  const isMessage = event?.type === 'message' || event?.type === 'app_mention'
  if (isMessage && event?.bot_id) return { status: 200, body: { ok: true } }
  if (isMessage && slackUserId) {
    // A reply in a clarification thread is an answer, not a new intake item.
    const answered = await maybeAnswerClarification(orgId, teamId, slackUserId, event?.text ?? '', event?.thread_ts, event?.channel)
    if (answered) return answered
    const result = await fileSlackIntake({ orgId, slackTeamId: teamId, slackUserId, text: event?.text ?? '', email: null, eventTs: event?.ts })
    inboundLog.info('slack event filed', { orgId, ok: result.ok, code: result.code })
    return { status: 200, body: { ok: result.ok, reply: result.reply, intakeId: result.intakeId } }
  }
  return { status: 200, body: { ok: true } }
}

/**
 * A message reply inside a posted clarification prompt's thread is delivered to
 * the paused run verbatim (US3 #4). Returns undefined when the message is not a
 * clarification answer, so normal filing continues.
 */
async function maybeAnswerClarification(
  orgId: string,
  teamId: string,
  slackUserId: string,
  text: string,
  threadTs: string | undefined,
  channelId: string | undefined,
): Promise<SlackHandleResult | undefined> {
  if (!channelId) return undefined
  let prompt
  if (threadTs) {
    prompt = await findSlackGatePromptByMessage(orgId, channelId, threadTs).catch(() => undefined)
  } else {
    // A plain DM reply carries no thread ts, so match the newest open
    // clarification prompt posted to this person's DM channel (US3 #4).
    const open = await listOpenSlackGatePromptsForUser(orgId, slackUserId, channelId).catch(() => [])
    prompt = open[0]
  }
  if (!prompt || prompt.promptKind !== 'clarification') return undefined
  if (prompt.slackUserId && prompt.slackUserId !== slackUserId) return undefined
  // Scope the identity to the event's workspace: a verified link in one team
  // must never answer a gate resolved through another (FR-027/SC-009).
  const userId = teamId
    ? await verifiedSlackUserId(orgId, teamId, slackUserId)
    : await verifiedSlackUserIdAnyTeam(orgId, slackUserId)
  if (!userId) return { status: 200, body: { ok: false, reply: 'Your Slack identity is not verified with Spaces, so I did not record an answer.' } }
  const answer = text.trim()
  if (!answer) return { status: 200, body: { ok: false, reply: 'The answer was empty, so nothing was recorded.' } }
  const result = await submitSlackClarification({ gateId: prompt.gateId, actorUserId: userId, answer, orgId })
  if (result.ok) return { status: 200, body: { ok: true, reply: 'Answer recorded; the run continues.' } }
  if (result.decision) return { status: 200, body: { ok: false, reply: `Already resolved: ${result.decision.outcome.replace(/_/g, ' ')}.` } }
  return { status: 200, body: { ok: false, reply: 'That question is no longer waiting for an answer.' } }
}

/** Fallback identity lookup when a payload carries no team id. Never throws. */
async function verifiedSlackUserIdAnyTeam(orgId: string, slackUserId: string): Promise<string | undefined> {
  const [row] = await getDb()<Array<{ userId: string | null }>>`
    SELECT user_id AS "userId" FROM slack_identity_links
     WHERE org_id = ${orgId} AND slack_user_id = ${slackUserId} AND state = 'verified'
  `
  return row?.userId ?? undefined
}

/** POST /api/slack/commands. */
export async function handleSlackCommand(orgId: string, payload: SlackPayload): Promise<SlackHandleResult> {
  const teamId = payload.team_id ?? payload.team?.id ?? ''
  const slackUserId = payload.user_id ?? payload.user?.id ?? ''
  if (!slackUserId) return { status: 200, body: { response_type: 'ephemeral', text: 'I could not identify you in this workspace.' } }
  const result = await fileSlackIntake({ orgId, slackTeamId: teamId, slackUserId, text: payload.text ?? '', email: null })
  return { status: 200, body: { response_type: 'ephemeral', text: result.reply } }
}

function feedbackFromView(payload: SlackPayload): string | null {
  const values = payload.view?.state?.values ?? {}
  for (const block of Object.values(values)) {
    for (const action of Object.values(block ?? {})) {
      if (typeof action?.value === 'string' && action.value.trim()) return action.value
    }
  }
  return null
}

function metadataFromView(payload: SlackPayload): { gateId?: string; outcome?: ApprovalOutcome } {
  try {
    const parsed = JSON.parse(payload.view?.private_metadata ?? '{}') as { gateId?: string; outcome?: ApprovalOutcome }
    return parsed
  } catch {
    return {}
  }
}

/** Open the feedback modal that collects notes for approve-with-notes / request-changes. */
async function openFeedbackModal(input: { orgId: string; triggerId: string; gateId: string; outcome: ApprovalOutcome }): Promise<boolean> {
  const token = await slackBotToken(input.orgId).catch(() => undefined)
  if (!token || !input.triggerId) return false
  const title = input.outcome === 'request_changes' ? 'Request changes' : 'Approve with notes'
  try {
    const response = await fetch('https://slack.com/api/views.open', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        trigger_id: input.triggerId,
        view: {
          type: 'modal',
          callback_id: 'spaces_gate_feedback',
          private_metadata: JSON.stringify({ gateId: input.gateId, outcome: input.outcome }),
          title: { type: 'plain_text', text: title },
          submit: { type: 'plain_text', text: 'Submit' },
          close: { type: 'plain_text', text: 'Cancel' },
          blocks: [{
            type: 'input',
            block_id: 'feedback',
            label: { type: 'plain_text', text: input.outcome === 'request_changes' ? 'What should change?' : 'Add notes for the agent' },
            element: { type: 'plain_text_input', action_id: 'value', multiline: true },
          }],
        },
      }),
    })
    const body = (await response.json().catch(() => ({}))) as { ok?: boolean }
    return body.ok !== false
  } catch (error) {
    inboundLog.warn('could not open the Slack feedback modal', { orgId: input.orgId, error: error instanceof Error ? error.message : String(error) })
    return false
  }
}

/** POST /api/slack/interactions (message shortcut, block actions and modal submissions). */
export async function handleSlackInteraction(orgId: string, payload: SlackPayload): Promise<SlackHandleResult> {
  const slackUserId = payload.user?.id ?? ''
  const teamId = payload.team_id ?? payload.team?.id ?? ''

  // A message shortcut files the message it was invoked on. Only this app's own
  // shortcut is accepted; filing owns the identity flow (US3 #8).
  if (payload.type === 'message_action') {
    if (payload.callback_id !== 'spaces_file_intake') return { status: 200, body: { ok: true } }
    const filed = await fileSlackIntake({
      orgId,
      slackTeamId: teamId,
      slackUserId: payload.user?.id ?? payload.message?.user ?? '',
      text: payload.message?.text ?? '',
      email: null,
      externalRef: payload.message?.ts ? `slack:${teamId}:${payload.message.ts}` : undefined,
    })
    inboundLog.info('slack shortcut filed', { orgId, ok: filed.ok, code: filed.code })
    return { status: 200, body: { response_type: 'ephemeral', text: filed.reply } }
  }

  let userId = await verifiedSlackUserId(orgId, teamId, slackUserId)
  if (!userId) {
    // An unlinked person gets the same one-time verification path as the filing
    // route instead of a dead end (US3 #6 / FR-015).
    const email = await slackUserEmail(orgId, slackUserId).catch(() => null)
    const linked = await linkSlackIdentity({ orgId, slackTeamId: teamId, slackUserId, email })
    if (linked.token) void sendIdentityVerification({ orgId, slackUserId, token: linked.token }).catch(() => undefined)
    userId = linked.link.state === 'verified' ? (linked.link.userId ?? undefined) : undefined
    if (!userId) return { status: 200, body: { ok: false, reply: 'Before you can decide from Slack, verify your identity with Spaces. I have sent you a one-time link; open it signed in as your Spaces user.' } }
  }

  // A modal submission carries the verbatim notes for a feedback decision.
  if (payload.type === 'view_submission') {
    const { gateId, outcome } = metadataFromView(payload)
    const feedback = feedbackFromView(payload)
    if (!gateId || !outcome || !['approve_with_notes', 'request_changes'].includes(outcome)) {
      return { status: 200, body: { response_action: 'clear' } }
    }
    if (!feedback) {
      return { status: 200, body: { response_action: 'errors', errors: { feedback: 'Add the notes the agent needs.' } } }
    }
    const submitted = await submitSlackDecision({ gateId, actorUserId: userId, outcome, feedback, orgId })
    if (submitted.ok) return { status: 200, body: { response_action: 'clear' } }
    if (submitted.decision) return { status: 200, body: { response_action: 'clear' } }
    return { status: 200, body: { response_action: 'errors', errors: { feedback: 'This gate is no longer waiting for a decision.' } } }
  }

  const action = payload.actions?.[0]
  const gateId = action?.value ?? ''
  const outcome = action?.action_id as ApprovalOutcome | undefined
  if (!action || !outcome || !['approve', 'approve_with_notes', 'request_changes'].includes(outcome) || !gateId) {
    return { status: 200, body: { ok: false, reply: 'I did not understand that action.' } }
  }

  // A feedback decision opens a modal; the notes arrive as a view_submission.
  if (outcome !== 'approve') {
    const opened = await openFeedbackModal({ orgId, triggerId: payload.trigger_id ?? '', gateId, outcome })
    if (opened) return { status: 200, body: { ok: true } }
  }

  const result = await submitSlackDecision({ gateId, actorUserId: userId, outcome, feedback: null, orgId })
  if (result.ok) {
    return { status: 200, body: { replace_original: true, text: `Decision recorded: ${result.decision.outcome.replace(/_/g, ' ')}.` } }
  }
  if (result.decision) {
    return { status: 200, body: { replace_original: true, text: `Already decided: ${result.decision.outcome.replace(/_/g, ' ')}.` } }
  }
  const reason = result.reason === 'feedback_required' ? 'This decision needs notes; open the in-app gate to add them.' : 'This gate is no longer waiting for a decision.'
  return { status: 200, body: { ok: false, replace_original: false, text: reason } }
}

