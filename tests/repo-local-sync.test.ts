import { afterAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
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
    const api = await repo('api', { 'src/index.ts': 'export {}\n' })
    await writeFile(path.join(api, 'src/search.ts'), 'export const search = 1\n') // work on the branch
    const flow = new AIDLCFlow({ cwd: governing, repoTargets: [{ label: 'governance', localPath: governing, isPrimary: true }, { label: 'api', localPath: api }] }, ['implement'])
    ;(flow as unknown as { activeFeatureBranch: string }).activeFeatureBranch = '003-search'
    await (flow as unknown as { syncIntentDocumentsToImplementationRepos: (s: string) => Promise<void> }).syncIntentDocumentsToImplementationRepos('implement')

    expect((await readdir(path.join(api, 'specs'))).sort()).toEqual(['search'])
    expect((await readdir(path.join(api, 'specs/search'))).sort()).toEqual(['change.yaml', 'spec.md', 'tasks.md'])
    const tasks = await readFile(path.join(api, 'specs/search/tasks.md'), 'utf8')
    expect(tasks).toContain('- [x] T001 Add search index in api')
    expect(tasks).not.toContain('T002')
    expect(await readFile(path.join(api, 'specs/search/change.yaml'), 'utf8')).toContain('initiative: search')
  })
})
