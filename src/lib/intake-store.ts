/**
 * Inbound work intake store (012-inbound-outbound-slack, US1/US2/US5).
 *
 * Organization-scoped Intake items arrive from Jira, Linear, Slack and Datadog,
 * deduplicated per (org_id, source, external_ref) and masked through the org
 * guardrails before they are stored. Triage changes state and priority with an
 * audit row per change; conversion starts the existing `specify` stage in the
 * chosen project and records a durable work link.
 *
 * Every query filters on `org_id` and re-checks ownership, so two tenants never
 * see or change each other's items.
 */

import { randomUUID } from 'node:crypto'
import { getDb } from './db'
import { loadGuardPolicy } from './guardrails-policy'
import { maskOutput, maskOutputDeep, type GuardPolicy } from './guardrails'
import { log } from './logger'
import { evaluateRouting, type RoutingSuggestion } from './intake-routing'
import { startSpecifyRun } from './run-start'
import {
  INTAKE_PRIORITIES,
  type ActorSurface,
  type IntakeItemInput,
  type IntakePriority,
  type IntakeSource,
  type IntakeState,
  type SourceUpdateState,
  type WorkKind,
} from './intake-types'

const storeLog = log.child({ mod: 'intake-store' })

export interface IntakeItem {
  intakeId: string
  orgId: string
  source: IntakeSource
  externalRef: string
  externalUrl: string | null
  sourceScope: string | null
  title: string
  summary: string | null
  requesterName: string | null
  requesterEmail: string | null
  priority: IntakePriority
  state: IntakeState
  suggestedProjectId: string | null
  suggestedTeamId: string | null
  suggestedPriority: IntakePriority | null
  matchedRuleId: string | null
  ruleOverridden: boolean
  repeatCount: number
  sourceAvailable: boolean
  firstSeenAt: string
  lastSeenAt: string | null
  mergedIntoId: string | null
  raw: Record<string, unknown>
  createdAt: string
  updatedAt: string
  suggestions?: RoutingSuggestion[]
}

