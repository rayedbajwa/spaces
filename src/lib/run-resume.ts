/**
 * Where a run should pick up after an interruption, read from what is already
 * on disk.
 *
 * A worker can die without warning — a container restart, an out-of-memory
 * kill, a deploy — and whatever it was doing is re-queued. Starting that run
 * from its first stage would redo work that is already finished and overwrite
 * the artifacts it produced, so the resume point comes from the feature
 * directory itself: a stage whose artifact exists is done, and the run starts
 * at the first one that is not. The stage last recorded on the run row is
 * honoured too — the run never moves backwards, only forwards past work that
 * demonstrably exists.
 *
 * Implementation progress is finer-grained than a file: tasks.md carries a
 * checkbox per task, so a half-finished implement stage resumes with the list
 * of what is already done rather than starting the whole task list again.
 */

import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { findLatestFeatureDirAbsolute, type StageName } from './aidlc'
import { log } from './logger'

const resumeLog = log.child({ mod: 'run-resume' })

export interface TaskProgress {
  done: number
  total: number
  /** Ids of tasks still open, oldest first (capped — this goes into a prompt). */
  remaining: string[]
  /** Ids already ticked off. */
  completed: string[]
}

export interface ResumePoint {
  /** Stage to start from, or undefined to start at the beginning. */
  stage?: StageName
  /** Stages whose artifacts already exist. */
  completed: StageName[]
  /** One line for the log and the run timeline. */
  reason: string
  /** Task checkboxes, when the feature has a task list. */
  taskProgress?: TaskProgress
}

/** The artifact each stage leaves behind, relative to the feature directory. */
const STAGE_ARTIFACT: Partial<Record<StageName, string>> = {
  specify: 'spec.md',
  plan: 'plan.md',
  tasks: 'tasks.md',
  testplan: 'test-plan.md',
  parallelize: 'parallel-workstreams.md',
  orchestrate: 'merge-orchestrator.md',
  review: 'code-review.md',
  verify: 'verification-report.md',
}

/** Works for directories as well as files (`.specify/` is a directory). */
async function exists(target: string): Promise<boolean> {
  return await stat(target).then(() => true).catch(() => false)
}

async function nonEmpty(file: string): Promise<boolean> {
  return await readFile(file, 'utf8').then((text) => text.trim().length > 0).catch(() => false)
}

/** Task checkboxes in the feature's tasks.md: `- [x] T001 …`. */
export function parseTaskProgress(tasksMarkdown: string): TaskProgress {
  const completed: string[] = []
  const remaining: string[] = []
  for (const line of tasksMarkdown.split('\n')) {
    const match = /^\s*-\s+\[([ xX])\]\s+([A-Za-z]+\d+)\b/.exec(line)
    if (!match) continue
    if (match[1]!.toLowerCase() === 'x') completed.push(match[2]!)
    else remaining.push(match[2]!)
  }
  return { done: completed.length, total: completed.length + remaining.length, remaining, completed }
}

/**
 * Task checkboxes outside the "## Delivery" group — the tasks implement is
 * responsible for. The delivery tasks (open the PR, merge, deploy, UAT) are
 * the deliver step's, so they stay unticked until after review and QA.
 */
export function implementationTaskProgress(tasksMarkdown: string): TaskProgress {
  const kept: string[] = []
  let deliveryLevel: number | undefined
  for (const line of tasksMarkdown.split('\n')) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const level = heading[1]!.length
      if (deliveryLevel !== undefined && level <= deliveryLevel) deliveryLevel = undefined
      if (deliveryLevel === undefined && /\bdelivery\b/i.test(heading[2]!)) deliveryLevel = level
      continue
    }
    if (deliveryLevel === undefined) kept.push(line)
  }
  return parseTaskProgress(kept.join('\n'))
}

