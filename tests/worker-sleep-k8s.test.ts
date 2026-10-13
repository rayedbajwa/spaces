import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { getDb } from '../src/lib/db'
import type { WorkerPlatform } from '../src/lib/worker-platform'
import { rolloutOnce } from '../src/lib/worker-rollout'
import { sleepIdleWorkers, wakeIfSleeping } from '../src/lib/worker-sleep'
import { createApprovalFixture } from './helpers/approval-fixture'

/**
 * Idle project workers on Kubernetes are stopped (scaled to 0) and started for
 * work (lib/worker-sleep.ts). The platform is a recording fake here; the real
 * cluster run is in docs/operations/project-workers.md.
 */
const fixture = await createApprovalFixture({ withServer: false })
const { projectA } = fixture
const sql = getDb()
const workerIds: string[] = []

const scaled: Array<{ name: string; replicas: number }> = []
const updated: string[] = []
const platform: WorkerPlatform = {
  kind: 'kubernetes',
  create: async () => ({ internalUrl: 'http://w' }),
  update: async (spec) => { updated.push(spec.version) },
  remove: async () => {},
  check: async () => ({ canRead: true }),
  scale: async (spec, _refs, replicas) => { scaled.push({ name: spec.name, replicas }) },
}

async function worker(patch: { state?: string; minutesSinceUpdate?: number; version?: string; migration?: string | null } = {}) {
  const minutes = patch.minutesSinceUpdate ?? 30
  await sql`
    INSERT INTO project_workers (project_id, internal_url, platform, service_ref, volume_ref, state, version, active, migration_state, updated_at, last_seen_at)
    VALUES (${projectA.projectId}, 'http://w', 'kubernetes', 'spaces-proj-x', 'spaces-proj-x-data', ${patch.state ?? 'ready'}, ${patch.version ?? 'v1'}, true, ${patch.migration ?? null},
            now() - make_interval(mins => ${minutes}), now() - make_interval(mins => ${minutes}))
    ON CONFLICT (project_id) DO UPDATE SET state = EXCLUDED.state, version = EXCLUDED.version, migration_state = EXCLUDED.migration_state,
           platform = 'kubernetes', service_ref = 'spaces-proj-x', updated_at = EXCLUDED.updated_at, last_seen_at = EXCLUDED.last_seen_at
  `
}
const state = async () => (await sql<Array<{ state: string; version: string }>>`SELECT state, version FROM project_workers WHERE project_id = ${projectA.projectId}`)[0]

afterAll(async () => {
  await sql`DELETE FROM project_jobs WHERE project_id = ${projectA.projectId}`
  if (workerIds.length) await sql`DELETE FROM workers WHERE worker_id IN ${sql(workerIds)}`
  await sql`DELETE FROM project_workers WHERE project_id = ${projectA.projectId}`
  await fixture.stop()
})

describe('stopping idle workers on Kubernetes', () => {
  test('a worker quiet for longer than the limit is scaled to 0 and marked sleeping', async () => {
    scaled.length = 0
    await worker()
    expect(await sleepIdleWorkers(platform, 600)).toEqual([projectA.projectId])
    expect(scaled).toEqual([{ name: expect.stringMatching(/^spaces-proj-/), replicas: 0 }])
    expect((await state())!.state).toBe('sleeping')
  })

  test('a worker that is busy, just started, being moved or heartbeating is left running', async () => {
    scaled.length = 0
    // Just started (woken a minute ago).
    await worker({ minutesSinceUpdate: 1 })
    expect(await sleepIdleWorkers(platform, 600)).toEqual([])
    // Queued work.
    await worker()
    const jobId = randomUUID()
    await sql`INSERT INTO project_jobs (job_id, project_id, kind, status, trigger_source) VALUES (${jobId}, ${projectA.projectId}, 'pipeline_run', 'queued', 'user')`
    expect(await sleepIdleWorkers(platform, 600)).toEqual([])
    await sql`DELETE FROM project_jobs WHERE job_id = ${jobId}`
    // Being moved.
    await worker({ migration: 'syncing' })
    expect(await sleepIdleWorkers(platform, 600)).toEqual([])
    // Its job process heartbeats.
    await worker()
    const workerId = `k8s-sleep-${randomUUID().slice(0, 8)}`
    workerIds.push(workerId)
    await sql`INSERT INTO workers (worker_id, project_id, last_heartbeat_at) VALUES (${workerId}, ${projectA.projectId}, now())`
    expect(await sleepIdleWorkers(platform, 600)).toEqual([])
    await sql`DELETE FROM workers WHERE worker_id = ${workerId}`
    expect(scaled).toEqual([])
    // A platform that sleeps services itself (Railway) has no scale: nothing to do.
    expect(await sleepIdleWorkers({ ...platform, scale: undefined }, 600)).toEqual([])
  })

  test('work starts a stopped worker once; a running one is left alone', async () => {
    scaled.length = 0
    await worker({ state: 'sleeping' })
    expect(await wakeIfSleeping(projectA.projectId, platform)).toBe(true)
    expect(await wakeIfSleeping(projectA.projectId, platform)).toBe(false)
    expect(scaled.map((s) => s.replicas)).toEqual([1])
    expect((await state())!.state).toBe('ready')
  })

  test('a failed start leaves it sleeping, with the error', async () => {
    await worker({ state: 'sleeping' })
    const failing: WorkerPlatform = { ...platform, scale: async () => { throw new Error('quota exceeded') } }
    expect(await wakeIfSleeping(projectA.projectId, failing)).toBe(false)
    const [row] = await sql<Array<{ state: string; lastError: string }>>`SELECT state, last_error AS "lastError" FROM project_workers WHERE project_id = ${projectA.projectId}`
    expect(row).toEqual({ state: 'sleeping', lastError: 'quota exceeded' })
  })

  test('a new version goes into a stopped worker without starting it', async () => {
    scaled.length = 0; updated.length = 0
    await worker({ state: 'sleeping', version: 'v1' })
    const result = await rolloutOnce({ desired: () => 'v2', platform: () => platform, busy: async () => [] })
    expect(result.updated).toContain(projectA.projectId)
    expect(updated).toEqual(['v2'])
    expect(scaled).toEqual([])
    expect(await state()).toEqual({ state: 'sleeping', version: 'v2' })
    // Already on it: nothing more.
    updated.length = 0
    await rolloutOnce({ desired: () => 'v2', platform: () => platform, busy: async () => [] })
    expect(updated).toEqual([])
  })
})
