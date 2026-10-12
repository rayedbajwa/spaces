import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { getDb } from '../src/lib/db'
import { syncProjectIntents } from '../src/lib/intent-store'
import { emitGateOutbound, emitRunOutbound } from '../src/lib/outbound-emit'
import { upsertSubscription } from '../src/lib/outbound-store'
import { createApprovalFixture } from './helpers/approval-fixture'

/**
 * FR-019: every outbound event payload carries the project and a navigable link
 * (test-plan §5.7). Covers each emitter: run_failed + stage_completed (run path),
 * gate_opened (gate path) and verification_completed + feature_delivered (intent
 * status transition).
 */
type EventKind = 'run_failed' | 'stage_completed' | 'gate_opened' | 'verification_completed' | 'feature_delivered'

const fixture = await createApprovalFixture({ withServer: false })
const { orgA, projectA, runA, gateA } = fixture
const originalPublicUrl = process.env.PUBLIC_URL
process.env.PUBLIC_URL = 'https://spaces.test'
const cleanup: string[] = []
const subscriptions: string[] = []

afterAll(async () => {
  if (originalPublicUrl === undefined) delete process.env.PUBLIC_URL
  else process.env.PUBLIC_URL = originalPublicUrl
  const sql = getDb()
  if (subscriptions.length) await sql`DELETE FROM outbound_subscriptions WHERE subscription_id IN ${sql(subscriptions)}`
  for (const dir of cleanup) await rm(dir, { recursive: true, force: true })
  await fixture.stop()
})

async function subscribe(eventKind: EventKind): Promise<string> {
  const sub = await upsertSubscription({ orgId: orgA, eventKind, targetKind: 'slack', action: 'post_message', targetConfig: { channel: '#payloads' } })
  subscriptions.push(sub.subscriptionId)
  return sub.subscriptionId
}

async function payloadByKind(subscriptionId: string, eventKind: string): Promise<Record<string, unknown> | undefined> {
  const [row] = await getDb()<Array<{ payload: Record<string, unknown> }>>`
    SELECT payload_json AS payload FROM outbound_deliveries
     WHERE subscription_id = ${subscriptionId} AND event_kind = ${eventKind}
     ORDER BY created_at DESC LIMIT 1
  `
  return row?.payload
}

async function waitForPayload(subscriptionId: string, eventKind: string, timeoutMs = 8_000): Promise<Record<string, unknown> | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const payload = await payloadByKind(subscriptionId, eventKind)
    if (payload) return payload
    if (Date.now() > deadline) return undefined
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

const expectedLink = `https://spaces.test/spaces/${encodeURIComponent(projectA.slug)}`
const expectedIntentLink = `https://spaces.test/spaces/${encodeURIComponent(projectA.code || projectA.slug)}`

describe('run and gate emissions carry project + link', () => {
  test('run_failed and stage_completed payloads carry projectName and link', async () => {
    const failedSub = await subscribe('run_failed')
    const stageSub = await subscribe('stage_completed')
    const runRef = { projectId: projectA.projectId, projectLabel: 'Payload Project', projectNamespace: projectA.slug, runId: runA }
    await emitRunOutbound(runRef, 'run_failed', `run:${runA}:failed`, { summary: 'the run failed' })
    await emitRunOutbound(runRef, 'stage_completed', `run:${runA}:stage:review`, { stage: 'review', summary: 'review done' })

    const failed = await waitForPayload(failedSub, 'run_failed')
    expect(failed).toMatchObject({ projectName: 'Payload Project', summary: 'the run failed', link: expectedLink })

    const completed = await waitForPayload(stageSub, 'stage_completed')
    expect(completed).toMatchObject({ projectName: 'Payload Project', stage: 'review', link: expectedLink })
  })

  test('gate_opened payload carries projectName and link', async () => {
    const subscriptionId = await subscribe('gate_opened')
    await emitGateOutbound(runA, gateA, 'review', 'review')
    const payload = await waitForPayload(subscriptionId, 'gate_opened')
    expect(payload).toMatchObject({ gateId: gateA, runId: runA, link: expectedLink })
    expect(typeof payload?.projectName).toBe('string')
    expect(payload?.projectName).not.toBe('')
  })
})

describe('intent status emissions carry project + link', () => {
  test('verification_completed and feature_delivered payloads carry projectName and link', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'outbound-payload-'))
    cleanup.push(root)
    const dirId = `901-payload-${crypto.randomUUID().slice(0, 6)}`
    const dir = path.join(root, 'specs', dirId)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'spec.md'), '# Feature Specification: Payload Context\n')
    await writeFile(path.join(dir, 'verification-report.md'), 'Verification Status: PASS\n')

    const verificationSub = await subscribe('verification_completed')
    const deliveredSub = await subscribe('feature_delivered')

    await syncProjectIntents(projectA.projectId, root, 'test')
    const verified = await waitForPayload(verificationSub, 'verification_completed')
    expect(verified).toMatchObject({ status: 'verified', link: expectedIntentLink })
    expect(verified?.projectName).toBeTruthy()

    await writeFile(path.join(dir, 'delivery-report.md'), 'Delivery Status: MERGED\n')
    await syncProjectIntents(projectA.projectId, root, 'test')
    const delivered = await waitForPayload(deliveredSub, 'feature_delivered')
    expect(delivered).toMatchObject({ status: 'delivered', link: expectedIntentLink })
    expect(delivered?.projectName).toBeTruthy()
  })
})
