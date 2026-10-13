import { afterAll, describe, expect, test } from 'bun:test'
import { conditionCount, matchRule, rankRules, replaceRoutingRules, selectRouting, type RoutingRule } from '../src/lib/intake-routing'
import { getIntakeItem, upsertIntakeItem } from '../src/lib/intake-store'
import { getDb } from '../src/lib/db'
import { createApprovalFixture } from './helpers/approval-fixture'

/**
 * Routing rule matching and precedence (US5: FR-022). Pure logic, no database.
 */
function rule(overrides: Partial<RoutingRule> = {}): RoutingRule {
  return {
    ruleId: overrides.ruleId ?? crypto.randomUUID(),
    orgId: 'org-1',
    label: overrides.label ?? 'rule',
    enabled: overrides.enabled ?? true,
    priorityOrder: overrides.priorityOrder ?? 0,
    match: overrides.match ?? {},
    targetProjectId: overrides.targetProjectId ?? null,
    targetTeamId: overrides.targetTeamId ?? null,
    targetPriority: overrides.targetPriority ?? null,
    createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
  }
}

const item = { source: 'datadog' as const, sourceScope: 'web', priority: 'high' as const, title: 'CPU high on web-1', summary: 'CPU > 90%', labels: ['perf', 'prod'] }

describe('match conditions', () => {
  test('all configured conditions must match', () => {
    expect(matchRule(rule({ match: { source: ['datadog'] } }), item)).toBe(true)
    expect(matchRule(rule({ match: { source: ['jira'] } }), item)).toBe(false)
    expect(matchRule(rule({ match: { scope: ['web'] } }), item)).toBe(true)
    expect(matchRule(rule({ match: { labels: ['prod'] } }), item)).toBe(true)
    expect(matchRule(rule({ match: { keywords: ['cpu'] } }), item)).toBe(true)
    expect(matchRule(rule({ match: { source: ['datadog'], labels: ['nope'] } }), item)).toBe(false)
  })

  test('severity floor is inclusive', () => {
    expect(matchRule(rule({ match: { severityMin: 'normal' } }), item)).toBe(true)
    expect(matchRule(rule({ match: { severityMin: 'high' } }), item)).toBe(true)
    expect(matchRule(rule({ match: { severityMin: 'urgent' } }), item)).toBe(false)
  })

  test('a disabled rule is never evaluated and a rule with no conditions never matches', () => {
    const disabled = rule({ enabled: false, match: { source: ['datadog'] } })
    expect(rankRules([disabled], item)).toHaveLength(0)
    expect(matchRule(rule({ match: {} }), item)).toBe(false)
  })
})

describe('precedence', () => {
  test('higher priority order wins, then more specific, then oldest', () => {
    const general = rule({ label: 'general', priorityOrder: 1, match: { source: ['datadog'] }, createdAt: '2026-01-01T00:00:00.000Z' })
    const specific = rule({ label: 'specific', priorityOrder: 1, match: { source: ['datadog'], scope: ['web'] }, createdAt: '2026-02-01T00:00:00.000Z' })
    const top = rule({ label: 'top', priorityOrder: 5, match: { source: ['datadog'] }, createdAt: '2026-03-01T00:00:00.000Z' })
    const ranked = rankRules([general, specific, top], item)
    expect(ranked.map((r) => r.label)).toEqual(['top', 'specific', 'general'])
  })

  test('the winner supplies the suggestion and the rest are lower suggestions', () => {
    const winner = rule({ label: 'winner', priorityOrder: 9, match: { source: ['datadog'] }, targetProjectId: 'p1', targetPriority: 'urgent' })
    const loser = rule({ label: 'loser', priorityOrder: 1, match: { source: ['datadog'] }, targetProjectId: 'p2' })
    const suggestions = selectRouting([loser, winner], item)
    expect(suggestions).toHaveLength(2)
    expect(suggestions[0]).toMatchObject({ ruleId: winner.ruleId, ruleLabel: 'winner', projectId: 'p1', priority: 'urgent' })
    expect(suggestions[1]!.ruleLabel).toBe('loser')
  })

  test('condition count measures specificity', () => {
    expect(conditionCount({ source: ['datadog'], scope: ['web'] })).toBe(2)
    expect(conditionCount({})).toBe(0)
  })
})

const fixture = await createApprovalFixture({ withServer: false })
afterAll(async () => { await fixture.stop() })

describe('routing applied on arrival', () => {
  test('a matching rule pre-suggests priority/project and names the rule', async () => {
    await replaceRoutingRules(fixture.orgA, [{ label: 'Ops alerts', match: { source: ['datadog'] }, targetPriority: 'urgent', targetProjectId: fixture.projectA.projectId }])
    const item = await upsertIntakeItem({ orgId: fixture.orgA, source: 'datadog', externalRef: `alert-${crypto.randomUUID().slice(0, 8)}`, title: 'CPU high' } as never)
    try {
      const reloaded = await getIntakeItem(fixture.orgA, item.intakeId)
      expect(reloaded?.suggestedPriority).toBe('urgent')
      expect(reloaded?.suggestedProjectId).toBe(fixture.projectA.projectId)
      expect(reloaded?.matchedRuleId).toBeTruthy()
      const [routed] = await getDb()<Array<{ n: number }>>`SELECT count(*)::int AS n FROM intake_transitions WHERE intake_id = ${item.intakeId} AND action = 'routed'`
      expect(routed?.n).toBe(1)
    } finally {
      await getDb()`DELETE FROM intake_items WHERE intake_id = ${item.intakeId}`
      await getDb()`DELETE FROM intake_routing_rules WHERE org_id = ${fixture.orgA}`
    }
  })
})
