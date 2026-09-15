#!/usr/bin/env bun
import process from 'node:process'
import { PipelineEngine } from './lib/pipeline-engine'
import { assertEnvOrExit } from './lib/env'
import { closeDb, getDb } from './lib/db'

assertEnvOrExit('worker')
import { acquireWarmSession, reapIdleAgents } from './lib/agent-pool'
import {
  claimNextJob,
  completeJob,
  enqueueJob,
  failJob,
  getJob,
  markJobRunning,
  reapOrphanedRuns,
  retryRunAndEnqueue,
} from './lib/dispatcher'
import {
  appendEvent,
  claimRunForWorker,
  getRun,
  incrementRetryAndRequeue,
  openGate,
  requeueRunFromStage,
  resolveOpenGate,
  updateRunStatus,
} from './lib/run-store'
import { getWorkerId, subscribeAsWorker } from './lib/worker-registry'
import type { FlowProgress, StageName } from './lib/aidlc'
import { log } from './lib/logger'

const workerLog = log.child({ mod: 'worker' })

/**
 * Phase 2 single-worker MVP.
 *
 * Holds live PipelineEngine instances in memory keyed by runId while a run is
 * active or paused. Answer jobs dispatch to the engine held by this worker.
 *
 * Multi-worker fan-out would require per-worker NOTIFY channels and instance
 * discovery — deferred to a later phase.
 */
const engines = new Map<string, PipelineEngine>()

/** project_jobs row currently executing each run, so shutdown can release it. */
const activeJobs = new Map<string, string>()

/**
 * Per-run promise chain that serializes appendEvent() writes. Without this,
 * concurrent void appendEvent() calls from streaming text_delta events land in
 * BIGSERIAL commit-order, which occasionally scrambles the concatenated log
 * on the client.
 */
const eventChains = new Map<string, Promise<unknown>>()

function queueEvent(runId: string, kind: string, payload: unknown, stepIndex?: number): Promise<void> {
  const prev = eventChains.get(runId) ?? Promise.resolve()
  const next = prev
    .catch(() => undefined)
    .then(() => appendEvent({ runId, kind, payload, stepIndex }))
  eventChains.set(runId, next)
  return next
}

async function drainEvents(runId: string): Promise<void> {
  const pending = eventChains.get(runId)
  if (!pending) return
  try {
    await pending
  } catch {
    // errors already logged; ignore
  }
  eventChains.delete(runId)
}

