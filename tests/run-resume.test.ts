import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildResumeNote, describeWorkInProgress, findUnfinishedFeature, implementationTaskProgress, parseTaskProgress, resolveResumePoint } from '../src/lib/run-resume'
import type { StageName } from '../src/lib/aidlc'

/**
 * An interrupted run must continue where it stopped: stages whose artifacts are
 * already written are not redone, and a half-finished task list carries over.
 */

const STAGES: StageName[] = ['init', 'specify', 'plan', 'tasks', 'testplan', 'implement', 'verify']
const roots: string[] = []

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'resume-'))
  roots.push(root)
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, content)
  }
  return root
}

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

describe('task progress', () => {
  test('counts ticked and open tasks', () => {
    const progress = parseTaskProgress(`## Phase 1\n- [x] T001 Set up the schema\n- [X] T002 [P] Seed data\n- [ ] T003 Wire the endpoint\n- not a task\n`)
    expect(progress).toEqual({ done: 2, total: 3, remaining: ['T003'], completed: ['T001', 'T002'] })
  })

  test('a file with no checkboxes has no tasks', () => {
    expect(parseTaskProgress('# Tasks\n\nNothing here yet.\n').total).toBe(0)
  })
})

describe('resume point', () => {
  test('continues after the stages whose artifacts exist', async () => {
    const root = await project({
      '.specify/memory/constitution.md': '# Constitution',
      'specs/001-feature/spec.md': '# Spec',
      'specs/001-feature/plan.md': '# Plan',
    })
    const point = await resolveResumePoint({ projectPath: root, stages: STAGES })
    expect(point.stage).toBe('tasks')
    expect(point.completed).toContain('specify')
    expect(point.completed).toContain('plan')
  })

  test('never moves back before the stage the run was on', async () => {
    const root = await project({
      '.specify/memory/constitution.md': '# Constitution',
      'specs/001-feature/spec.md': '# Spec',
    })
    const point = await resolveResumePoint({ projectPath: root, stages: STAGES, recorded: 'testplan' })
    expect(point.stage).toBe('testplan')
  })

  test('an empty artifact does not count as done', async () => {
    const root = await project({ '.specify/memory/constitution.md': '# Constitution', 'specs/001-feature/spec.md': '   \n' })
    const point = await resolveResumePoint({ projectPath: root, stages: STAGES })
    expect(point.stage).toBe('specify')
  })

  test('Delivery tasks belong to deliver: they neither hold implement back nor show up as work to resume', async () => {
    const root = await project({
      '.specify/memory/constitution.md': '# Constitution',
      'specs/001-feature/spec.md': '# Spec',
      'specs/001-feature/plan.md': '# Plan',
      'specs/001-feature/tasks.md': '## Phase 1\n- [x] T001 Build\n- [x] T002 Test\n## Delivery\n- [ ] T010 Open the PR\n- [ ] T011 Merge\n',
      'specs/001-feature/test-plan.md': '# Tests',
    })
    const point = await resolveResumePoint({ projectPath: root, stages: STAGES })
    expect(point.completed).toContain('implement')
    expect(point.stage).toBe('verify')
    expect(point.taskProgress?.remaining).toEqual([])
  })

  test('implement is finished only when every task is ticked', async () => {
    const half = await project({
      '.specify/memory/constitution.md': '# Constitution',
      'specs/001-feature/spec.md': '# Spec',
      'specs/001-feature/plan.md': '# Plan',
      'specs/001-feature/tasks.md': '- [x] T001 Done\n- [ ] T002 Open\n',
      'specs/001-feature/test-plan.md': '# Tests',
    })
    const halfway = await resolveResumePoint({ projectPath: half, stages: STAGES, recorded: 'implement' })
    expect(halfway.stage).toBe('implement')
    expect(halfway.taskProgress).toEqual({ done: 1, total: 2, remaining: ['T002'], completed: ['T001'] })
    expect(buildResumeNote(halfway)).toContain('1 of 2 tasks')
    expect(buildResumeNote(halfway)).toContain('T002')

    const finished = await project({
      '.specify/memory/constitution.md': '# Constitution',
      'specs/001-feature/spec.md': '# Spec',
      'specs/001-feature/plan.md': '# Plan',
      'specs/001-feature/tasks.md': '- [x] T001 Done\n- [x] T002 Done\n',
      'specs/001-feature/test-plan.md': '# Tests',
    })
    expect((await resolveResumePoint({ projectPath: finished, stages: STAGES })).stage).toBe('verify')
  })

  test('a project with nothing on disk starts at the first stage', async () => {
    const root = await project({ 'README.md': 'empty' })
    const point = await resolveResumePoint({ projectPath: root, stages: STAGES })
    expect(point.stage).toBe('init')
    expect(point.completed).toEqual([])
  })
})

