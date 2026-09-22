import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { getDatabaseUrl, getDb } from '../src/lib/db'
import { answerPausedRun } from '../src/lib/run-store'

async function isDbReachable(): Promise<boolean> {
  try { await getDb()`SELECT 1 FROM pipeline_gates LIMIT 0`; return true } catch { return false }
}
/** A worker running against this database would claim the jobs these tests queue (same probe as dispatcher.test.ts). */
async function foreignWorkerActive(): Promise<boolean> {
  const sql = getDb()
  const probe = randomUUID()
  try {
    await sql`INSERT INTO projects (project_id, name, slug) VALUES (${probe}, 'probe', ${`test-probe-${probe.slice(0, 8)}`})`
    await sql`INSERT INTO project_orchestrators (project_id, autonomous_mode, max_concurrent) VALUES (${probe}, false, 1)`
    const [job] = await sql<Array<{ jobId: string }>>`
      INSERT INTO project_jobs (job_id, project_id, kind, trigger_source, status) VALUES (${randomUUID()}, ${probe}, 'pipeline_run', 'api', 'queued') RETURNING job_id AS "jobId"`
    const deadline = Date.now() + 500
    while (Date.now() < deadline) {
      const [row] = await sql<Array<{ status: string }>>`SELECT status FROM project_jobs WHERE job_id = ${job!.jobId}`
      if (row && row.status !== 'queued') return true
      await new Promise((r) => setTimeout(r, 50))
    }
    return false
  } finally {
    await sql`DELETE FROM projects WHERE project_id = ${probe}`
  }
}

const dbAvailable = await isDbReachable()
const foreignWorker = dbAvailable ? await foreignWorkerActive() : false
const dbSuite = dbAvailable && !foreignWorker ? describe : describe.skip
if (!dbAvailable) test.skip(`answer DB tests skipped: DATABASE_URL not reachable (${getDatabaseUrl()})`, () => {})
else if (foreignWorker) test.skip('answer DB tests skipped: a worker is claiming jobs on this database (stop it and re-run)', () => {})

dbSuite('answering a paused run', () => {
  const projectId = randomUUID()
  const slug = `test-answer-${projectId.slice(0, 8)}`
  const sql = getDb()

  async function pausedRun(pauseKind: string | null, status = 'paused'): Promise<string> {
    const runId = randomUUID()
    await sql`
      INSERT INTO pipeline_runs (run_id, project_id, project_namespace, project_label, project_path, pipeline_name, template_json, options_json, status, pause_kind, current_stage)
      VALUES (${runId}, ${projectId}, ${slug}, 'test', '/tmp/test', 'answer-test', '{}'::jsonb, '{}'::jsonb, ${status}, ${pauseKind}, 'review')
    `
    if (pauseKind === 'review' || pauseKind === 'clarification') {
      await sql`INSERT INTO pipeline_gates (gate_id, run_id, step_index, kind, status, prompt) VALUES (${randomUUID()}, ${runId}, 0, ${pauseKind}, 'open', 'review')`
    }
    return runId
  }

  beforeAll(async () => {
    await sql`INSERT INTO projects (project_id, name, slug, description) VALUES (${projectId}, 'answer test', ${slug}, 'created by answer-paused-run.test.ts')`
  })
  afterAll(async () => {
    await sql`DELETE FROM project_jobs WHERE project_id = ${projectId}`
    await sql`DELETE FROM projects WHERE project_id = ${projectId}`
  })

  test('the run, the gate, the event and the job change together, once', async () => {
    const runId = await pausedRun('review')
    const first = await answerPausedRun({ runId, projectId, answer: 'approve' })
    expect(first).toEqual({ ok: true, stage: 'review', pauseKind: 'review' })

    const [run] = await sql<Array<{ status: string; pauseKind: string | null }>>`SELECT status, pause_kind AS "pauseKind" FROM pipeline_runs WHERE run_id = ${runId}`
    expect(run).toEqual({ status: 'queued', pauseKind: null })
    const [gate] = await sql<Array<{ status: string; response: string }>>`SELECT status, response FROM pipeline_gates WHERE run_id = ${runId}`
    expect(gate).toEqual({ status: 'resolved', response: 'approve' })
    const jobs = await sql<Array<{ payload: { answer: { text: string; pauseKind: string }; fromStage: string } }>>`SELECT payload_json AS payload FROM project_jobs WHERE run_id = ${runId}`
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.payload.answer).toEqual({ text: 'approve', pauseKind: 'review' })
    expect(jobs[0]!.payload.fromStage).toBe('review')
    const [event] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pipeline_events WHERE run_id = ${runId} AND kind = 'gate_resolved'`
    expect(event!.n).toBe(1)

    // A second answer finds nothing waiting and queues nothing.
    expect(await answerPausedRun({ runId, projectId, answer: 'approve' })).toEqual({ ok: false, reason: 'not_waiting' })
    const [count] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM project_jobs WHERE run_id = ${runId}`
    expect(count!.n).toBe(1)
  })

  test('a run that is not waiting at a gate takes no answer', async () => {
    expect(await answerPausedRun({ runId: await pausedRun(null, 'running'), projectId, answer: 'hi' })).toEqual({ ok: false, reason: 'not_waiting' })
  })

  test('an archived project takes no answer and the run stays paused', async () => {
    const runId = await pausedRun('clarification')
    await sql`UPDATE projects SET archived_at = now() WHERE project_id = ${projectId}`
    try {
      expect(await answerPausedRun({ runId, projectId, answer: 'yes' })).toEqual({ ok: false, reason: 'archived' })
      const [run] = await sql<Array<{ status: string }>>`SELECT status FROM pipeline_runs WHERE run_id = ${runId}`
      expect(run!.status).toBe('paused')
    } finally {
      await sql`UPDATE projects SET archived_at = NULL WHERE project_id = ${projectId}`
    }
  })
})
