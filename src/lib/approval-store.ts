/**
 * Owner approval links (011-owner-approval-link).
 *
 * When a run pauses at a human gate, the accountable person is resolved from the
 * existing project responsibility model (mapped standard responsibility, first
 * active assignee primary, Owner fallback when unassigned). One request per
 * recipient is persisted, each with a single-use, hashed, TTL-bounded link. The
 * request carries the exact stage summary the owner sees, and a decision is
 * recorded once per gate through the existing run answer path.
 *
 * Nothing here changes approval authority: a link only lets its bound recipient
 * submit the same decision the in-app gate accepts, and grants no membership,
 * role or project access. Every read and write is scoped through the project's
 * org and team.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { getDb } from './db'
import { approvalLinkTtlHours } from './env'
import { log } from './logger'
import { orgIdForProject } from './orgs'
import { listResponsibilities, responsibilityKeyForStage, type ResolutionStatus } from './project-responsibilities'
import { answerPausedRun } from './run-store'

const approvalLog = log.child({ mod: 'approval-store' })

export type ApprovalKind = 'review' | 'clarification'
export type ApprovalRequestState = 'pending' | 'delivered' | 'undeliverable' | 'decided' | 'invalidated' | 'expired'
export type ApprovalOutcome = 'approve' | 'approve_with_notes' | 'request_changes'
export type ApprovalChannel = 'slack' | 'email'
export type ApprovalLinkVerdict = 'valid' | 'expired' | 'consumed' | 'wrong_recipient' | 'revoked' | 'gate_resolved' | 'invalid'

export interface ApprovalRequest {
  requestId: string
  gateId: string
  runId: string
  projectId: string
  orgId: string
  responsibilityId: string | null
  responsibilityKey: string | null
  stage: string
  kind: ApprovalKind
  recipientUserId: string
  recipientEmail: string
  primaryRecipient: boolean
  summary: string | null
  state: ApprovalRequestState
  fallback: boolean
  createdAt: string
  updatedAt: string
}

export interface ApprovalDecision {
  decisionId: string
  requestId: string | null
  gateId: string
  runId: string
  linkId: string | null
  outcome: ApprovalOutcome
  feedback: string | null
  summaryShown: string | null
  decidedBy: string
  decidedByName?: string | null
  decidedAt: string
}

export interface ApprovalLink {
  linkId: string
  requestId: string
  tokenHash: string
  boundUserId: string
  expiresAt: string
  consumedAt: string | null
}

export interface GateRecipient {
  userId: string
  name: string
  email: string
  primary: boolean
}

export interface GateRecipients {
  responsibilityId: string | null
  responsibilityKey: string
  status: ResolutionStatus
  repairNeeded: boolean
  fallback: boolean
  recipients: GateRecipient[]
}

export interface CreatedApprovalRequest {
  request: ApprovalRequest
  token: string
}

export interface ApprovalLinkVerdictResult {
  verdict: ApprovalLinkVerdict
  request?: ApprovalRequest
  link?: ApprovalLink
  decision?: ApprovalDecision
}

const REQUEST_COLS = `
  request_id         AS "requestId",
  gate_id            AS "gateId",
  run_id             AS "runId",
  project_id         AS "projectId",
  org_id             AS "orgId",
  responsibility_id  AS "responsibilityId",
  responsibility_key AS "responsibilityKey",
  stage,
  kind,
  recipient_user_id  AS "recipientUserId",
  recipient_email    AS "recipientEmail",
  primary_recipient  AS "primaryRecipient",
  summary,
  state,
  fallback,
  created_at         AS "createdAt",
  updated_at         AS "updatedAt"
`

const LINK_COLS = `
  link_id       AS "linkId",
  request_id    AS "requestId",
  token_hash    AS "tokenHash",
  bound_user_id AS "boundUserId",
  expires_at    AS "expiresAt",
  consumed_at   AS "consumedAt"
`

const DECISION_COLS = `
  d.decision_id   AS "decisionId",
  d.request_id    AS "requestId",
  d.gate_id       AS "gateId",
  d.run_id        AS "runId",
  d.link_id       AS "linkId",
  d.outcome,
  d.feedback,
  d.summary_shown AS "summaryShown",
  d.decided_by    AS "decidedBy",
  u.name          AS "decidedByName",
  d.decided_at    AS "decidedAt"
`

export function hashApprovalToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** The compacted handoff when there is one, else the end of the stage output. */
export function stageSummary(summary: string | null | undefined, tail: string | null | undefined): string | undefined {
  const text = summary?.trim() || tail?.trim() || ''
  if (!text) return undefined
  return text.length > 1500 ? `…${text.slice(-1500)}` : text
}