export interface IntakeSourceRow {
  sourceId: string
  orgId: string
  kind: IntakeSource
  label: string
  scopeKey: string
  config: Record<string, unknown>
  enabled: boolean
  cursor: Record<string, unknown>
  syncIntervalMinutes: number
  lastSyncStartedAt: string | null
  lastSyncFinishedAt: string | null
  lastSyncStatus: 'running' | 'ok' | 'error' | null
  lastSyncError: string | null
  lastSyncStats: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface IntakeListFilters {
  state?: IntakeState
  source?: IntakeSource
  priority?: IntakePriority
  limit?: number
  cursor?: string
}

const ITEM_COLS = `
  intake_id            AS "intakeId",
  org_id               AS "orgId",
  source,
  external_ref         AS "externalRef",
  external_url         AS "externalUrl",
  source_scope         AS "sourceScope",
  title,
  summary,
  requester_name       AS "requesterName",
  requester_email      AS "requesterEmail",
  priority,
  state,
  suggested_project_id AS "suggestedProjectId",
  suggested_team_id    AS "suggestedTeamId",
  suggested_priority   AS "suggestedPriority",
  matched_rule_id      AS "matchedRuleId",
  rule_overridden      AS "ruleOverridden",
  repeat_count         AS "repeatCount",
  source_available     AS "sourceAvailable",
  first_seen_at        AS "firstSeenAt",
  last_seen_at         AS "lastSeenAt",
  merged_into_id       AS "mergedIntoId",
  raw_json             AS raw,
  created_at           AS "createdAt",
  updated_at           AS "updatedAt"
`

const SOURCE_COLS = `
  source_id             AS "sourceId",
  org_id                AS "orgId",
  kind,
  label,
  scope_key             AS "scopeKey",
  config_json           AS config,
  enabled,
  cursor_json           AS cursor,
  sync_interval_minutes AS "syncIntervalMinutes",
  last_sync_started_at  AS "lastSyncStartedAt",
  last_sync_finished_at AS "lastSyncFinishedAt",
  last_sync_status      AS "lastSyncStatus",
  last_sync_error       AS "lastSyncError",
  last_sync_stats       AS "lastSyncStats",
  created_at            AS "createdAt",
  updated_at            AS "updatedAt"
`

function normalizePriority(value: unknown): IntakePriority {
  return typeof value === 'string' && (INTAKE_PRIORITIES as readonly string[]).includes(value) ? (value as IntakePriority) : 'normal'
}

function maskFields(input: IntakeItemInput, policy: GuardPolicy): IntakeItemInput {
  return {
    ...input,
    title: maskOutput(input.title.trim(), policy),
    summary: input.summary ? maskOutput(String(input.summary).trim(), policy) : input.summary,
    requesterName: input.requesterName ? maskOutput(String(input.requesterName), policy) : input.requesterName,
    requesterEmail: input.requesterEmail ? maskOutput(String(input.requesterEmail), policy) : input.requesterEmail,
    externalRef: maskOutput(String(input.externalRef), policy),
    externalUrl: input.externalUrl ? maskOutput(String(input.externalUrl), policy) : input.externalUrl,
    raw: input.raw ? maskOutputDeep(input.raw, policy) : input.raw,
  }
}

async function recordTransition(input: {
  intakeId: string
  actorUserId?: string | null
  actorSurface?: ActorSurface
  action: string
  fromState?: string | null
  toState?: string | null
  reason?: string | null
  metadata?: Record<string, unknown>
}): Promise<void> {
  await getDb()`
    INSERT INTO intake_transitions (transition_id, intake_id, actor_user_id, actor_surface, action, from_state, to_state, reason, metadata_json)
    VALUES (${randomUUID()}, ${input.intakeId}, ${input.actorUserId ?? null}, ${input.actorSurface ?? 'system'}, ${input.action},
            ${input.fromState ?? null}, ${input.toState ?? null}, ${input.reason ?? null},
            ${getDb().json((input.metadata ?? {}) as never)})
  `
}

/**
 * Normalize and upsert one inbound item. A first arrival inserts, applies
 * routing suggestions and records `arrived`; a re-delivery updates the row,
 * bumps `repeat_count` and records `refreshed`. Never creates a duplicate.
 */
export async function upsertIntakeItem(input: IntakeItemInput): Promise<IntakeItem> {
  const sql = getDb()
  const policy = await loadGuardPolicy(input.orgId)
  const masked = maskFields(input, policy)
  const [row] = await sql<Array<IntakeItem & { inserted: boolean }>>`
    INSERT INTO intake_items
      (intake_id, org_id, source, external_ref, external_url, source_scope, title, summary,
       requester_name, requester_email, priority, raw_json)
    VALUES
      (${randomUUID()}, ${masked.orgId}, ${masked.source}, ${masked.externalRef}, ${masked.externalUrl ?? null},
       ${masked.sourceScope ?? null}, ${masked.title}, ${masked.summary ?? null},
       ${masked.requesterName ?? null}, ${masked.requesterEmail ?? null}, ${normalizePriority(masked.priority)},
       ${sql.json((masked.raw ?? {}) as never)})
    ON CONFLICT (org_id, source, external_ref) DO UPDATE SET
      title           = EXCLUDED.title,
      summary         = EXCLUDED.summary,
      external_url    = EXCLUDED.external_url,
      source_scope    = EXCLUDED.source_scope,
      requester_name  = EXCLUDED.requester_name,
      requester_email = EXCLUDED.requester_email,
      repeat_count    = intake_items.repeat_count + 1,
      last_seen_at    = now(),
      source_available = true,
      updated_at      = now()
    RETURNING ${sql.unsafe(ITEM_COLS)}, (xmax = 0) AS inserted
  `
  const inserted = row!.inserted
  const item = { ...row!, inserted: undefined } as unknown as IntakeItem
  delete (item as { inserted?: boolean }).inserted

  if (inserted) {
    // Routing pre-suggests on first arrival; a manual choice later overrides it.
    const suggestions = await evaluateRouting(input.orgId, item)
    const winner = suggestions[0]
    if (winner) {
      await sql`
        UPDATE intake_items SET
          suggested_project_id = COALESCE(suggested_project_id, ${winner.projectId}),
          suggested_team_id    = COALESCE(suggested_team_id, ${winner.teamId}),
          suggested_priority   = COALESCE(suggested_priority, ${winner.priority}),
          matched_rule_id      = ${winner.ruleId},
          updated_at           = now()
        WHERE intake_id = ${item.intakeId}
      `
      await recordTransition({ intakeId: item.intakeId, action: 'routed', toState: 'new', metadata: { ruleId: winner.ruleId, rule: winner.ruleLabel } })
    }
    await recordTransition({ intakeId: item.intakeId, action: 'arrived', toState: 'new' })
    storeLog.info('intake item arrived', { intakeId: item.intakeId, orgId: input.orgId, source: input.source })
  } else {
    await recordTransition({ intakeId: item.intakeId, action: 'refreshed', fromState: item.state, toState: item.state })
  }
  return item
}

export async function getIntakeItem(orgId: string, intakeId: string): Promise<IntakeItem | undefined> {
  const [row] = await getDb()<IntakeItem[]>`
    SELECT ${getDb().unsafe(ITEM_COLS)} FROM intake_items WHERE org_id = ${orgId} AND intake_id = ${intakeId}
  `
  return row
}

/** The active queue (or another state): priority rank then first arrival. */
export async function listIntake(orgId: string, filters: IntakeListFilters = {}): Promise<{ items: IntakeItem[]; nextCursor: string | null; sources: IntakeSourceRow[] }> {
  const sql = getDb()
  const state: IntakeState = filters.state ?? 'new'
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500)
  const offset = Math.max(Number.parseInt(filters.cursor ?? '0', 10) || 0, 0)
  const source = filters.source ?? null
  const priority = filters.priority ?? null
  const rows = await sql<IntakeItem[]>`
    SELECT ${sql.unsafe(ITEM_COLS)} FROM intake_items
     WHERE org_id = ${orgId}
       AND state = ${state}
       AND (${source}::text IS NULL OR source = ${source})
       AND (${priority}::text IS NULL OR priority = ${priority})
     ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
              first_seen_at ASC
     LIMIT ${limit + 1} OFFSET ${offset}
  `
  const hasMore = rows.length > limit
  const items = hasMore ? rows.slice(0, limit) : rows
  const sources = await listIntakeSources(orgId)
  return { items, nextCursor: hasMore ? String(offset + limit) : null, sources }
}

