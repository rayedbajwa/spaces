import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { getDb } from '../src/lib/db'
import { forceKillJob } from '../src/lib/dispatcher'

const reachable = await getDb()`SELECT 1 FROM project_jobs LIMIT 0`.then(() => true, () => false)
const suite = reachable ? describe : describe.skip

suite('force killing a stuck job', () => {
  test('cancels the job, every active job of its run and the run; names the workers holding them, and tells them', async () => {
    const sql = getDb()
    const projectId = randomUUID()
    const runId = randomUUID()
    const slug = `force-kill-${projectId.slice(0, 8)}`
    await sql`INSERT INTO projects (project_id, name, slug) VALUES (${projectId}, 'force kill', ${slug})`
    try {
      await sql`
        INSERT INTO pipeline_runs (run_id, project_id, project_namespace, project_label, project_path, pipeline_name, template_json, options_json, status)
        VALUES (${runId}, ${projectId}, ${slug}, 'test', '/tmp/test', 'test', '{}'::jsonb, '{}'::jsonb, 'running')
      `
      const stuck = randomUUID()
      const sibling = randomUUID()
      await sql`INSERT INTO project_jobs (job_id, project_id, kind, status, trigger_source, run_id, claimed_by) VALUES (${stuck}, ${projectId}, 'pipeline_run', 'running', 'api', ${runId}, 'worker-hung')`
      await sql`INSERT INTO project_jobs (job_id, project_id, kind, status, trigger_source, run_id, claimed_by) VALUES (${sibling}, ${projectId}, 'pipeline_run', 'claimed', 'api', ${runId}, 'worker-other')`
      const notices: string[] = []
      const listener = await sql.listen('worker_kill', (id) => { notices.push(id) })
      const result = await forceKillJob(projectId, stuck, 'sam@acme.io')
      await new Promise((r) => setTimeout(r, 300))
      await listener.unlisten()
      expect(result?.runId).toBe(runId)
      expect(result?.claimants.sort()).toEqual(['worker-hung', 'worker-other'])
      expect(notices.sort()).toEqual(['worker-hung', 'worker-other'])
      const jobs = await sql<Array<{ status: string }>>`SELECT status FROM project_jobs WHERE run_id = ${runId}`
      expect(jobs.map((j) => j.status)).toEqual(['cancelled', 'cancelled'])
      const [run] = await sql<Array<{ status: string; errorMessage: string }>>`SELECT status, error_message AS "errorMessage" FROM pipeline_runs WHERE run_id = ${runId}`
      expect(run).toEqual({ status: 'cancelled', errorMessage: 'Force killed by sam@acme.io' })
      // Another project's job cannot be killed through this one.
      expect(await forceKillJob(randomUUID(), stuck, 'x')).toBeUndefined()
    } finally {
      await sql`DELETE FROM projects WHERE project_id = ${projectId}`
    }
  })
})
