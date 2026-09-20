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

  const taskProgress = featureDir
    ? await readFile(path.join(featureDir, 'tasks.md'), 'utf8').then((t) => parseTaskProgress(t)).catch(() => undefined)
    : undefined
  // Implementation counts as finished only when every task is ticked off.
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
