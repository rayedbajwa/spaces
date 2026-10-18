import { afterAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { IMPLEMENT_LOOP_MAX_PASSES, implementLoopTemplate } from '../src/lib/implement-loop'
import { PipelineEngine } from '../src/lib/pipeline-engine'
import type { StepNavigatorResult } from '../src/lib/aidlc'

const dirs: string[] = []
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }) })

/** Drive the engine's navigator the way the flow does, with stage results written to disk. */
async function harness(options: { codeRepo?: string; priorVisits?: Record<string, number>; startAt?: number } = {}) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'impl-loop-'))
  dirs.push(cwd)
  const feature = path.join(cwd, 'specs', '001-x')
  await mkdir(feature, { recursive: true })
  const engine = new PipelineEngine(implementLoopTemplate(), {
    cwd,
    model: 'test/model',
    ...(options.codeRepo ? { repoTargets: [{ label: 'code', localPath: options.codeRepo }] } : {}),
    ...(options.priorVisits ? { priorVisits: options.priorVisits } : {}),
  } as never, {})
  const internals = engine as unknown as {
    buildNavigator: () => (ctx: { currentIndex: number; stage: string; stages: string[] }) => Promise<StepNavigatorResult>
    noteStepStart: (step: unknown) => Promise<void>
  }
  const navigate = internals.buildNavigator()
  const template = implementLoopTemplate()
  const stages = ['implement', 'review', 'verify']
  let index = options.startAt ?? 0
  const trail: string[] = []
  /** Finish the current stage, apply the navigator's answer, return the next stage or 'end'. */
  const finish = async (work?: () => Promise<void>): Promise<string> => {
    // As the stage's preamble does: a loop-back re-run records the code it starts from.
    await internals.noteStepStart(template.steps.find((s) => s.stage === stages[index])!)
    await work?.()
    trail.push(stages[index]!)
    const result = await navigate({ currentIndex: index, stage: stages[index]!, stages: [...stages] })
    if (result.extendStages) stages.push(...result.extendStages)
    index = result.nextIndex ?? index + 1
    return stages[index] ?? 'end'
  }
  const review = (status: string) => writeFile(path.join(feature, 'code-review.md'), `Code Review Status: ${status}\n`)
  const verification = (status: string, met = 10, total = 10, critical = 0) =>
    writeFile(path.join(feature, 'verification-report.md'), `Verification Status: ${status}\nAcceptance Criteria Met: ${met}/${total}\nCritical Issues Open: ${critical}\n`)
  return { finish, review, verification, trail }
}

async function gitRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'impl-loop-code-'))
  dirs.push(dir)
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'ignore' })
  git('init', '-q')
  await writeFile(path.join(dir, 'README.md'), 'x\n')
  git('add', '.')
  git('commit', '-qm', 'init')
  return dir
}

async function commit(dir: string, file: string): Promise<void> {
  await writeFile(path.join(dir, file), `${file}\n`)
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'ignore' })
  git('add', '.')
  git('commit', '-qm', file)
}

describe('implement loop', () => {
  test('review sends it back to implement, then it carries on through review and QA', async () => {
    const h = await harness()
    expect(await h.finish()).toBe('review')             // implement → review
    await h.review('CHANGES_REQUESTED')
    expect(await h.finish()).toBe('implement')          // review → back to implement
    expect(await h.finish()).toBe('review')             // the loop continues, it does not stop after implement
    await h.review('APPROVED')
    expect(await h.finish()).toBe('verify')             // approved → QA
    await h.verification('PASS')
    expect(await h.finish()).toBe('end')
    expect(h.trail).toEqual(['implement', 'review', 'implement', 'review', 'verify'])
  })

  test('QA close enough to accept ends the loop; short of that goes back to implement', async () => {
    const h = await harness()
    await h.finish()
    await h.review('APPROVED')
    await h.finish()
    await h.verification('PARTIAL', 30, 50, 2)
    expect(await h.finish()).toBe('implement')          // 60%, critical open → fix
    expect(await h.finish()).toBe('review')
    expect(await h.finish()).toBe('verify')
    await h.verification('PARTIAL', 49, 50, 0)
    expect(await h.finish()).toBe('end')                // 98%, nothing critical → stop, a person accepts
  })

  test('a verify that moved nothing since the last pass ends the loop', async () => {
    const h = await harness()
    await h.finish()
    await h.review('APPROVED')
    await h.finish()
    await h.verification('PARTIAL', 30, 50, 2)
    expect(await h.finish()).toBe('implement')          // first verify: fix what it flagged
    expect(await h.finish()).toBe('review')
    expect(await h.finish()).toBe('verify')
    await h.verification('PARTIAL', 30, 50, 2)
    expect(await h.finish()).toBe('end')                // same 30/50: another pass would land here too
  })

  test(`implement runs at most ${IMPLEMENT_LOOP_MAX_PASSES} times`, async () => {
    const h = await harness()
    await h.review('CHANGES_REQUESTED')
    let next = await h.finish()
    for (let i = 0; i < 20 && next !== 'end'; i += 1) next = await h.finish()
    expect(next).toBe('end')
    expect(h.trail.filter((s) => s === 'implement').length).toBe(IMPLEMENT_LOOP_MAX_PASSES)
  })

  test('a re-run of implement that changes no code ends the loop', async () => {
    const repo = await gitRepo()
    const h = await harness({ codeRepo: repo })
    await h.finish(() => commit(repo, 'a.ts'))           // first pass writes code
    await h.review('APPROVED')
    await h.finish()
    await h.verification('PARTIAL', 27, 31, 0)            // 87%: short of accepting
    expect(await h.finish()).toBe('implement')
    expect(await h.finish(() => commit(repo, 'b.ts'))).toBe('review')  // a fix: the loop carries on
    expect(await h.finish()).toBe('verify')
    await h.verification('PARTIAL', 29, 31, 0)            // progress (93.5%), still short of accepting
    expect(await h.finish()).toBe('implement')
    expect(await h.finish()).toBe('end')                  // nothing changed this time: stop, not another round
    expect(h.trail).toEqual(['implement', 'review', 'verify', 'implement', 'review', 'verify', 'implement'])
  })

  test('uncommitted changes count as a change', async () => {
    const repo = await gitRepo()
    const h = await harness({ codeRepo: repo })
    await h.review('APPROVED')
    await h.finish()
    await h.finish()
    await h.verification('FAIL', 1, 10, 1)
    await h.finish()
    expect(await h.finish(() => writeFile(path.join(repo, 'wip.ts'), 'x\n'))).toBe('review')
  })

  test('the iteration cap counts passes from before a restart', async () => {
    // Resumed at review with three implement passes already behind it.
    const h = await harness({ priorVisits: { 'code-generation': IMPLEMENT_LOOP_MAX_PASSES - 1, 'code-review': 3, 'build-and-test': 2 }, startAt: 1 })
    await h.review('APPROVED')
    await h.finish()
    await h.verification('FAIL', 1, 10, 1)
    expect(await h.finish()).toBe('implement')            // the last pass allowed
    await h.finish()
    await h.finish()
    expect(await h.finish()).toBe('end')
    expect(h.trail.filter((s) => s === 'implement').length).toBe(1)
  })

  test('no approval gates inside the loop', () => {
    for (const step of implementLoopTemplate().steps) {
      expect(step.humanGate ?? false).toBe(false)
      expect(step.review ?? false).toBe(false)
    }
  })
})
