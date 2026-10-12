import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getDb } from '../src/lib/db'
import { upsertAppIntegration, disconnectAppIntegration } from '../src/lib/app-integrations'
import { createApprovalRequests, resolveGateRecipients, submitApprovalDecision, type CreatedApprovalRequest } from '../src/lib/approval-store'
import { notifyApprovalDecision, notifyApprovalRequests, deliverApprovalRequestsForGate, reResolveRevokedRecipient } from '../src/lib/approval-notify'
import { createApprovalFixture } from './helpers/approval-fixture'

/**
 * Direct delivery (FR-003/004/016/019): channel precedence, one channel per
 * request, fallback, undeliverable and confirmation. Slack and Resend are
 * stubbed at the fetch boundary; no live credential is involved.
 */
const fixture = await createApprovalFixture({ withServer: false })
const { projectA, users } = fixture

const realFetch = globalThis.fetch
const calls: Array<{ url: string; body: unknown }> = []
let slackLookup: 'ok' | 'not_found' = 'ok'
let slackFailMethod: string | null = null

function slackResponse(method: string): unknown {
  if (method === slackFailMethod) return { ok: false, error: 'channel_not_found' }
  if (method === 'users.lookupByEmail') {
    if (slackLookup === 'not_found') return { ok: false, error: 'users_not_found' }
    return { ok: true, user: { id: 'U123' } }
  }
  if (method === 'conversations.open') return { ok: true, channel: { id: 'D123' } }
  return { ok: true, ts: '1.2' }
}