async function handleRunJob(runId: string, fromStage?: StageName): Promise<void> {
  const run = await getRun(runId)
  if (!run) {
    workerLog.error('run not found in DB', { runId })
    return
  }

  if (run.status !== 'queued') {
    workerLog.info('run already claimed, skipping', { runId, status: run.status })
    return
  }

  // Rerun/resume: start at the requested stage when it exists in this template.
  const templateStages = run.templateJson.steps.map((s) => s.stage as StageName)
  const startStage = fromStage && templateStages.includes(fromStage) ? fromStage : undefined

  await claimRunForWorker(runId, getWorkerId())
  await updateRunStatus(runId, { status: 'running', currentStage: startStage ?? templateStages[0], errorMessage: null })

  // Warm agent pool: reuse this project's primary session across runs so
  // the agent keeps context. Falls back to a fresh session if none warmed.
  let releaseAgent: ((sessionFile?: string | null) => Promise<void>) | undefined
  let poolInfo: { wasWarm: boolean; agentId: string } | undefined
  const options = {
    ...run.optionsJson,
    ...(startStage ? { startStage } : {}),
    ...(run.projectId
      ? {
          sessionManagerFactory: async () => {
            const grip = await acquireWarmSession({
              projectId: run.projectId!,
              role: 'primary',
              cwd: run.projectPath,
            })
            releaseAgent = grip.release
            poolInfo = { wasWarm: grip.wasWarm, agentId: grip.agentId }
            return grip.manager
          },
        }
      : {}),
  }

  await queueEvent(runId, startStage ? 'run_resumed' : 'run_started', {
    pipeline: run.pipelineName,
    workerId: getWorkerId(),
    ...(startStage ? { fromStage: startStage, attempt: run.retryCount } : {}),
  })

  // Wrap engine construction inside the try/catch too — the PipelineEngine
  // constructor can throw (e.g. validateStageInputs: "specify stage requires
  // --feature"). Without this wrapping, the throw bubbles up to
  // handleProjectJob and only the JOB gets marked errored — the RUN stays
  // stuck at 'running' forever, showing "in progress" in the UI.
  let engine: PipelineEngine
  try {
    engine = new PipelineEngine(run.templateJson, options, {
      stdout: (chunk) => {
        void queueEvent(runId, 'log', { stream: 'stdout', chunk })
      },
      stderr: (chunk) => {
        void queueEvent(runId, 'log', { stream: 'stderr', chunk })
      },
      onStageHandoff: async (h) => {
        const sql = getDb()
        await sql`
          INSERT INTO run_thread_entries (run_id, step_index, step_id, stage, model, tail)
          VALUES (${runId}, ${h.stepIndex}, ${h.stepId}, ${h.stage}, ${h.model ?? null}, ${h.tail})
        `
        void queueEvent(runId, 'handoff_captured', { stepId: h.stepId, stage: h.stage, model: h.model, tailBytes: h.tail.length })
      },
    })
  } catch (error) {
    await releaseAgent?.(null)
    await handleEngineError(runId, error)
    return
  }
  engines.set(runId, engine)

  try {
    const result = await engine.start()
    // Report warm-agent status once (after ensureSession has fired).
    if (poolInfo && poolInfo.wasWarm) {
      await queueEvent(runId, 'agent_reused', { agentId: poolInfo.agentId, role: 'primary' })
    }
    await applyProgress(runId, result)
    await releaseAgent?.(result.sessionFile ?? null)
  } catch (error) {
    await releaseAgent?.(null)
    await handleEngineError(runId, error)
  }
}

async function handleAnswerJob(runId: string, answer: string): Promise<void> {
  const engine = engines.get(runId)
  if (!engine) {
    // The engine that paused this run died with a previous worker process. We
    // can't feed the answer into a live session, but the run is not lost: record
    // the answer, then restart the paused stage (or, for an approved review gate,
    // the next stage) from its on-disk artifacts.
    const run = await getRun(runId)
    if (!run || run.status !== 'paused') {
      workerLog.error('no live engine for run and run is not paused; ignoring answer', { runId, status: run?.status })
      return
    }
    const gate = await resolveOpenGate(runId, answer)
    await queueEvent(runId, 'gate_resolved', { gateId: gate?.gateId, kind: gate?.kind, response: answer, afterRestart: true })
    const stages = run.templateJson.steps.map((s) => s.stage as StageName)
    const currentIdx = run.currentStage ? stages.indexOf(run.currentStage) : -1
    const approved = run.pauseKind === 'review' && /^(approve|approved|lgtm|yes|ok|continue)\b/i.test(answer.trim())
    const nextIdx = approved ? currentIdx + 1 : Math.max(0, currentIdx)
    if (approved && nextIdx >= stages.length) {
      await updateRunStatus(runId, { status: 'completed', currentStage: null, pauseKind: null, errorMessage: null })
      await queueEvent(runId, 'run_completed', { afterRestart: true })
      return
    }
    const fromStage = stages[nextIdx]
    const note = approved
      ? `Approved after a worker restart; continuing from stage ${fromStage}.`
      : `Worker restarted while paused; re-running stage ${fromStage} with your answer recorded in the run timeline.`
    await requeueRunFromStage(runId, fromStage ?? null, note)
    await queueEvent(runId, 'requeued', { fromStage, reason: note })
    if (run.projectId) {
      await enqueueJob({ projectId: run.projectId, kind: 'pipeline_run', triggerSource: 'user', payload: { runId, fromStage }, runId })
    }
    return
  }

  const gate = await resolveOpenGate(runId, answer)
  await queueEvent(runId, 'gate_resolved', { gateId: gate?.gateId, kind: gate?.kind, response: answer })

  try {
    const result = await engine.answer(answer)
    await applyProgress(runId, result)
  } catch (error) {
    await handleEngineError(runId, error)
  }
}

