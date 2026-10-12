import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { getDb } from '../src/lib/db'
import { deleteSubscription, emitOutboundEvent, listSubscriptions, upsertSubscription } from '../src/lib/outbound-store'
import { createApprovalFixture } from './helpers/approval-fixture'

/**
 * Outbound subscription CRUD and event-emission idempotency (US4:
 * FR-017/018/020). DB-backed against the guarded test database.
 */
const fixture = await createApprovalFixture({ withServer: false })
const { orgA, orgB, projectA, projectTeamB } = fixture
afterAll(async () => { await fixture.stop() })

const SLACK_CONFIG = { channel: '#spaces-alerts' }

describe('subscription CRUD', () => {
  test('creates, lists, edits, disables and deletes a subscription', async () => {
    const created = await upsertSubscription({ orgId: orgA, eventKind: 'run_failed', targetKind: 'slack', action: 'post_message', targetConfig: SLACK_CONFIG })
    try {
      expect(created.enabled).toBe(true)
      const listed = await listSubscriptions(orgA)
      expect(listed.some((s) => s.subscriptionId === created.subscriptionId)).toBe(true)

      const disabled = await upsertSubscription({ orgId: orgA, subscriptionId: created.subscriptionId, eventKind: 'run_failed', targetKind: 'slack', action: 'post_message', targetConfig: SLACK_CONFIG, enabled: false })
      expect(disabled.enabled).toBe(false)

      expect(await deleteSubscription(orgA, created.subscriptionId)).toBe(true)
      expect(await deleteSubscription(orgA, created.subscriptionId)).toBe(false)
    } finally {
      await getDb()`DELETE FROM outbound_subscriptions WHERE subscription_id = ${created.subscriptionId}`
    }
  })

  test('org B cannot delete org A subscription', async () => {
    const created = await upsertSubscription({ orgId: orgA, eventKind: 'gate_opened', targetKind: 'jira', action: 'comment', targetConfig: { issueKey: 'OPS-1' } })
    try {
      expect(await deleteSubscription(orgB, created.subscriptionId)).toBe(false)
    } finally {
      await getDb()`DELETE FROM outbound_subscriptions WHERE subscription_id = ${created.subscriptionId}`
    }
  })
})

describe('event emission', () => {
  test('inserts one delivery per enabled matching subscription, idempotent per event key', async () => {
    const subscription = await upsertSubscription({ orgId: orgA, eventKind: 'run_failed', targetKind: 'slack', action: 'post_message', targetConfig: SLACK_CONFIG })
    const eventKey = `run:${randomUUID()}:failed`
    try {
      const first = await emitOutboundEvent({ orgId: orgA, eventKind: 'run_failed', eventKey, payload: { summary: 'boom' } })
      expect(first).toBe(1)
      const second = await emitOutboundEvent({ orgId: orgA, eventKind: 'run_failed', eventKey, payload: { summary: 'boom again' } })
      expect(second).toBe(0)
      const [count] = await getDb()<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM outbound_deliveries WHERE subscription_id = ${subscription.subscriptionId} AND event_key = ${eventKey}
      `
      expect(count?.n).toBe(1)
    } finally {
      await getDb()`DELETE FROM outbound_subscriptions WHERE subscription_id = ${subscription.subscriptionId}`
    }
  })

  test('a disabled subscription produces no delivery; a project-scoped one only matches its project', async () => {
    const disabled = await upsertSubscription({ orgId: orgA, eventKind: 'stage_completed', targetKind: 'slack', action: 'post_message', targetConfig: SLACK_CONFIG, enabled: false })
    const scoped = await upsertSubscription({ orgId: orgA, projectId: projectA.projectId, eventKind: 'stage_completed', targetKind: 'slack', action: 'post_message', targetConfig: SLACK_CONFIG })
    const eventKey = `run:${randomUUID()}:stage:plan`
    try {
      const inserted = await emitOutboundEvent({ orgId: orgA, projectId: projectA.projectId, eventKind: 'stage_completed', eventKey, payload: { stage: 'plan' } })
      expect(inserted).toBe(1)
      const forOther = await emitOutboundEvent({ orgId: orgA, projectId: projectTeamB.projectId, eventKind: 'stage_completed', eventKey: `${eventKey}:other`, payload: { stage: 'plan' } })
      expect(forOther).toBe(0)
      const [count] = await getDb()<Array<{ n: number }>>`SELECT count(*)::int AS n FROM outbound_deliveries WHERE subscription_id = ${disabled.subscriptionId}`
      expect(count?.n).toBe(0)
    } finally {
      await getDb()`DELETE FROM outbound_subscriptions WHERE subscription_id IN (${disabled.subscriptionId}, ${scoped.subscriptionId})`
    }
  })
})
