#!/usr/bin/env bun
import process from 'node:process'
import { access } from 'node:fs/promises'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { PipelineEngine } from './lib/pipeline-engine'

async function fileExists(file: string): Promise<boolean> {
  try { await access(file); return true } catch { return false }
}
import { assertEnvOrExit } from './lib/env'
import { closeDb, getDb, ignoreShutdownDbErrors } from './lib/db'

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
  updateRunStatus,
  appendReviewerNote,
} from './lib/run-store'
import { getWorkerId, heartbeatWorker, unregisterWorker } from './lib/worker-registry'
import { parseApprovalAnswer, type FlowProgress, type StageName } from './lib/aidlc'
import { buildResumeNote, resolveResumePoint } from './lib/run-resume'
import { reapAbandonedJobs } from './lib/job-reaper'
import { restoreRunSession, saveRunSession } from './lib/session-store'
import { log } from './lib/logger'
import { checkProviderKeys } from './lib/provider-check'
import { listenProviderKeys, loadProviderKeys, scrubProviderKeysFromEnv } from './lib/provider-keys'
import { getDefaultOrgId, orgIdForProject } from './lib/orgs'
import { exportProjectState, reconcilePlanRepositories } from './lib/governance'
import { suggestRepositoriesAndWorkAreas } from './lib/suggestions'
import { enrichOpenRouterUsage, needsProviderCost, priceRecord, recordUsage, usageFromMessage } from './lib/run-usage'
import { loadModelCatalog, type CatalogModel } from './lib/model-catalog'
import { gitHubActorEnv } from './lib/github-app-auth'
import { drainBudget } from './lib/drain'

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
/** Runs cancelled from outside (project archived) while this worker held them. */
const cancelledRuns = new Set<string>()
/** Runs asked to pause (project paused); the flow stops before its next stage. */
const pausedRuns = new Set<string>()
/**
 * Draining for a deploy (see lib/drain.ts): no new jobs are claimed, running
 * stages finish, and each run is handed back to the queue at its next stage
 * boundary instead of being killed mid-stage.
 */
let draining = false
/** Runs the drain stopped at a stage boundary; they are re-queued, not paused. */
const drainStopped = new Set<string>()

/** A run_cancel NOTIFY: drop the live engine; the run row is already final. */
async function handleRunCancel(runId: string): Promise<void> {
  const engine = engines.get(runId)
  if (!engine && !activeJobs.has(runId)) return
  cancelledRuns.add(runId)
  workerLog.info('run cancelled; disposing engine', { runId })
  engines.delete(runId)
  await engine?.dispose().catch(() => undefined)
}

/** True when the run was cancelled — by NOTIFY here, or in the database by another process. */
async function runWasCancelled(runId: string): Promise<boolean> {
  if (cancelledRuns.has(runId)) return true
  const run = await getRun(runId).catch(() => undefined)
  return run?.status === 'cancelled'
}

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

/** Keep the database copy of the run's session current; a failure here must never fail the run. */
async function saveSessionCopy(runId: string, sessionFile?: string | null): Promise<void> {
  if (!sessionFile) return
  await saveRunSession(runId, sessionFile).catch((err) =>
    workerLog.warn('saving the session copy failed', { runId, error: err instanceof Error ? err.message : String(err) }))
}

/**
 * Answers being applied on this worker, until the flow moves on to its next
 * stage. A transient failure before then retries with the answer again, so a
 * person's answer is never dropped by a provider hiccup.
 */
const pendingAnswers = new Map<string, { answer: GateAnswer; stage: StageName }>()

/** A person's answer to a run paused at a gate, carried by the job that resumes it (see the answer route). */
interface GateAnswer {
  text: string
  pauseKind: 'review' | 'clarification'
}

