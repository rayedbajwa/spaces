import { describe, expect, test } from 'bun:test'
import { QUESTION_PATTERN, STAGE_DEFINITIONS, DEFAULT_STAGES } from '../src/lib/aidlc'
import { RESEARCH_BRIEF_FILE, buildResearchPrompt } from '../src/lib/research-stage'
import { getTemplate, listTemplates } from '../src/lib/pipeline-loader'

describe('research stage', () => {
  test('is a known stage that runs right after init by default', () => {
    expect(STAGE_DEFINITIONS.research.argKey).toBe('feature')
    expect(DEFAULT_STAGES.indexOf('research')).toBe(DEFAULT_STAGES.indexOf('init') + 1)
  })

  test('prompt asks for the brief and never reads as a question to the user', () => {
    const prompt = buildResearchPrompt('Add a cache layer for routing decisions')
    expect(prompt).toContain(RESEARCH_BRIEF_FILE)
    for (const heading of ['## Summary', '## Repositories', '## Existing code and patterns to reuse', '## Standards and decisions that apply', '## Open questions for the team', '## Inputs for the specification']) {
      expect(prompt).toContain(heading)
    }
    // A stray "## Question 1" or "Your choice:" would pause the run for a human.
    expect(QUESTION_PATTERN.test(prompt)).toBe(false)
  })

  test('shipped templates place research immediately after init', async () => {
    const names = (await listTemplates()).map((t) => t.name).filter((n) => !['test-minimal', 'aidlc-verify-loop'].includes(n))
    const templates = await Promise.all(names.map((n) => getTemplate(n)))
    const withInit = templates.filter((t) => t.template.steps.some((s) => s.stage === 'init'))
    expect(withInit.length).toBeGreaterThan(5)
    for (const t of withInit) {
      const stages = t.template.steps.map((s) => s.stage)
      expect(stages[stages.indexOf('init') + 1]).toBe('research')
    }
  })
})
