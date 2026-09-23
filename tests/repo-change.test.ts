import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { changeDirFor, initiativeIdFor, planRepoChanges, projectIdentifier, writeRepoChange } from '../src/lib/repo-change'

/**
 * Pure filesystem test: a governing feature directory with a spec, two
 * workstreams in two repositories, and the governance workspace itself (which
 * must never receive a change folder).
 */

let root: string
let featureDir: string
let apiRepo: string
let webRepo: string
let governance: string

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'repo-change-'))
  featureDir = path.join(root, 'gov', 'specs', '007-add-3ds')
  apiRepo = path.join(root, 'api')
  webRepo = path.join(root, 'web')
  governance = path.join(root, 'gov')
  await mkdir(featureDir, { recursive: true })
  await mkdir(apiRepo, { recursive: true })
  await mkdir(webRepo, { recursive: true })
  await writeFile(path.join(featureDir, 'spec.md'), '# Add 3-D Secure to checkout\n\n## User stories\n\n- As a shopper I can pay with 3DS.\n', 'utf8')
})

afterAll(async () => { await rm(root, { recursive: true, force: true }) })

describe('repo-local changes', () => {
  test('identifiers are stable and path-free', () => {
    expect(projectIdentifier({ githubRepo: 'acme/api', localPath: '/x/y' })).toBe('github.com/acme/api')
    expect(projectIdentifier({ githubRepo: 'https://github.com/acme/web.git', localPath: '/x/web' })).toBe('github.com/acme/web')
    expect(projectIdentifier({ localPath: '/home/me/checkouts/legacy' })).toBe('local/legacy')
    expect(initiativeIdFor('007-add-3ds')).toBe('007-add-3ds')
    expect(initiativeIdFor('Add 3DS!')).toBe('add-3ds')
    expect(changeDirFor('007-add-3ds')).toBe(path.join('specs', '007-add-3ds'))
  })

  test('plans one change per implementation repo, skips the governing workspace, writes initiative + links', async () => {
    const api = { label: 'api', githubRepo: 'acme/api', localPath: apiRepo }
    const web = { label: 'web', githubRepo: 'acme/web', localPath: webRepo }
    const gov = { label: 'governance', localPath: governance }
    const workstreams = [
      { title: 'Payments API: 3DS challenge flow', tasks: '- Add challenge endpoint\n- Persist auth result', outputs: 'POST /payments/3ds', qaFocus: 'Declines', repository: 'api' },
      { title: 'Web: 3DS iframe', tasks: '1. Render challenge iframe\n2. Handle callback', outputs: 'Checkout page change', repository: 'web' },
      { title: 'Docs in governance', tasks: '- Update runbook', repository: 'governance' },
    ]
    const plan = await planRepoChanges({
      featureDir,
      workstreams,
      repoFor: (ws) => ({ api, web, governance: gov } as Record<string, typeof api>)[(ws as { repository: string }).repository],
      project: { name: 'Checkout', code: 'PAY-4' },
    })
    expect(plan.initiativeId).toBe('007-add-3ds')
    expect(plan.changes.map((c) => c.project).sort()).toEqual(['github.com/acme/api', 'github.com/acme/web'])

    const initiative = parseYaml(await readFile(path.join(featureDir, 'initiative.yaml'), 'utf8')) as { id: string; repositories: string[]; project: string }
    expect(initiative.id).toBe('007-add-3ds')
    expect(initiative.repositories.sort()).toEqual(['github.com/acme/api', 'github.com/acme/web'])
    expect(initiative.project).toBe('PAY-4 · Checkout')
    const links = parseYaml(await readFile(path.join(featureDir, 'links.yaml'), 'utf8')) as { links: Array<{ project: string; change: string; path: string }> }
    expect(links.links.find((l) => l.project === 'github.com/acme/api')?.path).toBe(path.join('specs', '007-add-3ds'))

    // Write the api repo's change and check its contents.
    const apiChange = plan.changes.find((c) => c.project === 'github.com/acme/api')!
    const written = await writeRepoChange({ cwd: apiRepo, featureDir, plan, change: apiChange, project: { name: 'Checkout', code: 'PAY-4' } })
    expect(written.relativeDir).toBe(path.join('specs', '007-add-3ds'))
    const meta = parseYaml(await readFile(path.join(apiRepo, 'specs', '007-add-3ds', 'change.yaml'), 'utf8')) as { initiative: string; repository: string; links: Array<{ project: string; change: string }> }
    expect(meta.initiative).toBe('007-add-3ds')
    expect(meta.repository).toBe('github.com/acme/api')
    expect(meta.links).toEqual([{ project: 'github.com/acme/web', change: '007-add-3ds' }])

    const tasks = await readFile(path.join(apiRepo, 'specs', '007-add-3ds', 'tasks.md'), 'utf8')
    expect(tasks).toContain('## Payments API: 3DS challenge flow')
    expect(tasks).toContain('- [ ] Add challenge endpoint')
    expect(tasks).not.toContain('3DS iframe') // the web repo's work stays out of the api repo
    expect(tasks).toContain('github.com/acme/web')

    const spec = await readFile(path.join(apiRepo, 'specs', '007-add-3ds', 'spec.md'), 'utf8')
    expect(spec).toContain('delta for acme/api')
    expect(spec).toContain('As a shopper I can pay with 3DS.')

    // Nothing was written into the governing workspace's own specs as a change.
    await expect(readFile(path.join(governance, 'specs', '007-add-3ds', 'change.yaml'), 'utf8')).rejects.toThrow()
  })

  test('re-writing keeps the original created date', async () => {
    const api = { label: 'api', githubRepo: 'acme/api', localPath: apiRepo }
    const plan = { initiativeId: 'add-3ds', changes: [{ repo: api, changeId: 'add-3ds', project: 'github.com/acme/api', workstreams: [{ title: 'x', tasks: '- y' }] }] }
    const file = path.join(apiRepo, 'specs', '007-add-3ds', 'change.yaml')
    await writeFile(file, 'schema: spec-driven\ncreated: 2026-01-02\ninitiative: add-3ds\n', 'utf8')
    await writeRepoChange({ cwd: apiRepo, featureDir, plan, change: plan.changes[0]! })
    expect(await readFile(file, 'utf8')).toContain('created: 2026-01-02')
  })
})