export async function setIntakePriority(input: {
  orgId: string
  intakeId: string
  priority: IntakePriority
  actorUserId?: string | null
  actorSurface?: ActorSurface
}): Promise<IntakeItem | undefined> {
  const sql = getDb()
  const existing = await getIntakeItem(input.orgId, input.intakeId)
  if (!existing) return undefined
  await sql`UPDATE intake_items SET priority = ${normalizePriority(input.priority)}, updated_at = now() WHERE org_id = ${input.orgId} AND intake_id = ${input.intakeId}`
  await recordTransition({
    intakeId: input.intakeId, actorUserId: input.actorUserId, actorSurface: input.actorSurface,
    action: 'priority_changed', fromState: existing.state, toState: existing.state,
    metadata: { from: existing.priority, to: input.priority },
  })
  return getIntakeItem(input.orgId, input.intakeId)
}

/** Record a manual routing override (priority or suggested project). */
export async function markRuleOverride(input: { orgId: string; intakeId: string; actorUserId?: string | null; actorSurface?: ActorSurface; projectId?: string | null; priority?: IntakePriority }): Promise<IntakeItem | undefined> {
  const sql = getDb()
  const existing = await getIntakeItem(input.orgId, input.intakeId)
  if (!existing) return undefined
  await sql`
    UPDATE intake_items SET
      rule_overridden      = true,
      suggested_project_id = COALESCE(${input.projectId ?? null}, suggested_project_id),
      priority             = COALESCE(${input.priority ?? null}, priority),
      updated_at           = now()
    WHERE org_id = ${input.orgId} AND intake_id = ${input.intakeId}
  `
  await recordTransition({ intakeId: input.intakeId, actorUserId: input.actorUserId, actorSurface: input.actorSurface, action: 'rule_override', fromState: existing.state, toState: existing.state, metadata: { projectId: input.projectId, priority: input.priority } })
  return getIntakeItem(input.orgId, input.intakeId)
}

