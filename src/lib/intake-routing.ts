/**
 * Intake routing rules (012-inbound-outbound-slack, US5).
 *
 * Enabled rules are matched against an inbound item. A rule matches when every
 * condition it configures matches; the winning rule supplies the pre-suggested
 * project, team and priority. Precedence is explicit and deterministic:
 * higher `priority_order`, then the rule with more configured conditions (more
 * specific wins), then the oldest rule. Losers are kept as lower suggestions.
 *
 * Routing only *suggests*. A person's triage choice always wins and sets
 * `rule_overridden`, recorded as a transition.
 */

import { randomUUID } from 'node:crypto'
import { getDb } from './db'
import type { IntakePriority, IntakeSource } from './intake-types'

export interface RoutingMatch {
  source?: IntakeSource[]
  scope?: string[]
  labels?: string[]
  /** Minimum priority the item must have (inclusive). */
  severityMin?: IntakePriority
  keywords?: string[]
}

export interface RoutingRule {
  ruleId: string
  orgId: string
  label: string
  enabled: boolean
  priorityOrder: number
  match: RoutingMatch
  targetProjectId: string | null
  targetTeamId: string | null
  targetPriority: IntakePriority | null
  createdAt: string
}

export interface RoutingItemLike {
  source: IntakeSource
  sourceScope?: string | null
  priority: IntakePriority
  title: string
  summary?: string | null
  labels?: string[]
}

export interface RoutingSuggestion {
  projectId: string | null
  teamId: string | null
  priority: IntakePriority | null
  ruleId: string
  ruleLabel: string
}

const PRIORITY_RANK: Record<IntakePriority, number> = { urgent: 4, high: 3, normal: 2, low: 1 }

export function priorityRank(priority: IntakePriority): number {
  return PRIORITY_RANK[priority] ?? 0
}

/** How many conditions a rule configures — the specificity tiebreak. */
export function conditionCount(match: RoutingMatch): number {
  let n = 0
  if (match.source?.length) n += 1
  if (match.scope?.length) n += 1
  if (match.labels?.length) n += 1
  if (match.severityMin) n += 1
  if (match.keywords?.length) n += 1
  return n
}

/** All configured conditions must match. A rule with no conditions matches nothing. */
export function matchRule(rule: RoutingRule, item: RoutingItemLike): boolean {
  const match = rule.match ?? {}
  if (conditionCount(match) === 0) return false
  if (match.source?.length && !match.source.includes(item.source)) return false
  if (match.scope?.length) {
    const scope = item.sourceScope ?? ''
    if (!match.scope.some((s) => scope.toLowerCase() === s.toLowerCase())) return false
  }
  if (match.labels?.length) {
    const labels = (item.labels ?? []).map((l) => l.toLowerCase())
    if (!match.labels.some((l) => labels.includes(l.toLowerCase()))) return false
  }
  if (match.severityMin && priorityRank(item.priority) < priorityRank(match.severityMin)) return false
  if (match.keywords?.length) {
    const haystack = `${item.title} ${item.summary ?? ''}`.toLowerCase()
    if (!match.keywords.some((k) => haystack.includes(k.toLowerCase()))) return false
  }
  return true
}

/** Matching rules in precedence order: priorityOrder desc, specificity desc, createdAt asc. */
export function rankRules(rules: RoutingRule[], item: RoutingItemLike): RoutingRule[] {
  return rules
    .filter((rule) => rule.enabled && matchRule(rule, item))
    .sort((a, b) => {
      if (b.priorityOrder !== a.priorityOrder) return b.priorityOrder - a.priorityOrder
      const specificity = conditionCount(b.match ?? {}) - conditionCount(a.match ?? {})
      if (specificity !== 0) return specificity
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    })
}

/** Winner first, then the remaining matching rules as lower suggestions. */
export function selectRouting(rules: RoutingRule[], item: RoutingItemLike): RoutingSuggestion[] {
  return rankRules(rules, item).map((rule) => ({
    projectId: rule.targetProjectId,
    teamId: rule.targetTeamId,
    priority: rule.targetPriority,
    ruleId: rule.ruleId,
    ruleLabel: rule.label,
  }))
}

export async function listRoutingRules(orgId: string): Promise<RoutingRule[]> {
  const rows = await getDb()<Array<{
    ruleId: string; orgId: string; label: string; enabled: boolean; priorityOrder: number
    match: RoutingMatch; targetProjectId: string | null; targetTeamId: string | null
    targetPriority: IntakePriority | null; createdAt: string
  }>>`
    SELECT rule_id AS "ruleId", org_id AS "orgId", label, enabled, priority_order AS "priorityOrder",
           match_json AS match,
           target_project_id AS "targetProjectId", target_team_id AS "targetTeamId",
           target_priority AS "targetPriority", created_at AS "createdAt"
      FROM intake_routing_rules
     WHERE org_id = ${orgId}
     ORDER BY priority_order DESC, created_at ASC
  `
  return rows
}

/** Evaluate the org's enabled rules for an item. Empty when nothing matches. */
export async function evaluateRouting(orgId: string, item: RoutingItemLike): Promise<RoutingSuggestion[]> {
  const rules = await listRoutingRules(orgId)
  return selectRouting(rules, item)
}

export interface RoutingRuleInput {
  ruleId?: string
  label: string
  enabled?: boolean
  priorityOrder?: number
  match: RoutingMatch
  targetProjectId?: string | null
  targetTeamId?: string | null
  targetPriority?: IntakePriority | null
}

/** Replace an org's routing rules with the given set (create/update, never cross-org). */
export async function replaceRoutingRules(orgId: string, rules: RoutingRuleInput[], actorUserId?: string | null): Promise<RoutingRule[]> {
  const sql = getDb()
  await sql.begin(async (tx) => {
    await tx`DELETE FROM intake_routing_rules WHERE org_id = ${orgId}`
    for (const rule of rules) {
      await tx`
        INSERT INTO intake_routing_rules (rule_id, org_id, label, enabled, priority_order, match_json, target_project_id, target_team_id, target_priority, created_by)
        VALUES (${rule.ruleId ?? randomUUID()}, ${orgId}, ${rule.label}, ${rule.enabled ?? true}, ${rule.priorityOrder ?? 0},
                ${tx.json((rule.match ?? {}) as never)}, ${rule.targetProjectId ?? null}, ${rule.targetTeamId ?? null}, ${rule.targetPriority ?? null}, ${actorUserId ?? null})
      `
    }
  })
  return listRoutingRules(orgId)
}