describe('work in progress guardrail', () => {
  test('tells specify to continue an unfinished feature', async () => {
    const root = await project({
      '.specify/memory/constitution.md': '# Constitution',
      'specs/002-roles/spec.md': '# Spec',
      'specs/002-roles/plan.md': '# Plan',
      'specs/002-roles/tasks.md': '- [x] T001 Done\n- [ ] T002 Open\n',
    })
    const note = await describeWorkInProgress(root, 'specify')
    expect(note).toContain('002-roles')
    expect(note).toContain('1 of 2 done')
    expect(note).toContain('Do not create a new feature directory')
    expect(note).toContain('already initialized')
  })

  test('a requested new feature is not told to continue the unfinished one', async () => {
    const root = await project({
      '.specify/memory/constitution.md': '# Constitution',
      'specs/002-roles/spec.md': '# Spec',
    })
    const note = await describeWorkInProgress(root, 'specify', { newFeature: true })
    expect(note).not.toContain('002-roles')
    expect(note).not.toContain('Do not create a new feature directory')
    expect(note).toContain('already initialized')
  })

  test('says nothing once the feature has passed verification', async () => {
    const root = await project({
      '.specify/memory/constitution.md': '# Constitution',
      'specs/003-done/spec.md': '# Spec',
      'specs/003-done/verification-report.md': '# Verification\n\nStatus: PASS\n',
    })
    const note = await describeWorkInProgress(root, 'specify')
    expect(note).not.toContain('Do not create a new feature directory')
  })

  test('warns init about an initialized project and leaves other stages alone', async () => {
    const root = await project({ '.specify/memory/constitution.md': '# Constitution' })
    expect(await describeWorkInProgress(root, 'init')).toContain('already initialized')
    expect(await describeWorkInProgress(root, 'implement')).toBe('')
  })

  test('says nothing for a project with nothing in it', async () => {
    const root = await project({ 'README.md': 'empty' })
    expect(await describeWorkInProgress(root, 'specify')).toBe('')
  })
})

describe('unfinished feature detection', () => {
  test('reports the feature, its documents and its task progress', async () => {
    const root = await project({
      '.specify/memory/constitution.md': '# Constitution',
      'specs/003-responsibilities/spec.md': '# Spec',
      'specs/003-responsibilities/tasks.md': '- [x] T001 Done\n- [ ] T002 Open\n- [ ] T003 Open\n',
    })
    const unfinished = await findUnfinishedFeature(root)
    expect(unfinished?.name).toBe('003-responsibilities')
    expect(unfinished?.artifacts).toEqual(['spec.md', 'tasks.md'])
    expect(unfinished?.tasks?.done).toBe(1)
    expect(unfinished?.verificationFailed).toBe(false)
  })

  test('a verified feature is finished', async () => {
    const root = await project({
      'specs/004-done/spec.md': '# Spec',
      'specs/004-done/verification-report.md': '## Overall status: **PASS**\n',
    })
    expect(await findUnfinishedFeature(root)).toBeUndefined()
  })

  test('a delivered or accepted feature is finished even at partial verification', async () => {
    const delivered = await project({
      'specs/006-shipped/spec.md': '# Spec',
      'specs/006-shipped/verification-report.md': 'Verification Status: PARTIAL\n',
      'specs/006-shipped/delivery-report.md': 'Delivery Status: MERGED\n',
    })
    expect(await findUnfinishedFeature(delivered)).toBeUndefined()
    const accepted = await project({
      'specs/007-accepted/spec.md': '# Spec',
      'specs/007-accepted/verification-report.md': 'Verification Status: PARTIAL\n',
      'specs/007-accepted/acceptance.md': '# Acceptance\n',
    })
    expect(await findUnfinishedFeature(accepted)).toBeUndefined()
  })

  test('a failed verification leaves the feature unfinished', async () => {
    const root = await project({
      'specs/005-failing/spec.md': '# Spec',
      'specs/005-failing/verification-report.md': '## Overall status: FAIL\n',
    })
    const unfinished = await findUnfinishedFeature(root)
    expect(unfinished?.name).toBe('005-failing')
    expect(unfinished?.verificationFailed).toBe(true)
  })

  test('an empty feature directory is not work in progress', async () => {
    const root = await project({ 'specs/006-empty/.keep': '' })
    expect(await findUnfinishedFeature(root)).toBeUndefined()
  })
})

describe('implementationTaskProgress', () => {
  test('leaves out the Delivery group and everything nested under it', () => {
    const md = [
      '## Phase 1', '- [x] T001 build', '- [x] T002 test',
      '## Delivery', '### app repo', '- [ ] T010 open PR', '- [ ] T011 merge',
      '## Polish', '- [ ] T020 docs',
    ].join('\n')
    const p = implementationTaskProgress(md)
    expect(p.done).toBe(2)
    expect(p.total).toBe(3)
    expect(p.remaining).toEqual(['T020'])
  })
})
