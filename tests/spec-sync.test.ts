import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { syncIntentDocuments } from '../src/lib/spec-sync'

const cleanup: string[] = []
afterAll(async () => { for (const d of cleanup) await rm(d, { recursive: true, force: true }) })

async function workspace() {
  const governing = await mkdtemp(path.join(tmpdir(), 'gov-'))
  const impl = await mkdtemp(path.join(tmpdir(), 'impl-'))
  cleanup.push(governing, impl)
  const write = async (root: string, rel: string, content: string) => { await mkdir(path.dirname(path.join(root, rel)), { recursive: true }); await writeFile(path.join(root, rel), content) }
  await write(governing, 'specs/003-search/spec.md', '# Search\n')
  await write(governing, 'specs/003-search/tasks.md', '- [x] T001\n')
  await write(governing, 'specs/003-search/contracts/search.yaml', 'openapi: 3.1.0\n')
  await write(governing, 'specs/003-search/.hidden.md', 'no\n')
  await write(governing, 'specs/003-search/diagram.png', 'binary')
  return { governing, impl, write, featureDirAbs: path.join(governing, 'specs/003-search') }
}

describe('syncing an intent\'s documents into an implementation repository', () => {
  test('mirrors the intent directory (text documents, nested), and only what changed', async () => {
    const { governing, impl, featureDirAbs, write } = await workspace()
    const first = await syncIntentDocuments({ governingRoot: governing, featureDirAbs, targetRoot: impl })
    expect(first.written.sort()).toEqual(['contracts/search.yaml', 'spec.md', 'tasks.md'])
    expect(await readFile(path.join(impl, 'specs/003-search/tasks.md'), 'utf8')).toBe('- [x] T001\n')
    expect(await readFile(path.join(impl, 'specs/003-search/.hidden.md'), 'utf8').catch(() => null)).toBeNull()
    await write(governing, 'specs/003-search/tasks.md', '- [x] T001\n- [x] T002\n')
    const second = await syncIntentDocuments({ governingRoot: governing, featureDirAbs, targetRoot: impl })
    expect(second).toEqual({ written: ['tasks.md'], removed: [] })
  })

  test('removes documents the governing workspace no longer has, and nothing outside the intent', async () => {
    const { governing, impl, featureDirAbs, write } = await workspace()
    await write(impl, 'specs/003-search/old-notes.md', 'stale\n')
    await write(impl, 'specs/001-other/spec.md', '# Other\n')
    await write(impl, 'src/app.ts', 'code\n')
    const result = await syncIntentDocuments({ governingRoot: governing, featureDirAbs, targetRoot: impl })
    expect(result.removed).toEqual(['old-notes.md'])
    expect(await readFile(path.join(impl, 'specs/001-other/spec.md'), 'utf8')).toBe('# Other\n')
    expect(await readFile(path.join(impl, 'src/app.ts'), 'utf8')).toBe('code\n')
  })

  test('does nothing for the governing workspace itself, or through a symbolic link', async () => {
    const { governing, impl, featureDirAbs } = await workspace()
    expect(await syncIntentDocuments({ governingRoot: governing, featureDirAbs, targetRoot: governing })).toEqual({ written: [], removed: [] })
    const outside = await mkdtemp(path.join(tmpdir(), 'outside-'))
    cleanup.push(outside)
    await symlink(outside, path.join(impl, 'specs'))
    expect(await syncIntentDocuments({ governingRoot: governing, featureDirAbs, targetRoot: impl })).toEqual({ written: [], removed: [] })
  })
})

describe('review of #46', () => {
  test('an unreadable source changes nothing in the implementation checkout', async () => {
    const { governing, impl, write } = await workspace()
    await write(impl, 'specs/003-search/spec.md', '# Kept\n')
    // The "intent directory" is a file: it cannot be listed.
    await write(governing, 'specs/004-broken', 'not a directory')
    await expect(syncIntentDocuments({ governingRoot: governing, featureDirAbs: path.join(governing, 'specs/004-broken'), targetRoot: impl })).rejects.toThrow()
    expect(await readFile(path.join(impl, 'specs/003-search/spec.md'), 'utf8')).toBe('# Kept\n')
  })

  test('a symlinked folder inside the intent directory is never written through', async () => {
    const { governing, impl, featureDirAbs } = await workspace()
    const outside = await mkdtemp(path.join(tmpdir(), 'outside-'))
    cleanup.push(outside)
    await mkdir(path.join(impl, 'specs/003-search'), { recursive: true })
    await symlink(outside, path.join(impl, 'specs/003-search/contracts'))
    const result = await syncIntentDocuments({ governingRoot: governing, featureDirAbs, targetRoot: impl })
    expect(result.written.sort()).toEqual(['spec.md', 'tasks.md'])
    expect(await readFile(path.join(outside, 'search.yaml'), 'utf8').catch(() => null)).toBeNull()
  })
})
