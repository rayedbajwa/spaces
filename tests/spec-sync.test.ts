import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { withGoverningTicks } from '../src/lib/aidlc'
import { listIntentDocuments, removeMirroredIntentDir } from '../src/lib/spec-sync'

const cleanup: string[] = []
afterAll(async () => { for (const d of cleanup) await rm(d, { recursive: true, force: true }) })

async function workspace() {
  const governing = await mkdtemp(path.join(tmpdir(), 'gov-'))
  const impl = await mkdtemp(path.join(tmpdir(), 'impl-'))
  cleanup.push(governing, impl)
  const write = async (root: string, rel: string, content: string) => { await mkdir(path.dirname(path.join(root, rel)), { recursive: true }); await writeFile(path.join(root, rel), content) }
  for (const [rel, text] of [['spec.md', '# Search\n'], ['plan.md', '# Plan\n'], ['tasks.md', '- [x] T001\n'], ['contracts/search.yaml', 'openapi: 3.1.0\n']]) {
    await write(governing, `specs/003-search/${rel}`, text)
  }
  return { governing, impl, write, featureDir: path.join(governing, 'specs/003-search') }
}

describe('implementation repositories carry only their repo-local change', () => {
  test('a full copy of the intent directory (from the earlier mirror) is removed', async () => {
    const { governing, impl, write, featureDir } = await workspace()
    for (const rel of await listIntentDocuments(featureDir)) await write(impl, `specs/003-search/${rel}`, await readFile(path.join(featureDir, rel), 'utf8'))
    await write(impl, 'specs/search/change.yaml', 'schema: spec-driven\n')
    expect(await removeMirroredIntentDir({ governingFeatureDir: featureDir, targetRoot: impl, keep: 'specs/search' })).toBe(path.join('specs', '003-search'))
    expect(await readFile(path.join(impl, 'specs/003-search/plan.md'), 'utf8').catch(() => null)).toBeNull()
    expect(await readFile(path.join(impl, 'specs/search/change.yaml'), 'utf8')).toBe('schema: spec-driven\n')
    void governing
  })

  test('a directory with anything that is not an exact copy is left alone', async () => {
    const { impl, write, featureDir } = await workspace()
    await write(impl, 'specs/003-search/spec.md', '# Search\n')
    await write(impl, 'specs/003-search/notes.md', 'written in this repository\n')
    expect(await removeMirroredIntentDir({ governingFeatureDir: featureDir, targetRoot: impl, keep: 'specs/search' })).toBeUndefined()
    await write(impl, 'specs/003-other/spec.md', '# edited here\n')
    const edited = path.join(path.dirname(featureDir), '003-other')
    await write(path.dirname(path.dirname(featureDir)), 'specs/003-other/spec.md', '# original\n')
    expect(await removeMirroredIntentDir({ governingFeatureDir: edited, targetRoot: impl, keep: 'specs/other' })).toBeUndefined()
    expect(await readFile(path.join(impl, 'specs/003-search/notes.md'), 'utf8')).toBe('written in this repository\n')
  })

  test('never removes through a symbolic link, or the change directory itself', async () => {
    const { impl, featureDir } = await workspace()
    const outside = await mkdtemp(path.join(tmpdir(), 'outside-'))
    cleanup.push(outside)
    await mkdir(path.join(impl, 'specs'), { recursive: true })
    await symlink(outside, path.join(impl, 'specs/003-search'))
    expect(await removeMirroredIntentDir({ governingFeatureDir: featureDir, targetRoot: impl, keep: 'specs/search' })).toBeUndefined()
    expect(await removeMirroredIntentDir({ governingFeatureDir: featureDir, targetRoot: impl, keep: 'specs/003-search' })).toBeUndefined()
  })

  test('a repository\'s tasks carry the governing ticks', () => {
    const governing = '## Build\n- [x] T001 Add parser in api/src/parse.ts\n- [ ] T002 Wire parser into web\n- [x] T003 Docs\n'
    expect(withGoverningTicks('T001, T003', governing)).toBe('- [x] T001 Add parser in api/src/parse.ts\n- [x] T003 Docs')
    expect(withGoverningTicks('Build the thing', governing)).toBe('Build the thing')
  })
})
