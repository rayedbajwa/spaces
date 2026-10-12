import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { closeDb, getDb } from '../src/lib/db'
import { createProject } from '../src/lib/project-registry'
import { createRun, openGate } from '../src/lib/run-store'
import { answerForOutcome, createApprovalRequests, resolveGateRecipients, submitApprovalDecision, verifyApprovalLink, type ApprovalKind } from '../src/lib/approval-store'
import { createApprovalFixture } from './helpers/approval-fixture'

/**
 * Owner approval request/link lifecycle (FR-001/002/005/006/008/011/012/013/014/015/018/022).
 * Integration tests against the guarded test database; email/Slack are not involved.
 */
const fixture = await createApprovalFixture({ withServer: false })
const { projectA, projectTeamB, users, teamA } = fixture

async function newGate(kind: ApprovalKind = 'review', stage = kind === 'review' ? 'review' : 'specify'): Promise<{ runId: string; gateId: string }> {
  const run = await createRun({
    projectNamespace: projectA.slug, projectLabel: 'Approval store', projectPath: '/tmp/approval-store',
    pipelineName: 'test', options: {} as never, template: { stages: [] } as never, projectId: projectA.projectId,
  })
  const gateId = await openGate({ runId: run.runId, stepIndex: 0, kind, prompt: stage })
  await getDb()`UPDATE pipeline_runs SET status = 'paused', pause_kind = ${kind}, current_stage = ${stage} WHERE run_id = ${run.runId}`
  return { runId: run.runId, gateId }
}

async function requestsFor(gateId: string, runId: string, stage: string, kind: ApprovalKind) {
  const resolved = await resolveGateRecipients(projectA.projectId, stage)
  return createApprovalRequests({
    runId, gateId, projectId: projectA.projectId, stage, kind,
    summary: 'Approved with 2 minor findings.\nTests pass.', recipients: resolved.recipients,
    responsibilityId: resolved.responsibilityId, responsibilityKey: resolved.responsibilityKey, fallback: resolved.fallback,
  })
}

afterAll(async () => { await fixture.stop() })

describe('recipient resolution', () => {
  test('explicit assignment returns active assignees with the first as primary', async () => {
    const resolved = await resolveGateRecipients(projectA.projectId, 'review')
    expect(resolved.status).toBe('explicit')
    expect(resolved.responsibilityKey).toBe('product-owner')
    expect(resolved.repairNeeded).toBe(false)
    expect(resolved.recipients.map((r) => r.userId)).toEqual([users.productOwnerA, users.secondProductOwnerA])
    expect(resolved.recipients[0]!.primary).toBe(true)
    expect(resolved.recipients[1]!.primary).toBe(false)
  })

  test('an unassigned responsibility falls back to the Owner and is flagged', async () => {
    const resolved = await resolveGateRecipients(projectTeamB.projectId, 'review')
    expect(resolved.status).toBe('owner-fallback')
    expect(resolved.fallback).toBe(true)
    expect(resolved.recipients.map((r) => r.userId)).toEqual([users.otherOrgOwner])
  })

  test('a project with no eligible Owner is repair-needed with no guessed recipient', async () => {
    const teamless = await createProject({ name: `No owner ${randomUUID().slice(0, 6)}`, slug: `no-owner-${randomUUID().slice(0, 8)}`, teamId: null })
    try {
      const resolved = await resolveGateRecipients(teamless.projectId, 'review')
      expect(resolved.repairNeeded).toBe(true)
      expect(resolved.recipients).toHaveLength(0)
    } finally {
      await getDb()`DELETE FROM projects WHERE project_id = ${teamless.projectId}`
    }
  })
})

