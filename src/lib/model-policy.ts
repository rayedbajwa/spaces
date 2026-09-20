/**
 * Automatic model routing per provider, driven by cost and speed.
 *
 * Spaces does not name models. For the provider in use it scores the catalog
 * (price, generation, size class, reasoning) and fills three tiers:
 *
 *   small   — cheap and fast: review, chat, fast mode
 *   medium  — the everyday model: planning and implementation
 *   large   — the most capable one: quality mode, retry escalation
 *
 * The organization policy (stored in org_memory.model_policy_json, edited on
 * the Organization page) shifts the choice towards cost or quality, orders the
 * providers, allows or forbids premium ("pro") models, and can pin a tier
 * explicitly. With OpenRouter every tier is `openrouter/openrouter/auto`:
 * OpenRouter routes, we do not.
 */

import { getDb } from './db'
import { type ProviderId } from './default-model'
import { configuredProvidersFor } from './provider-keys'
import { log } from './logger'
import { loadModelCatalog, type CatalogModel } from './model-catalog'

const policyLog = log.child({ mod: 'model-policy' })

export type ModelTier = 'small' | 'medium' | 'large'
export type Preference = 'cost' | 'balanced' | 'quality'

export interface ModelPolicy {
  /** Lean towards the cheapest viable models, a balance, or the most capable ones. */
  preference: Preference
  /** Providers to route through, first configured one wins. */
  providerOrder: ProviderId[]
  /** Let the large tier pick premium models (e.g. "pro" variants: slow and several times the price). */
  allowPremium: boolean
  /** Explicit `provider/model` per tier; empty = automatic. */
  overrides: Partial<Record<ModelTier, string>>
}

export const DEFAULT_POLICY: ModelPolicy = {
  preference: 'balanced',
  providerOrder: ['anthropic', 'openrouter', 'openai'],
  allowPremium: false,
  overrides: {},
}

export interface TierModels { small: string; medium: string; large: string }

export interface ScoredModel extends CatalogModel {
  /** 0 (cheapest candidate) … 1 (most expensive), log scale. */
  costScore: number
  /** 0 … 1 capability proxy: price rank nudged by size class and reasoning. */
  qualityScore: number
  /** 0 … 1: the inverse of quality (cheaper, smaller models answer faster). */
  speedScore: number
  premium: boolean
  role?: ModelTier
}

export interface TierRouting {
  provider: ProviderId | null
  tiers: TierModels
  /** How each tier was chosen, for the UI and logs. */
  reasons: Record<ModelTier, string>
  candidates: ScoredModel[]
  policy: ModelPolicy
  configuredProviders: ProviderId[]
}

export const OPENROUTER_AUTO = 'openrouter/openrouter/auto'

// ---------------------------------------------------------------------------
// Policy storage
// ---------------------------------------------------------------------------

export async function getModelPolicy(orgId: string): Promise<ModelPolicy> {
  const [row] = await getDb()<Array<{ policy: Partial<ModelPolicy> | null }>>`SELECT model_policy_json AS policy FROM org_memory WHERE org_id = ${orgId}`.catch(() => [])
  return normalizePolicy(row?.policy ?? {})
}

export async function updateModelPolicy(orgId: string, patch: Partial<ModelPolicy>): Promise<ModelPolicy> {
  const current = await getModelPolicy(orgId)
  const next = normalizePolicy({ ...current, ...patch, overrides: { ...(patch.overrides ?? current.overrides) } })
  const sql = getDb()
  await sql`
    INSERT INTO org_memory (org_id, model_policy_json) VALUES (${orgId}, ${sql.json(next as never)})
    ON CONFLICT (org_id) DO UPDATE SET model_policy_json = EXCLUDED.model_policy_json, updated_at = now()
  `
  invalidateTierModels(orgId)
  return next
}

export function normalizePolicy(raw: Partial<ModelPolicy>): ModelPolicy {
  const providers: ProviderId[] = ['anthropic', 'openrouter', 'openai']
  const order = (raw.providerOrder ?? []).filter((p): p is ProviderId => providers.includes(p))
  for (const p of DEFAULT_POLICY.providerOrder) if (!order.includes(p)) order.push(p)
  const overrides: Partial<Record<ModelTier, string>> = {}
  for (const tier of ['small', 'medium', 'large'] as ModelTier[]) {
    const v = raw.overrides?.[tier]?.trim()
    if (v) overrides[tier] = v
  }
  return {
    preference: raw.preference === 'cost' || raw.preference === 'quality' ? raw.preference : 'balanced',
    providerOrder: order,
    allowPremium: Boolean(raw.allowPremium),
    overrides,
  }
}