beforeEach(() => {
  calls.length = 0
  slackLookup = 'ok'
  slackFailMethod = null
  delete process.env.APPROVAL_EMAIL_FROM
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, body })
    if (url.startsWith('https://slack.com/api/')) {
      const method = url.split('/').pop()!
      return new Response(JSON.stringify(slackResponse(method)), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.startsWith('https://api.resend.com/')) {
      const from = (body as { from?: string } | undefined)?.from ?? ''
      if (from.includes('spacesos.dev')) {
        return new Response(JSON.stringify({ message: 'The spacesos.dev domain is not verified. Please, add and verify your domain on https://resend.com/domains', name: 'validation_error', statusCode: 403 }), { status: 403, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ id: 'email-1' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return realFetch(input as never, init)
  }) as typeof fetch
})

afterEach(() => { globalThis.fetch = realFetch })
afterAll(async () => {
  delete process.env.RESEND_API_KEY
  await fixture.stop()
})

async function createdForSuffix(stage = 'review', kind: 'review' | 'clarification' = 'review'): Promise<CreatedApprovalRequest[]> {
  const run = await getDb()<Array<{ runId: string }>>`SELECT run_id AS "runId" FROM pipeline_runs WHERE project_id = ${projectA.projectId} ORDER BY created_at DESC LIMIT 1`
  const runId = run[0]!.runId
  const resolved = await resolveGateRecipients(projectA.projectId, stage)
  // Create a fresh paused gate for this delivery test.
  const { openGate } = await import('../src/lib/run-store')
  const gateId = await openGate({ runId, stepIndex: 0, kind, prompt: stage })
  await getDb()`UPDATE pipeline_runs SET status = 'paused', pause_kind = ${kind}, current_stage = ${stage} WHERE run_id = ${runId}`
  return createApprovalRequests({ runId, gateId, projectId: projectA.projectId, stage, kind, summary: 'Approved with 2 minor findings.', recipients: resolved.recipients, responsibilityId: resolved.responsibilityId, responsibilityKey: resolved.responsibilityKey, fallback: resolved.fallback })
}

const target = {
  project: { projectId: fixture.projectA.projectId, name: 'Approval Project', code: fixture.projectA.code, slug: fixture.projectA.slug },
  stage: 'review',
  kind: 'review' as const,
  summary: 'Approved with 2 minor findings.',
  responsibility: 'Product Owner',
  fallback: false,
  origin: 'https://spaces.example.com',
}

describe('channel precedence', () => {
  test('a Slack DM is preferred when connected and the recipient matches', async () => {
    await upsertAppIntegration({ orgId: fixture.orgA, kind: 'slack', status: 'connected', displayName: 'Slack', credentials: { access_token: 'xoxb-test' } })
    const created = await createdForSuffix()
    await notifyApprovalRequests([created[0]!], target)

    const slackCalls = calls.filter((c) => c.url.includes('slack.com'))
    const emailCalls = calls.filter((c) => c.url.includes('resend.com'))
    expect(slackCalls.map((c) => c.url.split('/').pop())).toEqual(['users.lookupByEmail', 'conversations.open', 'chat.postMessage'])
    expect(emailCalls).toHaveLength(0) // exactly one channel per request
    const post = slackCalls.find((c) => c.url.endsWith('chat.postMessage'))!.body as { text: string; blocks: unknown[] }
    expect(post.text).toContain('Approval needed')
    expect(JSON.stringify(post.blocks)).toContain('https://spaces.example.com/approvals/')
    const links = JSON.stringify(post.blocks).match(/https:\/\/spaces\.example\.com\/approvals\//g) ?? []
    expect(links).toHaveLength(1)

    const [request] = await getDb()<Array<{ state: string }>>`SELECT state FROM approval_requests WHERE request_id = ${created[0]!.request.requestId}`
    expect(request?.state).toBe('delivered')
    const [delivery] = await getDb()<Array<{ channel: string; outcome: string }>>`SELECT channel, outcome FROM approval_deliveries WHERE request_id = ${created[0]!.request.requestId} ORDER BY attempted_at DESC LIMIT 1`
    expect(delivery).toEqual({ channel: 'slack', outcome: 'delivered' })
  })

  test('an unmatched Slack recipient falls back to email', async () => {
    await upsertAppIntegration({ orgId: fixture.orgA, kind: 'slack', status: 'connected', displayName: 'Slack', credentials: { access_token: 'xoxb-test' } })
    process.env.RESEND_API_KEY = 're_test_key'
    slackLookup = 'not_found'
    const created = await createdForSuffix()
    await notifyApprovalRequests([created[0]!], target)
    expect(calls.some((c) => c.url.includes('resend.com/emails'))).toBe(true)
    const emailCall = calls.find((c) => c.url.includes('resend.com/emails'))!.body as { text: string; subject: string }
    // The email body carries the header once; it must not repeat the DM header.
    expect((emailCall.text.match(/Approval needed/g) ?? []).length).toBe(1)
    expect(emailCall.text).toContain('Approval needed for')
    expect(emailCall.text).toContain('Stage: review')
    const [delivery] = await getDb()<Array<{ channel: string; outcome: string }>>`SELECT channel, outcome FROM approval_deliveries WHERE request_id = ${created[0]!.request.requestId} AND outcome = 'delivered'`
    expect(delivery?.channel).toBe('email')
  })

  test('an unverified sender domain falls back to the shared onboarding sender', async () => {
    await upsertAppIntegration({ orgId: fixture.orgA, kind: 'slack', status: 'connected', displayName: 'Slack', credentials: { access_token: 'xoxb-test' } })
    process.env.RESEND_API_KEY = 're_test_key'
    process.env.APPROVAL_EMAIL_FROM = 'Spaces <noreply@spacesos.dev>'
    slackLookup = 'not_found'
    const created = await createdForSuffix()
    await notifyApprovalRequests([created[0]!], target)
    const emailCalls = calls.filter((c) => c.url.includes('resend.com/emails'))
    expect(emailCalls.length).toBe(2) // the unverified sender is rejected, then retried from onboarding
    expect((emailCalls[1]!.body as { from: string }).from).toContain('onboarding@resend.dev')
    const [delivery] = await getDb()<Array<{ channel: string; outcome: string }>>`SELECT channel, outcome FROM approval_deliveries WHERE request_id = ${created[0]!.request.requestId} AND outcome = 'delivered'`
    expect(delivery?.channel).toBe('email')
  })

  test('a Slack send failure falls back to email (FR-016)', async () => {
    await upsertAppIntegration({ orgId: fixture.orgA, kind: 'slack', status: 'connected', displayName: 'Slack', credentials: { access_token: 'xoxb-test-token' } })
    process.env.RESEND_API_KEY = 're-test-key'
    slackFailMethod = 'chat.postMessage'
    const created = await createdForSuffix()
    await notifyApprovalRequests([created[0]!], target)
    expect(calls.filter((c) => c.url.includes('slack.com')).length).toBeGreaterThan(0)
    expect(calls.some((c) => c.url.includes('resend.com/emails'))).toBe(true)
    const [delivery] = await getDb()<Array<{ channel: string; outcome: string }>>`SELECT channel, outcome FROM approval_deliveries WHERE request_id = ${created[0]!.request.requestId} AND outcome = 'delivered'`
    expect(delivery?.channel).toBe('email')
    const [failed] = await getDb()<Array<{ outcome: string }>>`SELECT outcome FROM approval_deliveries WHERE request_id = ${created[0]!.request.requestId} AND channel = 'slack' ORDER BY attempted_at DESC LIMIT 1`
    expect(failed?.outcome).toBe('failed')
  })

  test('with no channel available the request is undeliverable and the gate stays actionable', async () => {
    delete process.env.RESEND_API_KEY
    await disconnectAppIntegration(fixture.orgA, 'slack')
    const created = await createdForSuffix()
    await notifyApprovalRequests([created[0]!], target)
    const [request] = await getDb()<Array<{ state: string }>>`SELECT state FROM approval_requests WHERE request_id = ${created[0]!.request.requestId}`
    expect(request?.state).toBe('undeliverable')
    expect(calls.filter((c) => c.url.includes('resend.com'))).toHaveLength(0)
  })
})

describe('decision confirmation', () => {
  test('a decision is confirmed over the same channel with project, stage, decision and feedback', async () => {
    await upsertAppIntegration({ orgId: fixture.orgA, kind: 'slack', status: 'connected', displayName: 'Slack', credentials: { access_token: 'xoxb-test' } })
    const created = await createdForSuffix()
    await notifyApprovalRequests([created[0]!], target)
    calls.length = 0

    const submitted = await submitApprovalDecision({ token: created[0]!.token, actorUserId: users.productOwnerA, outcome: 'request_changes', feedback: 'Please add a rollback test.' })
    expect(submitted.ok).toBe(true)
    if (!submitted.ok) return
    await notifyApprovalDecision({ request: submitted.request, project: target.project, stage: target.stage, outcome: 'request_changes', feedback: 'Please add a rollback test.', decidedByName: 'Product Owner A' })

    const slackCalls = calls.filter((c) => c.url.includes('slack.com'))
    expect(slackCalls.some((c) => c.url.endsWith('chat.postMessage'))).toBe(true)
    const post = slackCalls.find((c) => c.url.endsWith('chat.postMessage'))!.body as { blocks: unknown[] }
    const text = JSON.stringify(post.blocks)
    expect(text).toContain('Approval Project')
    expect(text).toContain('review')
    expect(text).toContain('Please add a rollback test.')
  })
})

describe('gate-open trigger, timing and recovery (FR-001/003/016/018/021, SC-001/003/006)', () => {
  async function openGateOnNewRun(stage = 'review', kind: 'review' | 'clarification' = 'review'): Promise<{ runId: string; gateId: string }> {
    const { createRun, openGate } = await import('../src/lib/run-store')
    const run = await createRun({
      projectNamespace: fixture.projectA.slug, projectLabel: 'Gate open', projectPath: '/tmp/approval-gate-open',
      pipelineName: 'test', options: {} as never, template: { stages: [] } as never, projectId: fixture.projectA.projectId,
    })
    const gateId = await openGate({ runId: run.runId, stepIndex: 0, kind, prompt: stage })
    await getDb()`UPDATE pipeline_runs SET status = 'paused', pause_kind = ${kind}, current_stage = ${stage} WHERE run_id = ${run.runId}`
    return { runId: run.runId, gateId }
  }

  test('the worker gate-open trigger creates and delivers one request per accountable recipient (FR-001/003/021)', async () => {
    await upsertAppIntegration({ orgId: fixture.orgA, kind: 'slack', status: 'connected', displayName: 'Slack', credentials: { access_token: '...' } })
    const { runId } = await openGateOnNewRun()

    await deliverApprovalRequestsForGate(runId, fixture.projectA.projectId, 'review', 'review', 'Approved with 2 minor findings.')

    const requests = await getDb()<Array<{ state: string }>>`SELECT state FROM approval_requests WHERE run_id = ${runId} ORDER BY created_at`
    expect(requests).toHaveLength(2)
    expect(requests.every((row) => row.state === 'delivered')).toBe(true)
    expect(calls.filter((c) => c.url.endsWith('chat.postMessage'))).toHaveLength(2)
    await getDb()`DELETE FROM pipeline_runs WHERE run_id = ${runId}`
  })

  test('a revoked recipient is re-resolved and the current assignee is notified (FR-018)', async () => {
    await upsertAppIntegration({ orgId: fixture.orgA, kind: 'slack', status: 'connected', displayName: 'Slack', credentials: { access_token: '...' } })
    const { runId, gateId } = await openGateOnNewRun()
    const resolved = await resolveGateRecipients(fixture.projectA.projectId, 'review')
    const poId = resolved.responsibilityId!
    const created = await createApprovalRequests({
      runId, gateId, projectId: fixture.projectA.projectId, stage: 'review', kind: 'review',
      summary: 'Approved with 2 minor findings.', recipients: [resolved.recipients[0]!],
      responsibilityId: resolved.responsibilityId, responsibilityKey: resolved.responsibilityKey, fallback: resolved.fallback,
    })
    const revokedRequest = created[0]!.request
    const { replaceAssignments } = await import('../src/lib/project-responsibilities')
    await replaceAssignments(fixture.projectA.projectId, poId, [users.secondProductOwnerA], users.ownerA)
    try {
      await reResolveRevokedRecipient(revokedRequest)

      const [stale] = await getDb()<Array<{ state: string }>>`SELECT state FROM approval_requests WHERE request_id = ${revokedRequest.requestId}`
      expect(stale?.state).toBe('invalidated')
      const [staleLink] = await getDb()<Array<{ consumedAt: string | null }>>`SELECT consumed_at AS "consumedAt" FROM approval_links WHERE request_id = ${revokedRequest.requestId}`
      expect(staleLink?.consumedAt).not.toBeNull()
      const [replacement] = await getDb()<Array<{ state: string }>>`
        SELECT state FROM approval_requests WHERE run_id = ${runId} AND recipient_user_id = ${users.secondProductOwnerA}
      `
      expect(replacement?.state).toBe('delivered')
      expect(calls.some((c) => c.url.endsWith('chat.postMessage'))).toBe(true)
    } finally {
      await replaceAssignments(fixture.projectA.projectId, poId, [users.productOwnerA, users.secondProductOwnerA], users.ownerA)
      await getDb()`DELETE FROM pipeline_runs WHERE run_id = ${runId}`
    }
  })

  test('a total delivery failure leaves the run paused and the queue untouched (FR-016/SC-006)', async () => {
    delete process.env.RESEND_API_KEY
    await disconnectAppIntegration(fixture.orgA, 'slack')
    const created = await createdForSuffix()
    const runId = created[0]!.request.runId
    const before = await getDb()<Array<{ status: string; pauseKind: string | null }>>`
      SELECT status, pause_kind AS "pauseKind" FROM pipeline_runs WHERE run_id = ${runId}
    `
    const [jobsBefore] = await getDb()<Array<{ n: number }>>`SELECT count(*)::int AS n FROM project_jobs WHERE run_id = ${runId}`

    await notifyApprovalRequests(created, target)

    const after = await getDb()<Array<{ status: string; pauseKind: string | null }>>`
      SELECT status, pause_kind AS "pauseKind" FROM pipeline_runs WHERE run_id = ${runId}
    `
    const [jobsAfter] = await getDb()<Array<{ n: number }>>`SELECT count(*)::int AS n FROM project_jobs WHERE run_id = ${runId}`
    expect(after).toEqual(before)
    expect(after[0]?.status).toBe('paused')
    expect(jobsAfter?.n).toBe(jobsBefore?.n)
    for (const item of created) {
      const [row] = await getDb()<Array<{ state: string }>>`SELECT state FROM approval_requests WHERE request_id = ${item.request.requestId}`
      expect(row?.state).toBe('undeliverable')
    }
  })

  test('the accountable owner is notified well within one minute of the gate opening (SC-001)', async () => {
    await upsertAppIntegration({ orgId: fixture.orgA, kind: 'slack', status: 'connected', displayName: 'Slack', credentials: { access_token: '...' } })
    const started = Date.now()
    const created = await createdForSuffix()
    await notifyApprovalRequests([created[0]!], target)
    const elapsed = Date.now() - started
    const [delivered] = await getDb()<Array<{ outcome: string }>>`
      SELECT outcome FROM approval_deliveries WHERE request_id = ${created[0]!.request.requestId} AND outcome = 'delivered' LIMIT 1
    `
    expect(delivered?.outcome).toBe('delivered')
    expect(elapsed).toBeLessThan(60_000)
  })

  test('a decision is recorded well within two minutes (SC-003)', async () => {
    await upsertAppIntegration({ orgId: fixture.orgA, kind: 'slack', status: 'connected', displayName: 'Slack', credentials: { access_token: '...' } })
    const created = await createdForSuffix()
    await notifyApprovalRequests([created[0]!], target)
    const started = Date.now()
    const result = await submitApprovalDecision({ token: created[0]!.token, actorUserId: users.productOwnerA, outcome: 'approve' })
    const elapsed = Date.now() - started
    expect(result.ok).toBe(true)
    expect(elapsed).toBeLessThan(120_000)
  })
})
