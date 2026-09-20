/**
 * Jobs abandoned by a worker that died.
 *
 * A job is claimed before it starts and only finished by the worker holding
 * it, so a worker killed mid-flight — a deploy, an out-of-memory kill, a
 * container restart — leaves its job "claimed" or "running" for ever. That
 * single row blocks the whole project: the interface refuses to start anything
 * else while work is in flight, and nothing ever finishes it.
 *
 * Workers sweep for these, but a project whose worker never spawned has nobody
 * to sweep for it, so the web server runs the same sweep on a timer. Each
 * abandoned job is closed and its run handed back to the queue, which restarts
 * it from the stage it had reached.
 */

import { getDb } from './db'
import { enqueueJob, failJob } from './dispatcher'
import { log } from './logger'
import { appendEvent, getRun, requeueRunFromStage } from './run-store'
import type { StageName } from './aidlc'

const reaperLog = log.child({ mod: 'job-reaper' })

export interface ReapOptions {
  /** Limit the sweep to one project (a per-project worker sweeps only its own). */
  projectId?: string
  /** The caller's own worker id, so it never reaps the job it is running. */
  selfWorkerId?: string
}

/** Close jobs whose worker stopped heartbeating and re-queue their runs. Returns how many were closed. */
export async function reapAbandonedJobs(options: ReapOptions = {}): Promise<number> {
  const sql = getDb()
  const projectId = options.projectId ?? null
  const abandoned = await sql<Array<{ jobId: string; runId: string | null; projectId: string; claimedBy: string | null }>>`
    SELECT j.job_id AS "jobId", j.run_id AS "runId", j.project_id AS "projectId", j.claimed_by AS "claimedBy"
      FROM project_jobs j
      LEFT JOIN workers w ON w.worker_id = j.claimed_by
     WHERE j.status IN ('claimed','running')
       -- started_at is set only once the job actually runs, so a worker that died
       -- between claiming and starting would otherwise block its project for ever.
       AND COALESCE(j.started_at, j.updated_at, j.created_at) < now() - interval '2 minutes'
       AND (${projectId}::uuid IS NULL OR j.project_id = ${projectId}::uuid)
       AND (w.worker_id IS NULL OR w.last_heartbeat_at < now() - interval '90 seconds')
  `

  let closed = 0
  for (const job of abandoned) {
    if (options.selfWorkerId && job.claimedBy === options.selfWorkerId) continue
    await failJob(job.jobId, `Worker ${job.claimedBy ?? '(unknown)'} stopped heartbeating; job closed and run handed off.`)
    closed += 1
    if (!job.runId) continue
    const run = await getRun(job.runId)
    if (!run || run.status !== 'running') continue
    const stage = (run.currentStage as StageName | null) ?? null
    const note = `Worker ${job.claimedBy ?? '(unknown)'} died during stage ${stage ?? 'start'}; re-queued from that stage.`
    await requeueRunFromStage(job.runId, stage, note)
    await appendEvent({ runId: job.runId, kind: 'requeued', payload: { fromStage: stage, reason: note, deadWorker: job.claimedBy } })
    await enqueueJob({ projectId: job.projectId, kind: 'pipeline_run', triggerSource: 'api', payload: { runId: job.runId, fromStage: stage ?? undefined }, runId: job.runId })
    reaperLog.info('handed off a run from a dead worker', { runId: job.runId, deadWorker: job.claimedBy, stage })
  }
  if (closed > 0) reaperLog.info('closed abandoned jobs', { count: closed, projectId })
  return closed
}
