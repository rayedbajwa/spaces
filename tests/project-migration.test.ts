import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { getDb } from '../src/lib/db'
import { claimNextJob } from '../src/lib/dispatcher'
import { archiveStream, manifestFor, moveProjectBack, moveProjectToWorker, projectPaths, pullProject, type MigrationDeps, type PullResult } from '../src/lib/project-migration'
import { addRepo } from '../src/lib/project-registry'
import { getProjectWorker } from '../src/lib/worker-provisioner'
import { createApprovalFixture } from './helpers/approval-fixture'

/** 014-project-workers, phase 5: moving existing projects to their own workers. */

const fixture = await createApprovalFixture({ withServer: false })
const { projectA, projectTeamB } = fixture
const sql = getDb()
// realpath: macOS's /var is a symlink, and tar will not extract through one.
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'spaces-migrate-')))
const repoDir = path.join(root, 'repos', 'app')
await mkdir(path.join(repoDir, 'specs', '001-x'), { recursive: true })
await writeFile(path.join(repoDir, 'README.md'), 'hello\n')
await writeFile(path.join(repoDir, 'specs', '001-x', 'spec.md'), '# Spec\n')
await addRepo({ projectId: projectA.projectId, label: 'app', kind: 'local', localPath: repoDir, isPrimary: true })
const jobs: string[] = []

afterAll(async () => {
  if (jobs.length) await sql`DELETE FROM project_jobs WHERE job_id IN ${sql(jobs)}`
  await sql`DELETE FROM project_workers WHERE project_id IN (${projectA.projectId}, ${projectTeamB.projectId})`
  await rm(root, { recursive: true, force: true })
  await fixture.stop()
})

beforeEach(async () => {
  await sql`DELETE FROM project_workers WHERE project_id IN (${projectA.projectId}, ${projectTeamB.projectId})`
})

describe('copying a project', () => {
  test("a project's paths are its repositories (outermost only), and the manifest counts them", async () => {
    const paths = await projectPaths(projectA.projectId)
    expect(paths).toEqual([repoDir])
    expect(await manifestFor(paths)).toMatchObject({ files: 2, bytes: 13 })
  })

  test('a pull replaces the local copy with the archive and checks it against the manifest', async () => {
    const paths = await projectPaths(projectA.projectId)
    const manifest = await manifestFor(paths)
    const archive = new Uint8Array(await new Response(archiveStream(paths)).arrayBuffer())
    // A stale file only the receiving side has must not survive the pull.
    await writeFile(path.join(repoDir, 'stale.txt'), 'old')
    const fake = async (url: string) => url.endsWith('/manifest') ? new Response(JSON.stringify(manifest)) : new Response(archive)
    const result = await pullProject(projectA.projectId, 'http://source', fake as never)
    expect(result.error).toBeUndefined()
    expect(result.ok).toBe(true)
    expect(await Bun.file(path.join(repoDir, 'stale.txt')).exists()).toBe(false)
    expect(await Bun.file(path.join(repoDir, 'specs', '001-x', 'spec.md')).text()).toBe('# Spec\n')
  })

  test('a copy that does not match the manifest fails', async () => {
    const paths = await projectPaths(projectA.projectId)
    const manifest = await manifestFor(paths)
    const archive = new Uint8Array(await new Response(archiveStream(paths)).arrayBuffer())
    const lying = { ...manifest, paths: manifest.paths.map((p) => ({ ...p, files: p.files + 1 })) }
    const fake = async (url: string) => url.endsWith('/manifest') ? new Response(JSON.stringify(lying)) : new Response(archive)
    const result = await pullProject(projectA.projectId, 'http://source', fake as never)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('expected 3 files')
  })
})

function deps(result: Partial<PullResult> = {}) {
  const calls: string[] = []
  const ok: PullResult = { ok: true, source: { paths: [], files: 4, bytes: 100 }, ...result }
  const d: MigrationDeps = {
    provision: async (projectId) => {
      calls.push('provision')
      await sql`UPDATE project_workers SET state = 'ready', last_seen_at = now(), internal_url = 'http://worker' WHERE project_id = ${projectId}`
    },
    workerPull: async (_projectId, sourceUrl) => { calls.push(`worker pulls from ${sourceUrl}`); return ok },
    selfPull: async (_projectId, workerUrl) => { calls.push(`shared pulls from ${workerUrl}`); return ok },
    sourceUrl: () => 'http://spaces.railway.internal:3000',
    readyTimeoutMs: 5_000,
  }
  return { d, calls }
}

describe('moving a project', () => {
  test('a dry run copies and checks but leaves the project on the shared service', async () => {
    const { d, calls } = deps()
    await moveProjectToWorker(projectA.projectId, { activate: false }, d)
    expect(calls).toEqual(['provision', 'worker pulls from http://spaces.railway.internal:3000'])
    expect(await getProjectWorker(projectA.projectId)).toMatchObject({ active: false, migrationState: 'verified' })
  })

  test('a move activates the worker; moving back deactivates it after copying back', async () => {
    const { d, calls } = deps()
    await moveProjectToWorker(projectA.projectId, { activate: true }, d)
    expect(await getProjectWorker(projectA.projectId)).toMatchObject({ active: true, migrationState: 'moved' })
    await moveProjectBack(projectA.projectId, d)
    expect(calls.at(-1)).toBe('shared pulls from http://worker')
    expect(await getProjectWorker(projectA.projectId)).toMatchObject({ active: false, migrationState: 'verified' })
  })

  test('a failed copy is recorded and nothing is activated', async () => {
    const { d } = deps({ ok: false, error: 'checksum mismatch' })
    await moveProjectToWorker(projectA.projectId, { activate: true }, d)
    expect(await getProjectWorker(projectA.projectId)).toMatchObject({ active: false, migrationState: 'failed', migrationJson: { error: 'checksum mismatch' } })
  })

  test('a project with a running stage is not moved', async () => {
    const jobId = randomUUID()
    jobs.push(jobId)
    await sql`INSERT INTO project_jobs (job_id, project_id, kind, trigger_source, status) VALUES (${jobId}, ${projectTeamB.projectId}, 'webhook', 'api', 'running')`
    await expect(moveProjectToWorker(projectTeamB.projectId, { activate: true }, deps().d)).rejects.toThrow('A stage is running')
    await sql`UPDATE project_jobs SET status = 'completed' WHERE job_id = ${jobId}`
  })
})

describe("who claims a moved project's jobs", () => {
  test('the shared service claims until the move; then only the dedicated worker; a move in progress holds both', async () => {
    const jobId = randomUUID()
    jobs.push(jobId)
    await sql`INSERT INTO project_jobs (job_id, project_id, kind, trigger_source) VALUES (${jobId}, ${projectTeamB.projectId}, 'webhook', 'api')`
    await sql`INSERT INTO project_workers (project_id, active, migration_state) VALUES (${projectTeamB.projectId}, false, 'syncing')`
    expect(await claimNextJob('shared-test', projectTeamB.projectId, 'shared')).toBeUndefined()
    expect(await claimNextJob('dedicated-test', projectTeamB.projectId, 'dedicated')).toBeUndefined()
    await sql`UPDATE project_workers SET active = true, migration_state = 'moved' WHERE project_id = ${projectTeamB.projectId}`
    expect(await claimNextJob('shared-test', projectTeamB.projectId, 'shared')).toBeUndefined()
    expect((await claimNextJob('dedicated-test', projectTeamB.projectId, 'dedicated'))?.jobId).toBe(jobId)
  })
})
