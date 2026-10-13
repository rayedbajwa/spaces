import { describe, expect, test } from 'bun:test'
import { AGENT_CHECKS, checksFor, detectArtifact } from '../src/lib/agent-evals'
import { AGENT_EVAL_SAMPLES } from '../src/lib/agent-eval-samples'

describe('agent expectation checks', () => {
  for (const sample of AGENT_EVAL_SAMPLES) {
    test(`${sample.id} → ${sample.expected}`, () => {
      const checks = sample.artifact === 'any' ? AGENT_CHECKS.filter((c) => c.artifact === 'any') : checksFor(sample.artifact)
      const results = checks.map((c) => ({ name: c.name, ...c.check(sample.output) }))
      const pass = results.every((r) => r.pass)
      if (pass !== (sample.expected === 'pass')) throw new Error(`${sample.id}: expected ${sample.expected}, got ${JSON.stringify(results)}`)
      expect(pass).toBe(sample.expected === 'pass')
    })
  }

  test('every check has a passing and a failing sample', () => {
    for (const check of AGENT_CHECKS) {
      const samples = AGENT_EVAL_SAMPLES.filter((s) => s.artifact === check.artifact)
      expect(samples.some((s) => s.expected === 'pass')).toBe(true)
      expect(samples.some((s) => s.expected === 'fail')).toBe(true)
    }
  })

  test('outputs are recognised by the lines Spaces parses', () => {
    for (const sample of AGENT_EVAL_SAMPLES.filter((s) => s.expected === 'pass' && ['verification-report', 'code-review', 'delivery-report', 'dev-setup', 'tasks', 'plan', 'parallel-workstreams', 'clarify-questions', 'suggestions-json'].includes(s.artifact))) {
      expect(detectArtifact(sample.output)).toBe(sample.artifact)
    }
    expect(detectArtifact('Just a chat answer.')).toBeUndefined()
  })
})
