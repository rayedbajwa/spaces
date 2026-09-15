import { test, expect, describe } from 'bun:test'
import { MODELS, routeModel, type SpeedMode } from '../src/lib/model-router'

/**
 * Pure unit tests for the model router. No DB, no LLM, no config file — every
 * call uses the built-in defaults compiled into model-router.ts (we do not
 * pass a config argument), so results are stable regardless of what may or
 * may not be present at data/org/model-routing.yml.
 */

describe('routeModel: explicit pin wins outright', () => {
  test('explicitModel bypasses stage/mode/promptSize routing', () => {
    const decision = routeModel({ stage: 'plan', explicitModel: 'foo/bar' })
    expect(decision.model).toBe('foo/bar')
    // Reason should describe why we honored the pin, not what the default would have been.
    expect(decision.reason).toContain('pipeline template pinned')
  })

  test('explicitModel wins even in fast mode with a giant prompt', () => {
    // Would otherwise route to Haiku (fast) but then bump to Sonnet (promptSize
    // guard). Explicit pin must short-circuit both.
    const decision = routeModel({
      stage: 'implement',
      mode: 'fast',
      promptSize: 999_999,
      explicitModel: 'custom/model-x',
    })
    expect(decision.model).toBe('custom/model-x')
    expect(decision.reason).toContain('pipeline template pinned')
  })
})

describe('routeModel: stage-family defaults (balanced mode implicit)', () => {
  // Each row: stage → expected model tier + families it belongs to.
  const cases: Array<{ stage: string; expected: string; note: string }> = [
    { stage: 'specify', expected: MODELS.sonnet, note: 'plan family' },
    { stage: 'implement', expected: MODELS.sonnet, note: 'implement family' },
    { stage: 'review', expected: MODELS.haiku, note: 'review family' },
    { stage: 'chat', expected: MODELS.haiku, note: 'chat family' },
    { stage: 'orchestrate', expected: MODELS.sonnet, note: 'orchestrate family' },
    // Unknown stage falls through to the 'other' family which defaults to Sonnet.
    { stage: 'unknown-stage-xyz', expected: MODELS.sonnet, note: 'other family' },
  ]

  for (const c of cases) {
    test(`stage=${c.stage} → ${c.note}`, () => {
      const decision = routeModel({ stage: c.stage })
      expect(decision.model).toBe(c.expected)
    })
  }
})

describe('routeModel: speed mode', () => {
  test("fast mode implement → haiku (cheap tier)", () => {
    const decision = routeModel({ stage: 'implement', mode: 'fast' })
    expect(decision.model).toBe(MODELS.haiku)
    // Reason should mention the mode so operators can trace why haiku won.
    expect(decision.reason).toContain('fast')
  })

  test('quality mode orchestrate → opus with thinking=high', () => {
    const decision = routeModel({ stage: 'orchestrate', mode: 'quality' })
    expect(decision.model).toBe(MODELS.opus)
    expect(decision.thinking).toBe('high')
    expect(decision.reason).toContain('quality')
  })
})

describe('routeModel: retry escalation', () => {
  test('attempt=1 on implement bumps sonnet → opus', () => {
    // balanced/implement default is sonnet; one retry pushes up one tier.
    const decision = routeModel({ stage: 'implement', attempt: 1 })
    expect(decision.model).toBe(MODELS.opus)
    // Reason should explain the escalation was retry-driven.
    expect(decision.reason).toContain('retry')
  })

  test('attempt=0 does NOT escalate — same as no attempt argument', () => {
    const zero = routeModel({ stage: 'implement', attempt: 0 })
    const none = routeModel({ stage: 'implement' })
    expect(zero.model).toBe(MODELS.sonnet)
    expect(zero.model).toBe(none.model)
    // No retry escalation → reason should not mention retry.
    expect(zero.reason).not.toContain('retry')
  })
})

describe('routeModel: prompt-size guard', () => {
  test('fast/chat with a giant prompt bumps haiku → sonnet', () => {
    // Fast + chat lands on haiku; 60k chars > the 50k default threshold, so
    // the guard should upgrade to sonnet to avoid truncation.
    const decision = routeModel({ stage: 'chat', mode: 'fast', promptSize: 60_000 })
    expect(decision.model).toBe(MODELS.sonnet)
    // Reason should call out the threshold — human-readable and searchable in logs.
    expect(decision.reason).toContain('50000')
    expect(decision.reason).toContain('60000')
  })

  test('fast/chat with a small prompt stays on haiku', () => {
    const decision = routeModel({ stage: 'chat', mode: 'fast', promptSize: 10_000 })
    expect(decision.model).toBe(MODELS.haiku)
  })
})

describe('routeModel: reason strings are descriptive', () => {
  // The reason is user-visible (surfaces in the run UI + logs). We assert it's
  // non-empty and uses recognizable tokens rather than being e.g. the raw model
  // ID or an empty string.
  const RECOGNIZABLE = ['haiku', 'sonnet', 'opus', 'fast', 'quality', 'balanced', 'stage', 'retry', 'pinned']

  const samples: Array<{ label: string; input: Parameters<typeof routeModel>[0] }> = [
    { label: 'balanced default', input: { stage: 'plan' } },
    { label: 'fast implement', input: { stage: 'implement', mode: 'fast' } },
    { label: 'quality orchestrate', input: { stage: 'orchestrate', mode: 'quality' } },
    { label: 'retry escalation', input: { stage: 'implement', attempt: 1 } },
    { label: 'explicit pin', input: { stage: 'plan', explicitModel: 'foo/bar' } },
  ]

  for (const s of samples) {
    test(`${s.label} → reason mentions a recognizable token`, () => {
      const decision = routeModel(s.input)
      expect(decision.reason.length).toBeGreaterThan(0)
      const hit = RECOGNIZABLE.some((tok) => decision.reason.toLowerCase().includes(tok))
      expect(hit).toBe(true)
    })
  }

  // Sanity: SpeedMode type is exported and matches the documented values.
  const _typeCheck: SpeedMode[] = ['fast', 'balanced', 'quality']
  expect(_typeCheck.length).toBe(3)
})
