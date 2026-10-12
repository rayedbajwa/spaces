/**
 * Outbound delivery (012-inbound-outbound-slack, US4/R6).
 *
 * Drains the outbox. Each delivery performs one reversible action — comment or
 * update an issue, create an issue, or post a channel message — with the
 * payload masked through the organization's guardrails first. A target outage
 * is recorded and retried with exponential backoff; it never touches run state.
 */

import { getDb } from './db'
import { loadGuardPolicy } from './guardrails-policy'
import { maskOutputDeep } from './guardrails'
import { log } from './logger'
import { outboundBackoffBaseMs, outboundBackoffMaxMs, outboundMaxAttempts } from './env'
import { getAppIntegrationCredentials } from './app-integrations'
import { getIntegrationAccessToken } from './integration-token'
import { atlassianAccess, atlassianFetchJson, linearGraphQL } from './integration-sources'
import {
  dueOutboundDeliveries,
  getSubscription,
  recordDeliveryAttempt,
  type OutboundDelivery,
  type OutboundSubscription,
} from './outbound-store'

const deliverLog = log.child({ mod: 'outbound-deliver' })

export interface DeliveryResult {
  ok: boolean
  externalRef?: string
  error?: string
  /** A permanent refusal (no target configured) — never retried. */
  skipped?: boolean
}

/** The masked payload and a short human summary for the target action. */
export async function prepareDeliveryPayload(delivery: OutboundDelivery): Promise<{ payload: Record<string, unknown>; summary: string }> {
  const policy = await loadGuardPolicy(delivery.orgId)
  const payload = maskOutputDeep(delivery.payload ?? {}, policy)
  const summary = typeof payload.summary === 'string'
    ? payload.summary
    : `${delivery.eventKind.replace(/_/g, ' ')}${payload.projectName ? ` on ${payload.projectName}` : ''}`
  return { payload, summary: maskOutputDeep(summary, policy) }
}

