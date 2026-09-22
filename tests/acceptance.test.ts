import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readAcceptance, recordAcceptance, renderAcceptance, withdrawAcceptance } from '../src/lib/acceptance'
import { laneForProject } from '../src/lib/board-drop'

/**
 * A verification that comes back partial is not automatically a failure: the
 * person responsible may accept it. That decision is recorded, readable, and
 * reversible.
 */

const roots: string[] = []

async function project(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'accept-'))
  roots.push(root)
  await mkdir(path.join(root, 'specs', '001-feature'), { recursive: true })
  await writeFile(path.join(root, 'specs', '001-feature', 'spec.md'), '# Spec')
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

describe('acceptance records', () => {
  test('round-trips who accepted what, and why', async () => {
    const root = await project()
    const written = await recordAcceptance({
      projectPath: root,
      verificationStatus: 'partial',
      acceptedBy: 'Ada Lovelace',
      note: 'Browser suite cannot run here; covered manually.',
    })
    expect(written?.acceptance.verificationStatus).toBe('partial')

    const read = await readAcceptance(root)
    expect(read?.acceptedBy).toBe('Ada Lovelace')
    expect(read?.verificationStatus).toBe('partial')
    expect(read?.note).toContain('Browser suite')
    expect(read?.acceptedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    const file = await readFile(path.join(root, 'specs', '001-feature', 'acceptance.md'), 'utf8')
    expect(file).toContain('PARTIAL')
  })

  test('a project with no feature has nothing to accept', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'accept-empty-'))
    roots.push(root)
    expect(await recordAcceptance({ projectPath: root, verificationStatus: 'partial', acceptedBy: 'someone' })).toBeUndefined()
    expect(await readAcceptance(root)).toBeUndefined()
  })

  test('withdrawing puts the feature back where it was', async () => {
    const root = await project()
    await recordAcceptance({ projectPath: root, verificationStatus: 'fail', acceptedBy: 'someone' })
    expect(await withdrawAcceptance(root)).toBe(true)
    expect(await readAcceptance(root)).toBeUndefined()
    expect(await withdrawAcceptance(root)).toBe(false)
  })

  test('a record with no reason still reads back', () => {
    const text = renderAcceptance({ verificationStatus: 'partial', acceptedBy: 'someone', acceptedAt: '2026-09-22T00:00:00.000Z' }, '001-feature')
    expect(text).toContain('No reason given')
  })
})

describe('an accepted feature is releasing', () => {
  const base = { initialized: true, specified: true, planned: true, tasked: true, tasksDone: 4 }

  test('partial verification plus an acceptance moves on to Releasing, and Done once merged', () => {
    expect(laneForProject({ ...base, verificationStatus: 'partial' })).toBe('implementing')
    expect(laneForProject({ ...base, verificationStatus: 'partial', accepted: true })).toBe('releasing')
    expect(laneForProject({ ...base, verificationStatus: 'fail', accepted: true })).toBe('releasing')
    expect(laneForProject({ ...base, verificationStatus: 'partial', accepted: true, deliveryStatus: 'merged' })).toBe('done')
  })
})
