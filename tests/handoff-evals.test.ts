import { describe, expect, test } from 'bun:test'
import { HANDOFF_CHECKS, references, type Handoff } from '../src/lib/handoff-evals'

const check = (name: string) => HANDOFF_CHECKS.find((c) => c.name === name)!

// Shortened from real handoffs in run_thread_entries.
const REVIEW_TAIL = `I'll start by reading the feature artifacts.Code Review Status: CHANGES_REQUESTED

Files written/changed:
- \`specs/001-release-readiness/code-review.md\` — full review, status **CHANGES_REQUESTED** (2 MAJOR findings).
- \`specs/001-release-readiness/probes/deep-link-real-parse.test.ts\` — committed, reproducible probe.

Evidence gathered on \`rayedbajwa/taasq\` \`origin/main\` @ \`d92098a\`: gate pass; probe shows \`taasq://my-offers?offerId=456\` → \`path=""\`.
Open: implement stage to address both MAJOR findings.`
const REVIEW_SUMMARY = `**Review: CHANGES_REQUESTED.** Artifacts: \`specs/001-release-readiness/code-review.md\`; probe \`deep-link-real-parse.test.ts\`. On \`origin/main@d92098a\` the probe shows \`taasq://my-offers?offerId=456\` yields \`path=""\`. Open: implement both MAJOR findings.`

const handoff = (over: Partial<Handoff>): Handoff => ({ stage: 'review', tail: REVIEW_TAIL, handoff: REVIEW_SUMMARY, compacted: true, ...over })

describe('handoff checks', () => {
  test('a faithful summary passes every check', () => {
    for (const c of HANDOFF_CHECKS) expect({ name: c.name, ...c.check(handoff({})) }).toMatchObject({ name: c.name, pass: true })
  })

  test('a cut-off output fails handoff-complete', () => {
    const r = check('handoff-complete').check(handoff({ stage: 'implement', tail: 'Done. Wi', handoff: 'Done. Wi', compacted: false }))
    expect(r.pass).toBe(false)
    expect(r.problems[0]).toContain('8 characters')
  })

  test('a long raw tail fails handoff-compacted, a short one does not', () => {
    expect(check('handoff-compacted').check(handoff({ tail: 'x'.repeat(1400), handoff: 'x'.repeat(1400), compacted: false })).pass).toBe(false)
    expect(check('handoff-compacted').check(handoff({ tail: 'x'.repeat(600), handoff: 'x'.repeat(600), compacted: false })).pass).toBe(true)
  })

  test('a summary that drops the review status fails handoff-keeps-status', () => {
    const r = check('handoff-keeps-status').check(handoff({ handoff: 'Review done; see code-review.md at d92098a.' }))
    expect(r.problems).toEqual(['Code Review Status CHANGES_REQUESTED is not in the handoff'])
  })

  test('references are commits, pull requests and spec files', () => {
    expect(references('Committed `ba71e6b`, PR #77, branch @ `29292e3`; wrote `specs/001-x/tasks.md`. Gate passed=3.').sort()).toEqual(['#77', '29292e3', 'ba71e6b', 'tasks.md'])
    expect(references('port 3604, 141/141 tests, issue #12')).toEqual([])
  })

  test('a summary that loses most references fails handoff-keeps-references', () => {
    const tail = 'Fixed it on branch @ `29292e3`, PR #77, commit `ba71e6b`; updated `specs/001-x/tasks.md`.'
    expect(check('handoff-keeps-references').check(handoff({ tail, handoff: 'Fixed; PR #77, commit ba71e6b, tasks.md updated.' }))).toMatchObject({ pass: true, score: 0.75 })
    const r = check('handoff-keeps-references').check(handoff({ tail, handoff: 'Fixed the deep link bug.' }))
    expect(r).toMatchObject({ pass: false, score: 0 })
    expect(r.problems[0]).toContain('missing 29292e3')
  })

  test('a question the summary drops fails handoff-keeps-question', () => {
    const tail = 'Nothing to change.\n\n## Question 1: May I merge PR #77 so the release has the fix?'
    expect(check('handoff-keeps-question').check(handoff({ tail, handoff: 'PR #77 approved but not merged; merge is irreversible, await approval.' })).pass).toBe(true)
    expect(check('handoff-keeps-question').check(handoff({ tail, handoff: 'All tests pass; PR #77 is mergeable.' })).pass).toBe(false)
  })

  test('masking a test count fails handoff-not-over-redacted, masking a real secret does not', () => {
    const tail = 'Re-verified release 1.0.3: `VERIFY_RELEASE result=pass passed=3 failed=0`; impacted 5/91 suites.'
    const r = check('handoff-not-over-redacted').check(handoff({ tail, handoff: 'Re-verified release 1.0.3: VERIFY_RELEASE pass=[redacted] failed=0; impacted 5/91 suites.' }))
    expect(r.pass).toBe(false)
    expect(r.problems[0]).toContain('1 masked value(s) in the handoff, 0 in the stage')
    const secretTail = 'Set DATABASE_PASSWORD=hunter2hunter2 on the worker and redeployed.'
    expect(check('handoff-not-over-redacted').check(handoff({ tail: secretTail, handoff: 'Set DATABASE_PASSWORD=[redacted] on the worker.' })).pass).toBe(true)
  })
})
