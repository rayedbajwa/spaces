import { afterAll, describe, expect, test } from 'bun:test'
import { getDb } from '../src/lib/db'
import { createApprovalRequests, resolveGateRecipients, verifyApprovalLink } from '../src/lib/approval-store'
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

  test('non-string feedback is rejected as a 400, not a 500', async () => {
    const run = await createRun({
      projectNamespace: projectA.slug, projectLabel: 'Approval API', projectPath: '/tmp/approval-api',
      pipelineName: 'test', options: {} as never, template: { stages: [] } as never, projectId: projectA.projectId,
    })
    const gateId = await openGate({ runId: run.runId, stepIndex: 0, kind: 'review', prompt: 'review' })
    await getDb()`UPDATE pipeline_runs SET status = 'paused', pause_kind = 'review', current_stage = 'review' WHERE run_id = ${run.runId}`
    const fresh = await createApprovalRequests({
      runId: run.runId, gateId, projectId: projectA.projectId, stage: 'review', kind: 'review',
      summary: 'x', recipients: [{ userId: users.productOwnerA, name: 'Product Owner A', email: 'approval-po@example.test', primary: true }],
    })
    const res = await api<{ code: string }>('POST', `/api/approvals/${fresh[0]!.token}`, recipientCookie, { outcome: 'approve', feedback: 123 })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('invalid_feedback')
  })

  test('a viewer-role active assignee can decide their own link (FR-013)', async () => {
    const run = await createRun({
      projectNamespace: projectA.slug, projectLabel: 'Approval API', projectPath: '/tmp/approval-api',
      pipelineName: 'test', options: {} as never, template: { stages: [] } as never, projectId: projectA.projectId,
    })
    const gateId = await openGate({ runId: run.runId, stepIndex: 0, kind: 'review', prompt: 'review' })
    await getDb()`UPDATE pipeline_runs SET status = 'paused', pause_kind = 'review', current_stage = 'review' WHERE run_id = ${run.runId}`
    const resolved = await resolveGateRecipients(projectA.projectId, 'review')
    const poId = resolved.responsibilityId!
    const { replaceAssignments } = await import('../src/lib/project-responsibilities')
    // Make the viewer the accountable (active) assignee: the link is only valid
    // for a current recipient, and FR-013 says the viewer role must not block it.
    await replaceAssignments(projectA.projectId, poId, [users.viewerA], users.ownerA)
    try {
      const fresh = await createApprovalRequests({
        runId: run.runId, gateId, projectId: projectA.projectId, stage: 'review', kind: 'review',
        summary: 'viewer summary', recipients: [{ userId: users.viewerA, name: 'Viewer Assignee', email: 'viewer@example.test', primary: true }],
      })
      const viewerCookie = await fixture.cookieFor(users.viewerA, teamA)
      const res = await api<{ state: string; decision: { outcome: string } }>('POST', `/api/approvals/${fresh[0]!.token}`, viewerCookie, { outcome: 'approve' })
      expect(res.status).toBe(200)
      expect(res.body.state).toBe('decided')
      expect(res.body.decision.outcome).toBe('approve')
    } finally {
      await replaceAssignments(projectA.projectId, poId, [users.productOwnerA, users.secondProductOwnerA], users.ownerA)
    }
  })
})

describe('run cancellation (FR-012)', () => {
  test('cancelling a run invalidates its outstanding approval request and link', async () => {
    const run = await createRun({
      projectNamespace: projectA.slug, projectLabel: 'Approval API', projectPath: '/tmp/approval-api',
      pipelineName: 'test', options: {} as never, template: { stages: [] } as never, projectId: projectA.projectId,
    })
    const gateId = await openGate({ runId: run.runId, stepIndex: 0, kind: 'review', prompt: 'review' })
    await getDb()`UPDATE pipeline_runs SET status = 'paused', pause_kind = 'review', current_stage = 'review' WHERE run_id = ${run.runId}`
    const resolved = await resolveGateRecipients(projectA.projectId, 'review')
    const fresh = await createApprovalRequests({
      runId: run.runId, gateId, projectId: projectA.projectId, stage: 'review', kind: 'review',
      summary: 'cancel me', recipients: resolved.recipients, responsibilityId: resolved.responsibilityId,
      responsibilityKey: resolved.responsibilityKey, fallback: resolved.fallback,
    })

    const res = await api('POST', `/api/runs/${run.runId}/cancel`, recipientCookie)
    expect(res.status).toBe(200)

    for (const item of fresh) {
      const [request] = await getDb()<Array<{ state: string }>>`SELECT state FROM approval_requests WHERE request_id = ${item.request.requestId}`
      expect(request?.state).toBe('invalidated')
      const [link] = await getDb()<Array<{ consumedAt: string | null }>>`SELECT consumed_at AS "consumedAt" FROM approval_links WHERE request_id = ${item.request.requestId}`
      expect(link?.consumedAt).not.toBeNull()
    }
    expect((await verifyApprovalLink(fresh[0]!.token, users.productOwnerA)).verdict).toBe('consumed')
  })
})

describe('stale links (FR-006/FR-022)', () => {
  test('the recipient re-opening a decided link sees the recorded outcome', async () => {
    const res = await api<{ state: string; decision: { outcome: string; feedback: string } }>('GET', `/api/approvals/${token}`, recipientCookie)
    expect(res.status).toBe(200)
    expect(res.body.state).toBe('decided')
    expect(res.body.decision.outcome).toBe('request_changes')
  })

  test('a non-recipient cannot read a decided link summary', async () => {
    const res = await api<{ code: string }>('GET', `/api/approvals/${token}`, memberCookie)
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('wrong_recipient')
    expect(JSON.stringify(res.body)).not.toContain('minor findings')
  })
})
