import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { closeDb, getDb } from '../src/lib/db'
import { reapStrandedRuns } from '../src/lib/job-reaper'

/**
 * A run left 'running' with no job and no live worker (DEFA-1, 2026-10-13: a
 * restart while the agent worked on an answer closed the job but never handed
 * the run back) is re-queued from its stage; a run still being driven is not.
 */

const sql = getDb()
const projectId = randomUUID()
const slug = `test-stranded-${projectId.slice(0, 8)}`

async function insertRun(input: { owner?: string | null; startedAgo: string }): Promise<string> {
  const runId = randomUUID()
  await sql`
    INSERT INTO pipeline_runs (run_id, project_id, project_namespace, project_label, project_path, pipeline_name, template_json, options_json, status, current_stage, owning_worker_id, created_at)
    VALUES (${runId}, ${projectId}, ${slug}, 'test', '/tmp/test', 'stranded-test', '{}'::jsonb, '{}'::jsonb, 'running', 'deliver', ${input.owner ?? null}, now() - ${input.startedAgo}::interval)
  `
  return runId
}

async function insertJob(runId: string, status: string, endedAgo: string | null): Promise<void> {
  await sql`
    INSERT INTO project_jobs (job_id, project_id, kind, status, trigger_source, run_id, ended_at)
    VALUES (${randomUUID()}, ${projectId}, 'pipeline_run', ${status}, 'api', ${runId}, ${endedAgo ? sql`now() - ${endedAgo}::interval` : null})
  `
}

async function runState(runId: string) {
  const [run] = await sql<Array<{ status: string; currentStage: string | null }>>`SELECT status, current_stage AS "currentStage" FROM pipeline_runs WHERE run_id = ${runId}`
  const jobs = await sql<Array<{ payload: { fromStage?: string } }>>`SELECT payload_json AS payload FROM project_jobs WHERE run_id = ${runId} AND status = 'queued'`
  return { ...run!, queued: jobs }
}

beforeAll(async () => {
  await sql`INSERT INTO projects (project_id, name, slug) VALUES (${projectId}, 'stranded runs test', ${slug})`
})

afterAll(async () => {
  await sql`DELETE FROM pipeline_runs WHERE project_id = ${projectId}`
  await sql`DELETE FROM projects WHERE project_id = ${projectId}`
  await closeDb()
})

describe('reapStrandedRuns', () => {
  test('re-queues a running run whose job finished and whose worker is gone', async () => {
    const runId = await insertRun({ owner: null, startedAgo: '1 hour' })
    await insertJob(runId, 'completed', '10 minutes')
    expect(await reapStrandedRuns({ projectId })).toBe(1)
    const state = await runState(runId)
    expect(state.status).toBe('queued')
    expect(state.currentStage).toBe('deliver')
    expect(state.queued).toHaveLength(1)
    expect(state.queued[0]!.payload.fromStage).toBe('deliver')
    // Re-queued once: the queued job now drives it.
    expect(await reapStrandedRuns({ projectId })).toBe(0)
  })

  test('leaves a run alone while a job is running it', async () => {
    const runId = await insertRun({ owner: null, startedAgo: '1 hour' })
    await insertJob(runId, 'running', null)
    await reapStrandedRuns({ projectId })
    expect((await runState(runId)).status).toBe('running')
  })

  test('leaves a run alone while its owning worker is alive', async () => {
    const workerId = `test-${randomUUID()}`
    await sql`INSERT INTO workers (worker_id, last_heartbeat_at) VALUES (${workerId}, now())`
    try {
      const runId = await insertRun({ owner: workerId, startedAgo: '1 hour' })
      await insertJob(runId, 'completed', '10 minutes')
      await reapStrandedRuns({ projectId })
      expect((await runState(runId)).status).toBe('running')
    } finally {
      await sql`DELETE FROM workers WHERE worker_id = ${workerId}`
    }
  })

  test('gives a job that just ended time to move its run on', async () => {
    const runId = await insertRun({ owner: null, startedAgo: '1 hour' })
    await insertJob(runId, 'completed', '10 seconds')
    await reapStrandedRuns({ projectId })
    expect((await runState(runId)).status).toBe('running')
  })

  test("looks only at the worker's own project", async () => {
    const runId = await insertRun({ owner: null, startedAgo: '1 hour' })
    expect(await reapStrandedRuns({ projectId: randomUUID() })).toBe(0)
    expect((await runState(runId)).status).toBe('running')
  })
})
