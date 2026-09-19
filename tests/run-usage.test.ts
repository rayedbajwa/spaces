import { describe, expect, test } from 'bun:test'
import { usageFromMessage } from '../src/lib/run-usage'

describe('usage records', () => {
  test('maps an assistant message usage into a record with cost', () => {
    const r = usageFromMessage({ provider: 'openrouter', model: 'openrouter/auto', usage: { input: 1200, output: 300, cacheRead: 5000, cacheWrite: 0, cost: { total: 0.0123 } } }, { runId: 'r', projectNamespace: 'p', stage: 'implement' })
    expect(r).toMatchObject({ runId: 'r', projectNamespace: 'p', stage: 'implement', provider: 'openrouter', model: 'openrouter/auto', inputTokens: 1200, outputTokens: 300, cacheReadTokens: 5000, costUsd: 0.0123 })
  })
  test('ignores messages without tokens', () => {
    expect(usageFromMessage({ provider: 'x', model: 'y', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, { runId: 'r', projectNamespace: 'p' })).toBeUndefined()
    expect(usageFromMessage({}, { runId: 'r', projectNamespace: 'p' })).toBeUndefined()
  })
})

import { estimateCost, findPrice, priceRecord } from '../src/lib/run-usage'

describe('cost estimation for routed models', () => {
  const catalog = [
    { provider: 'openrouter', id: 'auto', inputCost: 0, outputCost: 0, cacheReadCost: 0, cacheWriteCost: 0 },
    { provider: 'openrouter', id: 'openai/gpt-5.6', inputCost: 2, outputCost: 8, cacheReadCost: 0.2, cacheWriteCost: 2.5 },
    { provider: 'anthropic', id: 'claude-sonnet-4-5', inputCost: 3, outputCost: 15, cacheReadCost: 0.3, cacheWriteCost: 3.75 },
  ]
  test('uses the routed model under the same provider first', () => {
    expect(findPrice(catalog, 'openrouter', 'auto', 'openai/gpt-5.6')?.outputCost).toBe(8)
  })
  test('falls back to a matching id under another provider', () => {
    expect(findPrice(catalog, 'openrouter', 'auto', 'anthropic/claude-sonnet-4-5')?.inputCost).toBe(3)
    expect(findPrice(catalog, 'openrouter', 'auto', 'mystery/model')).toBeUndefined()
  })
  test('estimates and marks the record', () => {
    const r = priceRecord({ runId: 'r', projectNamespace: 'p', provider: 'openrouter', model: 'auto', responseModel: 'openai/gpt-5.6', inputTokens: 1_000_000, outputTokens: 250_000, cacheReadTokens: 500_000, cacheWriteTokens: 0, costUsd: 0, costSource: 'none' }, catalog)
    expect(r.costUsd).toBeCloseTo(2 + 2 + 0.1, 6)
    expect(r.costSource).toBe('estimated')
    expect(estimateCost({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, catalog[1]!)).toBe(0)
  })
})