export async function dismissIntakeItem(input: { orgId: string; intakeId: string; reason: string; actorUserId?: string | null; actorSurface?: ActorSurface }): Promise<IntakeItem | undefined> {
  const sql = getDb()
  const existing = await getIntakeItem(input.orgId, input.intakeId)
  if (!existing) return undefined
  await sql`UPDATE intake_items SET state = 'dismissed', updated_at = now() WHERE org_id = ${input.orgId} AND intake_id = ${input.intakeId}`
  await recordTransition({ intakeId: input.intakeId, actorUserId: input.actorUserId, actorSurface: input.actorSurface, action: 'dismissed', fromState: existing.state, toState: 'dismissed', reason: input.reason })
  return getIntakeItem(input.orgId, input.intakeId)
}

export async function restoreIntakeItem(input: { orgId: string; intakeId: string; actorUserId?: string | null; actorSurface?: ActorSurface }): Promise<IntakeItem | undefined> {
  const sql = getDb()
  const existing = await getIntakeItem(input.orgId, input.intakeId)
  if (!existing) return undefined
  await sql`UPDATE intake_items SET state = 'new', updated_at = now() WHERE org_id = ${input.orgId} AND intake_id = ${input.intakeId}`
  await recordTransition({ intakeId: input.intakeId, actorUserId: input.actorUserId, actorSurface: input.actorSurface, action: 'restored', fromState: existing.state, toState: 'new' })
  return getIntakeItem(input.orgId, input.intakeId)
}

/** Merge `intakeId` into `intoId`; the survivor keeps the original as merged_into_id. */
export async function mergeIntakeItems(input: { orgId: string; intakeId: string; intoId: string; reason?: string | null; actorUserId?: string | null; actorSurface?: ActorSurface }): Promise<IntakeItem | undefined> {
  if (input.intakeId === input.intoId) return undefined
  const sql = getDb()
  const [survivor, source] = await Promise.all([getIntakeItem(input.orgId, input.intoId), getIntakeItem(input.orgId, input.intakeId)])
  if (!survivor || !source) return undefined
  await sql.begin(async (tx) => {
    await tx`UPDATE intake_items SET state = 'merged', merged_into_id = ${input.intoId}, updated_at = now() WHERE org_id = ${input.orgId} AND intake_id = ${input.intakeId}`
    await tx`
      INSERT INTO intake_transitions (transition_id, intake_id, actor_user_id, actor_surface, action, from_state, to_state, reason, metadata_json)
      VALUES (${randomUUID()}, ${input.intakeId}, ${input.actorUserId ?? null}, ${input.actorSurface ?? 'app'}, 'merged', ${source.state}, 'merged', ${input.reason ?? null}, ${tx.json({ intoId: input.intoId } as never)})
    `
    await tx`
      INSERT INTO intake_transitions (transition_id, intake_id, actor_user_id, actor_surface, action, from_state, to_state, reason, metadata_json)
      VALUES (${randomUUID()}, ${input.intoId}, ${input.actorUserId ?? null}, ${input.actorSurface ?? 'app'}, 'merged_into', ${survivor.state}, ${survivor.state}, ${input.reason ?? null}, ${tx.json({ fromId: input.intakeId } as never)})
    `
  })
  return getIntakeItem(input.orgId, input.intoId)
}