/** Read the summary recorded when a stage finished, so the notification and decision carry the same text. */
export async function summaryForGate(runId: string, stage: string, fallbackTail?: string | null): Promise<string | undefined> {
  const [entry] = await getDb()<Array<{ summary: string | null; tail: string }>>`
    SELECT summary, tail FROM run_thread_entries
     WHERE run_id = ${runId} AND stage = ${stage}
     ORDER BY entry_id DESC LIMIT 1
  `.catch(() => [] as Array<{ summary: string | null; tail: string }>)
  return stageSummary(entry?.summary, entry?.tail ?? fallbackTail)
}

/**
 * Resolve the accountable recipients for a paused stage. The mapped standard
 * responsibility's active assignees come first; an unassigned one falls back to
 * the Owner (flagged), and a project with no eligible Owner is repair-needed
 * with no guessed recipient.
 */
export async function resolveGateRecipients(projectId: string, stage: string): Promise<GateRecipients> {
  const key = responsibilityKeyForStage(stage)
  const views = await listResponsibilities(projectId)
  const view = views.find((item) => item.standardKey === key) ?? views.find((item) => item.standardKey === 'owner')
  if (!view) return { responsibilityId: null, responsibilityKey: key, status: 'unresolved', repairNeeded: true, fallback: false, recipients: [] }
  const resolution = view.resolution
  return {
    responsibilityId: view.responsibilityId,
    responsibilityKey: view.standardKey ?? key,
    status: resolution.status,
    repairNeeded: resolution.repairNeeded,
    fallback: resolution.status === 'owner-fallback',
    recipients: resolution.assignees.map((assignee) => ({ userId: assignee.userId, name: assignee.name, email: assignee.email, primary: assignee.primary })),
  }
}

/**
 * Persist one request per recipient, idempotently: a repeated gate event for the
 * same person returns nothing new while that person still holds a live link.
 * When the existing request has no live link (it was invalidated on revocation,
 * or its link expired) the request is revived in place and a fresh link is
 * minted, so a recipient restored to the gate can still act (FR-018). Each new
 * link's raw token is kept only as a SHA-256 hash at rest.
 */
export async function createApprovalRequests(input: {
  runId: string
  gateId: string
  projectId: string
  stage: string
  kind: ApprovalKind
  summary: string | null
  recipients: GateRecipient[]
  responsibilityId?: string | null
  responsibilityKey?: string | null
  fallback?: boolean
}): Promise<CreatedApprovalRequest[]> {
  if (input.recipients.length === 0) return []
  const orgId = await orgIdForProject(input.projectId)
  const ttlMs = approvalLinkTtlHours() * 3_600_000
  const sql = getDb()
  // The request and its link are written together so a crash can never leave a
  // request without a link (which the idempotency guard would then hide).
  const created = await sql.begin(async (tx) => {
    const out: CreatedApprovalRequest[] = []
    for (const recipient of input.recipients) {
      const requestId = randomUUID()
      const [row] = await tx<ApprovalRequest[]>`
        INSERT INTO approval_requests
          (request_id, gate_id, run_id, project_id, org_id, responsibility_id, responsibility_key, stage, kind,
           recipient_user_id, recipient_email, primary_recipient, summary, state, fallback)
        VALUES
          (${requestId}, ${input.gateId}, ${input.runId}, ${input.projectId}, ${orgId}, ${input.responsibilityId ?? null},
           ${input.responsibilityKey ?? null}, ${input.stage}, ${input.kind}, ${recipient.userId}, ${recipient.email},
           ${recipient.primary}, ${input.summary}, 'pending', ${input.fallback ?? false})
        ON CONFLICT (gate_id, recipient_user_id) DO UPDATE
          SET state              = 'pending',
              summary            = EXCLUDED.summary,
              stage              = EXCLUDED.stage,
              kind               = EXCLUDED.kind,
              responsibility_id  = EXCLUDED.responsibility_id,
              responsibility_key = EXCLUDED.responsibility_key,
              recipient_email    = EXCLUDED.recipient_email,
              primary_recipient  = EXCLUDED.primary_recipient,
              fallback           = EXCLUDED.fallback,
              updated_at         = now()
          WHERE approval_requests.state <> 'decided'
            AND NOT EXISTS (
              SELECT 1 FROM approval_links l
               WHERE l.request_id = approval_requests.request_id
                 AND l.consumed_at IS NULL
                 AND l.expires_at > now()
            )
        RETURNING ${tx.unsafe(REQUEST_COLS)}
      `
      // No row means the recipient already held a live link (idempotent repeat)
      // or the request was already decided; leave it untouched.
      if (!row) continue
      const token = randomBytes(32).toString('base64url')
      await tx`
        INSERT INTO approval_links (link_id, request_id, token_hash, bound_user_id, expires_at)
        VALUES (${randomUUID()}, ${row.requestId}, ${hashApprovalToken(token)}, ${recipient.userId}, ${new Date(Date.now() + ttlMs)})
      `
      out.push({ request: row, token })
    }
    return out
  })
  if (created.length) approvalLog.info('approval requests created', { gateId: input.gateId, stage: input.stage, kind: input.kind, recipients: created.length })
  return created
}