async function applyProgress(runId: string, progress: FlowProgress): Promise<void> {
  if (progress.status === 'paused') {
    await updateRunStatus(runId, {
      status: 'paused',
      pauseKind: progress.pauseKind,
      currentStage: progress.stage,
      sessionFile: progress.sessionFile ?? null,
    })
    const engine = engines.get(runId)
    const template = engine ? getTemplateFromEngine(engine) : undefined
    const stepIndex = template ? indexOfStage(template, progress.stage) : 0
    await openGate({
      runId,
      stepIndex,
      kind: progress.pauseKind ?? 'clarification',
      prompt: progress.stage,
    })
    await queueEvent(runId, 'paused', { stage: progress.stage, pauseKind: progress.pauseKind })
    return
  }

  // completed
  await updateRunStatus(runId, {
    status: 'completed',
    currentStage: null,
    pauseKind: null,
    sessionFile: progress.sessionFile ?? null,
    errorMessage: null,
  })
  await queueEvent(runId, 'run_completed', { sessionFile: progress.sessionFile })
  await drainEvents(runId)
  const engine = engines.get(runId)
  await engine?.dispose()
  engines.delete(runId)
}

/** Provider/network failures that are worth retrying from the same stage without human action. */
const TRANSIENT_PROVIDER_ERROR = /socket connection was closed|ECONNRESET|ETIMEDOUT|EPIPE|fetch failed|network error|overloaded|rate.?limit|\b(429|500|502|503|504|529)\b|internal server error|temporarily unavailable/i
const MAX_TRANSIENT_RETRIES = 2

async function handleEngineError(runId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error)
  const run = await getRun(runId)
  const retry = run?.templateJson.retry
  const attempts = run?.retryCount ?? 0
  // Keep the stage the failure happened in: reruns and the UI need it.
  const failedStage = (engines.get(runId)?.getCurrentStage() ?? run?.currentStage) as StageName | undefined

  // Transient provider error (socket closed, 5xx, overloaded): retry from the same
  // stage automatically, a couple of times, before asking a human to rerun.
  if (run?.projectId && TRANSIENT_PROVIDER_ERROR.test(message) && attempts < MAX_TRANSIENT_RETRIES) {
    const note = `Transient provider error during stage ${failedStage ?? 'start'} — retrying from that stage (attempt ${attempts + 2}/${MAX_TRANSIENT_RETRIES + 1}): ${message}`
    await queueEvent(runId, 'retry_scheduled', { message, attempt: attempts + 1, maxAttempts: MAX_TRANSIENT_RETRIES, fromStage: failedStage, transient: true })
    await drainEvents(runId)
    const engine = engines.get(runId)
    await engine?.dispose()
    engines.delete(runId)
    await requeueRunFromStage(runId, failedStage ?? null, note)
    await enqueueJob({ projectId: run.projectId, kind: 'pipeline_run', triggerSource: 'api', payload: { runId, fromStage: failedStage }, runId })
    return
  }

  if (retry && attempts < retry.max) {
    const nextAttempt = attempts + 1
    await queueEvent(runId, 'retry_scheduled', {
      message,
      attempt: nextAttempt,
      maxAttempts: retry.max,
      delayMs: retry.backoffMs ?? 0,
    })
    await drainEvents(runId)
    const engine = engines.get(runId)
    await engine?.dispose()
    engines.delete(runId)

    // Retry + enqueue must be transactional. If the process dies between
    // marking the run 'queued' and inserting the project_job, we leave an
    // orphan (queued run with no job to consume it). retryRunAndEnqueue
    // wraps both in a single sql.begin() so either both land or neither.
    if (run?.projectId) {
      await retryRunAndEnqueue({
        runId,
        projectId: run.projectId,
        triggerSource: 'verify_loop',
      })
    } else {
      // No projectId — can't enqueue a job. Just bump retry_count so the run
      // reflects the attempt, and let it sit as errored (dispatcher only runs
      // project-attached jobs anyway).
      await incrementRetryAndRequeue(runId)
      await updateRunStatus(runId, { status: 'error', errorMessage: `${message} (no projectId — cannot retry)` })
    }
    return
  }

  // Exhausted retries — dead letter. Keep the failed stage so "Rerun from <stage>" is possible.
  await updateRunStatus(runId, { status: 'error', errorMessage: message, currentStage: failedStage ?? null })
  await queueEvent(runId, retry ? 'dead_letter' : 'error', { message, attempts })
  await drainEvents(runId)
  const engine = engines.get(runId)
  await engine?.dispose()
  engines.delete(runId)
}

