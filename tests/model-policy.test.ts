import { describe, expect, test } from 'bun:test'
import { describeCatalogModel, generationOf, sizeHintOf, type CatalogModel } from '../src/lib/model-catalog'
import { DEFAULT_POLICY, OPENROUTER_AUTO, computeTierRouting, normalizePolicy } from '../src/lib/model-policy'

// A fake OpenAI-like catalog: two generations, small/mid/large variants and a premium "pro".
function fake(provider: string, id: string, input: number, output: number, extra: Partial<Parameters<typeof describeCatalogModel>[0]> = {}): CatalogModel {
  return describeCatalogModel({ provider, id, name: id, reasoning: true, cost: { input, output, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 32_000, input: ['text'], ...extra })
}

const catalog: CatalogModel[] = [
  fake('openai', 'gpt-5.4-nano', 0.1, 0.4),
  fake('openai', 'gpt-5.4-mini', 0.4, 1.6),
  fake('openai', 'gpt-5.4', 2.5, 15),
  fake('openai', 'gpt-5.5', 3, 18),
  fake('openai', 'gpt-5.5-pro', 30, 120),
  fake('openai', 'gpt-4.1', 2, 8), // previous generation → excluded
  fake('openai', 'text-embedding-3-small', 0.02, 0), // not a chat model
  fake('openai', 'gpt-5.4-2026-01-01', 2.5, 15), // dated snapshot
  fake('anthropic', 'claude-haiku-4-5', 1, 5),
  fake('anthropic', 'claude-sonnet-4-5', 3, 15),
  fake('anthropic', 'claude-opus-4-7', 5, 25),
]

describe('catalog hints', () => {
  test('generation and size are parsed from ids', () => {
    expect(generationOf('gpt-5.4-mini')).toBe(5.4)
    expect(generationOf('claude-opus-4-7')).toBe(4.7)
    expect(generationOf('anthropic/claude-sonnet-4.5')).toBe(4.5)
    expect(generationOf('gpt-5')).toBe(5)
    expect(sizeHintOf('gpt-5.4-nano')).toBe('small')
    expect(sizeHintOf('claude-opus-4-7')).toBe('large')
    expect(sizeHintOf('claude-fable-5-1')).toBe('large')
    expect(sizeHintOf('gpt-5.5-pro')).toBe('large')
    expect(sizeHintOf('gpt-5.4')).toBeUndefined()
  })

  test('non-chat, snapshot and legacy models are excluded from routing', () => {
    const byId = Object.fromEntries(catalog.map((m) => [m.id, m.excluded]))
    expect(byId['text-embedding-3-small']).toBeDefined()
    expect(byId['gpt-5.4-2026-01-01']).toBeDefined()
    expect(byId['gpt-4.1']).toBeDefined()
    expect(byId['gpt-5.4']).toBeUndefined()
  })
})

describe('computeTierRouting', () => {
  test('balanced OpenAI: cheapest / mid / most capable non-premium', () => {
    const r = computeTierRouting(catalog, DEFAULT_POLICY, ['openai'])
    expect(r.provider).toBe('openai')
    expect(r.tiers.small).toBe('openai/gpt-5.4-nano')
    expect(r.tiers.medium).toBe('openai/gpt-5.5') // the base model of the newest line
    expect(r.tiers.large).toBe('openai/gpt-5.5')  // nothing non-premium above it
    expect(r.candidates.some((c) => c.id === 'gpt-4.1')).toBe(false)
  })

  test('cost preference collapses large onto medium and never picks premium', () => {
    const r = computeTierRouting(catalog, { ...DEFAULT_POLICY, preference: 'cost', allowPremium: true }, ['openai'])
    expect(r.tiers.small).toBe('openai/gpt-5.4-nano')
    expect(r.tiers.medium).toBe('openai/gpt-5.4') // cheapest base overall
    expect(r.tiers.large).toBe(r.tiers.medium)
    expect(r.tiers.large).not.toContain('pro')
  })

  test('quality preference with premium allowed reaches the pro model', () => {
    const r = computeTierRouting(catalog, { ...DEFAULT_POLICY, preference: 'quality', allowPremium: true }, ['openai'])
    expect(r.tiers.large).toBe('openai/gpt-5.5-pro')
    expect(r.tiers.medium).toBe('openai/gpt-5.5')
    expect(r.tiers.small).toBe('openai/gpt-5.5') // quality lifts small to a base model
  })

  test('provider order picks the first configured provider', () => {
    const r = computeTierRouting(catalog, DEFAULT_POLICY, ['openai', 'anthropic'])
    expect(r.provider).toBe('anthropic')
    expect(r.tiers).toEqual({ small: 'anthropic/claude-haiku-4-5', medium: 'anthropic/claude-sonnet-4-5', large: 'anthropic/claude-opus-4-7' })
  })

  test('OpenRouter hands every tier to its own router', () => {
    const r = computeTierRouting(catalog, { ...DEFAULT_POLICY, providerOrder: ['openrouter', 'anthropic', 'openai'] }, ['openrouter', 'openai'])
    expect(r.tiers).toEqual({ small: OPENROUTER_AUTO, medium: OPENROUTER_AUTO, large: OPENROUTER_AUTO })
    expect(r.candidates).toEqual([])
  })

  test('overrides pin a tier and are reported as such', () => {
    const r = computeTierRouting(catalog, { ...DEFAULT_POLICY, overrides: { large: 'openai/gpt-5.5-pro' } }, ['openai'])
    expect(r.tiers.large).toBe('openai/gpt-5.5-pro')
    expect(r.reasons.large).toContain('pinned')
  })

  test('no provider key → empty tiers with a reason', () => {
    const r = computeTierRouting(catalog, DEFAULT_POLICY, [])
    expect(r.provider).toBeNull()
    expect(r.reasons.medium).toContain('no provider key')
  })

  test('normalizePolicy fills defaults and drops junk', () => {
    const p = normalizePolicy({ preference: 'weird' as never, providerOrder: ['openai', 'bogus' as never], overrides: { small: '  ', medium: 'x/y' } })
    expect(p.preference).toBe('balanced')
    expect(p.providerOrder).toEqual(['openai', 'anthropic', 'openrouter'])
    expect(p.overrides).toEqual({ medium: 'x/y' })
  })
})