/** Audit one delivery try; a delivered try moves the request to `delivered`. */
export async function recordDelivery(requestId: string, channel: ApprovalChannel, outcome: 'delivered' | 'failed' | 'skipped', failure?: string): Promise<void> {
  const sql = getDb()
  await sql`
    INSERT INTO approval_deliveries (delivery_id, request_id, channel, outcome, failure)
    VALUES (${randomUUID()}, ${requestId}, ${channel}, ${outcome}, ${failure ?? null})
  `
  if (outcome === 'delivered') {
    await sql`UPDATE approval_requests SET state = 'delivered', updated_at = now() WHERE request_id = ${requestId} AND state = 'pending'`
  }
}

/** Mark a request undeliverable when no channel accepted it. */
export async function markRequestUndeliverable(requestId: string): Promise<void> {
  await getDb()`UPDATE approval_requests SET state = 'undeliverable', updated_at = now() WHERE request_id = ${requestId} AND state = 'pending'`
}

/** Audit an open/verify attempt, including refused ones. */
export async function recordLinkAttempt(linkId: string | null, requestId: string | null, actorUserId: string | null | undefined, outcome: string): Promise<void> {
  await getDb()`
    INSERT INTO approval_link_attempts (attempt_id, link_id, request_id, actor_user_id, outcome)
    VALUES (${randomUUID()}, ${linkId}, ${requestId}, ${actorUserId ?? null}, ${outcome})
  `
}

async function getDecisionForGate(gateId: string): Promise<ApprovalDecision | undefined> {
  const [row] = await getDb()<ApprovalDecision[]>`
    SELECT ${getDb().unsafe(DECISION_COLS)}
      FROM approval_decisions d
      LEFT JOIN users u ON u.user_id = d.decided_by
     WHERE d.gate_id = ${gateId}
  `
  return row
}

export interface ApprovalDecisionView extends ApprovalDecision {
  projectName?: string
}

/**
 * Verify a raw link token for an actor. `valid` is the only verdict that allows
 * a decision; every other known verdict records an access attempt.
 */
