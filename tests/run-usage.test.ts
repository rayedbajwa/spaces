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
