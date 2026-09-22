import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { IMPLEMENT_LOOP_MAX_PASSES, implementLoopTemplate } from '../src/lib/implement-loop'
import { PipelineEngine } from '../src/lib/pipeline-engine'
import type { StepNavigatorResult } from '../src/lib/aidlc'

const dirs: string[] = []
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }) })

/** Drive the engine's navigator the way the flow does, with stage results written to disk. */
async function harness() {
  const cwd = await mkdtemp(path.join(tmpdir(), 'impl-loop-'))
  dirs.push(cwd)
  const feature = path.join(cwd, 'specs', '001-x')
  await mkdir(feature, { recursive: true })
  const engine = new PipelineEngine(implementLoopTemplate(), { cwd, model: 'test/model' } as never, {})
  const navigate = (engine as unknown as { buildNavigator: () => (ctx: { currentIndex: number; stage: string; stages: string[] }) => Promise<StepNavigatorResult> }).buildNavigator()
  const stages = ['implement', 'review', 'verify']
  let index = 0
  const trail: string[] = []
  /** Finish the current stage, apply the navigator's answer, return the next stage or 'end'. */
  const finish = async (): Promise<string> => {
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

  test(`implement runs at most ${IMPLEMENT_LOOP_MAX_PASSES} times`, async () => {
    const h = await harness()
    await h.review('CHANGES_REQUESTED')
    let next = await h.finish()
    for (let i = 0; i < 20 && next !== 'end'; i += 1) next = await h.finish()
    expect(next).toBe('end')
    expect(h.trail.filter((s) => s === 'implement').length).toBe(IMPLEMENT_LOOP_MAX_PASSES)
  })

  test('no approval gates inside the loop', () => {
    for (const step of implementLoopTemplate().steps) {
      expect(step.humanGate ?? false).toBe(false)
      expect(step.review ?? false).toBe(false)
    }
  })
})
