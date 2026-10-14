import { afterAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { codeChanged, implementStalled, renderImplementResult, snapshotCheckouts } from '../src/lib/implement-progress'

/** Whether an implement pass changed code: specs/ notes never count. */
describe('implement progress', () => {
  const dirs: string[] = []
  afterAll(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }) })

  async function repo(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'implement-progress-'))
    dirs.push(dir)
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' })
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 'test@example.test')
    git('config', 'user.name', 'Test')
    await writeFile(path.join(dir, 'app.ts'), 'export const a = 1\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
    return dir
  }
  const commit = (dir: string, message: string) => {
    execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'ignore' })
    execFileSync('git', ['-C', dir, 'commit', '-q', '-m', message], { stdio: 'ignore' })
  }

  test('a commit that only touches specs/ is no change', async () => {
    const dir = await repo()
    const before = snapshotCheckouts([dir])
    await mkdir(path.join(dir, 'specs/001'), { recursive: true })
    await writeFile(path.join(dir, 'specs/001/tasks.md'), '## Iteration 55 — no-op\n')
    commit(dir, 'docs: record no-op')
    expect(codeChanged(before, snapshotCheckouts([dir]))).toBe(false)
  })

  test('a code commit, a new branch with code, or uncommitted code is a change', async () => {
    const dir = await repo()
    let before = snapshotCheckouts([dir])
    await writeFile(path.join(dir, 'app.ts'), 'export const a = 2\n')
    expect(codeChanged(before, snapshotCheckouts([dir]))).toBe(true)
    commit(dir, 'fix')
    expect(codeChanged(before, snapshotCheckouts([dir]))).toBe(true)

    before = snapshotCheckouts([dir])
    execFileSync('git', ['-C', dir, 'checkout', '-q', '-b', 'feature/x'], { stdio: 'ignore' })
    await writeFile(path.join(dir, 'b.ts'), 'export const b = 1\n')
    commit(dir, 'feature')
    expect(codeChanged(before, snapshotCheckouts([dir]))).toBe(true)
  })

  test('stalled only against the report implement worked from', () => {
    const report = 'Verification Status: PARTIAL\nAcceptance Criteria Met: 1/2\n'
    expect(implementStalled(report, renderImplementResult({ changed: false, verificationReport: report }))).toBe(true)
    expect(implementStalled(`${report}\nnew line`, renderImplementResult({ changed: false, verificationReport: report }))).toBe(false)
    expect(implementStalled(report, renderImplementResult({ changed: true, verificationReport: report }))).toBe(false)
    expect(implementStalled(report, renderImplementResult({ changed: false }))).toBe(false)
  })
})
