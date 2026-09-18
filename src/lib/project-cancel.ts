/**
 * Cancel everything a project has in flight — used when a project is archived.
 *
 * Database first, then a signal: queued/claimed/running jobs and queued,
 * running or paused runs are marked `cancelled` (open gates resolved, busy
 * agents released), then a `run_cancel` NOTIFY per run tells whichever worker
 * holds the live engine to dispose it. The worker recognises the cancelled
 * status and neither retries nor overwrites it; if no worker is alive the rows
 * are already final.
 */

import { getDb } from './db'
import { log } from './logger'
import type { ProjectRow } from './project-registry'

const cancelLog = log.child({ mod: 'project-cancel' })

export interface CancelledWork {
  jobsCancelled: number
  runsCancelled: number
  runIds: string[]
}

export async function cancelProjectWork(project: ProjectRow, reason: string): Promise<CancelledWork> {
  const sql = getDb()
  const result = await sql.begin(async (tx) => {
    const jobs = await tx<Array<{ jobId: string }>>`
      UPDATE project_jobs SET status = 'cancelled', ended_at = now(), error_message = ${reason}, updated_at = now()
      WHERE project_id = ${project.projectId} AND status IN ('queued', 'claimed', 'running') RETURNING job_id AS "jobId"
    `
    const runs = await tx<Array<{ runId: string }>>`
      UPDATE pipeline_runs SET status = 'cancelled', error_message = ${reason}, pause_kind = NULL, owning_worker_id = NULL, updated_at = now()
      WHERE (project_namespace = ${project.slug} OR project_id = ${project.projectId}) AND status IN ('queued', 'running', 'paused')
      RETURNING run_id AS "runId"
    `
    const runIds = runs.map((r) => r.runId)
    if (runIds.length) {
      await tx`UPDATE pipeline_gates SET status = 'resolved', response = 'cancelled', resolved_at = now() WHERE run_id = ANY(${runIds}::uuid[]) AND status = 'open'`
      for (const runId of runIds) {
        await tx`INSERT INTO pipeline_events (run_id, kind, payload) VALUES (${runId}, 'cancelled', ${tx.json({ reason } as never)})`
      }
    }
    await tx`UPDATE project_agents SET status = 'idle', current_job_id = NULL WHERE project_id = ${project.projectId} AND status IN ('busy', 'warming')`
    return { jobsCancelled: jobs.length, runsCancelled: runs.length, runIds }
  })
  // Wake the workers holding live engines for these runs.
  for (const runId of result.runIds) await sql`SELECT pg_notify('run_cancel', ${runId})`
  if (result.jobsCancelled || result.runsCancelled) cancelLog.info('cancelled project work', { slug: project.slug, reason, ...result })
  return result
}
