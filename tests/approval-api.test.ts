import { afterAll, describe, expect, test } from 'bun:test'
import { getDb } from '../src/lib/db'
import { createApprovalRequests, resolveGateRecipients } from '../src/lib/approval-store'
import { createRun, openGate } from '../src/lib/run-store'
import { createApprovalFixture } from './helpers/approval-fixture'

/**
 * Approval API contract (FR-017/020/022): recipient matching, tenant isolation,
 * stale-state responses, single decision and no membership grant.
 */
const fixture = await createApprovalFixture({ port: 3126 })
const { baseUrl, projectA, users, teamA } = fixture

const recipientCookie = await fixture.cookieFor(users.productOwnerA, teamA)
const memberCookie = await fixture.cookieFor(users.memberA, teamA)
const otherOrgCookie = await fixture.cookieFor(users.otherOrgOwner)

const resolved = await resolveGateRecipients(projectA.projectId, 'review')
const created = await createApprovalRequests({
  runId: fixture.runA, gateId: fixture.gateA, projectId: projectA.projectId, stage: 'review', kind: 'review',
  summary: 'Approved with 2 minor findings.\nTests pass.', recipients: resolved.recipients,
  responsibilityId: resolved.responsibilityId, responsibilityKey: resolved.responsibilityKey, fallback: resolved.fallback,
})
const token = created.find((item) => item.request.recipientUserId === users.productOwnerA)!.token

async function api<T = any>(method: string, path: string, cookie?: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: unknown
  try { parsed = text ? JSON.parse(text) : undefined } catch { parsed = text }
  return { status: res.status, body: parsed as T }
}

afterAll(async () => { await fixture.stop() })

describe('GET /api/approvals/:token', () => {
  test('the bound recipient sees the summary and state', async () => {
    const res = await api<{ project: { name: string }; stage: string; summary: string; state: string }>('GET', `/api/approvals/${token}`, recipientCookie)
    expect(res.status).toBe(200)
    expect(res.body.project.name).toContain('Approval Project')
    expect(res.body.stage).toBe('review')
    expect(res.body.summary).toContain('2 minor findings')
    expect(res.body.state).toBe('pending')
  })

  test('an unauthenticated visitor is asked to sign in', async () => {
    const res = await api<{ code: string }>('GET', `/api/approvals/${token}`)
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('sign_in_required')
  })

  test('a non-recipient is refused and no project data leaks', async () => {
    const res = await api<{ code: string }>('GET', `/api/approvals/${token}`, memberCookie)
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('wrong_recipient')
    expect(JSON.stringify(res.body)).not.toContain('minor findings')
    const otherOrg = await api('GET', `/api/approvals/${token}`, otherOrgCookie)
    expect(otherOrg.status).toBe(403)
  })

  test('an unknown token is a 404', async () => {
    const res = await api('GET', '/api/approvals/not-a-real-token', recipientCookie)
    expect(res.status).toBe(404)
  })
})

describe('POST /api/approvals/:token', () => {
  test('the recipient decides once; a second submission returns the winner', async () => {
    const before = await getDb()<Array<{ n: number }>>`SELECT count(*)::int AS n FROM team_members WHERE team_id = ${teamA}`
    const res = await api<{ state: string; decision: { outcome: string; feedback: string } }>('POST', `/api/approvals/${token}`, recipientCookie, { outcome: 'request_changes', feedback: 'Please add a rollback test.' })
    expect(res.status).toBe(200)
    expect(res.body.state).toBe('decided')
    expect(res.body.decision.outcome).toBe('request_changes')
    expect(res.body.decision.feedback).toBe('Please add a rollback test.')

    const again = await api<{ code: string; decision: { outcome: string } }>('POST', `/api/approvals/${token}`, recipientCookie, { outcome: 'approve' })
    expect(again.status).toBe(409)
    expect(again.body.code).toBe('already_decided')
    expect(again.body.decision.outcome).toBe('request_changes')

    // The link grants no membership or role.
    const after = await getDb()<Array<{ n: number }>>`SELECT count(*)::int AS n FROM team_members WHERE team_id = ${teamA}`
    expect(after[0]!.n).toBe(before[0]!.n)
  })

  test('feedback is required for the non-bare outcomes', async () => {
    // A fresh, untouched gate: the first token was consumed above.
    const run = await createRun({
      projectNamespace: projectA.slug, projectLabel: 'Approval API', projectPath: '/tmp/approval-api',
      pipelineName: 'test', options: {} as never, template: { stages: [] } as never, projectId: projectA.projectId,
    })
    const gateId = await openGate({ runId: run.runId, stepIndex: 0, kind: 'review', prompt: 'review' })
    await getDb()`UPDATE pipeline_runs SET status = 'paused', pause_kind = 'review', current_stage = 'review' WHERE run_id = ${run.runId}`
    const fresh = await createApprovalRequests({
      runId: run.runId, gateId, projectId: projectA.projectId, stage: 'review', kind: 'review',
      summary: 'x', recipients: [{ userId: users.productOwnerA, name: 'Product Owner A', email: '<EMAIL_5>', primary: true }],
    })
    const res = await api<{ code: string }>('POST', `/api/approvals/${fresh[0]!.token}`, recipientCookie, { outcome: 'approve_with_notes' })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('feedback_required')
  })
})