// ---------------------------------------------------------------------------
// Scoring (pure)
// ---------------------------------------------------------------------------

/** Rank a provider's candidates and pick a model per tier under the policy. */
export function computeTierRouting(catalog: CatalogModel[], policy: ModelPolicy, configured: ProviderId[]): TierRouting {
  const provider = policy.providerOrder.find((p) => configured.includes(p)) ?? configured[0] ?? null
  const reasons: Record<ModelTier, string> = { small: '', medium: '', large: '' }
  if (!provider) {
    return { provider: null, tiers: { small: '', medium: '', large: '' }, reasons: { small: 'no provider key', medium: 'no provider key', large: 'no provider key' }, candidates: [], policy, configuredProviders: configured }
  }

  // OpenRouter routes itself; we hand it every request and stay out of the way.
  if (provider === 'openrouter') {
    const tiers = applyOverrides({ small: OPENROUTER_AUTO, medium: OPENROUTER_AUTO, large: OPENROUTER_AUTO }, policy, reasons)
    for (const t of ['small', 'medium', 'large'] as ModelTier[]) if (!reasons[t]) reasons[t] = 'OpenRouter picks the model per request'
    return { provider, tiers, reasons, candidates: [], policy, configuredProviders: configured }
  }

  const all = catalog.filter((m) => m.provider === provider && !m.excluded && m.blendedCost > 0)
  const scored = scoreModels(all)
  const byCost = (list: ScoredModel[]) => [...list].sort((a, b) => a.blendedCost - b.blendedCost || b.generation - a.generation)
  const cheapest = (list: ScoredModel[]) => byCost(list)[0]
  // Most expensive; among equals the newest generation wins.
  const priciest = (list: ScoredModel[]) => [...list].sort((a, b) => b.blendedCost - a.blendedCost || b.generation - a.generation)[0]
  const major = (m: ScoredModel) => Math.floor(m.generation)
  // Newest major generation (5.x, 6.x …) that has at least one model of the class.
  const newestMajor = (list: ScoredModel[]) => {
    const majors = [...new Set(list.map(major))].sort((a, b) => b - a)
    for (const g of majors) { const hit = list.filter((m) => major(m) === g); if (hit.length) return hit }
    return list
  }
  // Within a major, prefer the newest minor line that has the class (5.6 over 5.4).
  const newestMinor = (list: ScoredModel[]) => {
    const top = Math.max(...list.map((m) => m.generation))
    const hit = list.filter((m) => m.generation >= top - 0.05)
    return hit.length ? hit : list
  }

  // Size classes. Small also covers unnamed models priced far below the line's median.
  const regular = scored.filter((m) => !m.premium)
  const medianCost = byCost(regular)[Math.floor(regular.length / 2)]?.blendedCost ?? 0
  const smalls = regular.filter((m) => m.sizeHint === 'small' || (medianCost > 0 && m.blendedCost < 0.25 * medianCost))
  const bases = regular.filter((m) => m.sizeHint === undefined && !smalls.includes(m))
  const premiums = scored.filter((m) => m.premium)

  let small: ScoredModel | undefined
  let medium: ScoredModel | undefined
  let large: ScoredModel | undefined
  if (regular.length) {
    small = policy.preference === 'cost'
      ? cheapest(smalls) ?? cheapest(regular)
      : policy.preference === 'quality'
        ? cheapest(newestMinor(newestMajor(bases))) ?? cheapest(regular)
        : cheapest(newestMinor(newestMajor(smalls))) ?? cheapest(regular)
    medium = policy.preference === 'cost'
      ? cheapest(bases) ?? cheapest(regular.filter((m) => m !== small)) ?? small
      : policy.preference === 'quality'
        ? priciest(newestMajor(regular))
        : cheapest(newestMinor(newestMajor(bases))) ?? priciest(newestMajor(regular))
    large = policy.preference === 'cost'
      ? medium
      : policy.allowPremium && premiums.length
        ? priciest(newestMajor(premiums))
        : priciest(newestMajor(regular))
    // Tiers never go down in price: a "large" cheaper than "medium" means the line is thin.
    if (medium && small && medium.blendedCost < small.blendedCost) medium = small
    if (large && medium && large.blendedCost < medium.blendedCost) large = medium
  }
  for (const m of scored) m.role = undefined
  if (small) small.role = 'small'
  if (medium && !medium.role) medium.role = 'medium'
  if (large && !large.role) large.role = 'large'

  const describe = (m: ScoredModel | undefined, why: string) => (m ? `${why}: ${m.name} at $${m.inputCost}/M in, $${m.outputCost}/M out` : 'no candidate')
  reasons.small = describe(small, policy.preference === 'cost' ? 'cheapest small model' : policy.preference === 'quality' ? 'cheapest base model of the newest line' : 'cheapest small model of the newest line')
  reasons.medium = describe(medium, policy.preference === 'cost' ? 'cheapest base model' : policy.preference === 'quality' ? 'most capable non-premium model of the newest generation' : 'base model of the newest line')
  reasons.large = describe(large, large?.premium ? 'premium model of the newest generation (allowed by policy)' : policy.preference === 'cost' ? 'same as medium (cost preference)' : 'most capable non-premium model of the newest generation')

  const tiers = applyOverrides({ small: small?.spec ?? '', medium: medium?.spec ?? '', large: large?.spec ?? '' }, policy, reasons)
  return { provider, tiers, reasons, candidates: byCost(scored), policy, configuredProviders: configured }
}