/** Task progress of a project's latest feature, or undefined when it has no task list yet. */
export async function readTaskProgress(projectPath: string): Promise<TaskProgress | undefined> {
  const featureDir = await findLatestFeatureDirAbsolute(projectPath).catch(() => null)
  if (!featureDir) return undefined
  const tasks = await readFile(path.join(featureDir, 'tasks.md'), 'utf8').catch(() => undefined)
  if (!tasks) return undefined
  const progress = parseTaskProgress(tasks)
  return progress.total > 0 ? progress : undefined
}

/**
 * The stage an interrupted run should continue from.
 *
 * `recorded` is the stage the run row remembers. The answer is never earlier
 * than that, and never skips a stage whose artifact is missing.
 */
export async function resolveResumePoint(options: {
  projectPath: string
  stages: StageName[]
  recorded?: StageName | null
}): Promise<ResumePoint> {
  const { projectPath, stages } = options
  const recorded = options.recorded && stages.includes(options.recorded) ? options.recorded : undefined
  const featureDir = await findLatestFeatureDirAbsolute(projectPath).catch(() => null)

  const completed: StageName[] = []
  if (await exists(path.join(projectPath, '.specify'))) completed.push('init')
  if (featureDir) {
    for (const [stage, file] of Object.entries(STAGE_ARTIFACT) as Array<[StageName, string]>) {
      if (await nonEmpty(path.join(featureDir, file))) completed.push(stage)
    }
  }

  // The tasks implement owns: the "## Delivery" group is deliver's, so it neither
  // keeps implement from counting as finished nor shows up as work to resume.
  const taskProgress = featureDir
    ? await readFile(path.join(featureDir, 'tasks.md'), 'utf8').then((t) => implementationTaskProgress(t)).catch(() => undefined)
    : undefined
  // Implementation counts as finished only when every implementation task is ticked off.
  if (taskProgress && taskProgress.total > 0 && taskProgress.done === taskProgress.total) completed.push('implement')

  // The first stage of the pipeline whose artifact is missing.
  const firstIncomplete = stages.find((stage) => !completed.includes(stage))
  const indexOf = (stage?: StageName) => (stage ? stages.indexOf(stage) : -1)
  const furthest = indexOf(recorded) >= indexOf(firstIncomplete) ? recorded : firstIncomplete
  const stage = furthest ?? undefined

  const reason = !stage
    ? 'every stage of this pipeline already has its artifact; nothing to resume'
    : recorded && stage === recorded
      ? `continuing at ${stage}, the stage the run was on`
      : completed.length > 0
        ? `continuing at ${stage}; ${completed.join(', ')} already produced ${completed.length === 1 ? 'its artifact' : 'their artifacts'}`
        : `starting at ${stage}; no earlier artifacts found`

  resumeLog.info('resume point resolved', { projectPath, recorded: recorded ?? null, stage: stage ?? null, completed, tasks: taskProgress ? `${taskProgress.done}/${taskProgress.total}` : undefined })
  return { stage, completed, reason, taskProgress: taskProgress?.total ? taskProgress : undefined }
}

/**
 * A note for the agent when a run resumes, so it continues the work instead of
 * repeating it. Empty when there is nothing worth saying.
 */
export function buildResumeNote(point: ResumePoint): string {
  if (!point.stage && !point.taskProgress) return ''
  const lines: string[] = ['## Resuming an interrupted run', '']
  if (point.completed.length > 0) {
    lines.push(`These stages already produced their artifacts and must not be redone: ${point.completed.join(', ')}. Read them instead of regenerating them.`)
  }
  if (point.taskProgress && point.taskProgress.total > 0 && point.taskProgress.done > 0) {
    const { done, total, remaining } = point.taskProgress
    lines.push(
      '',
      `Implementation is ${done} of ${total} tasks in. The ticked tasks in tasks.md are finished — verify rather than rewrite them.`,
      remaining.length ? `Still open: ${remaining.slice(0, 40).join(', ')}${remaining.length > 40 ? `, and ${remaining.length - 40} more` : ''}.` : '',
      'Work through the open tasks in order and tick each one off in tasks.md as you complete it.',
    )
  }
  return lines.filter((line) => line !== undefined).join('\n').trim()
}

