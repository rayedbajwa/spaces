import { afterAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { changedFiles, touchesContainerBuild } from '../src/lib/change-scope'
import { testTierInstruction } from '../src/lib/test-tiers'

const cleanup: string[] = []
afterAll(async () => { for (const d of cleanup) await rm(d, { recursive: true, force: true }) })
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'pipe' })
const write = async (root: string, rel: string, text = 'x\n') => { await mkdir(path.dirname(path.join(root, rel)), { recursive: true }); await writeFile(path.join(root, rel), text) }

describe('the impacted area of an intent', () => {
  test('files the branch changed against the default branch, plus uncommitted work; specs excluded', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'scope-'))
    cleanup.push(repo)
    git(repo, 'init', '-q', '-b', 'main')
    await write(repo, 'src/untouched.ts'); await write(repo, 'src/search.ts')
    git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base')
    git(repo, 'checkout', '-qb', '003-search')
    await write(repo, 'src/search.ts', 'changed\n'); await write(repo, 'specs/003-search/spec.md')
    git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'work')
    await write(repo, 'tests/search.test.ts') // not committed yet
    expect(changedFiles(repo)).toEqual(['src/search.ts', 'tests/search.test.ts'])
    expect(changedFiles(repo, 'main')).toEqual(['src/search.ts', 'tests/search.test.ts'])
  })

  test('a container build is worth it only when what the image is built from changed', () => {
    expect(touchesContainerBuild(['src/a.ts', 'tests/a.test.ts'])).toBe(false)
    for (const f of ['Dockerfile', 'deploy/Dockerfile.prod', 'docker-compose.yml', 'compose.prod.yaml', 'package.json', 'bun.lock', 'services/api/go.mod', 'requirements-dev.txt']) expect([f, touchesContainerBuild([f])]).toEqual([f, true])
  })

  test('review and verify are told the area, to test only it, and when to build the image', () => {
    const scope = [{ label: 'api', files: ['src/search.ts', 'tests/search.test.ts'] }, { label: 'governance', files: [] }]
    const review = testTierInstruction('review', { testPort: 3456 }, scope)
    expect(review).toContain('**api** (2 files): `src/search.ts`, `tests/search.test.ts`')
    expect(review).not.toContain('governance')
    expect(review).toContain('CI runs it')
    const verify = testTierInstruction('verify', { testPort: 3456 }, scope)
    expect(verify).toContain('skip the image build')
    expect(verify).toContain('for the user flows the change affects')
    expect(testTierInstruction('verify', { testPort: 1 }, [{ label: 'api', files: ['Dockerfile'] }])).toContain('build the image once')
    expect(testTierInstruction('review', { testPort: 1 }, [])).toContain('could not be listed')
  })
})