function getTemplateFromEngine(engine: PipelineEngine): ReturnType<typeof engine.getCurrentStage> extends undefined ? never : never {
  // helper is unused; kept for future template metadata plumbing
  return undefined as never
}

function indexOfStage(template: { steps: Array<{ stage: string }> }, stage: string | undefined): number {
  if (!stage) return 0
  const idx = template.steps.findIndex((s) => s.stage === stage)
  return idx >= 0 ? idx : 0
}

/**
 * Handle one project_jobs row. Dispatches by kind to the underlying work handler.
 * Called from the poll loop, one at a time per worker.
 */
async function handleProjectJob(jobId: string): Promise<void> {
  const job = await getJob(jobId)
  if (!job) return

  await markJobRunning(jobId)
  try {
    switch (job.kind) {
      case 'pipeline_run':
      case 'verify_fix': {
        const payload = job.payloadJson as { runId?: string; fromStage?: StageName }
        const runId = payload.runId ?? job.runId
        if (!runId) throw new Error('pipeline_run job missing runId')
        activeJobs.set(runId, jobId)
        try {
          await handleRunJob(runId, payload.fromStage)
        } finally {
          activeJobs.delete(runId)
        }
        break
      }
      case 'task_run':
      case 'workstream_run': {
        // For now these go through the same PipelineEngine path via a synthesized
        // single-step template that the server-side execute-step route builds.
        const payload = job.payloadJson as { runId?: string; fromStage?: StageName }
        const runId = payload.runId ?? job.runId
        if (!runId) throw new Error('task/workstream job missing runId')
        activeJobs.set(runId, jobId)
        try {
          await handleRunJob(runId, payload.fromStage)
        } finally {
          activeJobs.delete(runId)
        }
        break
      }
      case 'webhook':
        // Webhook payloads translated to real jobs (Phase 5C).
        workerLog.info('webhook job — no-op (Phase 5C)', { jobId })
        break
    }
    await completeJob(jobId)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await failJob(jobId, message)
  }
}

let dispatcherRunning = false
async function drainDispatcher(workerId: string): Promise<void> {
  if (dispatcherRunning) return
  dispatcherRunning = true
  try {
    // Claim jobs one by one until nothing is runnable.
    while (true) {
      const job = await claimNextJob(workerId)
      if (!job) return
      await handleProjectJob(job.jobId)
    }
  } finally {
    dispatcherRunning = false
  }
}