/**
 * What a stage that could scaffold new work must know before it runs.
 *
 * `init` on an initialized project and `specify` while a feature is still
 * unfinished are the two ways a run destroys work: one rewrites the project
 * scaffold, the other opens a new feature directory and leaves the half-built
 * one behind. Both stages get a plain statement of what already exists and an
 * instruction to read it first. When the latest feature has passed
 * verification, starting the next one is legitimate and nothing is added.
 */
export interface UnfinishedFeature {
  /** Directory name, e.g. "003-project-responsibilities". */
  name: string
  /** Absolute path of the feature directory. */
  dir: string
  /** Documents it already has. */
  artifacts: string[]
  tasks?: TaskProgress
  /** True when a verification report exists but did not pass. */
  verificationFailed: boolean
}

/**
 * The project's latest feature when it is still unfinished, i.e. it has
 * documents but has not passed verification. A feature that verified
 * successfully is finished work and the next one may start.
 */
export async function findUnfinishedFeature(projectPath: string): Promise<UnfinishedFeature | undefined> {
  const featureDir = await findLatestFeatureDirAbsolute(projectPath).catch(() => null)
  if (!featureDir) return undefined

  const artifacts: string[] = []
  for (const file of ['spec.md', 'plan.md', 'tasks.md', 'test-plan.md', 'parallel-workstreams.md', 'merge-orchestrator.md', 'code-review.md', 'verification-report.md']) {
    if (await nonEmpty(path.join(featureDir, file))) artifacts.push(file)
  }
  if (artifacts.length === 0) return undefined

  const verification = await readFile(path.join(featureDir, 'verification-report.md'), 'utf8').catch(() => '')
  const verified = /(^|\n)#{0,3}\s*(overall\s+)?(status|result)\s*[:|-]?\s*\**\s*pass/i.test(verification)
  if (verified) return undefined

  const tasks = await readFile(path.join(featureDir, 'tasks.md'), 'utf8')
    .then((t) => parseTaskProgress(t))
    .catch(() => undefined)

  return {
    name: path.basename(featureDir),
    dir: featureDir,
    artifacts,
    tasks: tasks?.total ? tasks : undefined,
    verificationFailed: verification.trim().length > 0,
  }
}

export async function describeWorkInProgress(projectPath: string, stage: StageName): Promise<string> {
  if (stage !== 'init' && stage !== 'specify') return ''

  const initialized = await exists(path.join(projectPath, '.specify'))
  const unfinished = await findUnfinishedFeature(projectPath)
  const featureName = unfinished?.name
  const present = unfinished?.artifacts ?? []
  const tasks = unfinished?.tasks
  const verification = unfinished?.verificationFailed ? 'present' : ''

  const featureUnfinished = Boolean(unfinished)
  if (!initialized && !featureUnfinished) return ''

  const lines: string[] = ['## Work already in progress — continue it, do not start over', '']
  if (initialized) {
    lines.push('This project is already initialized: `.specify/` exists with its templates, memory and scripts. Do not scaffold it again or overwrite anything inside it.')
  }
  if (featureUnfinished) {
    lines.push(
      '',
      `Feature \`${featureName}\` is unfinished. It already has: ${present.join(', ')}.`,
      tasks && tasks.total > 0 ? `Its task list stands at ${tasks.done} of ${tasks.total} done.` : '',
      verification ? 'A verification report exists but has not passed.' : 'It has not been verified yet.',
      '',
      'Before doing anything else, read those files and the repository they describe. Then continue that feature: extend or correct the existing documents in place.',
      'Do not create a new feature directory, a new numbered branch or a second spec for the same work. If you are convinced the request is genuinely a different feature, say so in your reply and stop instead of creating one.',
    )
  } else if (initialized) {
    lines.push('', 'Check what is there and report it. Change nothing that already exists.')
  }
  return lines.filter((line) => line !== '').join('\n').trim()
}
