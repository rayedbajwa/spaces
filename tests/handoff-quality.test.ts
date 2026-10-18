import { describe, expect, test } from 'bun:test'
import { extractiveSummary, withHandoffFacts } from '../src/lib/context-compactor'
import { HANDOFF_CHECKS } from '../src/lib/handoff-evals'
import { implementationTaskProgress } from '../src/lib/run-resume'
import { implementLoopTemplate } from '../src/lib/implement-loop'

const passes = (tail: string, handoff: string) =>
  HANDOFF_CHECKS.filter((c) => !c.check({ stage: 'implement', tail, handoff, compacted: true }).pass).map((c) => c.name)

describe('handoff facts', () => {
  // Shape of the Oct 15 implement handoffs that dropped commits.
  const tail = 'Fixed the badge.\nCommits `42460e4`, `34dd0d4` and `6e50a02` on PR #78.\nVerification Status: PARTIAL\nUpdated specs/005-native-navigation-bar/tasks.md.\n' + 'Detail line. '.repeat(120)

  test('a summary that dropped commits, the PR and the status gets them back', async () => {
    const summary = 'Fixed the badge; tests pass.'
    expect(passes(tail, summary)).toContain('handoff-keeps-references')
    const kept = await withHandoffFacts(summary, tail)
    expect(kept).toContain('Refs: 42460e4, 34dd0d4, 6e50a02, #78, tasks.md')
    expect(kept).toContain('Status: Verification Status: PARTIAL')
    expect(passes(tail, kept)).toEqual([])
  })

  test('nothing is appended when the summary already has it', async () => {
    const summary = 'PARTIAL. Commits 42460e4, 34dd0d4, 6e50a02 on PR #78; tasks.md updated.'
    expect(await withHandoffFacts(summary, tail)).toBe(summary)
  })

  test('a pending question survives', async () => {
    const asked = '## Question 1: Merge PR #77?\nMay I merge PR #77 into main?\nPlease respond.'
    const kept = await withHandoffFacts('Ready to merge.', asked)
    expect(kept).toContain('Pending question: May I merge PR #77 into main?')
  })

  test('without a model, the extractive summary is short and keeps the facts', async () => {
    const out = await extractiveSummary(tail)
    expect(out.length).toBeLessThan(1000)
    expect(passes(tail, out)).toEqual([])
  })
})

describe('owner tasks', () => {
  test('person-only tasks are not implementation work left', () => {
    const tasks = `## Phase 1\n- [x] T001 Add the tab bar in app/(tabs)/_layout.tsx\n- [ ] T012 [OWNER] [US1] Run the iOS device checklist\n- [ ] T014 [US2] Confirm on-device that the keyboard keeps scroll position\n- [ ] T020 Fix the badge in components/badge.tsx\n\n## Delivery\n- [ ] T025 Merge the pull request\n`
    expect(implementationTaskProgress(tasks)).toMatchObject({ done: 1, total: 2, remaining: ['T020'] })
  })
})

describe('implement loop', () => {
  test('a verify that moved nothing ends the loop', () => {
    const verify = implementLoopTemplate().steps.find((s) => s.id === 'build-and-test')!
    const rules = verify.onComplete!.branch!
    const same = rules.findIndex((r) => r.when.includes("verification_progress == 'same'"))
    expect(same).toBeGreaterThan(-1)
    expect(rules[same]!.goto).toBe('end')
    expect(same).toBeLessThan(rules.findIndex((r) => r.when === 'true'))
  })
})
