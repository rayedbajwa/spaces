import { describe, expect, test } from 'bun:test'
import { composeChoiceAnswer, parseAgentQuestion } from '../src/web/agent-choices'

// Shapes taken from prod run logs (Oct 13–15).
const CLARIFY = `=== Stage 2/6: speckit.clarify ===

## Question 1: Release channel and target scope

**Recommended:** Option A — a private beta on both platforms first gives real-device evidence.

**Context**: The spec assumes both iOS and Android.

| Option | Description |
|--------|-------------|
| A | Private beta on both iOS and Android first, then public production release |
| B | Private beta on one platform only first; second platform later |
| C | Public production release directly, with no beta gate |
| Short | A different short answer (≤ 5 words) |

Reply with a letter, "yes" to accept the recommendation, or your own short answer.`

const MERGE_PLAN = `## Question 1: Approve merging PR #70 and continuing the release path?
Merging PR #70 is irreversible. Do you approve:
1. merging \`001-release-readiness\` (PR #70) into \`main\`, then
2. running T071–T072 (staging /health + UAT)?

Reply "approved" to proceed with all, or name the subset you authorize.`

describe('parseAgentQuestion', () => {
  test('a clarify table becomes lettered choices with the recommendation marked', () => {
    const q = parseAgentQuestion(CLARIFY)!
    expect(q.title).toBe('Release channel and target scope')
    expect(q.choices.map((c) => c.key)).toEqual(['A', 'B', 'C'])
    expect(q.choices[0]).toMatchObject({ recommended: true, label: expect.stringContaining('Private beta on both') })
    expect(q.recommendedReason).toContain('real-device evidence')
  })

  test('numbered steps under an approval question are a yes/no, not choices', () => {
    const q = parseAgentQuestion(MERGE_PLAN)!
    expect(q.yesNo).toBe(true)
    expect(q.choices.map((c) => c.key)).toEqual(['yes', 'no'])
  })

  test('a lettered list after "which" is a set of choices', () => {
    const q = parseAgentQuestion('Which store should we target first?\n\nA) Apple App Store\nB) Google Play\n- **C**: both at once')!
    expect(q.choices).toEqual([
      { key: 'A', label: 'Apple App Store' },
      { key: 'B', label: 'Google Play' },
      { key: 'C', label: 'both at once' },
    ])
  })

  test('an open question has a title and no choices', () => {
    expect(parseAgentQuestion('What is the staging URL?')).toEqual({ title: 'What is the staging URL?', choices: [] })
    expect(parseAgentQuestion('')).toBeUndefined()
  })

  test('only the latest question counts', () => {
    const q = parseAgentQuestion(`${CLARIFY}\n\nA\n\n## Question 2: Data retention\n\n| Option | Description |\n|---|---|\n| A | 30 days |\n| B | 1 year |`)!
    expect(q.title).toBe('Data retention')
    expect(q.choices.map((c) => c.label)).toEqual(['30 days', '1 year'])
  })
})

describe('composeChoiceAnswer', () => {
  test('a choice is sent with its text, and details follow', () => {
    const b = { key: 'B', label: 'Google Play' }
    expect(composeChoiceAnswer(b, '')).toBe('B — Google Play')
    expect(composeChoiceAnswer(b, ' Android 12+ only ')).toBe('B — Google Play\n\nAdditional details: Android 12+ only')
    expect(composeChoiceAnswer({ key: 'yes', label: 'Yes, go ahead' }, '', true)).toBe('yes')
    expect(composeChoiceAnswer(undefined, 'my own answer')).toBe('my own answer')
  })
})
