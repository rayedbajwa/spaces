import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { closeDb, getDatabaseUrl, getDb } from '../src/lib/db'
import { claimNextJob, enqueueJob, reapOrphanedRuns, retryRunAndEnqueue, upsertOrchestrator } from '../src/lib/dispatcher'

/**
 * Integration test for `claimNextJob` — verifies the SKIP LOCKED invariant:
 * two concurrent workers never claim the same job.
 *
 * Requires:
 *  - live Postgres at DATABASE_URL with db-schema.sql applied
 *  - no external worker.ts process racing against the test DB (would steal jobs
 *    before our test could observe them). If detected, the suite skips with a
 *    message rather than emitting a false failure.
 */

async function isDbReachable(): Promise<boolean> {
  try {
    const sql = getDb()
    await sql`SELECT 1`
    return true
  } catch {
    return false
  }
}

/**
 * Detect whether an external process is polling project_jobs on this DB. We
 * enqueue a probe job under a throwaway project, wait briefly, and see if
 * anything not named `test-probe-*` claimed it. If so, a real dispatcher is
 * running against the same DB and would race with our test — we skip.
 */
async function foreignWorkerActive(): Promise<boolean> {
  const sql = getDb()
  const probeProjectId = randomUUID()
  const slug = `test-probe-${probeProjectId.slice(0, 8)}`
  try {
    await sql`INSERT INTO projects (project_id, name, slug) VALUES (${probeProjectId}, ${'probe'}, ${slug})`
    await sql`
      INSERT INTO project_orchestrators (project_id, autonomous_mode, max_concurrent)
      VALUES (${probeProjectId}, false, 1)
    `
    const [job] = await sql<Array<{ jobId: string }>>`
      INSERT INTO project_jobs (job_id, project_id, kind, trigger_source, status)
      VALUES (${randomUUID()}, ${probeProjectId}, 'pipeline_run', 'api', 'queued')
      RETURNING job_id AS "jobId"
    `
    // Poll for up to ~500ms; if a foreign worker exists it will claim quickly.
    const deadline = Date.now() + 500
    while (Date.now() < deadline) {
      const [row] = await sql<Array<{ status: string; claimedBy: string | null }>>`
        SELECT status, claimed_by AS "claimedBy" FROM project_jobs WHERE job_id = ${job.jobId}
      `
      if (row && row.status !== 'queued') return true
      await new Promise((r) => setTimeout(r, 50))
    }
    return false
  } finally {
    // Cascade deletes the job + orchestrator rows.
    await sql`DELETE FROM projects WHERE project_id = ${probeProjectId}`
  }
}

const dbAvailable = await isDbReachable()
const foreignWorker = dbAvailable ? await foreignWorkerActive() : false
const shouldRun = dbAvailable && !foreignWorker
const suite = shouldRun ? describe : describe.skip

if (!dbAvailable) {
  test.skip(`dispatcher integration tests skipped: DATABASE_URL not reachable (${getDatabaseUrl()})`, () => {})
} else if (foreignWorker) {
  test.skip('dispatcher integration tests skipped: foreign worker process is claiming jobs on this DB (stop `bun run src/worker.ts` and re-run)', () => {})
}

