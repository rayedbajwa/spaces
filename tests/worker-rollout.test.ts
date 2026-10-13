import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { getDb } from '../src/lib/db'
import type { WorkerPlatform, WorkerSpec } from '../src/lib/worker-platform'
import { busyProjects, reportWorkerVersion, rolloutOnce } from '../src/lib/worker-rollout'
import { getProjectWorker } from '../src/lib/worker-provisioner'
import { createApprovalFixture } from './helpers/approval-fixture'

/** 014-project-workers, phase 4: workers move to the new version only while idle. */

const fixture = await createApprovalFixture({ withServer: false })
const { projectA, projectTeamB } = fixture
const sql = getDb()
afterAll(async () => {
  await sql`DELETE FROM project_workers WHERE project_id IN (${projectA.projectId}, ${projectTeamB.projectId})`
  await fixture.stop()
})

function platform(fail = false) {
  const updates: Array<{ projectId: string; version: string }> = []
  const p: WorkerPlatform = {
    kind: 'docker',
    create: async () => ({ internalUrl: 'http://x' }),
    update: async (spec: WorkerSpec) => { if (fail) throw new Error('engine refused'); updates.push({ projectId: spec.projectId, version: spec.version }) },
    remove: async () => undefined,
    check: async () => ({ canRead: true }),
  }
  return { p, updates }
}

beforeEach(async () => {
  await sql`DELETE FROM project_workers WHERE project_id IN (${projectA.projectId}, ${projectTeamB.projectId})`
  await sql`INSERT INTO project_workers (project_id, platform, service_ref, volume_ref, state, version) VALUES
    (${projectA.projectId}, 'docker', 'a', 'a-data', 'ready', 'old1111'),
    (${projectTeamB.projectId}, 'docker', 'b', 'b-data', 'ready', 'old1111')`
})

describe('rollout', () => {
  test('idle workers on another version are updated; a busy one waits', async () => {
    const { p, updates } = platform()
    const result = await rolloutOnce({ desired: () => 'new2222', platform: () => p, busy: async () => [projectTeamB.projectId] })
    expect(result.updated).toEqual([projectA.projectId])
    expect(result.deferred).toEqual([projectTeamB.projectId])
    expect(updates).toEqual([{ projectId: projectA.projectId, version: 'new2222' }])
    expect((await getProjectWorker(projectA.projectId))?.state).toBe('updating')
    expect((await getProjectWorker(projectTeamB.projectId))?.state).toBe('ready')
  })

  test('a worker that reports the new version is ready again and is not updated twice', async () => {
    const { p, updates } = platform()
    await rolloutOnce({ desired: () => 'new2222', platform: () => p, busy: async () => [] })
    await reportWorkerVersion(projectA.projectId, 'new2222')
    await reportWorkerVersion(projectTeamB.projectId, 'new2222')
    expect((await getProjectWorker(projectA.projectId))).toMatchObject({ state: 'ready', version: 'new2222' })
    updates.length = 0
    expect((await rolloutOnce({ desired: () => 'new2222', platform: () => p, busy: async () => [] })).updated).toEqual([])
  })

  test('a failed update leaves the worker ready, with the error shown', async () => {
    const { p } = platform(true)
    const result = await rolloutOnce({ desired: () => 'new2222', platform: () => p, busy: async () => [] })
    expect(result.failed.length).toBe(2)
    expect(await getProjectWorker(projectA.projectId)).toMatchObject({ state: 'ready', lastError: 'engine refused' })
  })

  test('a project with a running job is busy', async () => {
    const jobId = crypto.randomUUID()
    await sql`INSERT INTO project_jobs (job_id, project_id, kind, trigger_source, status) VALUES (${jobId}, ${projectA.projectId}, 'webhook', 'api', 'running')`
    try {
      expect(await busyProjects()).toContain(projectA.projectId)
    } finally {
      await sql`DELETE FROM project_jobs WHERE job_id = ${jobId}`
    }
  })

  test('nothing is updated until the version image is published', async () => {
    const { p, updates } = platform()
    const waiting = { ...p, versionAvailable: async () => false }
    expect((await rolloutOnce({ desired: () => 'new2222', platform: () => waiting, busy: async () => [] })).updated).toEqual([])
    expect(updates).toEqual([])
  })

  test('an unknown version (local build without GIT_COMMIT) updates nothing', async () => {
    const { p, updates } = platform()
    expect((await rolloutOnce({ desired: () => 'unknown', platform: () => p, busy: async () => [] })).updated).toEqual([])
    expect(updates).toEqual([])
  })
})
