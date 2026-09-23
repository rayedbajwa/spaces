import { touchesContainerBuild } from './change-scope'

/**
 * Which tests a stage runs.
 *
 * Every stage used to run whatever it thought best, which in practice meant
 * the whole suite, a Docker build and a full-application smoke test on each
 * implement pass. On a shared machine that is minutes per pass, and every
 * minute holds a worker slot other projects are waiting for. Tests are tiered
 * by what each stage needs to know:
 *
 * - implement / orchestrate: the tests covering what changed, fast, as often
 *   as needed while working.
 * - review: the tests of the impacted area — the files the intent changed
 *   (listed for it) and what uses them — not the whole suite.
 * - verify: the impacted area's tests, the application started with
 *   smoke/end-to-end tests for the affected flows, and the container build
 *   only when the change touches what the image is built from.
 *
 * The full suite and image build run in CI on the pull request.
 */

type Stage = string

/** What an intent changed, per checkout, for scoping the quality stages' tests. */
export interface ChangeScope { label: string; files: string[] }

function describeScope(scope: ChangeScope[] | undefined): string {
  const touched = (scope ?? []).filter((c) => c.files.length > 0)
  if (!touched.length) return 'The files this intent changed could not be listed: work out the impacted area from its tasks and the diff (`git diff --stat` against the default branch) before testing.'
  return ['The impacted area — what this intent changed (against each repository\'s default branch, specs excluded):', ...touched.map((c) => `- **${c.label}** (${c.files.length} file${c.files.length === 1 ? '' : 's'}): ${c.files.slice(0, 40).map((f) => `\`${f}\``).join(', ')}${c.files.length > 40 ? ', …' : ''}`)].join('\n')
}

export function testTierInstruction(stage: Stage, env: { testPort: number }, scope?: ChangeScope[]): string {
  const common = `Put a time limit on anything long (\`timeout 600 …\`), and stop what you start: servers on port ${env.testPort} and containers you brought up are stopped for you when the stage ends, but a hung command holds the machine until then.`
  const scoped = [
    'Run only the tests for the impacted area: the tests of the files listed, the tests of the modules that import them, and tests for the intent\'s acceptance criteria — for example `bun test <paths>`, `npx vitest related <files>`, `npx jest --findRelatedTests <files>`, `pytest <paths>`, `go test ./<changed packages>/...`. Do not run the whole suite: CI runs it on the pull request. If something outside the area looks affected (a shared type, a migration, configuration), include the tests that cover it and say why.',
  ].join('\n\n')
  if (stage === 'implement' || stage === 'orchestrate') {
    return [
      '## Tests in this stage: only what you changed',
      'Run the tests that cover the files you changed, as often as you need while working — for example `bun test <path>`, `npx vitest related <files>`, `npx jest --findRelatedTests <files>`, `pytest <path>`, `go test ./<pkg>/...`.',
      'Do not run the whole suite, build container images or start the full application here unless a task explicitly requires it: review and verify test the impacted area, and CI runs the full suite.',
      common,
    ].join('\n\n')
  }
  if (stage === 'review') {
    return [
      '## Tests in this stage: the impacted area',
      describeScope(scope),
      scoped,
      'Skip container builds and end-to-end runs — verify does those where the change needs them.',
      common,
    ].join('\n\n')
  }
  if (stage === 'verify') {
    const container = (scope ?? []).some((c) => touchesContainerBuild(c.files))
    return [
      '## Tests in this stage: the impacted area, and what the verdict needs',
      describeScope(scope),
      scoped,
      `Start the application (PORT=${env.testPort}) and run smoke/end-to-end tests for the user flows the change affects — not the whole end-to-end suite.`,
      container
        ? 'The change touches what the container image is built from (a Dockerfile, Compose file or dependency manifest): build the image once.'
        : 'The change does not touch what the container image is built from: skip the image build (CI builds it).',
      'Record in the verification report which tests you ran for which part of the scope, and that the full suite is left to CI.',
      common,
    ].join('\n\n')
  }
  return ''
}