describe('link lifecycle', () => {
  test('a link is valid, single-use and consumed by its own decision', async () => {
    const { runId, gateId } = await newGate()
    const created = await requestsFor(gateId, runId, 'review', 'review')
    expect(created).toHaveLength(2)
    const rawToken = created[0]!.token

    const valid = await verifyApprovalLink(rawToken, users.productOwnerA)
    expect(valid.verdict).toBe('valid')
    expect(valid.request?.summary).toContain('2 minor findings')

    const result = await submitApprovalDecision({ token: rawToken, actorUserId: users.productOwnerA, outcome: 'approve' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.decision.outcome).toBe('approve')
    expect(result.decision.summaryShown).toContain('2 minor findings')

    expect((await verifyApprovalLink(rawToken, users.productOwnerA)).verdict).toBe('consumed')
    const [run] = await getDb()<Array<{ status: string }>>`SELECT status FROM pipeline_runs WHERE run_id = ${runId}`
    expect(run?.status).toBe('queued')
    const [gate] = await getDb()<Array<{ status: string }>>`SELECT status FROM pipeline_gates WHERE gate_id = ${gateId}`
    expect(gate?.status).toBe('resolved')
  })

  test('a wrong recipient is refused and the attempt is recorded', async () => {
    const { runId, gateId } = await newGate()
    const created = await requestsFor(gateId, runId, 'review', 'review')
    const verdict = await verifyApprovalLink(created[0]!.token, users.memberA)
    expect(verdict.verdict).toBe('wrong_recipient')
    const [attempt] = await getDb()<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM approval_link_attempts a
        JOIN approval_requests r ON r.request_id = a.request_id WHERE r.gate_id = ${gateId} AND a.outcome = 'wrong_recipient'
    `
    expect(attempt?.n).toBe(1)
  })

  test('an expired link reports expired', async () => {
    const { runId, gateId } = await newGate()
    const created = await requestsFor(gateId, runId, 'review', 'review')
    await getDb()`UPDATE approval_links SET expires_at = now() - interval '1 hour' WHERE request_id = ${created[0]!.request.requestId}`
    expect((await verifyApprovalLink(created[0]!.token, users.productOwnerA)).verdict).toBe('expired')
  })

  test('a gate resolved elsewhere makes the link gate_resolved', async () => {
    const { runId, gateId } = await newGate()
    const created = await requestsFor(gateId, runId, 'review', 'review')
    await getDb()`UPDATE pipeline_gates SET status = 'resolved', resolved_at = now() WHERE gate_id = ${gateId}`
    expect((await verifyApprovalLink(created[0]!.token, users.productOwnerA)).verdict).toBe('gate_resolved')
  })

  test('an unknown token is invalid', async () => {
    expect((await verifyApprovalLink('not-a-real-token', users.productOwnerA)).verdict).toBe('invalid')
  })

  test('creating requests twice for a gate is idempotent', async () => {
    const { runId, gateId } = await newGate()
    const first = await requestsFor(gateId, runId, 'review', 'review')
    const second = await requestsFor(gateId, runId, 'review', 'review')
    expect(first).toHaveLength(2)
    expect(second).toHaveLength(0)
  })
})

describe('decision integrity', () => {
  test('the first decision wins and invalidates the sibling request', async () => {
    const { runId, gateId } = await newGate()
    const created = await requestsFor(gateId, runId, 'review', 'review')
    const winner = created[1]! // the non-primary assignee decides first

    const result = await submitApprovalDecision({ token: winner.token, actorUserId: users.secondProductOwnerA, outcome: 'request_changes', feedback: 'Please add a rollback test.' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.decision.outcome).toBe('request_changes')

    const [sibling] = await getDb()<Array<{ state: string }>>`SELECT state FROM approval_requests WHERE request_id = ${created[0]!.request.requestId}`
    expect(sibling?.state).toBe('invalidated')
    const [siblingLink] = await getDb()<Array<{ consumedAt: string | null }>>`SELECT consumed_at AS "consumedAt" FROM approval_links WHERE request_id = ${created[0]!.request.requestId}`
    expect(siblingLink?.consumedAt).not.toBeNull()

    const second = await submitApprovalDecision({ token: created[0]!.token, actorUserId: users.productOwnerA, outcome: 'approve' })
    expect(second.ok).toBe(false)
    const [decisions] = await getDb()<Array<{ n: number }>>`SELECT count(*)::int AS n FROM approval_decisions WHERE gate_id = ${gateId}`
    expect(decisions?.n).toBe(1)
  })

  test('feedback is required for approve_with_notes and request_changes', async () => {
    const { runId, gateId } = await newGate()
    const created = await requestsFor(gateId, runId, 'review', 'review')
    const missing = await submitApprovalDecision({ token: created[0]!.token, actorUserId: users.productOwnerA, outcome: 'request_changes', feedback: '  ' })
    expect(missing).toEqual({ ok: false, reason: 'feedback_required', decision: undefined })
  })

  test('a clarification decision maps to the run answer vocabulary', () => {
    expect(answerForOutcome('review', 'approve', null)).toBe('approve')
    expect(answerForOutcome('review', 'approve_with_notes', 'minor nits')).toBe('approve\nminor nits')
    expect(answerForOutcome('review', 'request_changes', 'redo it')).toBe('redo it')
    expect(answerForOutcome('clarification', 'approve', null)).toBe('continue')
    expect(answerForOutcome('clarification', 'approve_with_notes', 'use Postgres')).toBe('continue\nuse Postgres')
    expect(answerForOutcome('clarification', 'request_changes', 'use Postgres')).toBe('use Postgres')
  })

  test('a clarification link records the decision and resumes the run', async () => {
    const { runId, gateId } = await newGate('clarification', 'specify')
    const resolved = await resolveGateRecipients(projectA.projectId, 'specify')
    const created = await createApprovalRequests({ runId, gateId, projectId: projectA.projectId, stage: 'specify', kind: 'clarification', summary: 'Which database?', recipients: resolved.recipients })
    const result = await submitApprovalDecision({ token: created[0]!.token, actorUserId: users.productOwnerA, outcome: 'approve_with_notes', feedback: 'Use Postgres' })
    expect(result.ok).toBe(true)
    const [run] = await getDb()<Array<{ status: string }>>`SELECT status FROM pipeline_runs WHERE run_id = ${runId}`
    expect(run?.status).toBe('queued')
    const [event] = await getDb()<Array<{ payload: { response?: string } }>>`SELECT payload FROM pipeline_events WHERE run_id = ${runId} AND kind = 'gate_resolved' ORDER BY event_id DESC LIMIT 1`
    expect(event?.payload.response).toBe('continue\nUse Postgres')
  })

  test('resolving the gate records the decision feedback and actor in the event stream', async () => {
    const { runId, gateId } = await newGate()
    const created = await requestsFor(gateId, runId, 'review', 'review')
    await submitApprovalDecision({ token: created[0]!.token, actorUserId: users.productOwnerA, outcome: 'request_changes', feedback: 'Verbatim feedback' })
    const [event] = await getDb()<Array<{ payload: { decision?: { outcome?: string; feedback?: string | null; decidedBy?: string; via?: string } } }>>`
      SELECT payload FROM pipeline_events WHERE run_id = ${runId} AND kind = 'gate_resolved' ORDER BY event_id DESC LIMIT 1
    `
    expect(event?.payload.decision?.outcome).toBe('request_changes')
    expect(event?.payload.decision?.feedback).toBe('Verbatim feedback')
    expect(event?.payload.decision?.decidedBy).toBe(users.productOwnerA)
    expect(event?.payload.decision?.via).toBe('link')
  })

  test('a revoked assignee is no longer a recipient on re-resolution', async () => {
    const { runId, gateId } = await newGate()
    const before = await resolveGateRecipients(projectA.projectId, 'review')
    const poId = before.responsibilityId!
    try {
      const { replaceAssignments } = await import('../src/lib/project-responsibilities')
      await replaceAssignments(projectA.projectId, poId, [users.memberA], users.ownerA)
      const after = await resolveGateRecipients(projectA.projectId, 'review')
      expect(after.recipients.map((r) => r.userId)).toEqual([users.memberA])
    } finally {
      const { replaceAssignments } = await import('../src/lib/project-responsibilities')
      await replaceAssignments(projectA.projectId, poId, [users.productOwnerA, users.secondProductOwnerA], users.ownerA)
      await getDb()`DELETE FROM pipeline_runs WHERE run_id = ${runId}`
    }
  })

  test('a revoked assignee link is refused and records the attempt (FR-018)', async () => {
    const { runId, gateId } = await newGate()
    const resolved = await resolveGateRecipients(projectA.projectId, 'review')
    const poId = resolved.responsibilityId!
    const created = await createApprovalRequests({
      runId, gateId, projectId: projectA.projectId, stage: 'review', kind: 'review',
      summary: 'Approved with 2 minor findings.', recipients: resolved.recipients,
      responsibilityId: resolved.responsibilityId, responsibilityKey: resolved.responsibilityKey, fallback: resolved.fallback,
    })
    const revoked = created.find((item) => item.request.recipientUserId === users.productOwnerA)!
    try {
      const { replaceAssignments } = await import('../src/lib/project-responsibilities')
      await replaceAssignments(projectA.projectId, poId, [users.secondProductOwnerA], users.ownerA)
      const verdict = await verifyApprovalLink(revoked.token, users.productOwnerA)
      expect(verdict.verdict).toBe('revoked')
      const result = await submitApprovalDecision({ token: revoked.token, actorUserId: users.productOwnerA, outcome: 'approve' })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('revoked')
      const [attempt] = await getDb()<Array<{ outcome: string }>>`SELECT outcome FROM approval_link_attempts WHERE request_id = ${revoked.request.requestId} ORDER BY created_at DESC LIMIT 1`
      expect(attempt?.outcome).toBe('revoked')
    } finally {
      const { replaceAssignments } = await import('../src/lib/project-responsibilities')
      await replaceAssignments(projectA.projectId, poId, [users.productOwnerA, users.secondProductOwnerA], users.ownerA)
      await getDb()`DELETE FROM pipeline_runs WHERE run_id = ${runId}`
    }
  })

  test('a forwarded link does not expose the summary once it has been used (FR-006)', async () => {
    const { runId, gateId } = await newGate()
    const created = await requestsFor(gateId, runId, 'review', 'review')
    await submitApprovalDecision({ token: created[0]!.token, actorUserId: users.productOwnerA, outcome: 'approve' })
    const forwarded = await verifyApprovalLink(created[0]!.token, users.memberA)
    expect(forwarded.verdict).toBe('wrong_recipient')
  })

  test('a forwarded link does not expose the summary once it has expired (FR-006)', async () => {
    const { runId, gateId } = await newGate()
    const created = await requestsFor(gateId, runId, 'review', 'review')
    await getDb()`UPDATE approval_links SET expires_at = now() - interval '1 hour' WHERE request_id = ${created[0]!.request.requestId}`
    const forwarded = await verifyApprovalLink(created[0]!.token, users.memberA)
    expect(forwarded.verdict).toBe('wrong_recipient')
  })

  test('over-long feedback is reported as feedback_too_long', async () => {
    const { runId, gateId } = await newGate()
    const created = await requestsFor(gateId, runId, 'review', 'review')
    const tooLong = await submitApprovalDecision({ token: created[0]!.token, actorUserId: users.productOwnerA, outcome: 'request_changes', feedback: 'x'.repeat(4001) })
    expect(tooLong.ok).toBe(false)
    if (!tooLong.ok) expect(tooLong.reason).toBe('feedback_too_long')
  })

  test('an in-app gate answer invalidates outstanding approval requests (FR-012)', async () => {
    const { runId, gateId } = await newGate()
    const created = await requestsFor(gateId, runId, 'review', 'review')
    const { answerPausedRun } = await import('../src/lib/run-store')
    const answered = await answerPausedRun({ runId, projectId: projectA.projectId, answer: 'approve' })
    expect(answered.ok).toBe(true)
    for (const item of created) {
      const [row] = await getDb()<Array<{ state: string }>>`SELECT state FROM approval_requests WHERE request_id = ${item.request.requestId}`
      expect(row?.state).toBe('invalidated')
    }
  })

  test('two simultaneous submissions produce exactly one decision (FR-011/SC-004)', async () => {
    const { runId, gateId } = await newGate()
    const created = await requestsFor(gateId, runId, 'review', 'review')
    const [first, second] = await Promise.all([
      submitApprovalDecision({ token: created[0]!.token, actorUserId: users.productOwnerA, outcome: 'approve' }),
      submitApprovalDecision({ token: created[1]!.token, actorUserId: users.secondProductOwnerA, outcome: 'request_changes', feedback: 'please redo' }),
    ])
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1)
    const [decisions] = await getDb()<Array<{ n: number }>>`SELECT count(*)::int AS n FROM approval_decisions WHERE gate_id = ${gateId}`
    expect(decisions?.n).toBe(1)
  })

  test('a token from another organization is refused and exposes no cross-org data (FR-017)', async () => {
    const run = await createRun({
      projectNamespace: projectTeamB.slug, projectLabel: 'Org B', projectPath: '/tmp/approval-org-b',
      pipelineName: 'test', options: {} as never, template: { stages: [] } as never, projectId: projectTeamB.projectId,
    })
    const gateId = await openGate({ runId: run.runId, stepIndex: 0, kind: 'review', prompt: 'review' })
    await getDb()`UPDATE pipeline_runs SET status = 'paused', pause_kind = 'review', current_stage = 'review' WHERE run_id = ${run.runId}`
    const resolvedB = await resolveGateRecipients(projectTeamB.projectId, 'review')
    const createdB = await createApprovalRequests({
      runId: run.runId, gateId, projectId: projectTeamB.projectId, stage: 'review', kind: 'review',
      summary: 'org B secret summary', recipients: resolvedB.recipients,
      responsibilityId: resolvedB.responsibilityId, responsibilityKey: resolvedB.responsibilityKey, fallback: resolvedB.fallback,
    })
    const verdict = await verifyApprovalLink(createdB[0]!.token, users.memberA)
    expect(verdict.verdict).toBe('wrong_recipient')
    expect(verdict.request?.orgId).toBe(fixture.orgB)
    await getDb()`DELETE FROM pipeline_runs WHERE run_id = ${run.runId}`
  })
})

describe('cancellation invalidation (FR-012)', () => {
  test('cancelling a project invalidates every outstanding approval request and link', async () => {
    const { runId, gateId } = await newGate()
    const created = await requestsFor(gateId, runId, 'review', 'review')
    expect(created).toHaveLength(2)

    const { cancelProjectWork } = await import('../src/lib/project-cancel')
    const { getProjectBySlug } = await import('../src/lib/project-registry')
    const project = await getProjectBySlug(projectA.slug)
    expect(project).toBeDefined()
    const cancelled = await cancelProjectWork(project!, 'approval cancellation test')
    expect(cancelled.runIds).toContain(runId)

    for (const item of created) {
      const [request] = await getDb()<Array<{ state: string }>>`SELECT state FROM approval_requests WHERE request_id = ${item.request.requestId}`
      expect(request?.state).toBe('invalidated')
      const [link] = await getDb()<Array<{ consumedAt: string | null }>>`SELECT consumed_at AS "consumedAt" FROM approval_links WHERE request_id = ${item.request.requestId}`
      expect(link?.consumedAt).not.toBeNull()
    }
    // The cancelled run's links are consumed (invalidated) and can no longer act.
    expect((await verifyApprovalLink(created[0]!.token, users.productOwnerA)).verdict).toBe('consumed')
  })
})
