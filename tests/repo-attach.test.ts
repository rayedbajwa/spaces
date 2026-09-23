import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { getDatabaseUrl, getDb } from '../src/lib/db'
import { addRepo, createProject, listRepos, primaryStillCloning, type RepoRow } from '../src/lib/project-registry'

describe('primaryStillCloning', () => {
  const repo = (patch: Partial<RepoRow>): RepoRow => ({ repoId: randomUUID(), projectId: 'p', label: 'x', kind: 'github', isPrimary: true, localPath: null, githubRepo: 'acme/x', cloneStatus: 'pending', ...patch } as RepoRow)
  test('a GitHub primary without a checkout yet holds runs back', () => {
    expect(primaryStillCloning([repo({ label: 'governance', kind: 'local', isPrimary: false, localPath: '/w', cloneStatus: null }), repo({})])?.githubRepo).toBe('acme/x')
    expect(primaryStillCloning([repo({ cloneStatus: 'cloning' })])).toBeDefined()
  })
  test('a cloned, failed or local primary does not', () => {
    expect(primaryStillCloning([repo({ localPath: '/c', cloneStatus: 'ready' })])).toBeUndefined()
    expect(primaryStillCloning([repo({ cloneStatus: 'error' })])).toBeUndefined()
    expect(primaryStillCloning([repo({ kind: 'local', localPath: '/l', cloneStatus: null })])).toBeUndefined()
  })
})

async function isDbReachable(): Promise<boolean> {
  try { await getDb()`SELECT 1 FROM project_repos LIMIT 0`; return true } catch { return false }
}
const dbAvailable = await isDbReachable()
const dbSuite = dbAvailable ? describe : describe.skip
if (!dbAvailable) test.skip(`repo attach DB tests skipped: DATABASE_URL not reachable (${getDatabaseUrl()})`, () => {})

dbSuite('attaching the first code repository', () => {
  const ids: string[] = []
  afterAll(async () => { if (ids.length) await getDb()`DELETE FROM projects WHERE project_id = ANY(${ids}::uuid[])` })

  test('two attaches at once: exactly one becomes primary, and it is not the governing workspace', async () => {
    const suffix = randomUUID().slice(0, 8)
    const project = await createProject({ name: `Attach ${suffix}`, slug: `attach-${suffix}` })
    ids.push(project.projectId)
    await addRepo({ projectId: project.projectId, label: 'governance', kind: 'local', localPath: '/tmp/gov', isPrimary: true })
    await Promise.all([
      addRepo({ projectId: project.projectId, label: 'a', kind: 'github', githubRepo: 'acme/a', primaryIfFirst: true }),
      addRepo({ projectId: project.projectId, label: 'b', kind: 'github', githubRepo: 'acme/b', primaryIfFirst: true }),
    ])
    const repos = await listRepos(project.projectId)
    const primaries = repos.filter((r) => r.isPrimary)
    expect(primaries).toHaveLength(1)
    expect(['a', 'b']).toContain(primaries[0]!.label)
  })

  test('a later attach does not take over the primary', async () => {
    const suffix = randomUUID().slice(0, 8)
    const project = await createProject({ name: `Attach ${suffix}`, slug: `attach-${suffix}` })
    ids.push(project.projectId)
    await addRepo({ projectId: project.projectId, label: 'first', kind: 'github', githubRepo: 'acme/first', primaryIfFirst: true })
    await addRepo({ projectId: project.projectId, label: 'second', kind: 'github', githubRepo: 'acme/second', primaryIfFirst: true })
    expect((await listRepos(project.projectId)).find((r) => r.isPrimary)?.label).toBe('first')
  })
})
