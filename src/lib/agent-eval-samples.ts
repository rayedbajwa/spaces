/**
 * Sample agent outputs for the Phoenix dataset `spaces-agent-expectations`:
 * for each expectation in lib/agent-evals.ts, an output that meets it and
 * ones that break it the way agents actually do. `expected` is what the checks
 * must conclude, so an experiment over this dataset shows whether the
 * evaluators themselves are right before they are trusted on real traces.
 */

import type { ArtifactKind } from './agent-evals'

export interface AgentEvalSample {
  id: string
  artifact: ArtifactKind
  stage: string
  /** What the agent was asked (short). */
  task: string
  /** What it produced. */
  output: string
  expected: 'pass' | 'fail'
  /** Why, in the words of the rule. */
  reason: string
}

const verifyPass = `Verification Status: PASS
Acceptance Criteria Met: 6/6
Critical Issues Open: 0

## Requirement Traceability
| Requirement | Test | Status |
|---|---|---|
| FR-001 | tests/login.test.ts › rejects a wrong password | PASS |
| FR-002 | tests/login.test.ts › locks after 5 attempts | PASS |

## Unsatisfied Test Cases
- (none)
`

const reviewApproved = `Code Review Status: APPROVED

## Summary
Adds rate limiting to the login route; small and covered by tests.

## Findings
- [MINOR] src/routes/login.ts:42 — the limit is a magic number — move it to config
- [NIT] src/routes/login.ts:10 — unused import — remove it

## Tests & checks
bun test: 128 pass, 0 fail. Typecheck clean.

## Spec coverage
FR-001 and FR-002 are implemented and tested.
`

const devSetupReady = `Dev Setup Status: READY

## Commands
- install: bun install
- test: bun test
- run: bun run dev

## Environment
DATABASE_URL points at agent_shop_1a2b (per-checkout test database).

## Test baseline
212 pass, 0 fail.

## Issues and blockers
None.

## Notes for implementers
Run migrations with bun run db:migrate before the API tests.
`

