/**
 * When a job in the Recent jobs list is offered a force kill.
 */
export interface JobActivity { displayStatus: string; createdAt: string; lastActivityAt?: string; workerHeartbeatAt?: string }

/** How long a job may go without activity before it is offered a force kill. */
export const JOB_STUCK_MS = 10 * 60_000

/**
 * A job that has done nothing for a while: running or claimed with no new
 * activity (or its worker no longer heartbeating), paused for long, or queued
 * with nobody picking it up.
 */
export function jobLooksStuck(job: JobActivity, now = Date.now()): boolean {
  const idleFor = now - Date.parse(job.lastActivityAt ?? job.createdAt)
  if (job.displayStatus === 'running' || job.displayStatus === 'claimed') {
    const heartbeatStale = job.workerHeartbeatAt ? now - Date.parse(job.workerHeartbeatAt) > 2 * 60_000 : false
    return idleFor > JOB_STUCK_MS || heartbeatStale
  }
  if (job.displayStatus === 'paused' || job.displayStatus === 'queued') return idleFor > JOB_STUCK_MS
  return false
}
