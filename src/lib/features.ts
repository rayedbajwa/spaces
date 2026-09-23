import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { ACCEPTANCE_FILE } from './acceptance'

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
  const entries = await readdir(specsDir, { withFileTypes: true }).catch(() => [])
  const ids = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort((a, b) => b.localeCompare(a))
  return await Promise.all(ids.map(async (id, index) => {
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
      current: index === 0,
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
