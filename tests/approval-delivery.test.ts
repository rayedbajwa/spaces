import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getDb } from '../src/lib/db'
import { upsertAppIntegration, disconnectAppIntegration } from '../src/lib/app-integrations'
import { createApprovalRequests, resolveGateRecipients, submitApprovalDecision, type CreatedApprovalRequest } from '../src/lib/approval-store'
import { notifyApprovalDecision, notifyApprovalRequests } from '../src/lib/approval-notify'
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

function slackResponse(method: string): unknown {
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
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, body })
    if (url.startsWith('https://slack.com/api/')) {
      const method = url.split('/').pop()!
      return new Response(JSON.stringify(slackResponse(method)), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.startsWith('https://api.resend.com/')) {
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
    const [delivery] = await getDb()<Array<{ channel: string; outcome: string }>>`SELECT channel, outcome FROM approval_deliveries WHERE request_id = ${created[0]!.request.requestId} AND outcome = 'delivered'`
    expect(delivery?.channel).toBe('email')
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
    await notifyApprovalDecision({ request: submitted.request, project: target.project, stage: target.stage, outcome: 'request_changes', feedback: 'Please add a rollback test.', decidedByName: 'Product Owner A', origin: target.origin })

    const slackCalls = calls.filter((c) => c.url.includes('slack.com'))
    expect(slackCalls.some((c) => c.url.endsWith('chat.postMessage'))).toBe(true)
    const post = slackCalls.find((c) => c.url.endsWith('chat.postMessage'))!.body as { blocks: unknown[] }
    const text = JSON.stringify(post.blocks)
    expect(text).toContain('Approval Project')
    expect(text).toContain('review')
    expect(text).toContain('Please add a rollback test.')
  })
})
