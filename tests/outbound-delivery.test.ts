import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { getDb } from '../src/lib/db'
import { upsertAppIntegration } from '../src/lib/app-integrations'
import { drainOutbound } from '../src/lib/outbound-deliver'
import { emitOutboundEvent, upsertSubscription } from '../src/lib/outbound-store'
import { createApprovalFixture } from './helpers/approval-fixture'

/**
 * Outbound delivery, retry/backoff, duplicate-once and payload masking (US4:
 * FR-019/020/021). Target HTTP is stubbed at the fetch boundary.
 */
const fixture = await createApprovalFixture({ withServer: false })
const { orgA } = fixture
afterAll(async () => { await fixture.stop() })

const realFetch = globalThis.fetch
function stubFetch(handler: (url: string, init?: RequestInit) => Response): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init)) as typeof fetch
}
afterEach(() => { globalThis.fetch = realFetch })

async function deliveryState(deliveryId: string) {
  const [row] = await getDb()<Array<{ state: string; attempts: number; nextAttemptAt: string | null; lastError: string | null }>>`
    SELECT state, attempts, next_attempt_at AS "nextAttemptAt", last_error AS "lastError" FROM outbound_deliveries WHERE delivery_id = ${deliveryId}
  `
  return row
}

async function ourDelivery(subscriptionId: string, eventKey: string): Promise<string | undefined> {
  const [row] = await getDb()<Array<{ deliveryId: string }>>`
    SELECT delivery_id AS "deliveryId" FROM outbound_deliveries WHERE subscription_id = ${subscriptionId} AND event_key = ${eventKey}
  `
  return row?.deliveryId
}

async function connectSlack(): Promise<void> {
  await upsertAppIntegration({ orgId: orgA, kind: 'slack', status: 'connected', credentials: { access_token: 'slack-token-value' } })
}

