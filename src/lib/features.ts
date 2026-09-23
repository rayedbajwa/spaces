import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ACCEPTANCE_FILE } from './acceptance'
import { activeFeatureId, featureDirNames } from './active-feature'

/**
 * A project's features, one after another.
 *
 * Each feature is a numbered directory under specs/ (`001-login`, `002-billing`)
 * holding its own spec, plan, tasks, reports and delivery record. The highest
 * number is the current feature: the board, the next step and runs work on it.
 * Earlier features are history, kept with their documents and final status.
 */

export type FeatureStatus =
  | 'specified'
  | 'planned'
  | 'tasked'
  | 'implementing'
  | 'verified'
  | 'accepted'
  | 'delivering'
  | 'delivered'

export interface FeatureSummary {
  id: string
  relativePath: string
  title: string
  current: boolean
  status: FeatureStatus
  codeReview?: 'approved' | 'changes_requested'
  verification?: 'pass' | 'partial' | 'fail'
  delivery?: 'merged' | 'partial' | 'blocked'
  documents: Array<{ label: string; path: string }>
}

const DOCUMENTS: Array<[string, string]> = [
  ['Spec', 'spec.md'],
  ['Plan', 'plan.md'],
  ['Tasks', 'tasks.md'],
  ['Test plan', 'test-plan.md'],
  ['Code review', 'code-review.md'],
  ['Verification report', 'verification-report.md'],
  ['Acceptance', ACCEPTANCE_FILE],
  ['Delivery report', 'delivery-report.md'],
]

async function read(file: string): Promise<string | undefined> {
  return await readFile(file, 'utf8').then((text) => (text.trim() ? text : undefined)).catch(() => undefined)
}

/** The spec's heading without Spec Kit's "Feature Specification:" prefix; the directory name otherwise. */
export function featureTitle(spec: string | undefined, id: string): string {
  const heading = spec?.split('\n').find((line) => line.startsWith('# '))
  const title = heading?.replace(/^#\s+/, '').replace(/^Feature Specification:\s*/i, '').trim()
  return title || id.replace(/^\d+-/, '').replace(/-/g, ' ')
}

/** Where a feature stands, from the documents it has (furthest milestone wins). */
export function featureStatus(docs: {
  spec?: string; plan?: string; tasks?: string; verification?: string; acceptance?: string; delivery?: string; hasImplementation: boolean
}): Pick<FeatureSummary, 'status' | 'verification' | 'delivery'> {
  const verification = /Verification Status:\s*\**\s*(PASS|PARTIAL|FAIL)/i.exec(docs.verification ?? '')?.[1]?.toLowerCase() as FeatureSummary['verification']
  const delivery = /Delivery Status:\s*\**\s*(MERGED|PARTIAL|BLOCKED)/i.exec(docs.delivery ?? '')?.[1]?.toLowerCase() as FeatureSummary['delivery']
  const status: FeatureStatus = delivery === 'merged' ? 'delivered'
    : delivery ? 'delivering'
      : docs.acceptance ? 'accepted'
        : verification === 'pass' ? 'verified'
          : docs.hasImplementation || verification ? 'implementing'
            : docs.tasks ? 'tasked'
              : docs.plan ? 'planned'
                : 'specified'
  return { status, ...(verification ? { verification } : {}), ...(delivery ? { delivery } : {}) }
}

/** Every feature of the project, newest (the current one) first. */
export async function listFeatures(projectRoot: string): Promise<FeatureSummary[]> {
  const specsDir = path.join(projectRoot, 'specs')
  const ids = featureDirNames(projectRoot)
  const active = activeFeatureId(projectRoot)
  return await Promise.all(ids.map(async (id) => {
    const dir = path.join(specsDir, id)
    const [spec, plan, tasks, review, verification, acceptance, delivery] = await Promise.all(
      ['spec.md', 'plan.md', 'tasks.md', 'code-review.md', 'verification-report.md', ACCEPTANCE_FILE, 'delivery-report.md'].map((f) => read(path.join(dir, f))))
    const hasImplementation = Boolean(review) || /^\s*-\s+\[[xX]\]/m.test(tasks ?? '')
      || await stat(path.join(dir, 'merge-orchestrator.md')).then(() => true).catch(() => false)
    const codeReview = /Code Review Status:\s*\**\s*(APPROVED|CHANGES[_ ]REQUESTED)/i.exec(review ?? '')?.[1]
    const documents: FeatureSummary['documents'] = []
    for (const [label, file] of DOCUMENTS) {
      if (await stat(path.join(dir, file)).then((s) => s.isFile()).catch(() => false)) documents.push({ label, path: `specs/${id}/${file}` })
    }
    return {
      id,
      relativePath: `specs/${id}`,
      title: featureTitle(spec, id),
      current: id === active,
      ...featureStatus({ spec, plan, tasks, verification, acceptance, delivery, hasImplementation }),
      ...(codeReview ? { codeReview: /^approved$/i.test(codeReview) ? 'approved' as const : 'changes_requested' as const } : {}),
      documents,
    }
  }))
}

/** A current feature that is not finished yet (not merged, accepted or verified): starting another parks it. */
export function isUnfinished(feature: FeatureSummary | undefined): boolean {
  return Boolean(feature && !(feature.verification === 'pass' || feature.status === 'accepted' || feature.delivery === 'merged'))
}

/**
 * Rename a feature: its title is the spec's first heading, so that line is
 * rewritten (keeping Spec Kit's "Feature Specification:" prefix). The directory
 * and branch keep their names — pull requests and history point at them.
 */
export async function renameFeature(projectRoot: string, id: string, title: string): Promise<void> {
  const clean = title.replace(/\s+/g, ' ').trim()
  if (!clean) throw new Error('A title is required.')
  if (clean.length > 200) throw new Error('Keep the title under 200 characters.')
  const file = path.join(projectRoot, 'specs', id, 'spec.md')
  const spec = await readFile(file, 'utf8').catch(() => undefined)
  if (spec === undefined) throw new Error(`Feature ${id} has no spec.md to rename.`)
  const lines = spec.split('\n')
  const index = lines.findIndex((line) => line.startsWith('# '))
  if (index === -1) {
    lines.unshift(`# Feature Specification: ${clean}`, '')
  } else {
    const prefixed = /^#\s+Feature Specification:/i.test(lines[index]!)
    lines[index] = `# ${prefixed ? 'Feature Specification: ' : ''}${clean}`
  }
  await writeFile(file, lines.join('\n'))
}