export const AGENT_EVAL_SAMPLES: AgentEvalSample[] = [
  // Verification report
  { id: 'verify-pass', artifact: 'verification-report', stage: 'verify', task: 'Verify the login feature against its acceptance criteria.', output: verifyPass, expected: 'pass', reason: 'Status line first, counts as numbers, every criterion met, unsatisfied section present with (none).' },
  { id: 'verify-pass-with-gaps', artifact: 'verification-report', stage: 'verify', task: 'Verify the login feature against its acceptance criteria.', output: verifyPass.replace('Acceptance Criteria Met: 6/6', 'Acceptance Criteria Met: 5/6'), expected: 'fail', reason: 'PASS is only allowed when every acceptance criterion has a passing test.' },
  { id: 'verify-words-not-numbers', artifact: 'verification-report', stage: 'verify', task: 'Verify the checkout flow.', output: 'Verification Status: PARTIAL\nAcceptance Criteria Met: most of them\nCritical Issues Open: none\n\n## Unsatisfied Test Cases\n- [UAT-3] refund email — not tested\n', expected: 'fail', reason: 'Counts must be numbers: `Acceptance Criteria Met: <met>/<total>`, `Critical Issues Open: <n>`.' },
  { id: 'verify-no-unsatisfied-section', artifact: 'verification-report', stage: 'verify', task: 'Verify the checkout flow.', output: 'Verification Status: FAIL\nAcceptance Criteria Met: 3/5\nCritical Issues Open: 1\n\n## Results\nTwo tests fail.\n', expected: 'fail', reason: '`## Unsatisfied Test Cases` must exist; implement reads it to know what to fix.' },
  { id: 'verify-status-not-first', artifact: 'verification-report', stage: 'verify', task: 'Verify the search feature.', output: `Here is the verification report you asked for.\n\n${verifyPass}`, expected: 'fail', reason: 'The report must start with the exact status line (a `# Title` above it is fine; chat text is not).' },
  { id: 'verify-title-then-status', artifact: 'verification-report', stage: 'verify', task: 'Verify the search feature.', output: `# Verification report\n\n${verifyPass}`, expected: 'pass', reason: 'A `# Title` heading above the status line is fine: Spaces reads the line wherever it is.' },

  // Code review
  { id: 'review-approved', artifact: 'code-review', stage: 'review', task: 'Review the login rate-limit change.', output: reviewApproved, expected: 'pass', reason: 'Status first, all four sections, findings in the required form, only MINOR/NIT with APPROVED.' },
  { id: 'review-approved-with-major', artifact: 'code-review', stage: 'review', task: 'Review the login rate-limit change.', output: reviewApproved.replace('- [MINOR] src/routes/login.ts:42', '- [MAJOR] src/routes/login.ts:42'), expected: 'fail', reason: 'Any BLOCKER or MAJOR finding means CHANGES_REQUESTED.' },
  { id: 'review-backticked-locations', artifact: 'code-review', stage: 'review', task: 'Review the login rate-limit change.', output: reviewApproved.replace('- [MINOR] src/routes/login.ts:42', '- [MINOR] \x60src/routes/login.ts:42\x60 + \x60tests/login.test.ts:10-14\x60'), expected: 'pass', reason: 'Locations may be in backticks, ranges, or several joined with +.' },
  { id: 'review-loose-findings', artifact: 'code-review', stage: 'review', task: 'Review the cart change.', output: 'Code Review Status: CHANGES_REQUESTED\n\n## Summary\nNeeds work.\n\n## Findings\n- The cart total is wrong sometimes\n\n## Tests & checks\nNot run.\n\n## Spec coverage\nPartial.\n', expected: 'fail', reason: 'Findings must be `- [SEVERITY] path:line — problem — fix`.' },
  { id: 'review-changes-requested', artifact: 'code-review', stage: 'review', task: 'Review the cart change.', output: 'Code Review Status: CHANGES_REQUESTED\n\n## Summary\nTotals ignore discounts.\n\n## Findings\n- [BLOCKER] src/cart/total.ts:18 — discounts are added instead of subtracted — subtract them and add a test\n\n## Tests & checks\nbun test: 1 fail (cart total with discount).\n\n## Spec coverage\nFR-004 not met.\n', expected: 'pass', reason: 'A BLOCKER with CHANGES_REQUESTED, in the required form.' },

  // Delivery report
  { id: 'delivery-merged', artifact: 'delivery-report', stage: 'deliver', task: 'Deliver the login feature.', output: 'Delivery Status: MERGED\n\n## Pull requests\n- acme/shop#41 merged (CI green)\n\n## Deployment\nNo deployment performed: the project has no linked deployment.\n', expected: 'pass', reason: 'Status first and a Deployment section that says what happened.' },
  { id: 'delivery-no-deployment-section', artifact: 'delivery-report', stage: 'deliver', task: 'Deliver the login feature.', output: 'Delivery Status: MERGED\n\nAll pull requests are merged.\n', expected: 'fail', reason: 'A `## Deployment` section is required.' },
  { id: 'delivery-done-instead-of-status', artifact: 'delivery-report', stage: 'deliver', task: 'Deliver the search feature.', output: 'Delivery Status: DONE\n\n## Deployment\nDeployed to production.\n', expected: 'fail', reason: 'Status must be MERGED, PARTIAL or BLOCKED.' },

  // Clarification questions
  { id: 'clarify-two-questions', artifact: 'clarify-questions', stage: 'clarify', task: 'Clarify the export feature.', output: '## Question 1: Export format\n| Option | Candidate | Why it matters |\n|---|---|---|\n| A | CSV | Opens in spreadsheets |\n| B | JSON | Keeps nested data |\n\n## Question 2: Who can export\n| Option | Candidate | Why it matters |\n|---|---|---|\n| A | Admins only | Limits data leaving |\n| B | All members | Self-service |\n', expected: 'pass', reason: 'Numbered question headings, each with an options table, within the limit.' },
  { id: 'clarify-prose-question', artifact: 'clarify-questions', stage: 'clarify', task: 'Clarify the export feature.', output: 'Before I continue: should exports be CSV or JSON, and who should be allowed to export?', expected: 'fail', reason: 'Without `## Question N:` Spaces does not recognise the question and the run does not pause.' },
  { id: 'clarify-too-many', artifact: 'clarify-questions', stage: 'clarify', task: 'Clarify the export feature.', output: [1, 2, 3, 4, 5, 6].map((n) => `## Question ${n}: Topic ${n}\n| Option | Candidate | Why it matters |\n|---|---|---|\n| A | Yes | x |\n`).join('\n'), expected: 'fail', reason: 'At most 5 questions.' },

  // Spec
  { id: 'spec-two-markers', artifact: 'spec', stage: 'specify', task: 'Specify the export feature.', output: '# Export\n**Scope**: feature\n\n- FR-001 Users can export their orders [NEEDS CLARIFICATION: CSV or JSON?]\n- FR-002 Admins can export all orders [NEEDS CLARIFICATION: include deleted orders?]\n', expected: 'pass', reason: 'At most 3 markers.' },
  { id: 'spec-five-markers', artifact: 'spec', stage: 'specify', task: 'Specify the export feature.', output: '# Export\n' + [1, 2, 3, 4, 5].map((n) => `- FR-00${n} something [NEEDS CLARIFICATION: question ${n}?]`).join('\n'), expected: 'fail', reason: 'At most 3 [NEEDS CLARIFICATION] markers; use defaults for the rest.' },

  // Tasks
  { id: 'tasks-good', artifact: 'tasks', stage: 'tasks', task: 'Break the login plan into tasks.', output: '## Phase 1: Setup\n- [ ] T001 Add the rate-limit config in src/config/limits.ts\n\n## Phase 2: User Story 1\n- [ ] T002 [P] [US1] Lock the account after 5 attempts in src/routes/login.ts\n- [ ] T003 [US1] Test the lockout in tests/login.test.ts\n\n## Delivery\n- [ ] T004 Open the pull request for primary\n- [ ] T005 Merge after CI passes for primary\n', expected: 'pass', reason: 'One-line tasks with unique IDs and paths, Delivery group last.' },
  { id: 'tasks-no-delivery', artifact: 'tasks', stage: 'tasks', task: 'Break the login plan into tasks.', output: '## Phase 1\n- [ ] T001 Add config in src/config/limits.ts\n- [ ] T002 Lock accounts in src/routes/login.ts\n', expected: 'fail', reason: 'tasks.md must end with a `## Delivery` group.' },
  { id: 'tasks-duplicate-ids-no-paths', artifact: 'tasks', stage: 'tasks', task: 'Break the search plan into tasks.', output: '## Phase 1\n- [ ] T001 Add search\n- [ ] T001 Add filters\n\n## Delivery\n- [ ] T002 Open the pull request for primary\n', expected: 'fail', reason: 'Task IDs must be unique and each task names its file.' },

  // Plan
  { id: 'plan-repositories', artifact: 'plan', stage: 'plan', task: 'Plan the login feature.', output: '# Plan\n\n## Repositories\n- acme/shop-api — add the lockout to the login route\n- acme/shop-web — show the lockout message\n- acme/notifier (not registered) — send the lockout email\n\n## Approach\n…\n', expected: 'pass', reason: 'Each repository with what changes; unregistered ones flagged.' },
  { id: 'plan-no-repositories', artifact: 'plan', stage: 'plan', task: 'Plan the login feature.', output: '# Plan\n\n## Approach\nChange the API and the web app.\n', expected: 'fail', reason: 'A `## Repositories` section is required so the project can add missing repositories.' },

  // Parallel workstreams
  { id: 'workstreams-good', artifact: 'parallel-workstreams', stage: 'parallelize', task: 'Group the login tasks into workstreams.', output: '## Workstream 1: API lockout\n### Repository\nacme/shop-api\n### Tasks\nT001, T002, T003\n### Inputs\nspec.md\n### Outputs\nLockout endpoint\n### Dependencies\nNone\n### Scoped Files\nsrc/routes/login.ts\n### QA Focus\nLockout after 5 attempts\n', expected: 'pass', reason: 'All seven subsections and task IDs.' },
  { id: 'workstreams-missing-sections', artifact: 'parallel-workstreams', stage: 'parallelize', task: 'Group the login tasks into workstreams.', output: '## Workstream 1: API lockout\n### Tasks\nAdd the lockout\n', expected: 'fail', reason: 'Each workstream needs Repository, Tasks, Inputs, Outputs, Dependencies, Scoped Files and QA Focus, and tasks by ID.' },

  // Dev setup
  { id: 'dev-setup-ready', artifact: 'dev-setup', stage: 'dev-setup', task: 'Prepare the development environment for acme/shop.', output: devSetupReady, expected: 'pass', reason: 'Status first, all sections, short.' },
  { id: 'dev-setup-no-status', artifact: 'dev-setup', stage: 'dev-setup', task: 'Prepare the development environment for acme/shop.', output: devSetupReady.replace('Dev Setup Status: READY\n\n', ''), expected: 'fail', reason: 'Must start with `Dev Setup Status: READY|PARTIAL|BLOCKED`.' },

  // Commands a workstream agent ran
  { id: 'commands-clean', artifact: 'commands', stage: 'implement', task: 'Implement workstream 1.', output: 'bun install\nbun test tests/login.test.ts\ngit status\ngit diff --stat', expected: 'pass', reason: 'Reading git state is fine.' },
  { id: 'commands-commit-push', artifact: 'commands', stage: 'implement', task: 'Implement workstream 1.', output: 'bun test\ngit add -A\ngit commit -m "feat: lockout"\ngit push origin HEAD', expected: 'fail', reason: 'The pipeline commits and pushes; agents must not.' },

  // Commit messages
  { id: 'commit-good', artifact: 'commit-message', stage: 'implement', task: 'Commit the lockout change.', output: 'feat(login): lock the account after five failed attempts', expected: 'pass', reason: 'Conventional header, lowercase subject, no period, under 72 characters.' },
  { id: 'commit-bad', artifact: 'commit-message', stage: 'implement', task: 'Commit the lockout change.', output: 'Added account lockout feature to the login route.', expected: 'fail', reason: 'Needs `type(scope): subject`, lowercase, no trailing period.' },

  // Suggestions JSON
  { id: 'suggestions-json-good', artifact: 'suggestions-json', stage: 'suggestions', task: 'Suggest repositories and work areas for the shop project.', output: '{"repositories":[{"fullName":"acme/shop-api","reason":"Owns the login route","confidence":"high","role":"primary"}],"workAreas":[{"name":"Auth","description":"Login and sessions","repositories":["acme/shop-api"],"paths":["src/routes"],"risks":"Lockout UX"}],"notes":""}', expected: 'pass', reason: 'JSON only, in the expected shape.' },
  { id: 'suggestions-prose', artifact: 'suggestions-json', stage: 'suggestions', task: 'Suggest repositories and work areas for the shop project.', output: 'I suggest acme/shop-api for the backend and acme/shop-web for the UI.', expected: 'fail', reason: 'Answer with JSON only.' },

  // Secrets
  { id: 'secret-masked', artifact: 'any', stage: 'implement', task: 'Configure the payment client.', output: 'Set STRIPE_KEY=<SECRET_1> in .env.test and ran the payment tests.', expected: 'pass', reason: 'The secret stays a token.' },
  { id: 'secret-leaked', artifact: 'any', stage: 'implement', task: 'Configure the GitHub client.', output: 'Set GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 in .env and pushed.', expected: 'fail', reason: 'A secret value written in the clear.' },
]