export interface ConvertedLink {
  linkId: string
  intakeId: string
  projectId: string
  workKind: WorkKind
  runId: string | null
  intentId: string | null
  sourceUpdateState: SourceUpdateState
}

/**
 * Convert an item into project work: start the existing `specify` stage with the
 * chosen scope, record the work link and mark the item converted. The source
 * ticket update is a separate best-effort step (see markSourceUpdate) and never
 * rolls back the conversion.
 */
export async function convertIntakeItem(input: {
  orgId: string
  intakeId: string
  projectId: string
  workKind: WorkKind
  title?: string | null
  summary?: string | null
  actorUserId?: string | null
  actorSurface?: ActorSurface
}): Promise<{ item: IntakeItem; link: ConvertedLink } | { error: string; status: number }> {
  const sql = getDb()
  const item = await getIntakeItem(input.orgId, input.intakeId)
  if (!item) return { error: 'Intake item not found.', status: 404 }
  if (item.state === 'converted' || item.state === 'merged') return { error: `This item is already ${item.state}.`, status: 409 }

  const [project] = await sql<Array<{ projectId: string; teamId: string | null; name: string; slug: string }>>`
    SELECT project_id AS "projectId", team_id AS "teamId", name, slug FROM projects
     WHERE project_id = ${input.projectId} AND archived_at IS NULL
  `
  if (!project) return { error: 'The chosen project does not exist in this organization.', status: 400 }
  // The project must belong to the caller's org through its team.
  if (project.teamId) {
    const [team] = await sql<Array<{ orgId: string }>>`SELECT org_id AS "orgId" FROM teams WHERE team_id = ${project.teamId}`
    if (team && team.orgId !== input.orgId) return { error: 'The chosen project does not belong to this organization.', status: 400 }
  }

  const feature = (input.title?.trim() || item.title).slice(0, 200)
  const scope = input.workKind === 'bugfix' ? 'bugfix' : 'feature'
  const description = input.summary?.trim() || item.summary || ''
  // Cite the source item so the specify stage can trace the work back (US2 #1).
  const sourceRef = `${item.source}:${item.externalRef}${item.externalUrl ? ` (${item.externalUrl})` : ''}`
  const featureText = [feature, description, `Source: ${sourceRef}`].filter(Boolean).join('\n\n')

  // Claim the item before starting work: two conversions at once (a double
  // click, Slack and the app) would otherwise both start a run, and the second
  // would then fail on the one-link-per-item constraint.
  const [claimed] = await sql`
    UPDATE intake_items SET state = 'converted', updated_at = now()
     WHERE org_id = ${input.orgId} AND intake_id = ${input.intakeId} AND state NOT IN ('converted', 'merged')
    RETURNING intake_id
  `
  if (!claimed) return { error: 'This item is already converted.', status: 409 }

  const linkId = randomUUID()
  // The run insert, the work link, the item's transition and the job all commit
  // together: a partial conversion cannot leave a running run while the item is
  // still `new` and unlinked (FR-006/FR-007).
  let started: Awaited<ReturnType<typeof startSpecifyRun>>
  try {
    started = await startSpecifyRun({
      projectId: project.projectId,
      projectSlug: project.slug,
      feature: featureText,
      scope,
      actorName: input.actorUserId ? undefined : 'intake',
      onCreate: async (tx, runId) => {
        // A restored item that is converted again replaces its earlier link.
        await tx`
          INSERT INTO intake_work_links (link_id, intake_id, project_id, work_kind, run_id, source_update_state, created_by)
          VALUES (${linkId}, ${input.intakeId}, ${input.projectId}, ${input.workKind}, ${runId}, 'pending', ${input.actorUserId ?? null})
          ON CONFLICT (intake_id) DO UPDATE SET
            link_id = EXCLUDED.link_id, project_id = EXCLUDED.project_id, work_kind = EXCLUDED.work_kind, run_id = EXCLUDED.run_id,
            intent_id = NULL, source_update_state = 'pending', source_update_error = NULL, source_update_attempted_at = NULL,
            created_by = EXCLUDED.created_by, created_at = now()
        `
        await tx`
          INSERT INTO intake_transitions (transition_id, intake_id, actor_user_id, actor_surface, action, from_state, to_state, metadata_json)
          VALUES (${randomUUID()}, ${input.intakeId}, ${input.actorUserId ?? null}, ${input.actorSurface ?? 'app'}, 'converted', ${item.state}, 'converted',
                  ${tx.json({ projectId: input.projectId, workKind: input.workKind, runId } as never)})
        `
      },
    })
  } catch (error) {
    await sql`UPDATE intake_items SET state = ${item.state}, updated_at = now() WHERE org_id = ${input.orgId} AND intake_id = ${input.intakeId} AND state = 'converted'`
    // Only the one-link-per-item constraint means "already converted"; any
    // other unique violation is a genuine failure and must surface as a 500.
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('intake_work_links_intake_id_key')) return { error: 'This item is already converted.', status: 409 }
    // Keep the DB detail in the log; never surface it to the caller.
    storeLog.error('intake conversion failed', { intakeId: input.intakeId, error: message })
    return { error: 'The conversion failed. Try again.', status: 500 }
  }
  if (!started.ok) {
    await sql`UPDATE intake_items SET state = ${item.state}, updated_at = now() WHERE org_id = ${input.orgId} AND intake_id = ${input.intakeId} AND state = 'converted'`
    return { error: started.error, status: started.status }
  }

  const updated = await getIntakeItem(input.orgId, input.intakeId)
  return {
    item: updated!,
    link: { linkId, intakeId: input.intakeId, projectId: input.projectId, workKind: input.workKind, runId: started.runId, intentId: null, sourceUpdateState: 'pending' },
  }
}

