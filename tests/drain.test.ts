import { describe, expect, test } from 'bun:test'
import { drainBudget } from '../src/lib/drain'

describe('drainBudget', () => {
  test('without a platform window, runs are handed back at once with the old timeouts', () => {
    expect(drainBudget({})).toEqual({ totalMs: 0, workerMs: 0, supervisorMs: 15_000, standaloneMs: 25_000 })
    expect(drainBudget({ RAILWAY_DEPLOYMENT_DRAINING_SECONDS: '30' }).workerMs).toBe(0)
  })

  test("Railway's window is split innermost first, each process leaving room for the next", () => {
    const b = drainBudget({ RAILWAY_DEPLOYMENT_DRAINING_SECONDS: '900' })
    expect(b.totalMs).toBe(900_000)
    expect(b.workerMs).toBeLessThan(b.supervisorMs)
    expect(b.supervisorMs).toBeLessThan(b.standaloneMs)
    expect(b.standaloneMs).toBeLessThan(b.totalMs)
    expect(b.workerMs).toBeGreaterThan(800_000)
  })

  test('SPACES_DRAIN_SECONDS overrides the Railway variable; nonsense means no drain', () => {
    expect(drainBudget({ SPACES_DRAIN_SECONDS: '120', RAILWAY_DEPLOYMENT_DRAINING_SECONDS: '900' }).totalMs).toBe(120_000)
    expect(drainBudget({ RAILWAY_DEPLOYMENT_DRAINING_SECONDS: 'abc' }).workerMs).toBe(0)
  })
})
