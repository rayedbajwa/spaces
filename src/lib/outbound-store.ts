/**
 * Outbound subscriptions and outbox (012-inbound-outbound-slack, US4).
 *
 * Organizations and projects configure per-event subscriptions. Emitting an
 * event inserts one delivery row per matching enabled subscription, idempotent
 * on (subscription_id, event_key); a worker timer drains them with retry and
 * backoff. Emitting never blocks or changes a run, and a target outage only
 * marks the delivery attempted.
 */

import { randomUUID } from 'node:crypto'
import { getDb } from './db'
import { log } from './logger'

const outboundLog = log.child({ mod: 'outbound-store' })

export const OUTBOUND_EVENT_KINDS = ['run_failed', 'gate_opened', 'stage_completed', 'verification_completed', 'feature_delivered'] as const
export type OutboundEventKind = (typeof OUTBOUND_EVENT_KINDS)[number]

export const OUTBOUND_TARGET_KINDS = ['jira', 'linear', 'github', 'slack'] as const
export type OutboundTargetKind = (typeof OUTBOUND_TARGET_KINDS)[number]

export const OUTBOUND_ACTIONS = ['comment', 'update_issue', 'create_issue', 'post_message'] as const
export type OutboundAction = (typeof OUTBOUND_ACTIONS)[number]