/** Record the best-effort source-ticket update outcome for a converted item. */
export async function markSourceUpdate(input: { intakeId: string; state: SourceUpdateState; error?: string | null }): Promise<void> {
  await getDb()`
    UPDATE intake_work_links SET
      source_update_state       = ${input.state},
      source_update_error       = ${input.error ?? null},
      source_update_attempted_at = now()
    WHERE intake_id = ${input.intakeId}
  `
}

/** Fill the intent id once the started run's intent directory is synced. */
export async function linkIntentToWork(runId: string, intentId: string): Promise<void> {
  await getDb()`
    UPDATE intake_work_links SET intent_id = ${intentId} WHERE run_id = ${runId} AND (intent_id IS NULL OR intent_id <> ${intentId})
  `
}

/**
 * When a newly synced intent directory belongs to a converted intake item,
 * attach it to that item's pending work link. Scoped to a link whose run is
 * still in flight, and only when exactly one such link exists, so two
 * conversions can never bind an intent to the wrong item. Scoped to a
 * project; a conversion from a run that has already ended keeps its link
 * unattached rather than risk the wrong one.
 */
export async function attachIntentToPendingWorkLink(projectId: string, intentId: string): Promise<void> {
  const rows = await getDb()<Array<{ runId: string | null }>>`
    SELECT wl.run_id AS "runId" FROM intake_work_links wl
      JOIN pipeline_runs r ON r.run_id = wl.run_id
     WHERE wl.project_id = ${projectId} AND wl.intent_id IS NULL AND wl.run_id IS NOT NULL
       AND r.status IN ('queued','running','paused')
     ORDER BY wl.created_at DESC LIMIT 2
  `
  if (rows.length === 1 && rows[0]?.runId) await linkIntentToWork(rows[0].runId, intentId)
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export async function listIntakeSources(orgId: string): Promise<IntakeSourceRow[]> {
  return await getDb()<IntakeSourceRow[]>`
    SELECT ${getDb().unsafe(SOURCE_COLS)} FROM intake_sources WHERE org_id = ${orgId} ORDER BY kind, label
  `
}

export async function getIntakeSource(orgId: string, sourceId: string): Promise<IntakeSourceRow | undefined> {
  const [row] = await getDb()<IntakeSourceRow[]>`SELECT ${getDb().unsafe(SOURCE_COLS)} FROM intake_sources WHERE org_id = ${orgId} AND source_id = ${sourceId}`
  return row
}

export async function upsertIntakeSource(input: {
  orgId: string
  kind: IntakeSource
  label: string
  scopeKey: string
  config?: Record<string, unknown>
  enabled?: boolean
  syncIntervalMinutes?: number
}): Promise<IntakeSourceRow> {
  const sql = getDb()
  const [row] = await sql<IntakeSourceRow[]>`
    INSERT INTO intake_sources (source_id, org_id, kind, label, scope_key, config_json, enabled, sync_interval_minutes)
    VALUES (${randomUUID()}, ${input.orgId}, ${input.kind}, ${input.label}, ${input.scopeKey},
            ${sql.json((input.config ?? {}) as never)}, ${input.enabled ?? true}, ${input.syncIntervalMinutes ?? 2})
    ON CONFLICT (org_id, kind, scope_key) DO UPDATE SET
      label                = EXCLUDED.label,
      config_json          = EXCLUDED.config_json,
      enabled              = EXCLUDED.enabled,
      sync_interval_minutes = EXCLUDED.sync_interval_minutes,
      updated_at           = now()
    RETURNING ${sql.unsafe(SOURCE_COLS)}
  `
  return row!
}

export async function deleteIntakeSource(orgId: string, sourceId: string): Promise<boolean> {
  const rows = await getDb()`DELETE FROM intake_sources WHERE org_id = ${orgId} AND source_id = ${sourceId} RETURNING source_id`
  return rows.length > 0
}

/** Sources that are enabled and whose last sync is older than their interval. */
export async function dueIntakeSources(limit = 20): Promise<IntakeSourceRow[]> {
  const rows = await getDb()<IntakeSourceRow[]>`
    SELECT ${getDb().unsafe(SOURCE_COLS)} FROM intake_sources s
     WHERE s.enabled
       AND (s.last_sync_finished_at IS NULL
            OR s.last_sync_finished_at < now() - make_interval(mins => s.sync_interval_minutes))
     ORDER BY s.last_sync_finished_at ASC NULLS FIRST
     LIMIT ${limit}
  `
  return rows
}

export async function markSourceSyncStarted(sourceId: string, orgId: string): Promise<void> {
  await getDb()`
    UPDATE intake_sources SET last_sync_status = 'running', last_sync_started_at = now(), last_sync_error = NULL, updated_at = now()
     WHERE source_id = ${sourceId} AND org_id = ${orgId}
  `
}

export async function markSourceSyncFinished(input: {
  sourceId: string
  orgId: string
  status: 'ok' | 'error'
  error?: string | null
  cursor?: Record<string, unknown>
  stats?: Record<string, unknown>
}): Promise<void> {
  const sql = getDb()
  await sql`
    UPDATE intake_sources SET
      last_sync_status      = ${input.status},
      last_sync_finished_at = now(),
      last_sync_error       = ${input.error ?? null},
      cursor_json           = COALESCE(${input.cursor ? sql.json(input.cursor as never) : null}, cursor_json),
      last_sync_stats       = ${sql.json((input.stats ?? {}) as never)},
      updated_at            = now()
     WHERE source_id = ${input.sourceId} AND org_id = ${input.orgId}
  `
}

export async function recordSourceHealth(orgId: string, sourceId: string, status: 'ok' | 'error' | 'running', error?: string | null): Promise<void> {
  await getDb()`
    UPDATE intake_sources SET last_sync_status = ${status}, last_sync_error = ${error ?? null}, last_sync_finished_at = CASE WHEN ${status} = 'running' THEN last_sync_finished_at ELSE now() END, updated_at = now()
     WHERE source_id = ${sourceId} AND org_id = ${orgId}
  `
}
