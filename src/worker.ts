#!/usr/bin/env bun
import process from 'node:process'
import { access } from 'node:fs/promises'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { PipelineEngine } from './lib/pipeline-engine'

async function fileExists(file: string): Promise<boolean> {
  try { await access(file); return true } catch { return false }
}
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
  getOrchestrator,
  markJobRunning,
  reapOrphanedRuns,
  retryRunAndEnqueue,
} from './lib/dispatcher'
import type { SpeedMode } from './lib/model-router'
import {
  appendEvent,
  claimRunForWorker,
  clearRunOwner,
  getRun,
  incrementRetryAndRequeue,
  openGate,
  requeueRunFromStage,
  resolveOpenGate,
  updateRunStatus,
} from './lib/run-store'
import { getWorkerId, heartbeatWorker, subscribeAsWorker, unregisterWorker } from './lib/worker-registry'
import type { FlowProgress, StageName } from './lib/aidlc'
import { log } from './lib/logger'
import { checkAnthropicKey } from './lib/provider-check'
import { exportProjectState, reconcilePlanRepositories } from './lib/governance'
import { suggestRepositoriesAndWorkAreas } from './lib/suggestions'

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
  const templateStages = (run.templateJson?.steps ?? []).map((s) => s.stage as StageName)
  const startStage = fromStage && templateStages.includes(fromStage) ? fromStage : undefined

  await claimRunForWorker(runId, getWorkerId())
  await updateRunStatus(runId, { status: 'running', currentStage: startStage ?? templateStages[0], errorMessage: null })

  // Read speed mode from the project's orchestrator config (persisted in
  // project_orchestrators.config_json.speed_mode). Falls through to 'balanced'
  // if not set. Feeds the model router.
  let speedMode: SpeedMode | undefined
  if (run.projectId) {
    const orch = await getOrchestrator(run.projectId)
    const raw = (orch?.configJson as Record<string, unknown> | undefined)?.speed_mode
    if (raw === 'fast' || raw === 'balanced' || raw === 'quality') {
      speedMode = raw
    }
  }

  // Warm agent pool: reuse this project's primary session across runs so
  // the agent keeps context. Falls back to a fresh session if none warmed.
  let releaseAgent: ((sessionFile?: string | null) => Promise<void>) | undefined
  let poolInfo: { wasWarm: boolean; agentId: string } | undefined
  // Rerun/resume: continue the previous attempt's agent session (its whole
  // conversation, tool results and files read) and seed the cross-stage handoff
  // thread from what earlier stages recorded, instead of starting from scratch.
  const resumeSessionFile = startStage && run.sessionFile && (await fileExists(run.sessionFile)) ? run.sessionFile : undefined
  const priorHandoffs = startStage
    ? (await getDb()<Array<{ stepId: string; stage: string; model: string | null; tail: string; summary: string | null }>>`
        SELECT step_id AS "stepId", stage, model, tail, summary
          FROM run_thread_entries WHERE run_id = ${runId} ORDER BY entry_id ASC
      `).slice(-6).map((h) => ({ stepId: h.stepId, stage: h.stage, model: h.model ?? undefined, text: h.summary ?? h.tail, compacted: Boolean(h.summary) }))
    : []
  if (startStage) {
    await queueEvent(runId, 'context_restored', { sessionFile: resumeSessionFile ?? null, priorHandoffStages: priorHandoffs.map((h) => h.stage) })
  }

  const options = {
    ...run.optionsJson,
    ...(startStage ? { startStage } : {}),
    ...(speedMode ? { speedMode } : {}),
    ...(priorHandoffs.length ? { priorHandoffs } : {}),
    ...(resumeSessionFile
      ? {
          // Same session file as the previous attempt → the agent keeps its context.
          persistSession: true,
          sessionManagerFactory: async () => SessionManager.open(resumeSessionFile, undefined, run.projectPath),
        }
      : run.projectId
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
          INSERT INTO run_thread_entries (run_id, step_index, step_id, stage, model, tail, summary, summary_hash)
          VALUES (${runId}, ${h.stepIndex}, ${h.stepId}, ${h.stage}, ${h.model ?? null}, ${h.tail}, ${h.summary ?? null}, ${h.summaryHash ?? null})
        `
        // Plan named repositories? Register + clone the missing ones now so the
        // following stages (tasks, implement) can work in them.
        if (h.stage === 'plan' && run.projectId) {
          void reconcilePlanRepositories(run.projectId, run.projectPath)
            .then(async ({ added, unknown }) => {
              if (added.length || unknown.length) void queueEvent(runId, 'plan_repositories', { added, unknown })
              // Refresh repository/work-area suggestions from the plan itself.
              const suggestions = await suggestRepositoriesAndWorkAreas(run.projectId!, { basis: 'plan', model: run.optionsJson.model }).catch(() => undefined)
              if (suggestions) void queueEvent(runId, 'suggestions_updated', { basis: 'plan', repositories: suggestions.repositories.length, workAreas: suggestions.workAreas.length })
            })
            .catch((err) => workerLog.warn('plan repository reconciliation failed', { runId, error: err instanceof Error ? err.message : String(err) }))
        }
        void queueEvent(runId, 'handoff_captured', {
          stepId: h.stepId,
          stage: h.stage,
          model: h.model,
          tailBytes: h.tail.length,
          summaryBytes: h.summary?.length ?? 0,
          compacted: !!h.summary,
        })
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
    const stages = (run.templateJson?.steps ?? []).map((s) => s.stage as StageName)
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

  // A second answer (double click, or "Continue" followed by typed text) can
  // arrive while the engine is already running the previous one. The flow would
  // throw "not waiting for input" and the run would be marked failed although it
  // is healthy — so ignore it and say so in the timeline instead.
  if (!engine.isWaitingForInput()) {
    workerLog.info('answer ignored: engine is not waiting for input', { runId })
    await queueEvent(runId, 'answer_ignored', { response: answer, reason: 'The run is already continuing; this answer arrived while the previous one was being processed.' })
    return
  }

  const gate = await resolveOpenGate(runId, answer)
  await queueEvent(runId, 'gate_resolved', { gateId: gate?.gateId, kind: gate?.kind, response: answer })
  // Flip the run to running right away so the UI stops offering the answer box
  // while the stage continues; the pause state is re-established if it pauses again.
  await updateRunStatus(runId, { status: 'running', currentStage: engine.getCurrentStage() ?? null, pauseKind: null, errorMessage: null })
  await queueEvent(runId, 'resumed', { stage: engine.getCurrentStage() })

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
    void exportRunProjectState(runId, `stage ${progress.stage ?? '?'} paused`)
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
  void exportRunProjectState(runId, 'run completed')
  await drainEvents(runId)
  const engine = engines.get(runId)
  await engine?.dispose()
  engines.delete(runId)
}

/** Provider/network failures that are worth retrying from the same stage without human action. */
const TRANSIENT_PROVIDER_ERROR = /socket connection was closed|ECONNRESET|ETIMEDOUT|EPIPE|fetch failed|network error|overloaded|rate.?limit|\b(429|500|502|503|504|529)\b|internal server error|temporarily unavailable/i
const MAX_TRANSIENT_RETRIES = 2

let shuttingDown = false

/** Persist memory/knowledge/manifest into the project's governing workspace (and S3 when configured). */
async function exportRunProjectState(runId: string, reason: string): Promise<void> {
  try {
    const run = await getRun(runId)
    if (!run?.projectId) return
    await exportProjectState(run.projectId, `${reason} (run ${runId.slice(0, 8)})`)
  } catch (err) {
    workerLog.warn('governance export failed', { runId, error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleEngineError(runId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error)
  // During shutdown, engines are disposed under in-flight prompts, which surface
  // as "Flow session has not been created yet." — shutdown() already re-queued
  // or paused the run; don't overwrite that with a bogus failure.
  if (shuttingDown) {
    workerLog.info('engine error during shutdown ignored (run already handed off)', { runId, message })
    return
  }
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

/**
 * Jobs from different projects run concurrently on one worker, up to this many
 * at once. Per-project concurrency is still enforced by claimNextJob (each
 * project's max_concurrent), so a long pipeline run in one project no longer
 * blocks a quick verify in another.
 */
const MAX_CONCURRENT_JOBS = Math.max(1, Number(process.env.WORKER_MAX_CONCURRENT_JOBS ?? '4') || 4)
const inFlightJobs = new Set<Promise<void>>()
let dispatcherRunning = false

/**
 * Per-project mode (set by src/supervisor.ts): only claim this project's jobs,
 * and exit once idle for WORKER_IDLE_EXIT_SECONDS so the supervisor can scale
 * workers down. A worker holding paused runs (live engines) is never idle.
 */
const WORKER_PROJECT_ID = process.env.WORKER_PROJECT_ID?.trim() || undefined
const WORKER_IDLE_EXIT_SECONDS = Math.max(0, Number(process.env.WORKER_IDLE_EXIT_SECONDS ?? '0') || 0)
let idleSince: number | undefined

async function drainDispatcher(workerId: string): Promise<void> {
  if (dispatcherRunning) return
  dispatcherRunning = true
  try {
    // Claim runnable jobs until every slot is busy or nothing is runnable.
    while (inFlightJobs.size < MAX_CONCURRENT_JOBS) {
      const job = await claimNextJob(workerId, WORKER_PROJECT_ID)
      if (!job) return
      const task: Promise<void> = handleProjectJob(job.jobId)
        .catch((err) => workerLog.error('job handler crashed', { jobId: job.jobId }, err instanceof Error ? err : new Error(String(err))))
        .finally(() => {
          inFlightJobs.delete(task)
          // A slot freed up: look for more work right away.
          void drainDispatcher(workerId)
        })
      inFlightJobs.add(task)
    }
  } finally {
    dispatcherRunning = false
  }
}

/**
 * Close jobs claimed by workers that stopped heartbeating and hand their runs
 * to the queue. Only this worker's own project (per-project mode) or every
 * project (shared mode) is considered.
 */
async function reapDeadWorkerJobs(): Promise<void> {
  const sql = getDb()
  try {
    const dead = await sql<Array<{ jobId: string; runId: string | null; projectId: string; claimedBy: string | null }>>`
      SELECT j.job_id AS "jobId", j.run_id AS "runId", j.project_id AS "projectId", j.claimed_by AS "claimedBy"
        FROM project_jobs j
        LEFT JOIN workers w ON w.worker_id = j.claimed_by
       WHERE j.status IN ('claimed','running')
         AND j.started_at < now() - interval '2 minutes'
         AND (${WORKER_PROJECT_ID ?? null}::uuid IS NULL OR j.project_id = ${WORKER_PROJECT_ID ?? null}::uuid)
         AND (w.worker_id IS NULL OR w.last_heartbeat_at < now() - interval '90 seconds')
    `
    for (const job of dead) {
      // Never reap our own in-flight jobs (we are obviously alive).
      if (job.claimedBy === getWorkerId()) continue
      await failJob(job.jobId, `Worker ${job.claimedBy ?? '(unknown)'} stopped heartbeating; job closed and run handed off.`)
      if (!job.runId) continue
      const run = await getRun(job.runId)
      if (!run || run.status !== 'running') continue
      const stage = run.currentStage ?? null
      const note = `Worker ${job.claimedBy ?? '(unknown)'} died during stage ${stage ?? 'start'}; re-queued from that stage.`
      await requeueRunFromStage(job.runId, stage, note)
      await appendEvent({ runId: job.runId, kind: 'requeued', payload: { fromStage: stage, reason: note, deadWorker: job.claimedBy } })
      await enqueueJob({ projectId: job.projectId, kind: 'pipeline_run', triggerSource: 'api', payload: { runId: job.runId, fromStage: stage ?? undefined }, runId: job.runId })
      workerLog.info('handed off run from dead worker', { runId: job.runId, deadWorker: job.claimedBy, stage })
    }
    if (dead.length > 0) workerLog.info('reaped dead-worker jobs', { count: dead.length })
  } catch (err) {
    workerLog.error('dead-worker reaper failed', err instanceof Error ? err : new Error(String(err)))
  }
}

async function main(): Promise<void> {
  const workerId = getWorkerId()
  workerLog.info('worker starting', { workerId })

  // Register + heartbeat so the server can tell whether the worker that owns a
  // paused run is still alive before routing an answer to it, and so the
  // supervisor/UI can see hot vs idle per-project workers.
  const heartbeatMeta = () => ({
    projectId: WORKER_PROJECT_ID,
    pid: process.pid,
    activeJobs: inFlightJobs.size,
    pausedRuns: engines.size,
    supervised: Boolean(process.env.WORKER_SUPERVISED),
  })
  await heartbeatWorker(workerId, heartbeatMeta())
  if (WORKER_PROJECT_ID) workerLog.info('per-project worker', { projectId: WORKER_PROJECT_ID, idleExitSeconds: WORKER_IDLE_EXIT_SECONDS })
  // Non-fatal: warn loudly if the Anthropic key in this process's environment is a placeholder or rejected.
  void checkAnthropicKey(workerLog)
  setInterval(() => {
    void heartbeatWorker(workerId, heartbeatMeta()).catch((err) => workerLog.error('heartbeat failed', err))

    // Idle exit (per-project workers): nothing running and no live engines for
    // long enough → shut down cleanly; the supervisor respawns when work appears.
    if (WORKER_IDLE_EXIT_SECONDS > 0) {
      const idle = inFlightJobs.size === 0 && engines.size === 0
      if (!idle) {
        idleSince = undefined
      } else if (idleSince === undefined) {
        idleSince = Date.now()
      } else if (Date.now() - idleSince > WORKER_IDLE_EXIT_SECONDS * 1000) {
        workerLog.info('idle for too long; exiting so the supervisor can scale down', { idleSeconds: WORKER_IDLE_EXIT_SECONDS })
        void shutdown('IDLE')
      }
    }
  }, 5_000)

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
  // Reap jobs whose worker died. Liveness comes from the workers heartbeat
  // table, NOT from elapsed time: a plan or implement stage legitimately runs
  // for far longer than any fixed timeout, and the old 10-minute rule marked
  // healthy jobs as failed, let the dispatcher start a second run for the same
  // project, and re-queued duplicates. A dead worker's run is handed off: the
  // job is closed and the run is re-queued from the stage it was in.
  setInterval(() => { void reapDeadWorkerJobs() }, 60_000)
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
  if (shuttingDown) return
  shuttingDown = true
  workerLog.info('shutdown signal received; disposing engines', { signal })
  for (const [runId, engine] of engines) {
    try {
      const run = await getRun(runId)
      // Trust the engine, not the DB row: a run whose answer is being processed
      // can still read 'paused' in the DB for a moment while the engine is busy.
      if (run && engine.isWaitingForInput()) {
        // Nothing was executing. Keep the run paused; the next answer restarts
        // the stage on a fresh worker (see handleAnswerJob's no-engine path).
        await updateRunStatus(runId, {
          status: 'paused',
          pauseKind: run.pauseKind ?? null,
          currentStage: run.currentStage ?? null,
          errorMessage: `Worker restarted (${signal}) while paused. Answering or approving will restart stage ${run.currentStage ?? '?'} on a new worker.`,
        })
        await queueEvent(runId, 'worker_restarted', { signal, stage: run.currentStage, status: 'paused' })
        // Nobody will listen on this worker's channel any more: drop ownership so the
        // server's answer route falls back to re-queueing instead of a lost NOTIFY.
        await clearRunOwner(runId)
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
  await unregisterWorker(getWorkerId()).catch(() => undefined)
  await closeDb()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

await main()