async function handleRunJob(runId: string, fromStage?: StageName, answer?: GateAnswer): Promise<void> {
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
  const requested = fromStage && templateStages.includes(fromStage) ? fromStage : undefined
  // A run that has run before picks up from what exists on disk rather than from
  // the top: stages whose artifacts are already written are not redone, and a
  // half-finished task list continues where it stopped. A run starting for the
  // first time always begins at the first stage — the artifacts it would find
  // belong to the previous feature, not to this one.
  const isResume = Boolean(requested || run.currentStage || run.retryCount > 0)
  // An answer continues the stage that paused; progress on disk must not move it on.
  const resumePoint = answer
    ? { stage: requested, completed: [], reason: `answer to the ${answer.pauseKind === 'review' ? 'approval gate' : 'question'} at ${requested ?? 'its stage'}` } as Awaited<ReturnType<typeof resolveResumePoint>>
    : isResume
    ? await resolveResumePoint({ projectPath: run.projectPath, stages: templateStages, recorded: requested ?? run.currentStage })
        .catch((error) => {
          workerLog.warn('resume point could not be read; starting from the requested stage', { runId, error: error instanceof Error ? error.message : String(error) })
          return { stage: requested, completed: [], reason: 'progress on disk could not be read' } as Awaited<ReturnType<typeof resolveResumePoint>>
        })
    : { stage: undefined, completed: [], reason: 'new run' } as Awaited<ReturnType<typeof resolveResumePoint>>
  let startStage = resumePoint.stage ?? requested
  if (startStage && startStage !== requested) {
    workerLog.info('resuming from existing progress', { runId, requested: requested ?? null, startStage, reason: resumePoint.reason })
  }

  await claimRunForWorker(runId, getWorkerId())
  await updateRunStatus(runId, { status: 'running', currentStage: startStage ?? templateStages[0], errorMessage: null })
  if (startStage) await queueEvent(runId, 'resumed', { stage: startStage, completed: resumePoint.completed, reason: resumePoint.reason, tasks: resumePoint.taskProgress ? { done: resumePoint.taskProgress.done, total: resumePoint.taskProgress.total } : undefined })

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
  let releaseAgent: ((sessionFile?: string | null, options?: { detach?: boolean }) => Promise<void>) | undefined
  let poolInfo: { wasWarm: boolean; agentId: string } | undefined
  // Rerun/resume: continue the previous attempt's agent session (its whole
  // conversation, tool results and files read) and seed the cross-stage handoff
  // thread from what earlier stages recorded, instead of starting from scratch.
  // This worker's disk may not have the conversation (a new volume, another
  // host): bring it back from the database copy before deciding how to resume.
  if (startStage && run.sessionFile) {
    const restored = await restoreRunSession(runId, run.sessionFile).catch((err) => {
      workerLog.warn('restoring the session copy failed', { runId, error: err instanceof Error ? err.message : String(err) })
      return false
    })
    if (restored) await queueEvent(runId, 'restored', { what: 'agent session', from: 'database' })
  }
  const resumeSessionFile = startStage && run.sessionFile && (await fileExists(run.sessionFile)) ? run.sessionFile : undefined
  // Answering a gate reopens the paused conversation and continues it in place.
  // Without the session file that is impossible: an approval moves on to the
  // next stage, and anything else re-runs the stage with the answer in context.
  const rehydrate = Boolean(answer && resumeSessionFile && startStage)
  if (rehydrate) pendingAnswers.set(runId, { answer: answer!, stage: startStage! })
  let answerContext = ''
  if (answer && !rehydrate) {
    const approval = parseApprovalAnswer(answer.text)
    if (answer.pauseKind === 'review' && approval.approved) {
      if (approval.note) {
        await appendReviewerNote(runId, startStage ?? null, approval.note)
        // The options below are built from this run row: pick up the note just stored.
        const refreshed = await getRun(runId)
        if (refreshed) run.optionsJson = refreshed.optionsJson
      }
      const next = startStage ? templateStages[templateStages.indexOf(startStage) + 1] : undefined
      if (!next) {
        await updateRunStatus(runId, { status: 'completed', currentStage: null, pauseKind: null, errorMessage: null })
        await queueEvent(runId, 'run_completed', { afterRestart: true })
        await drainEvents(runId)
        return
      }
      startStage = next
    } else {
      answerContext = `# A person's answer\n\nThis stage paused for ${answer.pauseKind === 'review' ? 'review' : 'a question'} and the conversation could not be reopened, so it runs again. Take this into account:\n\n${answer.text}`
    }
  }
  const priorHandoffs = startStage
    ? (await getDb()<Array<{ stepId: string; stage: string; model: string | null; tail: string; summary: string | null }>>`
        SELECT step_id AS "stepId", stage, model, tail, summary
          FROM run_thread_entries WHERE run_id = ${runId} ORDER BY entry_id ASC
      `).slice(-6).map((h) => ({ stepId: h.stepId, stage: h.stage, model: h.model ?? undefined, text: h.summary ?? h.tail, compacted: Boolean(h.summary) }))
    : []
  if (startStage) {
    await queueEvent(runId, 'context_restored', { sessionFile: resumeSessionFile ?? null, priorHandoffStages: priorHandoffs.map((h) => h.stage) })
  }

  // The agent is told what is already finished, so it continues the work instead of repeating it.
  const resumeNote = startStage && !answer ? buildResumeNote(resumePoint) : ''
  const sharedContextPrompt = [run.optionsJson?.sharedContextPrompt, resumeNote, answerContext].filter((part) => part && String(part).trim()).join('\n\n') || undefined

  const options = {
    ...run.optionsJson,
    ...(sharedContextPrompt ? { sharedContextPrompt } : {}),
    ...(startStage ? { startStage } : {}),
    ...(rehydrate ? { resumeWaiting: { kind: answer!.pauseKind, stage: startStage! } } : {}),
    ...(speedMode ? { speedMode } : {}),
    // Project paused (by NOTIFY here, or in the database): stop before the next stage.
    shouldPauseBeforeStage: async () => {
      if (pausedRuns.has(runId)) return true
      if (run.projectId) {
        const [row] = await getDb()<Array<{ pausedAt: string | null }>>`SELECT paused_at AS "pausedAt" FROM projects WHERE project_id = ${run.projectId}`
        if (row?.pausedAt) return true
      }
      // A deploy is draining this worker: stop here, between stages, and let the new one continue.
      if (draining) {
        drainStopped.add(runId)
        return true
      }
      return false
    },
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
  // Agent shells push and open pull requests as the GitHub App (bot) when one
  // is installed, so branch protection applies to the agent and humans approve.
  // A full volume kills a run mid-stage, usually while writing an artifact, so
  // space is reclaimed before the work starts rather than after it fails.
  {
    const { ensureDiskSpace, formatBytes } = await import('./lib/disk-housekeeping')
    const { workspaceRoot } = await import('./lib/github')
    const usage = await ensureDiskSpace(workspaceRoot()).catch(() => undefined)
    if (usage && usage.freeBytes < 200 * 1024 * 1024) {
      const message = `The workspace volume has only ${formatBytes(usage.freeBytes)} free of ${formatBytes(usage.totalBytes)}. Free space or grow the volume before running this again.`
      await updateRunStatus(runId, { status: 'error', errorMessage: message, currentStage: null })
      await queueEvent(runId, 'error', { message, reason: 'disk_full' })
      workerLog.error('refusing to start a run on a full volume', new Error(message))
      return
    }
  }

  const runOrgId = run.projectId ? await orgIdForProject(run.projectId) : await getDefaultOrgId()
  Object.assign(process.env, await gitHubActorEnv(runOrgId).catch(() => ({})))

  let engine: PipelineEngine
  try {
    engine = new PipelineEngine(run.templateJson, options, {
      onUsage: (message, stage) => {
        const raw = usageFromMessage(message, { runId, projectNamespace: run.projectNamespace, stage })
        if (!raw) return
        const record = priceRecord(raw, priceCatalog)
        void recordUsage(record)
          .then(async (usageId) => {
            // OpenRouter's routed models carry no static price: fetch the real cost and model, then let the UI refresh.
            if (needsProviderCost(record)) {
              const real = await enrichOpenRouterUsage(usageId, record.responseId!, (await loadProviderKeys(runOrgId).catch(() => ({} as Awaited<ReturnType<typeof loadProviderKeys>>))).openrouter)
              if (real) await queueEvent(runId, 'usage', { stage, provider: record.provider, model: real.model ?? record.model, costUsd: real.costUsd, priced: true })
            }
          })
          .catch((err) => workerLog.warn('usage record failed', { runId, error: err instanceof Error ? err.message : String(err) }))
        void queueEvent(runId, 'usage', { stage, provider: record.provider, model: record.model, inputTokens: record.inputTokens, outputTokens: record.outputTokens, cacheReadTokens: record.cacheReadTokens, costUsd: record.costUsd })
      },
      onStageStart: ({ stage, index, total }) => {
        // The answer has been applied once a stage starts: a later failure retries without it.
        pendingAnswers.delete(runId)
        // A flow reports progress only when it pauses or finishes, so without this
        // the stored stage lags behind the one running — and a restart would then
        // resume at the wrong stage, or from the beginning when none was stored.
        void updateRunStatus(runId, { status: 'running', currentStage: stage, pauseKind: null })
          .catch((err) => workerLog.warn('recording the current stage failed', { runId, stage, error: err instanceof Error ? err.message : String(err) }))
        void queueEvent(runId, 'stage_start', { stage, index, total })
      },
      stdout: (chunk) => {
        void queueEvent(runId, 'log', { stream: 'stdout', chunk })
      },
      stderr: (chunk) => {
        void queueEvent(runId, 'log', { stream: 'stderr', chunk })
      },
      onStageHandoff: async (h) => {
        // A stage finished: keep the database copy of the conversation current.
        void saveSessionCopy(runId, engines.get(runId)?.getSessionFile())
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
  if (await runWasCancelled(runId)) {
    // Cancelled between claim and start: never run it.
    await engine.dispose().catch(() => undefined)
    await releaseAgent?.(null)
    cancelledRuns.delete(runId)
    return
  }
  engines.set(runId, engine)

  try {
    const result = rehydrate ? await engine.resumeWithAnswer(answer!.text) : await engine.start()
    if (await runWasCancelled(runId)) {
      await finishCancelledRun(runId)
      await releaseAgent?.(null)
      return
    }
    // Report warm-agent status once (after ensureSession has fired).
    if (poolInfo && poolInfo.wasWarm) {
      await queueEvent(runId, 'agent_reused', { agentId: poolInfo.agentId, role: 'primary' })
    }
    await applyProgress(runId, result)
    // A run that stopped (at a gate, or paused) reopens this session later: it
    // is not handed to the next run of the project in the meantime.
    await releaseAgent?.(result.sessionFile ?? null, { detach: result.status === 'paused' })
    pendingAnswers.delete(runId)
  } catch (error) {
    await releaseAgent?.(null)
    if (await runWasCancelled(runId)) {
      // The engine was disposed under the running stage; that is the cancel, not a failure.
      await finishCancelledRun(runId)
      return
    }
    await handleEngineError(runId, error)
  }
}

async function finishCancelledRun(runId: string): Promise<void> {
  cancelledRuns.delete(runId)
  const engine = engines.get(runId)
  engines.delete(runId)
  await engine?.dispose().catch(() => undefined)
  await drainEvents(runId).catch(() => undefined)
  workerLog.info('run stopped after cancellation', { runId })
}

async function applyProgress(runId: string, progress: FlowProgress): Promise<void> {
  // Paused or finished: the next step (an answer, a rerun) may happen on another worker.
  await saveSessionCopy(runId, progress.sessionFile)
  if (progress.status === 'paused') {
    await updateRunStatus(runId, {
      status: 'paused',
      pauseKind: progress.pauseKind,
      currentStage: progress.stage,
      sessionFile: progress.sessionFile ?? null,
    })
    if (progress.pauseKind === 'user' && drainStopped.delete(runId)) {
      // Stopped by a deploy's drain, not by a person: the stage before this one
      // finished here, so the new deployment picks the run up at this stage.
      const run = await getRun(runId)
      const note = `Deploy in progress: the previous stage finished before the restart; continuing from stage ${progress.stage ?? 'start'} on the new deployment.`
      await requeueRunFromStage(runId, progress.stage ?? null, note)
      await queueEvent(runId, 'requeued', { fromStage: progress.stage, reason: note, signal: 'drain' })
      if (run?.projectId) {
        await enqueueJob({ projectId: run.projectId, kind: 'pipeline_run', triggerSource: 'api', payload: { runId, fromStage: progress.stage ?? undefined }, runId })
      }
      const held = engines.get(runId)
      engines.delete(runId)
      await held?.dispose().catch(() => undefined)
      await drainEvents(runId).catch(() => undefined)
      workerLog.info('drain: run handed back at a stage boundary', { runId, fromStage: progress.stage })
      return
    }
    if (progress.pauseKind === 'user') {
      // Paused by a user at a stage boundary: no question to answer. Resuming the
      // project re-queues the run from `progress.stage`, so the engine can go.
      await queueEvent(runId, 'paused', { stage: progress.stage, pauseKind: 'user', reason: 'Project paused by a user' })
      pausedRuns.delete(runId)
      const held = engines.get(runId)
      engines.delete(runId)
      await held?.dispose().catch(() => undefined)
      await drainEvents(runId).catch(() => undefined)
      return
    }
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
    // Nothing is held while a person decides: the session file is saved on the
    // run, and the answer comes back as a job any worker can take, which reopens
    // the conversation at this gate. The worker is free to go idle meanwhile.
    engines.delete(runId)
    await engine?.dispose().catch(() => undefined)
    await clearRunOwner(runId).catch(() => undefined)
    await drainEvents(runId).catch(() => undefined)
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
    // Still at the gate the answer was for: retry with the answer, so it is applied, not lost.
    const pending = pendingAnswers.get(runId)
    const carry = pending && pending.stage === failedStage ? { answer: pending.answer } : {}
    pendingAnswers.delete(runId)
    await requeueRunFromStage(runId, failedStage ?? null, note)
    await enqueueJob({ projectId: run.projectId, kind: 'pipeline_run', triggerSource: 'api', payload: { runId, fromStage: failedStage, ...carry }, runId })
    return
  }
  pendingAnswers.delete(runId)

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
        const payload = job.payloadJson as { runId?: string; fromStage?: StageName; answer?: GateAnswer }
        const runId = payload.runId ?? job.runId
        if (!runId) throw new Error('pipeline_run job missing runId')
        activeJobs.set(runId, jobId)
        try {
          await handleRunJob(runId, payload.fromStage, payload.answer)
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
  if (dispatcherRunning || draining || shuttingDown) return
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
 * Close jobs abandoned by dead workers and hand their runs back to the queue.
 * A per-project worker sweeps only its own project; a shared worker sweeps all.
 */
async function reapDeadWorkerJobs(): Promise<void> {
  try {
    await reapAbandonedJobs({ projectId: WORKER_PROJECT_ID ?? undefined, selfWorkerId: getWorkerId() })
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
  // Provider keys are read per organization, never from this process's environment.
  scrubProviderKeysFromEnv()
  await listenProviderKeys().catch(() => undefined)
  priceCatalog = await loadModelCatalog().catch(() => [])
  void checkProviderKeys(workerLog)
  timers.push(setInterval(() => {
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
  }, 5_000))

  // Wake on any project_jobs INSERT via pg NOTIFY.
  const sql = getDb()
  await sql.listen('project_job', () => {
    void drainDispatcher(workerId)
  })

  // Pause requests (project paused): the flow stops before its next stage.
  await sql.listen('run_pause', (runId) => {
    if (engines.has(runId) || activeJobs.has(runId)) {
      pausedRuns.add(runId)
      workerLog.info('pause requested; run will stop at its next stage boundary', { runId })
    }
  })

  // Cancellations (project archived): dispose the live engine for that run.
  await sql.listen('run_cancel', (runId) => {
    void handleRunCancel(runId).catch((err) => workerLog.error('run cancel failed', { runId }, err instanceof Error ? err : new Error(String(err))))
  })


  // Polling floor in case a NOTIFY is missed (e.g., reconnect).
  timers.push(setInterval(() => { void drainDispatcher(workerId).catch((err) => { if (!shuttingDown) workerLog.error('poll failed', err instanceof Error ? err : new Error(String(err))) }) }, 5000))
  // Reap idle warm agents every 5 minutes (default cutoff: 30 min idle).
  timers.push(setInterval(() => {
    void reapIdleAgents().then((n) => {
      if (n > 0) workerLog.info('reaped idle agents', { count: n })
    })
  }, 5 * 60_000))
  // Reap jobs whose worker died. Liveness comes from the workers heartbeat
  // table, NOT from elapsed time: a plan or implement stage legitimately runs
  // for far longer than any fixed timeout, and the old 10-minute rule marked
  // healthy jobs as failed, let the dispatcher start a second run for the same
  // project, and re-queued duplicates. A dead worker's run is handed off: the
  // job is closed and the run is re-queued from the stage it was in.
  timers.push(setInterval(() => { void reapDeadWorkerJobs() }, 60_000))
  // Reap orphaned pipeline_runs — queued runs older than 30s with no matching
  // project_jobs row. Caused by a worker crash between the retry UPDATE and
  // the job INSERT before retryRunAndEnqueue was transactional. This reaper
  // is a safety net: even with the transactional fix, a crashed peer worker
  // or a manual DB manipulation could still leave orphans behind.
  timers.push(setInterval(() => {
    void reapOrphanedRuns()
      .then(({ reenqueued, failed }) => {
        if (reenqueued > 0 || failed > 0) {
          workerLog.info('reaped orphaned runs', { reenqueued, failed })
        }
      })
      .catch((err) => workerLog.error('orphan-run reaper failed', err))
  }, 30_000))
  await drainDispatcher(workerId)

  workerLog.info('subscribed to project_job queue; waiting for jobs')
}

/** Model prices for costing usage when the SDK reports none (OpenRouter's routed models). Loaded at boot, refreshed when keys change. */
let priceCatalog: CatalogModel[] = []

/** Periodic timers (heartbeat, polling floor, reapers); cleared first on shutdown so nothing queries a closing pool. */
const timers: Array<ReturnType<typeof setInterval>> = []

/**
 * A deploy's SIGTERM with a drain budget: claim nothing new and wait for the
 * running stages to finish (each run stops at its next stage boundary and is
 * re-queued, or pauses at a gate, or completes). Returns when nothing is
 * executing or the budget is spent; shutdown() then hands back whatever is left.
 */
async function drainRunningStages(budgetMs: number): Promise<void> {
  draining = true
  const deadline = Date.now() + budgetMs
  workerLog.info('drain: finishing running stages before exit', { running: inFlightJobs.size, budgetSeconds: Math.round(budgetMs / 1000) })
  while (inFlightJobs.size > 0 && Date.now() < deadline) {
    await Promise.race([Promise.allSettled([...inFlightJobs]), new Promise((resolve) => setTimeout(resolve, 5_000))])
  }
  if (inFlightJobs.size > 0) workerLog.warn('drain: budget spent with stages still running; handing them back mid-stage', { running: inFlightJobs.size })
  else workerLog.info('drain: nothing running; exiting')
}

async function shutdown(signal: string): Promise<void> {
  // A second signal while draining is ignored, except Ctrl-C, which stops at once.
  if (shuttingDown || (draining && signal !== 'SIGINT')) return
  const budget = drainBudget()
  if (signal === 'SIGTERM' && budget.workerMs > 0 && inFlightJobs.size > 0) {
    await drainRunningStages(budget.workerMs)
    if (shuttingDown) return
  }
  shuttingDown = true
  for (const t of timers) clearInterval(t)
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
        // The engine knows which stage was executing; the row may be a step behind.
        const stage = engine.getCurrentStage() ?? (run.currentStage as StageName | null) ?? null
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

// Queries still in flight when the pool closes are part of shutting down, not a crash.
ignoreShutdownDbErrors((reason) => workerLog.error('unhandled rejection', reason instanceof Error ? reason : new Error(String(reason))))
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

await main()