export async function verifyApprovalLink(token: string, actorUserId?: string): Promise<ApprovalLinkVerdictResult> {
  if (!token) return { verdict: 'invalid' }
  const sql = getDb()
  const [row] = await sql<Array<ApprovalRequest & ApprovalLink>>`
    SELECT
      r.request_id         AS "requestId",
      r.gate_id            AS "gateId",
      r.run_id             AS "runId",
      r.project_id         AS "projectId",
      r.org_id             AS "orgId",
      r.responsibility_id  AS "responsibilityId",
      r.responsibility_key AS "responsibilityKey",
      r.stage,
      r.kind,
      r.recipient_user_id  AS "recipientUserId",
      r.recipient_email    AS "recipientEmail",
      r.primary_recipient  AS "primaryRecipient",
      r.summary,
      r.state,
      r.fallback,
      r.created_at         AS "createdAt",
      r.updated_at         AS "updatedAt",
      l.link_id            AS "linkId",
      r.request_id         AS "linkRequestId",
      l.token_hash         AS "tokenHash",
      l.bound_user_id      AS "boundUserId",
      l.expires_at         AS "expiresAt",
      l.consumed_at        AS "consumedAt"
      FROM approval_links l
      JOIN approval_requests r ON r.request_id = l.request_id
     WHERE l.token_hash = ${hashApprovalToken(token)}
  `
  if (!row) return { verdict: 'invalid' }

  const request: ApprovalRequest = {
    requestId: row.requestId, gateId: row.gateId, runId: row.runId, projectId: row.projectId, orgId: row.orgId,
    responsibilityId: row.responsibilityId, responsibilityKey: row.responsibilityKey, stage: row.stage, kind: row.kind,
    recipientUserId: row.recipientUserId, recipientEmail: row.recipientEmail, primaryRecipient: row.primaryRecipient,
    summary: row.summary, state: row.state, fallback: row.fallback, createdAt: row.createdAt, updatedAt: row.updatedAt,
  }
  const link: ApprovalLink = {
    linkId: row.linkId, requestId: row.requestId, tokenHash: row.tokenHash, boundUserId: row.boundUserId,
    expiresAt: row.expiresAt, consumedAt: row.consumedAt,
  }

  let verdict: ApprovalLinkVerdict
  // Recipient matching comes first so a forwarded link can never read the
  // summary once the real recipient's link has been used or has expired (FR-006).
  if (actorUserId && actorUserId !== link.boundUserId) verdict = 'wrong_recipient'
  else if (link.consumedAt) verdict = 'consumed'
  else if (new Date(link.expiresAt).getTime() <= Date.now()) verdict = 'expired'
  else if (request.state === 'decided') verdict = 'consumed'
  else if (request.state === 'invalidated') verdict = 'gate_resolved'
  else if (request.state === 'expired') verdict = 'expired'
  else if (!['pending', 'delivered'].includes(request.state)) verdict = 'gate_resolved'
  else {
    // A live link still needs its subject to be an active, assigned recipient:
    // revocation before they act refuses the link and re-resolves the request (FR-018).
    const subjectUserId = actorUserId ?? link.boundUserId
    const resolved = await resolveGateRecipients(request.projectId, request.stage)
    if (!resolved.recipients.some((recipient) => recipient.userId === subjectUserId)) verdict = 'revoked'
    else {
      const [gate] = await sql<Array<{ status: string }>>`SELECT status FROM pipeline_gates WHERE gate_id = ${request.gateId}`
      const [run] = await sql<Array<{ status: string }>>`SELECT status FROM pipeline_runs WHERE run_id = ${request.runId}`
      verdict = gate?.status === 'open' && run?.status === 'paused' ? 'valid' : 'gate_resolved'
    }
  }

  await recordLinkAttempt(link.linkId, request.requestId, actorUserId, verdict)
  const decision = await getDecisionForGate(request.gateId)
  return { verdict, request, link, decision }
}

/** Map a link outcome to the run answer vocabulary (see data-model.md). */
export function answerForOutcome(kind: ApprovalKind, outcome: ApprovalOutcome, feedback: string | null): string {
  const base = kind === 'review'
    ? (outcome === 'approve' || outcome === 'approve_with_notes' ? 'approve' : '')
    : (outcome === 'approve' || outcome === 'approve_with_notes' ? 'continue' : '')
  if (outcome === 'approve') return base
  return base ? `${base}\n${feedback ?? ''}`.trimEnd() : (feedback ?? '')
}

/** Invalidate one recipient's outstanding request and link (a revoked recipient). */
export async function invalidateApprovalRequest(requestId: string): Promise<void> {
  const sql = getDb()
  await sql.begin(async (tx) => {
    await tx`UPDATE approval_requests SET state = 'invalidated', updated_at = now() WHERE request_id = ${requestId} AND state IN ('pending','delivered')`
    await tx`UPDATE approval_links SET consumed_at = now() WHERE request_id = ${requestId} AND consumed_at IS NULL`
  })
}