export interface OutboundSubscription {
  subscriptionId: string
  orgId: string
  projectId: string | null
  eventKind: OutboundEventKind
  targetKind: OutboundTargetKind
  action: OutboundAction
  targetConfig: Record<string, unknown>
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface OutboundDelivery {
  deliveryId: string
  subscriptionId: string
  orgId: string
  projectId: string | null
  eventKind: OutboundEventKind
  eventKey: string
  payload: Record<string, unknown>
  state: 'pending' | 'delivered' | 'failed' | 'skipped'
  attempts: number
  nextAttemptAt: string
  lastError: string | null
  externalRef: string | null
}

const SUB_COLS = `
  subscription_id AS "subscriptionId",
  org_id          AS "orgId",
  project_id      AS "projectId",
  event_kind      AS "eventKind",
  target_kind     AS "targetKind",
  action,
  target_config   AS "targetConfig",
  enabled,
  created_at      AS "createdAt",
  updated_at      AS "updatedAt"
`

const DELIVERY_COLS = `
  delivery_id     AS "deliveryId",
  subscription_id AS "subscriptionId",
  org_id          AS "orgId",
  project_id      AS "projectId",
  event_kind      AS "eventKind",
  event_key       AS "eventKey",
  payload_json    AS payload,
  state,
  attempts,
  next_attempt_at AS "nextAttemptAt",
  last_error      AS "lastError",
  external_ref    AS "externalRef"
`

export async function listSubscriptions(orgId: string, projectId?: string | null): Promise<OutboundSubscription[]> {
  const sql = getDb()
  if (projectId === undefined) {
    return await sql<OutboundSubscription[]>`SELECT ${sql.unsafe(SUB_COLS)} FROM outbound_subscriptions WHERE org_id = ${orgId} ORDER BY event_kind, target_kind`
  }
  return await sql<OutboundSubscription[]>`
    SELECT ${sql.unsafe(SUB_COLS)} FROM outbound_subscriptions
     WHERE org_id = ${orgId} AND (project_id IS NULL OR project_id = ${projectId})
     ORDER BY event_kind, target_kind
  `
}

export async function upsertSubscription(input: {
  orgId: string
  subscriptionId?: string
  projectId?: string | null
  eventKind: OutboundEventKind
  targetKind: OutboundTargetKind
  action: OutboundAction
  targetConfig?: Record<string, unknown>
  enabled?: boolean
  createdBy?: string | null
}): Promise<OutboundSubscription> {
  const sql = getDb()
  if (input.subscriptionId) {
    const [row] = await sql<OutboundSubscription[]>`
      UPDATE outbound_subscriptions SET
        project_id = ${input.projectId ?? null}, event_kind = ${input.eventKind}, target_kind = ${input.targetKind},
        action = ${input.action}, target_config = ${sql.json((input.targetConfig ?? {}) as never)}, enabled = ${input.enabled ?? true}, updated_at = now()
       WHERE org_id = ${input.orgId} AND subscription_id = ${input.subscriptionId}
       RETURNING ${sql.unsafe(SUB_COLS)}
    `
    if (row) return row
  }
  const [row] = await sql<OutboundSubscription[]>`
    INSERT INTO outbound_subscriptions (subscription_id, org_id, project_id, event_kind, target_kind, action, target_config, enabled, created_by)
    VALUES (${randomUUID()}, ${input.orgId}, ${input.projectId ?? null}, ${input.eventKind}, ${input.targetKind}, ${input.action},
            ${sql.json((input.targetConfig ?? {}) as never)}, ${input.enabled ?? true}, ${input.createdBy ?? null})
    RETURNING ${sql.unsafe(SUB_COLS)}
  `
  return row!
}

export async function deleteSubscription(orgId: string, subscriptionId: string): Promise<boolean> {
  const rows = await getDb()`DELETE FROM outbound_subscriptions WHERE org_id = ${orgId} AND subscription_id = ${subscriptionId} RETURNING subscription_id`
  return rows.length > 0
}

/**
 * Insert one delivery per matching enabled subscription, idempotent per
 * (subscription_id, event_key). Never throws to the caller and never writes run
 * state; a missing subscription creates no row.
 */
export async function emitOutboundEvent(input: {
  orgId: string
  projectId?: string | null
  eventKind: OutboundEventKind
  eventKey: string
  payload: Record<string, unknown>
}): Promise<number> {
  const sql = getDb()
  const subscriptions = await sql<Array<{ subscriptionId: string }>>`
    SELECT subscription_id AS "subscriptionId" FROM outbound_subscriptions
     WHERE org_id = ${input.orgId}
       AND event_kind = ${input.eventKind}
       AND enabled
       AND (project_id IS NULL OR project_id = ${input.projectId ?? null})
  `
  let inserted = 0
  for (const sub of subscriptions) {
    const rows = await sql`
      INSERT INTO outbound_deliveries (delivery_id, subscription_id, org_id, project_id, event_kind, event_key, payload_json)
      VALUES (${randomUUID()}, ${sub.subscriptionId}, ${input.orgId}, ${input.projectId ?? null}, ${input.eventKind}, ${input.eventKey}, ${sql.json(input.payload as never)})
      ON CONFLICT (subscription_id, event_key) DO NOTHING
      RETURNING delivery_id
    `
    inserted += rows.length
  }
  if (inserted > 0) outboundLog.info('outbound event queued', { eventKind: input.eventKind, eventKey: input.eventKey, deliveries: inserted })
  return inserted
}

/** Fire-and-forget variant used from run paths: a delivery can never affect the run. */
export function emitOutboundEventQuietly(input: {
  orgId: string
  projectId?: string | null
  eventKind: OutboundEventKind
  eventKey: string
  payload: Record<string, unknown>
}): void {
  void emitOutboundEvent(input).catch((error) => outboundLog.warn('outbound emit failed', { eventKind: input.eventKind, error: error instanceof Error ? error.message : String(error) }))
}

/** Due deliveries for the worker drain, oldest first. Exhausted rows have no due time. */
export async function dueOutboundDeliveries(limit = 20): Promise<OutboundDelivery[]> {
  return await getDb()<OutboundDelivery[]>`
    SELECT ${getDb().unsafe(DELIVERY_COLS)} FROM outbound_deliveries
     WHERE state IN ('pending','failed') AND next_attempt_at IS NOT NULL AND next_attempt_at <= now()
     ORDER BY next_attempt_at ASC
     LIMIT ${limit}
  `
}

export async function getSubscription(subscriptionId: string): Promise<OutboundSubscription | undefined> {
  const [row] = await getDb()<OutboundSubscription[]>`SELECT ${getDb().unsafe(SUB_COLS)} FROM outbound_subscriptions WHERE subscription_id = ${subscriptionId}`
  return row
}

export async function recordDeliveryAttempt(input: {
  deliveryId: string
  state: 'delivered' | 'failed' | 'skipped'
  externalRef?: string | null
  error?: string | null
  /**
   * The next due time. `undefined` keeps the existing one; `null` makes the row
   * terminal (exhausted) so the drain never selects it again.
   */
  nextAttemptAt?: Date | null
}): Promise<void> {
  const sql = getDb()
  const next = input.nextAttemptAt === undefined ? sql`next_attempt_at` : input.nextAttemptAt
  await sql`
    UPDATE outbound_deliveries SET
      state = ${input.state},
      attempts = attempts + 1,
      external_ref = COALESCE(${input.externalRef ?? null}, external_ref),
      last_error = ${input.error ?? null},
      next_attempt_at = ${next},
      updated_at = now()
     WHERE delivery_id = ${input.deliveryId}
  `
}

export async function listDeliveries(orgId: string, limit = 100): Promise<OutboundDelivery[]> {
  return await getDb()<OutboundDelivery[]>`
    SELECT ${getDb().unsafe(DELIVERY_COLS)} FROM outbound_deliveries WHERE org_id = ${orgId} ORDER BY created_at DESC LIMIT ${limit}
  `
}
