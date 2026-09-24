import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { StageName } from './aidlc'

/**
 * Which of the intent's files a stage reads, told to it by path.
 *
 * A run used to start with every feature file inlined in its shared context —
 * spec, plan, tasks, test plan, research, data model, contracts, reports — on
 * every stage, although each stage needs two or three of them and the skill
 * then read them again from disk. The copies were also the ones from before the
 * run started. Now each stage gets the list of the current files, the ones it
 * must read first and the rest by name, and reads only what it needs.
 */

/** Files a stage reads before doing anything, relative to the feature directory. */
const REQUIRED: Partial<Record<StageName, string[]>> = {
  clarify: ['spec.md'],
  plan: ['spec.md'],
  tasks: ['spec.md', 'plan.md'],
  testplan: ['spec.md', 'plan.md', 'tasks.md'],
  parallelize: ['plan.md', 'tasks.md'],
  checklist: ['spec.md', 'plan.md'],
  analyze: ['spec.md', 'plan.md', 'tasks.md'],
  implement: ['tasks.md', 'plan.md', 'code-review.md', 'verification-report.md'],
  orchestrate: ['parallel-workstreams.md', 'tasks.md'],
  review: ['spec.md', 'tasks.md', 'delivery-status.md'],
  verify: ['test-plan.md', 'spec.md', 'tasks.md', 'code-review.md'],
  deliver: ['tasks.md', 'test-plan.md', 'verification-report.md', 'delivery-status.md', 'plan.md'],
  taskstoissues: ['tasks.md'],
}

/** Stages that work before a feature directory exists, or outside it. */
const NO_FEATURE_FILES: StageName[] = ['init', 'research', 'constitution', 'specify']

/** Every file of an intent a stage may be pointed at, in reading order. */
const KNOWN = [
  'spec.md', 'plan.md', 'research.md', 'data-model.md', 'quickstart.md', 'tasks.md', 'test-plan.md',
  'parallel-workstreams.md', 'code-review.md', 'verification-report.md', 'delivery-status.md', 'delivery-report.md',
]

export interface StageFile {
  name: string
  bytes: number
}

async function fileSize(file: string): Promise<number | undefined> {
  return stat(file).then((s) => (s.isFile() && s.size > 0 ? s.size : undefined)).catch(() => undefined)
}

/** The intent's files that exist now, with their sizes (contracts/ and checklists/ by file). */
export async function listFeatureFiles(featureDirAbs: string): Promise<StageFile[]> {
  const files: StageFile[] = []
  for (const name of KNOWN) {
    const bytes = await fileSize(path.join(featureDirAbs, name))
    if (bytes) files.push({ name, bytes })
  }
  for (const dir of ['contracts', 'checklists']) {
    const entries = await readdir(path.join(featureDirAbs, dir)).catch(() => [] as string[])
    for (const entry of entries.sort()) {
      const bytes = await fileSize(path.join(featureDirAbs, dir, entry))
      if (bytes) files.push({ name: `${dir}/${entry}`, bytes })
    }
  }
  return files
}

function kb(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
}

/**
 * The "Files for this stage" section: the feature directory, what to read
 * first, and what else exists (read only when needed). Empty for stages that
 * run before there is a feature directory.
 */
export function renderStageFiles(stage: StageName, featureDir: string, files: StageFile[]): string {
  if (NO_FEATURE_FILES.includes(stage) || files.length === 0) return ''
  const required = REQUIRED[stage] ?? []
  const first = required.map((name) => files.find((f) => f.name === name)).filter((f): f is StageFile => Boolean(f))
  const rest = files.filter((f) => !first.includes(f))
  const line = (f: StageFile) => `\`${f.name}\` (${kb(f.bytes)})`
  return [
    '## Files for this stage',
    `The intent's files are in \`${featureDir}/\`. They are current on disk and are not copied into this prompt.`,
    first.length ? `- Read first: ${first.map(line).join(', ')}` : '',
    rest.length ? `- Also there (read one only when this stage needs it): ${rest.map(line).join(', ')}` : '',
  ].filter(Boolean).join('\n')
}

/**
 * How a stage ends. The files carry the work; the final message is what the
 * next stage's hand-off summary and the run log are made from, so it stays short.
 */
export const STAGE_REPLY_RULE = [
  '## Your final message',
  'End with a short summary (at most 12 lines): the files you wrote or changed, the decisions that matter, and anything open.',
  'Do not repeat what the files say, and keep any status line this stage requires (for example `Verification Status: …`) exactly as asked.',
  'When you need an answer instead, ask in the question format this stage gives and stop.',
].join('\n')

/** Both sections for a stage, from the files on disk now. */
export async function stageContextFor(stage: StageName, projectRoot: string, featureDirAbs: string | undefined): Promise<string> {
  const files = featureDirAbs ? await listFeatureFiles(featureDirAbs) : []
  const guide = featureDirAbs ? renderStageFiles(stage, path.relative(projectRoot, featureDirAbs) || '.', files) : ''
  return [guide, stage === 'init' ? '' : STAGE_REPLY_RULE].filter(Boolean).join('\n\n')
}
