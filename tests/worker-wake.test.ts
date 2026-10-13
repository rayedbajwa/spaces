import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { getDb } from '../src/lib/db'
import { awakeProjects, capWaiting, maxAwakeWorkers, projectsWaitingForWorker, recordCapHit, wakeProjectWorker, type WakeDeps } from '../src/lib/worker-wake'
import type { ProjectWorkerRow } from '../src/lib/worker-provisioner'
import { createApprovalFixture } from './helpers/approval-fixture'

/** 014-project-workers, phase 3: waking workers for queued work within the awake cap. */

const fixture = await createApprovalFixture({ withServer: false })
const { projectA, projectTeamB } = fixture
const sql = getDb()
const jobs: string[] = []
const workerIds: string[] = []

afterAll(async () => {
  if (jobs.length) await sql`DELETE FROM project_jobs WHERE job_id IN ${sql(jobs)}`
  if (workerIds.length) await sql`DELETE FROM workers WHERE worker_id IN ${sql(workerIds)}`
  await sql`DELETE FROM project_workers WHERE project_id IN (${projectA.projectId}, ${projectTeamB.projectId})`
  await sql`DELETE FROM worker_cap_hits WHERE project_id IN (${projectA.projectId}, ${projectTeamB.projectId})`
  await fixture.stop()
})

const ready = (projectId: string): ProjectWorkerRow => ({ projectId, internalUrl: 'http://w', platform: 'docker', serviceRef: 's', volumeRef: 'v', state: 'ready', version: null, lastSeenAt: null, diskUsedBytes: null, lastError: null, updatedAt: '', active: true, migrationState: null, migrationJson: null, migrationAt: null })

function deps(overrides: Partial<WakeDeps> = {}) {
  const calls: string[] = []
  const d: WakeDeps = {
    awake: async () => [],
    getWorker: async (projectId) => ready(projectId),
    provision: async (projectId) => { calls.push(`provision ${projectId}`) },
    wake: async (projectId) => { calls.push(`wake ${projectId}`); return true },
    hasPlatform: () => true,
    provisionMissing: () => true,
    hasLocalFiles: async () => false,
    capHit: async (projectId, awake, cap) => { calls.push(`cap ${projectId} ${awake}/${cap}`) },
    cap: () => 2,
    ...overrides,
  }
  return { d, calls }
}

describe('waking a project worker', () => {
  test('a ready worker that is not running is woken', async () => {
    const { d, calls } = deps()
    expect(await wakeProjectWorker('p1', d)).toBe('woken')
    expect(calls).toEqual(['wake p1'])
  })

  test('a running worker is left alone', async () => {
    const { d, calls } = deps({ awake: async () => ['p1'] })
    expect(await wakeProjectWorker('p1', d)).toBe('running')
    expect(calls).toEqual([])
  })

  test('at the cap the work waits and the cap hit is recorded', async () => {
    const { d, calls } = deps({ awake: async () => ['a', 'b'] })
    expect(await wakeProjectWorker('p1', d)).toBe('at_cap')
    expect(calls).toEqual(['cap p1 2/2'])
  })

  test('a project without a worker is provisioned (and woken once it is up)', async () => {
    const { d, calls } = deps({ getWorker: async () => undefined })
    expect(await wakeProjectWorker('p1', d)).toBe('provisioning')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(calls).toEqual(['provision p1', 'wake p1'])
  })

  test("a project whose files are still on the shared disk is not given an empty worker", async () => {
    const { d, calls } = deps({ getWorker: async () => undefined, hasLocalFiles: async () => true })
    expect(await wakeProjectWorker('p5', d)).toBe('unavailable')
    expect(calls).toEqual([])
  })

  test('without a platform there is nothing to wake', async () => {
    const { d } = deps({ getWorker: async () => undefined, hasPlatform: () => false })
    expect(await wakeProjectWorker('p1', d)).toBe('unavailable')
  })

  test('concurrent wakes for one project make one call', async () => {
    const { d, calls } = deps({ wake: async (projectId) => { calls.push(`wake ${projectId}`); await new Promise((r) => setTimeout(r, 20)); return true } })
    await Promise.all([wakeProjectWorker('p2', d), wakeProjectWorker('p2', d), wakeProjectWorker('p2', d)])
    expect(calls).toEqual(['wake p2'])
  })

  test('outside the web role only moved projects are woken; nothing is provisioned', async () => {
    const { d, calls } = deps({ provisionMissing: () => false, getWorker: async () => undefined })
    expect(await wakeProjectWorker('p3', d)).toBe('unavailable')
    const inactive = deps({ provisionMissing: () => false, getWorker: async (projectId) => ({ ...ready(projectId), active: false }) })
    expect(await wakeProjectWorker('p4', inactive.d)).toBe('unavailable')
    expect([...calls, ...inactive.calls]).toEqual([])
  })

  test('the cap defaults to 5', () => {
    expect(maxAwakeWorkers({})).toBe(5)
    expect(maxAwakeWorkers({ PROJECT_WORKERS_MAX_AWAKE: '8' })).toBe(8)
  })
})

describe('what is awake and what is waiting', () => {
  beforeEach(async () => {
    await sql`INSERT INTO project_workers (project_id, state) VALUES (${projectA.projectId}, 'ready'), (${projectTeamB.projectId}, 'ready') ON CONFLICT (project_id) DO NOTHING`
  })

  test('a project with queued work and no running worker is waiting; a heartbeat makes it awake', async () => {
    const jobId = randomUUID()
    jobs.push(jobId)
    await sql`INSERT INTO project_jobs (job_id, project_id, kind, trigger_source) VALUES (${jobId}, ${projectA.projectId}, 'pipeline_run', 'user')`
    expect(await projectsWaitingForWorker()).toContain(projectA.projectId)
    const workerId = `test-${randomUUID()}`
    workerIds.push(workerId)
    await sql`INSERT INTO workers (worker_id, project_id, last_heartbeat_at) VALUES (${workerId}, ${projectA.projectId}, now())`
    expect(await awakeProjects()).toContain(projectA.projectId)
    expect(await projectsWaitingForWorker()).not.toContain(projectA.projectId)
  })

  test('the super admin is told at most once an hour; the page lists who waits', async () => {
    const jobId = randomUUID()
    jobs.push(jobId)
    await sql`INSERT INTO project_jobs (job_id, project_id, kind, trigger_source) VALUES (${jobId}, ${projectTeamB.projectId}, 'pipeline_run', 'user')`
    await sql`DELETE FROM worker_cap_hits`
    await recordCapHit(projectTeamB.projectId, 5, 5)
    const [first] = await sql<Array<{ notifiedAt: string | null }>>`SELECT notified_at AS "notifiedAt" FROM worker_cap_hits WHERE project_id = ${projectTeamB.projectId}`
    expect(first?.notifiedAt).toBeTruthy()
    await recordCapHit(projectA.projectId, 5, 5)
    const [second] = await sql<Array<{ notifiedAt: string | null }>>`SELECT notified_at AS "notifiedAt" FROM worker_cap_hits WHERE project_id = ${projectA.projectId}`
    expect(second?.notifiedAt).toBeNull()
    expect((await capWaiting()).map((w) => w.projectId)).toContain(projectTeamB.projectId)
  })
})
