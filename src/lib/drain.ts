/**
 * Graceful shutdown budget for a deploy.
 *
 * Railway sends the old deployment SIGTERM and, after
 * RAILWAY_DEPLOYMENT_DRAINING_SECONDS (0 unless configured), SIGKILL. A worker
 * killed mid-stage loses the whole stage and the run starts it again on the new
 * deployment — a long review or implement stage then repeats on every merge.
 *
 * With a budget, the worker stops claiming work and lets the running stage
 * finish, then hands the run back from its next stage and exits. The
 * supervisor and the standalone parent wait for it, so each process gets a
 * slice of the same window, innermost first. The web server keeps serving the
 * old version until the worker is gone: a service with a volume cannot run two
 * deployments at once, so the new one starts only after this one exits.
 *
 * SPACES_DRAIN_SECONDS overrides the Railway variable (for other platforms or
 * to drain less than the platform allows). Under a minute there is no room to
 * finish a stage, so the worker hands its runs back at once, as before.
 */

/** Below this there is no point waiting for a stage; runs are handed back immediately. */
const MIN_DRAIN_SECONDS = 60

export interface DrainBudget {
  /** The platform's window between SIGTERM and SIGKILL, in ms (0 when unset). */
  totalMs: number
  /** How long the worker may let running stages finish before handing runs back anyway. */
  workerMs: number
  /** How long the supervisor waits for its workers before SIGKILL. */
  supervisorMs: number
  /** How long the standalone parent waits for the supervisor before stopping everything. */
  standaloneMs: number
}

export function drainBudget(env: NodeJS.ProcessEnv = process.env): DrainBudget {
  const raw = env.SPACES_DRAIN_SECONDS ?? env.RAILWAY_DEPLOYMENT_DRAINING_SECONDS ?? '0'
  const seconds = Math.max(0, Number(raw) || 0)
  const totalMs = seconds * 1000
  if (seconds < MIN_DRAIN_SECONDS) {
    // The previous fixed timeouts: enough to re-queue runs, not to finish a stage.
    return { totalMs, workerMs: 0, supervisorMs: 15_000, standaloneMs: 25_000 }
  }
  // Innermost first, each leaving room for the one outside it: the worker needs
  // ~10 s after its deadline to hand runs back and close its connections.
  return {
    totalMs,
    workerMs: totalMs - 35_000,
    supervisorMs: totalMs - 20_000,
    standaloneMs: totalMs - 10_000,
  }
}
