/**
 * Direct delivery of owner approval requests (011-owner-approval-link).
 *
 * Each request goes over exactly one channel: a Slack DM when the organization
 * has Slack connected and the recipient matches a Slack account by email,
 * otherwise email through the organization's connected email integration or the
 * platform Resend fallback. A failure on the chosen channel falls through to the
 * other; if neither works the request is `undeliverable` and the in-app gate
 * stays actionable. Nothing here throws, blocks or fails a run.
 *
 * Outbound text is passed through the organization's AI data guardrails before
 * it leaves the app, exactly as project channel posts are.
 */

import { getDb } from './db'
import { loadGuardPolicy } from './guardrails-policy'
import { maskOutputDeep } from './guardrails'
import { log } from './logger'
import { emailConfigured, emailSender, sendEmail } from './email'
import { sendDirectMessage, renderApprovalDm, slackText } from './slack'
import {
  createApprovalRequests,
  invalidateApprovalRequest,
  markRequestUndeliverable,
  recordDelivery,
  resolveGateRecipients,
  type ApprovalRequest,
  type CreatedApprovalRequest,
} from './approval-store'

const notifyLog = log.child({ mod: 'approval-notify' })

export interface ApprovalNotifyTarget {
  project: { projectId: string; name: string; code: string | null; slug: string }
  stage: string
  kind: 'review' | 'clarification'
  summary?: string | null
  responsibility?: string | null
  fallback?: boolean
  origin?: string
}

/** Absolute link to the one-time approval page; falls back to PUBLIC_URL. */
export function approvalLinkUrl(token: string, origin?: string): string {
  const base = (origin ?? process.env.PUBLIC_URL ?? 'http://localhost:3000').replace(/\/+$/, '')
  return `${base}/approvals/${encodeURIComponent(token)}`
}

function decisionLabel(outcome: 'approve' | 'approve_with_notes' | 'request_changes'): string {
  if (outcome === 'approve') return 'Approved'
  if (outcome === 'approve_with_notes') return 'Approved with notes'
  return 'Changes requested'
}

/**
 * Deliver one created request over one channel. Returns the channel that
 * delivered, or undefined when the request is undeliverable.
 */
async function deliverOne(created: CreatedApprovalRequest, target: ApprovalNotifyTarget): Promise<'slack' | 'email' | undefined> {
  const request = created.request
  const orgId = request.orgId
  const policy = await loadGuardPolicy(orgId).catch(() => undefined)
  const link = approvalLinkUrl(created.token, target.origin)

  const dm = renderApprovalDm({
    project: target.project,
    stage: target.stage,
    summary: target.summary ?? request.summary,
    link,
    responsibility: target.responsibility,
    fallback: target.fallback,
  })
  const maskedDm = policy ? maskOutputDeep(dm, policy) : dm

  const slack = await sendDirectMessage({ orgId, email: request.recipientEmail, text: maskedDm.text, blocks: maskedDm.blocks })
  if (slack.ok) {
    await recordDelivery(request.requestId, 'slack', 'delivered')
    notifyLog.info('approval delivered by Slack DM', { requestId: request.requestId, stage: target.stage })
    return 'slack'
  }
  if (slack.reason === 'slack_error') await recordDelivery(request.requestId, 'slack', 'failed', slack.message)
  else await recordDelivery(request.requestId, 'slack', 'skipped', slack.reason)

  if (await emailConfigured(orgId)) {
    const maskedText = policy ? maskOutputDeep(maskedDm.text, policy) : maskedDm.text
    const summary = target.summary ?? request.summary
    const role = target.responsibility ? `${target.responsibility}${target.fallback ? ' (Owner fallback)' : ''}` : (target.fallback ? 'Owner fallback' : '')
    const body = [
      `Approval needed for ${target.project.code ? `${target.project.code} · ` : ''}${target.project.name}`,
      ``,
      `Stage: ${target.stage}${role ? `\nResponsibility: ${role}` : ''}`,
      summary ? `\n${summary}` : '',
      ``,
      `Decide here (personal, single use): ${link}`,
      ``,
      `The in-app gate stays available if you prefer.`,
    ].filter((line) => line !== undefined).join('\n')
    const { from } = await emailSender(orgId)
    const sent = await sendEmail({ orgId, to: request.recipientEmail, subject: `Approval needed: ${target.project.name} · ${target.stage}`, text: maskedText.length ? `${maskedText}\n\n${body}` : body, html: `<p>${slackText(body).replace(/\n/g, '<br>')}</p>` })
    if (sent.ok) {
      await recordDelivery(request.requestId, 'email', 'delivered')
      notifyLog.info('approval delivered by email', { requestId: request.requestId, from, stage: target.stage })
      return 'email'
    }
    await recordDelivery(request.requestId, 'email', 'failed', sent.reason === 'not_configured' ? 'not_configured' : sent.message)
  } else {
    await recordDelivery(request.requestId, 'email', 'skipped', 'not_configured')
  }

  await markRequestUndeliverable(request.requestId)
  notifyLog.warn('approval request undeliverable', { requestId: request.requestId, stage: target.stage })
  return undefined
}

