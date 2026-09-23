import { afterAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { activeFeatureDir, activeFeatureId, chosenFeatureId, removeFeatureDir, setActiveFeature } from '../src/lib/active-feature'
import { listFeatures } from '../src/lib/features'
import { readCodeReviewStatus, readVerificationStatus } from '../src/lib/pipeline-branch'
import { switchToFeatureBranch } from '../src/lib/pull-requests'

const roots: string[] = []
afterAll(async () => { for (const r of roots) await rm(r, { recursive: true, force: true }) })
async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'active-'))
  roots.push(root)
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true })
    await writeFile(path.join(root, rel), content)
  }
  return root
}
const twoFeatures = {
  'specs/001-login/spec.md': '# Login\n',
  'specs/001-login/code-review.md': 'Code Review Status: CHANGES_REQUESTED\n',
  'specs/001-login/verification-report.md': 'Verification Status: PARTIAL\n',
  'specs/002-billing/spec.md': '# Billing\n',
  'specs/002-billing/code-review.md': 'Code Review Status: APPROVED\n',
  'specs/002-billing/verification-report.md': 'Verification Status: PASS\n',
}

describe('active feature', () => {
  test('the newest is active until a person picks another; the choice is cleared back to the newest', async () => {
    const root = await project(twoFeatures)
    expect(activeFeatureId(root)).toBe('002-billing')
    await setActiveFeature(root, '001-login')
    expect(activeFeatureId(root)).toBe('001-login')
    expect(activeFeatureDir(root)).toBe(path.join(root, 'specs', '001-login'))
    await setActiveFeature(root, null)
    expect(activeFeatureId(root)).toBe('002-billing')
    await expect(setActiveFeature(root, '999-nope')).rejects.toThrow('does not exist')
  })

  test('stage reports and the features list follow the active feature', async () => {
    const root = await project(twoFeatures)
    expect(await readCodeReviewStatus(root)).toBe('approved')
    await setActiveFeature(root, '001-login')
    expect(await readCodeReviewStatus(root)).toBe('changes_requested')
    expect(await readVerificationStatus(root)).toBe('partial')
    const features = await listFeatures(root)
    expect(features.find((f) => f.current)?.id).toBe('001-login')
  })

  test('deleting the active feature returns to the newest; bad ids are refused', async () => {
    const root = await project(twoFeatures)
    await setActiveFeature(root, '001-login')
    await removeFeatureDir(root, '001-login')
    expect(activeFeatureId(root)).toBe('002-billing')
    expect((await listFeatures(root)).map((f) => f.id)).toEqual(['002-billing'])
    await expect(removeFeatureDir(root, '../x')).rejects.toThrow('Invalid')
    await expect(removeFeatureDir(root, '001-login')).rejects.toThrow('does not exist')
  })
})

describe('switchToFeatureBranch', () => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim()

  test('checks out the feature branch, and leaves uncommitted work alone', async () => {
    const root = await project({ 'a.txt': '1\n' })
    git(root, 'init', '-q', '-b', 'main'); git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'one')
    git(root, 'branch', '001-login')
    expect(await switchToFeatureBranch(root, '001-login')).toEqual({ switched: true })
    expect(git(root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('001-login')
    expect((await switchToFeatureBranch(root, '001-login')).reason).toBe('already on it')
    expect((await switchToFeatureBranch(root, '404-missing')).reason).toContain('no branch')
    git(root, 'checkout', '-q', 'main')
    await writeFile(path.join(root, 'a.txt'), 'edited\n')
    expect((await switchToFeatureBranch(root, '001-login')).reason).toContain('uncommitted')
    expect(git(root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
  })

  test('an untracked file counts as uncommitted work', async () => {
    const root = await project({ 'a.txt': '1\n' })
    git(root, 'init', '-q', '-b', 'main'); git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'one')
    git(root, 'branch', '001-login')
    await writeFile(path.join(root, 'new.txt'), 'draft\n')
    expect((await switchToFeatureBranch(root, '001-login')).reason).toContain('uncommitted')
    expect(git(root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
  })

  test('a local repository fetches a branch that exists only on its origin', async () => {
    const root = await project({ 'seed/a.txt': '1\n' })
    const seed = path.join(root, 'seed')
    git(seed, 'init', '-q', '-b', 'main'); git(seed, 'add', '.'); git(seed, 'commit', '-q', '-m', 'one')
    git(root, 'clone', '-q', seed, 'work')
    git(seed, 'branch', '001-login')
    const work = path.join(root, 'work')
    expect(await switchToFeatureBranch(work, '001-login')).toEqual({ switched: true })
    expect(git(work, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('001-login')
  })
})

describe('chosenFeatureId', () => {
  test('is set only by an explicit choice of an existing feature', async () => {
    const root = await project(twoFeatures)
    expect(chosenFeatureId(root)).toBeNull()
    await setActiveFeature(root, '001-login')
    expect(chosenFeatureId(root)).toBe('001-login')
    await setActiveFeature(root, null)
    expect(chosenFeatureId(root)).toBeNull()
  })
})
