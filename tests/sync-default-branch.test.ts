import { afterAll, describe, expect, mock, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

mock.module('../src/lib/github-app-auth', () => ({ getGitHubActorToken: async () => 'test-token' }))
const { syncDefaultBranch } = await import('../src/lib/pull-requests')

const dirs: string[] = []
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }) })
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim()

/** An origin with main, a clone of it on a feature branch, and a way to push new commits to origin. */
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'sync-'))
  dirs.push(root)
  const origin = path.join(root, 'origin.git')
  const seed = path.join(root, 'seed')
  git(root, 'init', '-q', '--bare', '-b', 'main', origin)
  git(root, 'clone', '-q', origin, seed)
  await writeFile(path.join(seed, 'a.txt'), '1\n')
  git(seed, 'add', '.'); git(seed, 'commit', '-q', '-m', 'one'); git(seed, 'push', '-q', 'origin', 'main')
  const work = path.join(root, 'work')
  git(root, 'clone', '-q', origin, work)
  git(work, 'checkout', '-q', '-b', 'feat/001-old')
  const pushToOrigin = async (content: string) => {
    await writeFile(path.join(seed, 'a.txt'), content)
    git(seed, 'commit', '-qam', content.trim()); git(seed, 'push', '-q', 'origin', 'main')
    return git(seed, 'rev-parse', 'HEAD')
  }
  return { work, pushToOrigin }
}

describe('syncDefaultBranch', () => {
  test('switches from the old feature branch to main and fast-forwards to origin', async () => {
    const { work, pushToOrigin } = await setup()
    const latest = await pushToOrigin('2\n')
    const result = await syncDefaultBranch('org', work, 'acme/app')
    expect(result.skipped).toBeUndefined()
    expect(result.branch).toBe('main')
    expect(result.after).toBe(latest)
    expect(git(work, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
  })

  test('never touches uncommitted work', async () => {
    const { work, pushToOrigin } = await setup()
    await pushToOrigin('2\n')
    await writeFile(path.join(work, 'a.txt'), 'local edit\n')
    const result = await syncDefaultBranch('org', work, 'acme/app')
    expect(result.skipped).toContain('uncommitted')
    expect(git(work, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/001-old')
  })

  test('a main that diverged from origin is left alone', async () => {
    const { work, pushToOrigin } = await setup()
    git(work, 'checkout', '-q', 'main')
    await writeFile(path.join(work, 'b.txt'), 'local\n')
    git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'local only')
    await pushToOrigin('2\n')
    const result = await syncDefaultBranch('org', work, 'acme/app')
    expect(result.skipped).toContain('diverged')
  })

  test('a diverged main is not checked out: the checkout stays on its feature branch', async () => {
    const { work, pushToOrigin } = await setup()
    git(work, 'checkout', '-q', 'main')
    await writeFile(path.join(work, 'b.txt'), 'local\n')
    git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'local only')
    git(work, 'checkout', '-q', 'feat/001-old')
    await pushToOrigin('2\n')
    const result = await syncDefaultBranch('org', work, 'acme/app')
    expect(result.skipped).toContain('diverged')
    expect(git(work, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/001-old')
  })
})