/** Invalidate every outstanding request and link for a gate, inside a caller's transaction. */
export async function invalidateApprovalRequestsForGateTx(tx: any, gateId: string): Promise<void> {
  await tx`UPDATE approval_requests SET state = 'invalidated', updated_at = now() WHERE gate_id = ${gateId} AND state IN ('pending','delivered')`
  await tx`
    UPDATE approval_links SET consumed_at = now()
     WHERE consumed_at IS NULL
       AND request_id IN (SELECT request_id FROM approval_requests WHERE gate_id = ${gateId})
  `
}

/** Invalidate every outstanding request and link for a gate. */
export async function invalidateApprovalRequestsForGate(gateId: string): Promise<void> {
  const sql = getDb()
  await sql.begin((tx) => invalidateApprovalRequestsForGateTx(tx, gateId))
}

/** Invalidate every outstanding request and link for every gate of a run (cancellation). */
export async function invalidateApprovalRequestsForRunTx(tx: any, runId: string): Promise<void> {
  await tx`UPDATE approval_requests SET state = 'invalidated', updated_at = now() WHERE run_id = ${runId} AND state IN ('pending','delivered')`
  await tx`
    UPDATE approval_links SET consumed_at = now()
     WHERE consumed_at IS NULL
       AND request_id IN (SELECT request_id FROM approval_requests WHERE run_id = ${runId})
  `
}

export type SubmitDecisionResult =
  | { ok: true; decision: ApprovalDecision; request: ApprovalRequest }
  | { ok: false; reason: 'invalid' | 'expired' | 'consumed' | 'wrong_recipient' | 'revoked' | 'gate_resolved' | 'feedback_required' | 'feedback_too_long' | 'not_waiting'; decision?: ApprovalDecision; request?: ApprovalRequest }

/**
 * Verify a link and submit its decision in one transaction through the run
 * store, so the decision row, link consumption, sibling invalidation, gate
 * resolution and resume job can never diverge. The first decision wins.
 */
export async function submitApprovalDecision(input: {
  token: string
  actorUserId?: string
  outcome: ApprovalOutcome
  feedback?: string | null
}): Promise<SubmitDecisionResult> {
  const verified = await verifyApprovalLink(input.token, input.actorUserId)
  if (verified.verdict !== 'valid' || !verified.request || !verified.link) {
    const verdict = verified.verdict === 'valid' ? 'invalid' : verified.verdict
    return { ok: false, reason: verdict, decision: verified.decision, ...(verdict === 'revoked' ? { request: verified.request } : {}) }
  }
  const feedback = input.feedback?.trim() ?? ''
  if (input.outcome !== 'approve' && !feedback) return { ok: false, reason: 'feedback_required', decision: verified.decision }
  if (feedback.length > 4000) return { ok: false, reason: 'feedback_too_long', decision: verified.decision }

  const request = verified.request
  const answer = answerForOutcome(request.kind, input.outcome, feedback || null)
  const result = await answerPausedRun({
    runId: request.runId,
    projectId: request.projectId,
    answer,
    decision: {
      requestId: request.requestId,
      linkId: verified.link.linkId,
      gateId: request.gateId,
      outcome: input.outcome,
      feedback: feedback || null,
      summaryShown: request.summary,
      decidedBy: input.actorUserId ?? verified.link.boundUserId,
    },
  })
  if (!result.ok) {
    const winning = await getDecisionForGate(request.gateId)
    approvalLog.warn('approval decision rejected; the gate is no longer waiting', { gateId: request.gateId, reason: result.reason })
    return { ok: false, reason: result.reason === 'archived' ? 'not_waiting' : 'gate_resolved', decision: winning }
  }
  const decision = await getDecisionForGate(request.gateId)
  if (!decision) return { ok: false, reason: 'gate_resolved' }
  approvalLog.info('approval decision recorded', { gateId: request.gateId, outcome: input.outcome, by: input.actorUserId ?? verified.link.boundUserId })
  return { ok: true, decision, request }
}