suite('dispatcher.claimNextJob concurrency', () => {
  const projectId = randomUUID()
  const projectSlug = `test-dispatcher-${projectId.slice(0, 8)}`

  beforeAll(async () => {
    const sql = getDb()
    await sql`
      INSERT INTO projects (project_id, name, slug, description)
      VALUES (${projectId}, ${'dispatcher test project'}, ${projectSlug}, ${'created by dispatcher.test.ts'})
    `
    await upsertOrchestrator({
      projectId,
      autonomousMode: true,
      maxConcurrent: 1,
    })
  })

  afterAll(async () => {
    const sql = getDb()
    // ON DELETE CASCADE on project_jobs + project_orchestrators removes the rest.
    await sql`DELETE FROM projects WHERE project_id = ${projectId}`
    await closeDb()
  })

  test('two concurrent claimNextJob calls never return the same job', async () => {
    // Core SKIP LOCKED invariant: even when two workers race for the same
    // project's queue, they must NEVER both claim the same job row.
    const jobA = await enqueueJob({
      projectId,
      kind: 'pipeline_run',
      triggerSource: 'api',
      priority: 1,
    })
    const jobB = await enqueueJob({
      projectId,
      kind: 'pipeline_run',
      triggerSource: 'api',
      priority: 1,
    })
    expect(jobA.jobId).not.toBe(jobB.jobId)

    const [claimA, claimB] = await Promise.all([
      claimNextJob('worker-A'),
      claimNextJob('worker-B'),
    ])

    // Primary invariant: whatever the outcome, they must not both point at
    // the same job. This is what FOR UPDATE SKIP LOCKED protects against.
    if (claimA && claimB) {
      expect(claimA.jobId).not.toBe(claimB.jobId)
    }

    // max_concurrent=1 invariant: only ONE of the two concurrent claims
    // may succeed. Enforced by the per-project advisory lock in
    // claimNextJob — before the lock, both could bypass the limit because
    // the in_flight subquery read pre-update snapshots. The advisory lock
    // is non-blocking, so the losing worker's claim returns undefined
    // rather than waiting.
    const winners = [claimA, claimB].filter((r): r is NonNullable<typeof r> => Boolean(r))
    expect(winners.length).toBe(1)
    const winner = winners[0]!
    expect(winner.status).toBe('claimed')
    expect(['worker-A', 'worker-B']).toContain(winner.claimedBy)
    expect([jobA.jobId, jobB.jobId]).toContain(winner.jobId)
  })

  test('sequential claims succeed up to max_concurrent, then are refused', async () => {
    // Advisory lock only serializes concurrent claims within one project —
    // sequential claims are unaffected. This test verifies max_concurrent is
    // still an upper bound: with a limit of 2, two sequential claims succeed
    // and the third is refused (returns undefined) even though a job is queued.
    await upsertOrchestrator({ projectId, maxConcurrent: 2 })

    // Reset the queue for this project: mark any leftover claimed/running as
    // completed so in_flight = 0 for a clean start.
    const sql = getDb()
    await sql`UPDATE project_jobs SET status = 'completed', ended_at = now()
              WHERE project_id = ${projectId} AND status IN ('claimed','running')`
    await sql`UPDATE project_jobs SET status = 'completed', ended_at = now()
              WHERE project_id = ${projectId} AND status = 'queued'`

    await enqueueJob({ projectId, kind: 'pipeline_run', triggerSource: 'api' })
    await enqueueJob({ projectId, kind: 'pipeline_run', triggerSource: 'api' })
    await enqueueJob({ projectId, kind: 'pipeline_run', triggerSource: 'api' })

    // Sequential claims — each one commits before the next starts, so the
    // advisory lock is released between them.
    const first = await claimNextJob('worker-1')
    const second = await claimNextJob('worker-2')
    const third = await claimNextJob('worker-3')

    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(first!.jobId).not.toBe(second!.jobId)
    // Third claim must be refused — in_flight is now 2, which equals the limit.
    expect(third).toBeUndefined()
  })

  test('concurrent claims across DIFFERENT projects both succeed', async () => {
    // The advisory lock is per-project (namespace 8140, key = hashtext(project_id)).
    // Two workers claiming from two different projects should not serialize.
    const projectX = randomUUID()
    const projectY = randomUUID()
    const sql = getDb()
    try {
      await sql`INSERT INTO projects (project_id, name, slug)
                VALUES (${projectX}, 'cross-a', ${'cross-a-' + projectX.slice(0, 8)}),
                       (${projectY}, 'cross-b', ${'cross-b-' + projectY.slice(0, 8)})`
      await upsertOrchestrator({ projectId: projectX, autonomousMode: true, maxConcurrent: 1 })
      await upsertOrchestrator({ projectId: projectY, autonomousMode: true, maxConcurrent: 1 })

      await enqueueJob({ projectId: projectX, kind: 'pipeline_run', triggerSource: 'api' })
      await enqueueJob({ projectId: projectY, kind: 'pipeline_run', triggerSource: 'api' })

      const [cx, cy] = await Promise.all([
        claimNextJob('worker-X'),
        claimNextJob('worker-Y'),
      ])

      // Different projects → both claims should succeed. They may be assigned
      // to whichever project each thread happened to lock first; what matters
      // is that BOTH concurrent claims returned a job.
      expect(cx).toBeDefined()
      expect(cy).toBeDefined()
      expect(cx!.jobId).not.toBe(cy!.jobId)
      expect(new Set([cx!.projectId, cy!.projectId])).toEqual(new Set([projectX, projectY]))
    } finally {
      await sql`DELETE FROM projects WHERE project_id IN (${projectX}, ${projectY})`
    }
  })

  test('retryRunAndEnqueue is atomic: run and job land together or neither', async () => {
    // Create a pipeline_run in errored state, then retry it. Both the run
    // status update AND the project_jobs insert must succeed together.
    const sql = getDb()
    const runId = randomUUID()
    await sql`
      INSERT INTO pipeline_runs (run_id, project_id, project_namespace, project_label, project_path, pipeline_name, template_json, options_json, status, retry_count)
      VALUES (${runId}, ${projectId}, ${projectSlug}, 'test', '/tmp/test', 'test-pipeline', '{}'::jsonb, '{}'::jsonb, 'error', 0)
    `

    const { retryCount, jobId } = await retryRunAndEnqueue({
      runId,
      projectId,
      triggerSource: 'verify_loop',
    })

    expect(retryCount).toBe(1)
    expect(jobId).toBeDefined()

    // Verify both sides of the transaction landed.
    const [runRow] = await sql<Array<{ status: string; retryCount: number }>>`
      SELECT status, retry_count AS "retryCount"
        FROM pipeline_runs WHERE run_id = ${runId}
    `
    expect(runRow!.status).toBe('queued')
    expect(runRow!.retryCount).toBe(1)

    const [jobRow] = await sql<Array<{ status: string; runId: string }>>`
      SELECT status, run_id AS "runId"
        FROM project_jobs WHERE job_id = ${jobId}
    `
    expect(jobRow!.status).toBe('queued')
    expect(jobRow!.runId).toBe(runId)

    // Cleanup
    await sql`DELETE FROM pipeline_runs WHERE run_id = ${runId}`
  })

  test('reapOrphanedRuns re-enqueues queued runs with no matching job', async () => {
    // Simulate an orphan: a pipeline_run in 'queued' status with no job, older
    // than the reaper's staleAfterMs. Reaper should re-enqueue it.
    const sql = getDb()
    const runId = randomUUID()
    await sql`
      INSERT INTO pipeline_runs (run_id, project_id, project_namespace, project_label, project_path, pipeline_name, template_json, options_json, status, retry_count, created_at)
      VALUES (${runId}, ${projectId}, ${projectSlug}, 'test', '/tmp/test', 'orphan-test', '{}'::jsonb, '{}'::jsonb, 'queued', 0, now() - INTERVAL '5 minutes')
    `

    const result = await reapOrphanedRuns(30_000)
    expect(result.reenqueued).toBeGreaterThanOrEqual(1)

    const [jobRow] = await sql<Array<{ status: string; triggerSource: string }>>`
      SELECT status, trigger_source AS "triggerSource"
        FROM project_jobs
       WHERE run_id = ${runId}
    `
    expect(jobRow).toBeDefined()
    expect(jobRow!.status).toBe('queued')
    expect(jobRow!.triggerSource).toBe('reaper')

    // A second reap should NOT enqueue a duplicate — the orphan now has a
    // queued job so it doesn't qualify.
    const second = await reapOrphanedRuns(30_000)
    const [count] = await sql<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n FROM project_jobs WHERE run_id = ${runId}
    `
    expect(count!.n).toBe(1)
    expect(second.reenqueued).toBe(0)

    await sql`DELETE FROM pipeline_runs WHERE run_id = ${runId}`
  })

  test('reapOrphanedRuns skips recent queued runs (younger than threshold)', async () => {
    const sql = getDb()
    const runId = randomUUID()
    // Fresh run — created just now, should be ignored by the reaper.
    await sql`
      INSERT INTO pipeline_runs (run_id, project_id, project_namespace, project_label, project_path, pipeline_name, template_json, options_json, status)
      VALUES (${runId}, ${projectId}, ${projectSlug}, 'test', '/tmp/test', 'fresh-test', '{}'::jsonb, '{}'::jsonb, 'queued')
    `

    const before = await reapOrphanedRuns(30_000)
    const [jobs] = await sql<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n FROM project_jobs WHERE run_id = ${runId}
    `
    expect(jobs!.n).toBe(0)
    expect(before.reenqueued).toBe(0)

    await sql`DELETE FROM pipeline_runs WHERE run_id = ${runId}`
  })
})