async function main(): Promise<void> {
  const workerId = getWorkerId()
  workerLog.info('worker starting', { workerId })

  // Wake on any project_jobs INSERT via pg NOTIFY.
  const sql = getDb()
  await sql.listen('project_job', () => {
    void drainDispatcher(workerId)
  })

  // Answer notifications for paused runs (unchanged from Phase 3).
  await subscribeAsWorker(workerId, async (payload) => {
    workerLog.debug('answer notify received', { runId: payload.runId })
    await handleAnswerJob(payload.runId, payload.answer)
  })

  // Polling floor in case a NOTIFY is missed (e.g., reconnect).
  setInterval(() => { void drainDispatcher(workerId) }, 5000)
  // Reap idle warm agents every 5 minutes (default cutoff: 30 min idle).
  setInterval(() => {
    void reapIdleAgents().then((n) => {
      if (n > 0) workerLog.info('reaped idle agents', { count: n })
    })
  }, 5 * 60_000)
  // Reap stale in-flight jobs (worker crashed mid-run). Any job stuck in
  // claimed/running for > 10 minutes with no ended_at is marked error so the
  // dispatcher can accept new jobs for the same project.
  setInterval(() => {
    const sql = getDb()
    void sql`
      UPDATE project_jobs
         SET status='error', ended_at=now(),
             error_message=COALESCE(error_message, '') || 'Stale — worker did not complete within 10 min; auto-reaped.'
       WHERE status IN ('claimed','running')
         AND started_at IS NOT NULL
         AND started_at < now() - INTERVAL '10 minutes'
      RETURNING job_id
    `.then((rows) => {
      if (rows.length > 0) workerLog.info('reaped stale jobs', { count: rows.length })
    }).catch((err) => workerLog.error('stale reaper failed', err))
  }, 60_000)
  // Reap orphaned pipeline_runs — queued runs older than 30s with no matching
  // project_jobs row. Caused by a worker crash between the retry UPDATE and
  // the job INSERT before retryRunAndEnqueue was transactional. This reaper
  // is a safety net: even with the transactional fix, a crashed peer worker
  // or a manual DB manipulation could still leave orphans behind.
  setInterval(() => {
    void reapOrphanedRuns()
      .then(({ reenqueued, failed }) => {
        if (reenqueued > 0 || failed > 0) {
          workerLog.info('reaped orphaned runs', { reenqueued, failed })
        }
      })
      .catch((err) => workerLog.error('orphan-run reaper failed', err))
  }, 30_000)
  await drainDispatcher(workerId)

  workerLog.info('subscribed to project_job queue; waiting for jobs')
}

async function shutdown(signal: string): Promise<void> {
  workerLog.info('shutdown signal received; disposing engines', { signal })
  for (const [runId, engine] of engines) {
    try {
      const run = await getRun(runId)
      if (run?.status === 'paused') {
        // Nothing was executing. Keep the run paused; the next answer restarts
        // the stage on a fresh worker (see handleAnswerJob's no-engine path).
        await updateRunStatus(runId, {
          status: 'paused',
          pauseKind: run.pauseKind ?? null,
          currentStage: run.currentStage ?? null,
          errorMessage: `Worker restarted (${signal}) while paused. Answering or approving will restart stage ${run.currentStage ?? '?'} on a new worker.`,
        })
        await queueEvent(runId, 'worker_restarted', { signal, stage: run.currentStage, status: 'paused' })
      } else if (run) {
        // Mid-stage: put the run back on the queue at the interrupted stage so the
        // next worker picks it up automatically instead of leaving a dead "error".
        const stage = run.currentStage ?? null
        const note = `Interrupted by a worker restart (${signal}) during stage ${stage ?? 'start'}; re-queued from that stage.`
        await requeueRunFromStage(runId, stage, note)
        await queueEvent(runId, 'requeued', { fromStage: stage, reason: note, signal })
        const jobId = activeJobs.get(runId)
        if (jobId) await failJob(jobId, `Worker shutting down (${signal}); run re-queued`)
        if (run.projectId) {
          await enqueueJob({ projectId: run.projectId, kind: 'pipeline_run', triggerSource: 'api', payload: { runId, fromStage: stage ?? undefined }, runId })
        }
      }
      await drainEvents(runId)
      await engine.dispose()
    } catch (err) {
      workerLog.error('shutdown cleanup for run failed', { runId }, err instanceof Error ? err : new Error(String(err)))
    }
  }
  engines.clear()
  activeJobs.clear()
  await closeDb()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

await main()
