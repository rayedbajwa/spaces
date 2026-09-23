import { describe, expect, test } from 'bun:test'
import { prepareForNewFeature, type NewFeatureDeps } from '../src/lib/new-feature'
import type { BranchSync } from '../src/lib/pull-requests'
import type { RepoRow } from '../src/lib/project-registry'

const repo = (repoId: string, githubRepo: string, isPrimary = false): RepoRow => ({
  repoId, projectId: 'p1', label: repoId, kind: 'github', localPath: `/checkouts/${repoId}`, githubRepo, isPrimary, addedAt: '2026-09-01',
})

/** Fakes for everything preparation calls, recording what it asked for. */
function fakes(syncs: Record<string, BranchSync | Error>) {
  const calls = { synced: [] as string[], learned: [] as string[], memory: 0, bundle: 0 }
  const deps: Partial<NewFeatureDeps> = {
    getProject: (async () => ({ projectId: 'p1', slug: 'acme', name: 'Acme' })) as never,
    listRepos: (async () => [repo('app', 'acme/app', true), repo('api', 'acme/api'), repo('web', 'acme/web')]) as never,
    syncDefaultBranch: async (_org, cwd, githubRepo) => {
      calls.synced.push(githubRepo)
      const result = syncs[githubRepo]!
      if (result instanceof Error) throw result
      return result
    },
    refreshRepositoryKnowledge: (async (_projectId: string, repoId: string) => { calls.learned.push(repoId) }) as never,
    composeProjectMemory: (async () => { calls.memory += 1 }) as never,
    buildContextBundle: (async () => { calls.bundle += 1; return { promptBundle: 'fresh context', project: { memory: 'fresh memory' } } }) as never,
  }
  return { calls, deps }
}

describe('prepareForNewFeature', () => {
  test('pulls every repository, learns again only those that changed, and hands back fresh context', async () => {
    const { calls, deps } = fakes({
      'acme/app': { branch: 'main', before: 'aaaaaaa1', after: 'bbbbbbb2' },
      'acme/api': { branch: 'main', before: 'ccccccc3', after: 'ccccccc3' },
      'acme/web': new Error('network down'),
    })
    const lines: string[] = []
    const result = await prepareForNewFeature({ projectId: 'p1', orgId: 'o1', print: (l) => lines.push(l) }, deps)

    expect(calls.synced).toEqual(['acme/app', 'acme/api', 'acme/web'])
    expect(calls.learned).toEqual(['app'])
    expect(calls.memory).toBe(1)
    expect(result).toEqual({ sharedContextPrompt: 'fresh context', projectMemory: 'fresh memory' })
    const log = lines.join('')
    expect(log).toContain('acme/app: updated main aaaaaaa → bbbbbbb')
    expect(log).toContain('acme/api: main is already up to date')
    expect(log).toContain('acme/web: could not pull (network down)')
  })

  test('a skipped sync is reported and not learned again; memory is still rebuilt', async () => {
    const { calls, deps } = fakes({
      'acme/app': { branch: 'main', before: 'a', after: 'a', skipped: 'uncommitted changes in the checkout' },
      'acme/api': { branch: 'main', before: 'b', after: 'b' },
      'acme/web': { branch: 'main', before: 'c', after: 'c', skipped: 'local main has diverged from origin/main' },
    })
    const lines: string[] = []
    const result = await prepareForNewFeature({ projectId: 'p1', orgId: 'o1', print: (l) => lines.push(l) }, deps)

    expect(calls.learned).toEqual([])
    expect(calls.memory).toBe(1)
    expect(result?.sharedContextPrompt).toBe('fresh context')
    expect(lines.join('')).toContain('acme/app: left as it is (uncommitted changes in the checkout)')
  })

  test('a failed re-learn does not stop the refresh', async () => {
    const { calls, deps } = fakes({
      'acme/app': { branch: 'main', before: 'a', after: 'b' },
      'acme/api': { branch: 'main', before: 'c', after: 'd' },
      'acme/web': { branch: 'main', before: 'e', after: 'e' },
    })
    deps.refreshRepositoryKnowledge = (async (_p: string, repoId: string) => {
      calls.learned.push(repoId)
      if (repoId === 'app') throw new Error('model unavailable')
    }) as never
    const lines: string[] = []
    const result = await prepareForNewFeature({ projectId: 'p1', orgId: 'o1', print: (l) => lines.push(l) }, deps)

    expect(calls.learned).toEqual(['app', 'api'])
    expect(result?.projectMemory).toBe('fresh memory')
    expect(lines.join('')).toContain('Learning acme/app failed: model unavailable')
  })

  test('without a project there is nothing to prepare', async () => {
    const { calls, deps } = fakes({})
    expect(await prepareForNewFeature({ orgId: 'o1', print: () => undefined }, deps)).toBeUndefined()
    expect(calls.synced).toEqual([])
  })
})
