import { describe, expect, test } from 'bun:test'
import { pickSlotToFree } from '../src/lib/worker-slots'

const now = 1_000_000
const w = (projectId: string, startedAt: number) => ({ projectId, startedAt })

describe('freeing a worker slot for a waiting project', () => {
  test('a worker with no work left goes at once, oldest first', () => {
    const picked = pickSlotToFree({ holders: [w('real', 1), w('test-probe', 5), w('old-idle', 2)], work: [{ projectId: 'real', inFlight: 1 }], waitedMs: 0, rotatedAt: new Map(), now })
    expect(picked).toEqual({ holder: w('old-idle', 2), reason: 'no work left' })
  })

  test('a worker running a job is never chosen', () => {
    expect(pickSlotToFree({ holders: [w('a', 1), w('b', 2)], work: [{ projectId: 'a', inFlight: 1 }, { projectId: 'b', inFlight: 2 }], waitedMs: 10 * 60_000, rotatedAt: new Map(), now })).toBeUndefined()
  })

  test('queued but not running: only after the starvation wait, and not twice within the cooldown', () => {
    const input = { holders: [w('stalled', 1)], work: [{ projectId: 'stalled', inFlight: 0 }], rotatedAt: new Map<string, number>(), now }
    expect(pickSlotToFree({ ...input, waitedMs: 30_000 })).toBeUndefined()
    expect(pickSlotToFree({ ...input, waitedMs: 61_000 })).toEqual({ holder: w('stalled', 1), reason: 'no job running' })
    expect(pickSlotToFree({ ...input, waitedMs: 61_000, rotatedAt: new Map([['stalled', now - 60_000]]) })).toBeUndefined()
  })
})