function applyOverrides(tiers: TierModels, policy: ModelPolicy, reasons: Record<ModelTier, string>): TierModels {
  const out = { ...tiers }
  for (const tier of ['small', 'medium', 'large'] as ModelTier[]) {
    const pin = policy.overrides[tier]
    if (pin) { out[tier] = pin; reasons[tier] = `pinned in the organization policy` }
  }
  return out
}

function scoreModels(models: CatalogModel[]): ScoredModel[] {
  const costs = models.map((m) => Math.log(Math.max(m.blendedCost, 0.01)))
  const min = Math.min(...costs)
  const max = Math.max(...costs)
  const span = max - min || 1
  const median = models.map((m) => m.blendedCost).sort((a, b) => a - b)[Math.floor(models.length / 2)] ?? 0
  return models.map((m, i) => {
    const costScore = (costs[i]! - min) / span
    let quality = costScore
    if (m.sizeHint === 'small') quality -= 0.15
    if (m.sizeHint === 'large') quality += 0.15
    if (m.reasoning) quality += 0.05
    quality = Math.max(0, Math.min(1, quality))
    // Premium: a "pro"-style variant, or priced several times above the median.
    const premium = /(^|-)pro($|-)|ultra/i.test(m.id) || (median > 0 && m.blendedCost >= 4 * median)
    return { ...m, costScore, qualityScore: quality, speedScore: 1 - quality, premium }
  })
}

// ---------------------------------------------------------------------------
// Resolution + cache
// ---------------------------------------------------------------------------

const routingCache = new Map<string, { at: number; value: TierRouting }>()
const CACHE_MS = 5 * 60_000

export function invalidateTierModels(orgId?: string): void {
  if (orgId) routingCache.delete(orgId)
  else routingCache.clear()
}

export async function getTierRouting(orgId: string, force = false): Promise<TierRouting> {
  const cached = routingCache.get(orgId)
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.value
  const [catalog, policy, configured] = await Promise.all([loadModelCatalog(), getModelPolicy(orgId), configuredProvidersFor(orgId)])
  const value = computeTierRouting(catalog, policy, configured)
  routingCache.set(orgId, { at: Date.now(), value })
  return value
}

export async function getTierModels(orgId: string): Promise<TierModels> {
  return (await getTierRouting(orgId)).tiers
}

/** The model used when a run, sub-agent or onboarding job names none: the medium tier. */
export async function defaultModel(orgId: string): Promise<string> {
  const tiers = await getTierModels(orgId)
  return tiers.medium || tiers.small || tiers.large
}

/** Compute once at boot so the first request does not pay for it, and log the outcome. */
export async function warmModelRouting(orgId: string, logger: { info: (m: string, meta?: Record<string, unknown>) => void; warn: (m: string, meta?: Record<string, unknown>) => void } = policyLog): Promise<TierRouting> {
  const routing = await getTierRouting(orgId, true)
  if (!routing.provider) logger.warn('No LLM provider key is set for this organization; its runs cannot start until one is added.', { orgId })
  else logger.info('model routing', { orgId, provider: routing.provider, preference: routing.policy.preference, ...routing.tiers })
  return routing
}