describe('slack delivery', () => {
  test('posts a channel message and marks the delivery delivered', async () => {
    await connectSlack()
    const subscription = await upsertSubscription({ orgId: orgA, eventKind: 'run_failed', targetKind: 'slack', action: 'post_message', targetConfig: { channel: '#spaces-alerts' } })
    const eventKey = `run:${randomUUID()}:failed`
    await emitOutboundEvent({ orgId: orgA, eventKind: 'run_failed', eventKey, payload: { summary: 'the run failed', link: 'https://example.test/runs/1' } })
    const deliveryId = (await ourDelivery(subscription.subscriptionId, eventKey))!
    try {
      let body = ''
      stubFetch((_url, init) => { body = String(init?.body ?? ''); return new Response(JSON.stringify({ ok: true, ts: '111.222' }), { status: 200 }) })
      const outcome = await drainOutbound(50)
      expect(outcome.delivered).toBeGreaterThanOrEqual(1)
      expect(body).toContain('spaces-alerts')
      expect(body).toContain('the run failed')
      const state = await deliveryState(deliveryId)
      expect(state?.state).toBe('delivered')
      expect(state?.attempts).toBe(1)
    } finally {
      await getDb()`DELETE FROM outbound_subscriptions WHERE subscription_id = ${subscription.subscriptionId}`
    }
  })

  test('a target outage is recorded and scheduled for retry with backoff, never touching a run', async () => {
    await connectSlack()
    const subscription = await upsertSubscription({ orgId: orgA, eventKind: 'gate_opened', targetKind: 'slack', action: 'post_message', targetConfig: { channel: '#spaces-alerts' } })
    const eventKey = `gate:${randomUUID()}:opened`
    await emitOutboundEvent({ orgId: orgA, eventKind: 'gate_opened', eventKey, payload: { summary: 'a gate opened' } })
    const deliveryId = (await ourDelivery(subscription.subscriptionId, eventKey))!
    try {
      stubFetch(() => { throw new Error('slack down') })
      await drainOutbound(50)
      const state = await deliveryState(deliveryId)
      expect(state?.state).toBe('failed')
      expect(state?.attempts).toBe(1)
      expect(state?.lastError).toContain('slack down')
      expect(Date.parse(state!.nextAttemptAt)).toBeGreaterThan(Date.now())
    } finally {
      await getDb()`DELETE FROM outbound_subscriptions WHERE subscription_id = ${subscription.subscriptionId}`
    }
  })

  test('a permanently failing delivery stops after the retry cap', async () => {
    process.env.OUTBOUND_MAX_ATTEMPTS = '2'
    await connectSlack()
    const subscription = await upsertSubscription({ orgId: orgA, eventKind: 'run_failed', targetKind: 'slack', action: 'post_message', targetConfig: { channel: '#spaces-alerts' } })
    const eventKey = `run:${randomUUID()}:failed`
    await emitOutboundEvent({ orgId: orgA, eventKind: 'run_failed', eventKey, payload: { summary: 'permanently failing' } })
    const deliveryId = (await ourDelivery(subscription.subscriptionId, eventKey))!
    try {
      stubFetch(() => { throw new Error('permanent outage') })
      await drainOutbound(50)
      await getDb()`UPDATE outbound_deliveries SET next_attempt_at = now() - interval '1 second' WHERE delivery_id = ${deliveryId}`
      await drainOutbound(50)
      const exhausted = await deliveryState(deliveryId)
      expect(exhausted?.state).toBe('failed')
      expect(exhausted?.attempts).toBe(2)
      expect(exhausted?.nextAttemptAt).toBeNull()
      // Once exhausted the drain never selects it again.
      await drainOutbound(50)
      expect((await deliveryState(deliveryId))?.attempts).toBe(2)
    } finally {
      delete process.env.OUTBOUND_MAX_ATTEMPTS
      await getDb()`DELETE FROM outbound_subscriptions WHERE subscription_id = ${subscription.subscriptionId}`
    }
  })

  test('payloads are guardrail-masked before they leave the app', async () => {
    await connectSlack()
    // Built at runtime so no literal secret is committed; the value still matches
    // the guardrail secret detector.
    const fakeToken = ['s','k'].join('') + '-ant-' + 'a'.repeat(24)
    const subscription = await upsertSubscription({ orgId: orgA, eventKind: 'stage_completed', targetKind: 'slack', action: 'post_message', targetConfig: { channel: '#spaces-alerts' } })
    const eventKey = `run:${randomUUID()}:stage:verify`
    await emitOutboundEvent({ orgId: orgA, eventKind: 'stage_completed', eventKey, payload: { summary: `token ${fakeToken} was leaked` } })
    try {
      let body = ''
      stubFetch((_url, init) => { body = String(init?.body ?? ''); return new Response(JSON.stringify({ ok: true }), { status: 200 }) })
      await drainOutbound(50)
      expect(body).not.toContain(fakeToken)
      expect(body).toContain('[redacted')
    } finally {
      await getDb()`DELETE FROM outbound_subscriptions WHERE subscription_id = ${subscription.subscriptionId}`
    }
  })
})

describe('linear delivery', () => {
  test('bounds the Linear GraphQL call with a timeout signal', async () => {
    await upsertAppIntegration({ orgId: orgA, kind: 'linear', status: 'connected', credentials: { access_token: 'linear-token' } })
    const subscription = await upsertSubscription({ orgId: orgA, eventKind: 'run_failed', targetKind: 'linear', action: 'comment', targetConfig: { issueId: 'uuid-1' } })
    const eventKey = `run:${randomUUID()}:failed`
    await emitOutboundEvent({ orgId: orgA, eventKind: 'run_failed', eventKey, payload: { summary: 'linear comment' } })
    const deliveryId = (await ourDelivery(subscription.subscriptionId, eventKey))!
    try {
      let signal: AbortSignal | null | undefined
      stubFetch((_url, init) => {
        signal = init?.signal
        return new Response(JSON.stringify({ data: { commentCreate: { success: true, comment: { id: 'c1' } } } }), { status: 200, headers: { 'content-type': 'application/json' } })
      })
      await drainOutbound(50)
      expect(signal).toBeInstanceOf(AbortSignal)
      expect(signal?.aborted).toBe(false)
      expect((await deliveryState(deliveryId))?.state).toBe('delivered')
    } finally {
      await getDb()`DELETE FROM outbound_subscriptions WHERE subscription_id = ${subscription.subscriptionId}`
    }
  })
})
