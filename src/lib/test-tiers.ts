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
 * - review: the whole unit/integration suite, once.
 * - verify: everything that gives the verdict — the full suite, the
 *   application started and smoke/end-to-end tests against it, and the
 *   container build when the project ships one.
 */

type Stage = string

export function testTierInstruction(stage: Stage, env: { testPort: number }): string {
  const common = `Put a time limit on anything long (\`timeout 600 …\`), and stop what you start: servers on port ${env.testPort} and containers you brought up are stopped for you when the stage ends, but a hung command holds the machine until then.`
  if (stage === 'implement' || stage === 'orchestrate') {
    return [
      '## Tests in this stage: only what you changed',
      'Run the tests that cover the files you changed, as often as you need while working — for example `bun test <path>`, `npx vitest related <files>`, `npx jest --findRelatedTests <files>`, `pytest <path>`, `go test ./<pkg>/...`.',
      'Do not run the whole suite, build container images or start the full application here unless a task explicitly requires it: review runs the full suite and verify runs the application, end-to-end tests and the container build.',
      common,
    ].join('\n\n')
  }
  if (stage === 'review') {
    return [
      '## Tests in this stage: the full suite, once',
      'Run the project\'s whole unit and integration suite once, and base the review on its result. Skip container builds and end-to-end runs — verify does those.',
      common,
    ].join('\n\n')
  }
  if (stage === 'verify') {
    return [
      '## Tests in this stage: everything the verdict needs',
      `Run the full suite; start the application (PORT=${env.testPort}) and run the smoke/end-to-end tests against it; build the container image when the project ships a Dockerfile. Run independent suites in parallel where the project allows it (e.g. separate processes for unit and end-to-end).`,
      common,
    ].join('\n\n')
  }
  return ''
}
