import type { PipelineTemplate } from './pipeline-template'

/** How many times the implement loop may run implement before it stops and leaves the rest to a person. */
export const IMPLEMENT_LOOP_MAX_PASSES = 4

/**
 * Running implement is an autonomous loop, not a single step: implement, then
 * code review — back to implement while the review requests changes — then QA,
 * back to implement until verification passes or comes close enough to accept
 * (more than 95% of criteria met, nothing critical open). No approval gates
 * inside the loop; implement runs at most IMPLEMENT_LOOP_MAX_PASSES times, and
 * re-runs work only on what the review or the verification report flagged.
 */
export function implementLoopTemplate(role?: string): PipelineTemplate {
  return {
    name: 'adhoc-implement-loop',
    version: 1,
    description: 'Implement, code review and QA in a loop until review approves and verification passes or comes close.',
    steps: [
      { id: 'code-generation', stage: 'implement', maxIterations: IMPLEMENT_LOOP_MAX_PASSES, ...(role ? { role: role as never } : {}) },
      {
        id: 'code-review',
        stage: 'review',
        role: 'quality',
        maxIterations: IMPLEMENT_LOOP_MAX_PASSES,
        onComplete: { branch: [{ when: "code_review_status == 'changes_requested'", goto: 'code-generation' }] },
      },
      {
        id: 'build-and-test',
        stage: 'verify',
        role: 'quality',
        maxIterations: IMPLEMENT_LOOP_MAX_PASSES,
        onComplete: {
          branch: [
            { when: "verification_status == 'pass'", goto: 'end' },
            { when: "verification_near_pass == 'true'", goto: 'end' },
            { when: 'true', goto: 'code-generation' },
          ],
        },
      },
    ],
  }
}