/** Perform one target action. Returns a permanent `skipped` for missing config. */
export async function performDelivery(subscription: OutboundSubscription, delivery: OutboundDelivery): Promise<DeliveryResult> {
  const { payload, summary } = await prepareDeliveryPayload(delivery)
  const config = subscription.targetConfig ?? {}
  const link = typeof payload.link === 'string' ? payload.link : undefined

  try {
    switch (subscription.targetKind) {
      case 'slack': {
        const channel = typeof config.channel === 'string' ? config.channel : undefined
        if (!channel) return { ok: false, skipped: true, error: 'Slack subscription has no channel configured.' }
        const creds = await getAppIntegrationCredentials(subscription.orgId, 'slack')
        const token = typeof creds?.access_token === 'string' ? creds.access_token : await getIntegrationAccessToken(subscription.orgId, 'slack')
        const response = await fetch('https://slack.com/api/chat.postMessage', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ channel, text: link ? `${summary} — ${link}` : summary }),
        })
        const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; ts?: string }
        if (!response.ok || body.ok === false) return { ok: false, error: body.error ?? `Slack ${response.status}` }
        return { ok: true, externalRef: body.ts }
      }
      case 'jira': {
        const issueKey = typeof config.issueKey === 'string' ? config.issueKey : undefined
        if (!issueKey) return { ok: false, skipped: true, error: 'Jira subscription has no issueKey configured.' }
        const access = await atlassianAccess(subscription.orgId, 'jira')
        const token = await getIntegrationAccessToken(subscription.orgId, 'jira')
        const response = await fetch(`https://api.atlassian.com/ex/jira/${access.cloudId}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: link ? `${summary} (${link})` : summary }] }] } }),
        })
        if (!response.ok) { const text = await response.text().catch(() => ''); return { ok: false, error: `Jira ${response.status}: ${text.slice(0, 200)}` } }
        const body = (await response.json().catch(() => ({}))) as { id?: string }
        return { ok: true, externalRef: body.id }
      }
      case 'linear': {
        const issueId = typeof config.issueId === 'string' ? config.issueId : undefined
        if (subscription.action === 'create_issue') {
          const teamId = typeof config.teamId === 'string' ? config.teamId : undefined
          if (!teamId) return { ok: false, skipped: true, error: 'Linear subscription has no teamId configured.' }
          const data = await linearGraphQL<{ issueCreate: { success: boolean; issue?: { id: string; identifier: string; url: string } } }>(subscription.orgId,
            `mutation Intake($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }`,
            { input: { teamId, title: summary, description: link ?? null } })
          return data.issueCreate?.success ? { ok: true, externalRef: data.issueCreate.issue?.identifier } : { ok: false, error: 'Linear issueCreate failed.' }
        }
        if (!issueId) return { ok: false, skipped: true, error: 'Linear subscription has no issueId configured.' }
        const data = await linearGraphQL<{ commentCreate: { success: boolean; comment?: { id: string } } }>(subscription.orgId,
          `mutation Intake($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }`,
          { input: { issueId, body: link ? `${summary}\n${link}` : summary } })
        return data.commentCreate?.success ? { ok: true, externalRef: data.commentCreate.comment?.id } : { ok: false, error: 'Linear commentCreate failed.' }
      }
      case 'github': {
        const repo = typeof config.repo === 'string' ? config.repo : undefined
        if (!repo) return { ok: false, skipped: true, error: 'GitHub subscription has no repo configured.' }
        const token = await getIntegrationAccessToken(subscription.orgId, 'github')
        const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'spaces', 'content-type': 'application/json' }
        if (subscription.action === 'create_issue') {
          const response = await fetch(`https://api.github.com/repos/${repo}/issues`, { method: 'POST', headers, body: JSON.stringify({ title: summary, body: link ?? undefined }) })
          if (!response.ok) { const text = await response.text().catch(() => ''); return { ok: false, error: `GitHub ${response.status}: ${text.slice(0, 200)}` } }
          const body = (await response.json().catch(() => ({}))) as { number?: number }
          return { ok: true, externalRef: body.number ? String(body.number) : undefined }
        }
        const issueNumber = Number(config.issueNumber)
        if (!issueNumber) return { ok: false, skipped: true, error: 'GitHub subscription has no issueNumber configured.' }
        const response = await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`, { method: 'POST', headers, body: JSON.stringify({ body: link ? `${summary}\n${link}` : summary }) })
        if (!response.ok) { const text = await response.text().catch(() => ''); return { ok: false, error: `GitHub ${response.status}: ${text.slice(0, 200)}` } }
        const body = (await response.json().catch(() => ({}))) as { id?: number }
        return { ok: true, externalRef: body.id ? String(body.id) : undefined }
      }
      default:
        return { ok: false, skipped: true, error: `Unknown target kind ${subscription.targetKind}.` }
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Drain due deliveries with bounded exponential backoff. A target failure is
 * recorded and retried; after the cap the row is left `failed` for inspection.
 */
export async function drainOutbound(limit = 20): Promise<{ delivered: number; failed: number; skipped: number }> {
  const due = await dueOutboundDeliveries(limit)
  const base = outboundBackoffBaseMs()
  const max = outboundBackoffMaxMs()
  const cap = outboundMaxAttempts()
  let delivered = 0
  let failed = 0
  let skipped = 0
  for (const delivery of due) {
    const subscription = await getSubscription(delivery.subscriptionId)
    if (!subscription || !subscription.enabled) {
      await recordDeliveryAttempt({ deliveryId: delivery.deliveryId, state: 'skipped', error: 'Subscription disabled or removed.' })
      skipped += 1
      continue
    }
    const attempt = delivery.attempts + 1
    const result = await performDelivery(subscription, delivery)
    if (result.ok) {
      await recordDeliveryAttempt({ deliveryId: delivery.deliveryId, state: 'delivered', externalRef: result.externalRef ?? null })
      delivered += 1
      continue
    }
    const exhausted = attempt >= cap
    const next = new Date(Date.now() + Math.min(base * 2 ** (attempt - 1), max))
    await recordDeliveryAttempt({
      deliveryId: delivery.deliveryId,
      state: 'failed',
      error: result.error ?? 'delivery failed',
      // Exhaustion clears the due time so the row is terminal, not retried forever.
      nextAttemptAt: exhausted ? null : next,
    })
    failed += 1
    deliverLog.warn('outbound delivery failed', { deliveryId: delivery.deliveryId, target: subscription.targetKind, attempt, exhausted, error: result.error })
  }
  return { delivered, failed, skipped }
}

/** Exposed for tests that want to assert one target action in isolation. */
export { atlassianFetchJson }
