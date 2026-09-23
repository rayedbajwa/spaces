import { describe, expect, test } from 'bun:test'
import { AIDLCFlow } from '../src/lib/aidlc'
import { AgentGuard } from '../src/lib/guardrails'

function flowWith(session: unknown, guard?: AgentGuard) {
  const flow = new AIDLCFlow({ cwd: process.cwd() }, ['implement'])
  const internals = flow as unknown as { session: unknown; guard?: AgentGuard; pendingStageNote?: string; log: string }
  internals.session = session
  if (guard) internals.guard = guard
  return { flow, internals }
}

describe('interrupting a running agent with feedback', () => {
  test('mid-stage: steered into the session (masked), and written to the log', async () => {
    const steered: string[] = []
    const { flow, internals } = flowWith({ isStreaming: true, steer: async (text: string) => { steered.push(text) } }, new AgentGuard())
    expect(await flow.steer('Use jane@acme.io as the test user, not the admin account', 'Sam')).toBe('now')
    expect(steered).toHaveLength(1)
    expect(steered[0]).toContain('interrupted with feedback')
    expect(steered[0]).not.toContain('jane@acme.io')
    expect(steered[0]).toMatch(/<EMAIL_\d+>/)
    // The log shows it too — with the guardrails' token, as for everything logged.
    expect(flow.getLog()).toMatch(/\[feedback from Sam\] Use <EMAIL_\d+> as the test user/)
    expect(internals.pendingStageNote).toBeUndefined()
  })

  test('between stages: kept for the next stage\'s prompt', async () => {
    const { flow, internals } = flowWith({ isStreaming: false, steer: async () => { throw new Error('not streaming') } })
    expect(await flow.steer('Skip the Docker build', 'Sam')).toBe('next stage')
    expect(await flow.steer('And keep the API unchanged', 'Ana')).toBe('next stage')
    expect(internals.pendingStageNote).toContain('Skip the Docker build')
    expect(internals.pendingStageNote).toContain('And keep the API unchanged')
  })

  test('empty feedback is refused', async () => {
    const { flow } = flowWith({ isStreaming: true, steer: async () => undefined })
    await expect(flow.steer('   ', 'Sam')).rejects.toThrow('empty')
  })
})
