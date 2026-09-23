import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readAcceptance, recordAcceptance, renderAcceptance, withdrawAcceptance } from '../src/lib/acceptance'
import { laneForProject } from '../src/lib/board-drop'
import { extractFigmaLinks, listFeatures } from '../src/lib/features'
import { generateDesignFidelityChecklist } from '../src/lib/aidlc'

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

describe('an accepted, reviewed feature is releasing', () => {
  const base = { initialized: true, specified: true, planned: true, tasked: true, tasksDone: 4, codeReviewStatus: 'approved' as const }

  test('partial verification plus an acceptance moves on to Releasing, and Done once merged', () => {
    expect(laneForProject({ ...base, verificationStatus: 'partial' })).toBe('implementing')
    expect(laneForProject({ ...base, verificationStatus: 'partial', accepted: true })).toBe('releasing')
    expect(laneForProject({ ...base, verificationStatus: 'fail', accepted: true })).toBe('releasing')
    expect(laneForProject({ ...base, verificationStatus: 'partial', accepted: true, deliveryStatus: 'merged' })).toBe('done')
  })

  test('accepting QA does not skip the code review', () => {
    expect(laneForProject({ ...base, codeReviewStatus: undefined, verificationStatus: 'partial', accepted: true })).toBe('implementing')
  })
})

describe('feature design artifact association and review gate checklist (US4)', () => {
  test('extracts Figma links from spec markdown', () => {
    const specContent = `
# Feature Specification: Checkout Modal

## Mockups
- Primary screen: https://www.figma.com/design/Vf123Abc456/Checkout?node-id=10-25
- Mobile responsive: https://figma.com/file/Vf123Abc456/Checkout?node-id=20-50
`
    const links = extractFigmaLinks(specContent)
    expect(links).toHaveLength(2)
    expect(links[0].fileKey).toBe('Vf123Abc456')
    expect(links[0].nodeId).toBe('10:25')
    expect(links[1].nodeId).toBe('20:50')
  })

  test('listFeatures associates designLinks from spec.md', async () => {
    const root = await project({
      'specs/001-feature/spec.md': '# Feature Specification\nSee https://www.figma.com/design/Key123/Project?node-id=5-5',
    })
    const features = await listFeatures(root)
    expect(features).toHaveLength(1)
    expect(features[0].designLinks).toBeDefined()
    expect(features[0].designLinks).toHaveLength(1)
    expect(features[0].designLinks?.[0].fileKey).toBe('Key123')
    expect(features[0].designLinks?.[0].nodeId).toBe('5:5')
  })

  test('generateDesignFidelityChecklist formats checklist items for review gate', () => {
    const links = [
      { url: 'https://www.figma.com/design/Key123/Project?node-id=5:5', fileKey: 'Key123', nodeId: '5:5' },
    ]
    const checklist = generateDesignFidelityChecklist(links)
    expect(checklist).toContain('Design Fidelity & Design System Checklist')
    expect(checklist).toContain('Inspect linked design artifact')
    expect(checklist).toContain('https://www.figma.com/design/Key123/Project?node-id=5:5')
    expect(checklist).toContain('typography scale, colors, elevation')
    expect(checklist).toContain('auto-layout padding, item spacing')
  })
})
