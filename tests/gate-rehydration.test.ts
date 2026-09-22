import { describe, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { AIDLCFlow, type StageName } from '../src/lib/aidlc'

const stages: StageName[] = ['implement', 'review', 'verify']

function flow(resumeWaiting?: { kind: 'clarification' | 'review'; stage: StageName }) {
  // The model runtime resolves lazily; nothing here talks to a provider.
  const f = new AIDLCFlow({ cwd: tmpdir(), model: 'test/model', projectId: undefined, ...(resumeWaiting ? { resumeWaiting } : {}) } as never, [...stages])
  ;(f as unknown as { modelRuntimePromise: Promise<unknown> }).modelRuntimePromise.catch(() => undefined)
  return f
}

describe('a flow rebuilt at a gate', () => {
  test('starts waiting for input at the stage that paused', () => {
    const f = flow({ kind: 'review', stage: 'review' })
    expect(f.isWaitingForInput()).toBe(true)
    expect(f.getCurrentStage()).toBe('review')
  })

  test('a question keeps its kind and stage', () => {
    const f = flow({ kind: 'clarification', stage: 'verify' })
    expect(f.isWaitingForInput()).toBe(true)
    expect(f.getCurrentStage()).toBe('verify')
  })

  test('an ordinary flow is not waiting, and cannot be resumed with an answer', async () => {
    const f = flow()
    expect(f.isWaitingForInput()).toBe(false)
    await expect(f.resumeWithAnswer('approve')).rejects.toThrow('not rebuilt at a gate')
  })
})
