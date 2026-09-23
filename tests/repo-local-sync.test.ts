import { afterAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AIDLCFlow } from '../src/lib/aidlc'

const cleanup: string[] = []
afterAll(async () => { for (const d of cleanup) await rm(d, { recursive: true, force: true }) })

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'pipe' }).toString()

async function repo(name: string, files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `${name}-`))
  cleanup.push(root)
  git(root, 'init', '-q', '-b', 'main')
  for (const [rel, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, rel)), { recursive: true }); await writeFile(path.join(root, rel), text) }
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'base')
  git(root, 'checkout', '-qb', '003-search')
  return root
}

describe('code stages write the repo-local change into implementation repositories', () => {
  test('only change.yaml, the repository\'s tasks (ticked as in the governing tasks) and its delta spec — nothing else', async () => {
    const governing = await repo('governance', {
      'specs/003-search/spec.md': '# Feature Specification: Search\n',
      'specs/003-search/plan.md': '# Plan\n',
      'specs/003-search/test-plan.md': '# Test plan\n',
      'specs/003-search/contracts/search.yaml': 'openapi: 3.1.0\n',
      'specs/003-search/tasks.md': '## Build\n- [x] T001 Add search index in api\n- [ ] T002 Search box in web\n',
    })
    const api = await repo('api', {
      'src/index.ts': 'export {}\n',
      // What an earlier version mirrored here: exact copies of the governing documents.
      'specs/003-search/plan.md': '# Plan\n',
      'specs/003-search/test-plan.md': '# Test plan\n',
      'specs/003-search/contracts/search.yaml': 'openapi: 3.1.0\n',
      // Written in this repository: stays.
      'specs/003-search/notes.md': 'api-only notes\n',
    })
    await writeFile(path.join(api, 'src/search.ts'), 'export const search = 1\n') // work on the branch
    const flow = new AIDLCFlow({ cwd: governing, repoTargets: [{ label: 'governance', localPath: governing, isPrimary: true }, { label: 'api', localPath: api }] }, ['implement'])
    ;(flow as unknown as { activeFeatureBranch: string }).activeFeatureBranch = '003-search'
    await (flow as unknown as { syncIntentDocumentsToImplementationRepos: (s: string) => Promise<void> }).syncIntentDocumentsToImplementationRepos('implement')

    // The numbered directory, as in the governing workspace: its repo-local change, nothing that belongs in Spaces.
    expect((await readdir(path.join(api, 'specs'))).sort()).toEqual(['003-search'])
    expect((await readdir(path.join(api, 'specs/003-search'))).sort()).toEqual(['change.yaml', 'notes.md', 'spec.md', 'tasks.md'])
    const tasks = await readFile(path.join(api, 'specs/003-search/tasks.md'), 'utf8')
    expect(tasks).toContain('- [x] T001 Add search index in api')
    expect(tasks).not.toContain('T002')
    expect(await readFile(path.join(api, 'specs/003-search/change.yaml'), 'utf8')).toContain('initiative: 003-search')
  })

  test('never writes over the intent itself when the implementation repository is the one that holds it', async () => {
    const { writeRepoChange } = await import('../src/lib/repo-change')
    const app = await repo('app', { 'specs/003-search/spec.md': '# Feature Specification: Search\n', 'specs/003-search/tasks.md': '- [ ] T001 real task\n' })
    const worktree = path.join(await mkdtemp(path.join(tmpdir(), 'wt-')), 'ws-1')
    cleanup.push(path.dirname(worktree))
    git(app, 'worktree', 'add', '-q', '-b', 'ws-1', worktree)
    const plan = { initiativeId: '003-search', changes: [{ repo: { label: 'app', localPath: worktree }, changeId: '003-search', project: 'local/app', workstreams: [{ title: 'x', tasks: '- delta' }] }] }
    await writeRepoChange({ cwd: worktree, featureDir: path.join(app, 'specs/003-search'), plan, change: plan.changes[0]! })
    expect(await readFile(path.join(worktree, 'specs/003-search/spec.md'), 'utf8')).toBe('# Feature Specification: Search\n')
    expect(await readFile(path.join(worktree, 'specs/003-search/tasks.md'), 'utf8')).toBe('- [ ] T001 real task\n')
    expect(await readFile(path.join(worktree, 'specs/003-search/change.yaml'), 'utf8').catch(() => null)).toBeNull()
  })

  test('a repo-local change is never written through a symbolic link', async () => {
    const { writeRepoChange } = await import('../src/lib/repo-change')
    const governing = await repo('governance2', { 'specs/003-search/spec.md': '# Search\n' })
    const api = await repo('api2', { 'README.md': 'x\n' })
    const outside = await mkdtemp(path.join(tmpdir(), 'outside-'))
    cleanup.push(outside)
    await symlink(outside, path.join(api, 'specs'))
    const plan = { initiativeId: '003-search', changes: [{ repo: { label: 'api2', localPath: api }, changeId: '003-search', project: 'local/api2', workstreams: [{ title: 'x', tasks: '- y' }] }] }
    await expect(writeRepoChange({ cwd: api, featureDir: path.join(governing, 'specs/003-search'), plan, change: plan.changes[0]! })).rejects.toThrow('not a plain directory')
    expect(await readdir(outside)).toEqual([])
  })

  test('a task mentioning a word that merely contains the repository name is not its task', async () => {
    const governing = await repo('governance3', {
      'specs/003-search/spec.md': '# Search\n',
      'specs/003-search/tasks.md': '- [ ] T001 Build index in api/src\n- [ ] T002 Render results rapidly in web\n',
    })
    const api = await repo('api', { 'src/a.ts': 'x\n' })
    await writeFile(path.join(api, 'src/b.ts'), 'y\n')
    const flow = new AIDLCFlow({ cwd: governing, repoTargets: [{ label: 'governance', localPath: governing, isPrimary: true }, { label: 'api', localPath: api }] }, ['implement'])
    ;(flow as unknown as { activeFeatureBranch: string }).activeFeatureBranch = '003-search'
    await (flow as unknown as { syncIntentDocumentsToImplementationRepos: (s: string) => Promise<void> }).syncIntentDocumentsToImplementationRepos('implement')
    const tasks = await readFile(path.join(api, 'specs/003-search/tasks.md'), 'utf8')
    expect(tasks).toContain('T001')
    expect(tasks).not.toContain('T002')
  })
})
