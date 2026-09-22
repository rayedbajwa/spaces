import { describe, expect, test } from 'bun:test'
import { isProjectStateFresh, PROJECT_STATE_MAX_AGE_MS } from '../src/lib/project-state'

const now = Date.parse('2026-09-22T12:00:00.000Z')
const at = (msAgo: number) => new Date(now - msAgo).toISOString()

describe('isProjectStateFresh', () => {
  test('recent state with no newer run is reused', () => {
    expect(isProjectStateFresh({ stale: false, computedAt: at(60_000) }, at(120_000), now)).toBe(true)
    expect(isProjectStateFresh({ stale: false, computedAt: at(60_000) }, undefined, now)).toBe(true)
  })

  test('a run updated since (stage start, pause, finish) means recompute', () => {
    expect(isProjectStateFresh({ stale: false, computedAt: at(60_000) }, at(30_000), now)).toBe(false)
  })

  test('marked stale, or older than the backstop, means recompute', () => {
    expect(isProjectStateFresh({ stale: true, computedAt: at(1_000) }, undefined, now)).toBe(false)
    expect(isProjectStateFresh({ stale: false, computedAt: at(PROJECT_STATE_MAX_AGE_MS + 1) }, undefined, now)).toBe(false)
  })
})
