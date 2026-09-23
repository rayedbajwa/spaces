import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { withGoverningTicks } from '../src/lib/aidlc'
import { pruneMirroredDocuments } from '../src/lib/spec-sync'

const cleanup: string[] = []
afterAll(async () => { for (const d of cleanup) await rm(d, { recursive: true, force: true }) })

async function workspace() {
  const governing = await mkdtemp(path.join(tmpdir(), 'gov-'))
  const impl = await mkdtemp(path.join(tmpdir(), 'impl-'))
  cleanup.push(governing, impl)
  const write = async (root: string, rel: string, content: string) => { await mkdir(path.dirname(path.join(root, rel)), { recursive: true }); await writeFile(path.join(root, rel), content) }
  for (const [rel, text] of [['spec.md', '# Search\n'], ['plan.md', '# Plan\n'], ['tasks.md', '- [x] T001\n'], ['contracts/search.yaml', 'openapi: 3.1.0\n']]) await write(governing, `specs/003-search/${rel}`, text)
  return { impl, write, featureDir: path.join(governing, 'specs/003-search') }
}

describe('implementation repositories keep only their repo-local change', () => {
  test('mirrored copies of the governing documents are pruned; the change files and anything written here stay', async () => {
    const { impl, write, featureDir } = await workspace()
    await write(impl, 'specs/003-search/plan.md', '# Plan\n')
    await write(impl, 'specs/003-search/contracts/search.yaml', 'openapi: 3.1.0\n')
    await write(impl, 'specs/003-search/spec.md', '# delta spec\n')
    await write(impl, 'specs/003-search/change.yaml', 'schema: spec-driven\n')
    await write(impl, 'specs/003-search/notes.md', 'written here\n')
    const removed = await pruneMirroredDocuments({ governingFeatureDir: featureDir, targetRoot: impl, changeDir: 'specs/003-search' })
    expect(removed.sort()).toEqual(['contracts/search.yaml', 'plan.md'])
    expect((await readdir(path.join(impl, 'specs/003-search'))).sort()).toEqual(['change.yaml', 'notes.md', 'spec.md'])
  })

  test('an edited copy stays, and nothing is removed through a symbolic link', async () => {
    const { impl, write, featureDir } = await workspace()
    await write(impl, 'specs/003-search/plan.md', '# Plan, edited in this repository\n')
    expect(await pruneMirroredDocuments({ governingFeatureDir: featureDir, targetRoot: impl, changeDir: 'specs/003-search' })).toEqual([])
    const outside = await mkdtemp(path.join(tmpdir(), 'outside-'))
    cleanup.push(outside)
    await writeFile(path.join(outside, 'search.yaml'), 'openapi: 3.1.0\n')
    await symlink(outside, path.join(impl, 'specs/003-search/contracts'))
    expect(await pruneMirroredDocuments({ governingFeatureDir: featureDir, targetRoot: impl, changeDir: 'specs/003-search' })).toEqual([])
    expect(await readFile(path.join(outside, 'search.yaml'), 'utf8')).toBe('openapi: 3.1.0\n')
  })

  test("a repository's tasks carry the governing ticks", () => {
    const governing = '## Build\n- [x] T001 Add parser in api/src/parse.ts\n- [ ] T002 Wire parser into web\n- [x] T003 Docs\n'
    expect(withGoverningTicks('T001, T003', governing)).toBe('- [x] T001 Add parser in api/src/parse.ts\n- [x] T003 Docs')
    expect(withGoverningTicks('Build the thing', governing)).toBe('Build the thing')
  })

  test('never prunes the intent itself', async () => {
    const { featureDir } = await workspace()
    const governingRoot = path.dirname(path.dirname(featureDir))
    expect(await pruneMirroredDocuments({ governingFeatureDir: featureDir, targetRoot: governingRoot, changeDir: 'specs/003-search' })).toEqual([])
    expect((await readdir(featureDir)).sort()).toEqual(['contracts', 'plan.md', 'spec.md', 'tasks.md'])
  })

  test('tasks without an id are kept beside the governing lines of numbered ones', () => {
    const governing = '- [x] T001 Add parser\n- [ ] T002 Wire it\n'
    expect(withGoverningTicks('- T001 parser\n- Update the runbook\n- T002 and T001 again', governing)).toBe('- [x] T001 Add parser\n- Update the runbook\n- [ ] T002 Wire it')
  })

  test('a repository is named by whole words only', async () => {
    // Exercised through the flow in repo-local-sync; here the rule itself.
    const names = ['api']
    const matches = (line: string) => names.some((n) => new RegExp(`(^|[^a-z0-9_-])${n}($|[^a-z0-9_-])`, 'i').test(line))
    expect(matches('- [ ] T001 Add index in api/src/search.ts')).toBe(true)
    expect(matches('- [ ] T002 Render rapidly in web')).toBe(false)
    expect(matches('- [ ] T003 Call the API service')).toBe(true)
  })
})