/** Deliver every request created for one gate; independent per recipient. */
export async function notifyApprovalRequests(created: CreatedApprovalRequest[], target: ApprovalNotifyTarget): Promise<void> {
  for (const request of created) {
    try {
      await deliverOne(request, target)
    } catch (error) {
      notifyLog.warn('approval delivery threw; leaving the gate actionable', { requestId: request.request.requestId, error: error instanceof Error ? error.message : String(error) })
      await markRequestUndeliverable(request.request.requestId).catch(() => undefined)
    }
  }
}

/**
 * A recipient's access or assignment was revoked before they acted. Refuse
 * their link, invalidate their stale request, re-resolve the gate to the
 * current accountable recipient and notify them (FR-018). Best effort: any
 * failure is logged and never affects the run.
 */
export async function reResolveRevokedRecipient(request: ApprovalRequest): Promise<void> {
  try {
    await invalidateApprovalRequest(request.requestId)
    const resolved = await resolveGateRecipients(request.projectId, request.stage)
    if (resolved.recipients.length === 0) return
    const created = await createApprovalRequests({
      runId: request.runId,
      gateId: request.gateId,
      projectId: request.projectId,
      stage: request.stage,
      kind: request.kind,
      summary: request.summary,
      recipients: resolved.recipients,
      responsibilityId: resolved.responsibilityId,
      responsibilityKey: resolved.responsibilityKey,
      fallback: resolved.fallback,
    })
    if (!created.length) return
    const [project] = await getDb()<Array<{ name: string; code: string | null; slug: string }>>`
      SELECT name, code, slug FROM projects WHERE project_id = ${request.projectId}
    `
    await notifyApprovalRequests(created, {
      project: { projectId: request.projectId, name: project?.name ?? 'Project', code: project?.code ?? null, slug: project?.slug ?? '' },
      stage: request.stage,
      kind: request.kind,
      summary: request.summary,
      responsibility: request.responsibilityKey,
      fallback: request.fallback,
    })
    notifyLog.info('revoked approval recipient re-resolved', { gateId: request.gateId, stage: request.stage, recipients: created.length })
  } catch (error) {
    notifyLog.warn('re-resolving a revoked approval recipient failed', { gateId: request.gateId, error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * Confirm a recorded decision to its owner over the same channel when possible.
 * Best effort: a failure here never affects the run, which has already resumed.
 */
export async function notifyApprovalDecision(input: {
  request: ApprovalRequest
  project: { name: string; code: string | null; slug: string }
  stage: string
  outcome: 'approve' | 'approve_with_notes' | 'request_changes'
  feedback?: string | null
  decidedByName?: string | null
}): Promise<void> {
  const orgId = input.request.orgId
  const policy = await loadGuardPolicy(orgId).catch(() => undefined)
  const label = `${input.project.code ? `${input.project.code} · ` : ''}${input.project.name}`
  const verbatim = input.feedback?.trim() ?? ''
  const decision = decisionLabel(input.outcome)
  const summary = input.request.summary?.trim()

  const slackTextBody = [
    `✅ *${slackText(decision)}* — ${slackText(label)} · *${slackText(input.stage)}*`,
    input.decidedByName ? `Decided by ${slackText(input.decidedByName)}.` : '',
    verbatim ? `>${slackText(verbatim, 2600).replace(/\n/g, '\n>')}` : '',
    summary ? `Decision on: ${slackText(summary, 1000)}` : '',
  ].filter(Boolean).join('\n\n')
  const maskedSlack = policy ? maskOutputDeep(slackTextBody, policy) : slackTextBody

  const slack = await sendDirectMessage({ orgId, email: input.request.recipientEmail, text: `Decision recorded: ${label} · ${input.stage}`, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: maskedSlack } }] })
  if (slack.ok) return
  if (slack.reason === 'slack_error') notifyLog.warn('decision confirmation DM failed; trying email', { requestId: input.request.requestId })

  if (!(await emailConfigured(orgId))) return
  const bodyText = [
    `Decision recorded for ${label}`,
    `Stage: ${input.stage}`,
    `Decision: ${decision}`,
    input.decidedByName ? `Decided by: ${input.decidedByName}` : '',
    verbatim ? `\n${verbatim}` : '',
    summary ? `\nDecision on: ${summary}` : '',
  ].filter(Boolean).join('\n')
  const masked = policy ? (maskOutputDeep(bodyText, policy) as string) : bodyText
  await sendEmail({ orgId, to: input.request.recipientEmail, subject: `Decision recorded: ${input.project.name} · ${input.stage}`, text: masked }).catch(() => undefined)
}
