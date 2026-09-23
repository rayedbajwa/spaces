import { createHash, randomUUID } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { parseAcceptance } from './acceptance'
import { ACCEPTANCE_FILE } from './acceptance-file'
import { activeFeatureId, featureDirNames } from './active-feature'
import { getDb } from './db'
import { featureStatus, featureTitle, type FeatureStatus } from './features'
import { log } from './logger'
import { implementationTaskProgress, parseTaskProgress } from './run-resume'
import { summarizeVerification, type VerificationSummary } from './verification-summary'

/**
 * Intents in the database: the record of what a project has built and where
 * each intent stands.
 *
 * Agents work in files — Spec Kit writes specs/NNN-name/spec.md, plan.md,
 * tasks.md and the reports — so the files are the working copy. After every
 * stage (and when a project is first seen) the intent directories are synced
 * in: each document is stored when its content changed, the statuses are read
 * from them (review, verification and its summary, delivery, acceptance, task
 * progress), and every status change is recorded with what made it. An
 * intent a person deleted stays deleted even if its directory is still on
 * another branch's disk.
 */

const storeLog = log.child({ mod: 'intent-store' })

export interface IntentRecord {
  intentId: string
  projectId: string
  dirId: string
  number: number | null
  title: string
  status: FeatureStatus
  codeReviewStatus: 'approved' | 'changes_requested' | null
  verificationStatus: 'pass' | 'partial' | 'fail' | null
  verificationSummary: VerificationSummary | null
  deliveryStatus: 'merged' | 'partial' | 'blocked' | null
  acceptedBy: string | null
  acceptedAt: string | null
  acceptedNote: string | null
  acceptedVerification: string | null
  tasksDone: number
  tasksTotal: number
  implementationDone: number
  implementationTotal: number
  active: boolean
  syncedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface IntentDocument {
  path: string
  kind: string
  content: string
  sha256: string
  bytes: number
  updatedBy: string
  updatedAt: string
}

const DOCUMENT_FILE = /\.(md|json|ya?ml|txt)$/i
const MAX_DOCUMENT_BYTES = 1024 * 1024

/** What a document is, from its name inside the intent's directory. */
export function documentKind(relativePath: string): string {
  const name = relativePath.toLowerCase()
  if (name === 'spec.md') return 'spec'
  if (name === 'plan.md') return 'plan'
  if (name === 'tasks.md') return 'tasks'
  if (name === 'test-plan.md') return 'test-plan'
  if (name === 'code-review.md') return 'code-review'
  if (name === 'verification-report.md') return 'verification'
  if (name === 'delivery-report.md') return 'delivery'
  if (name === 'delivery-status.md') return 'delivery-status'
  if (name === ACCEPTANCE_FILE) return 'acceptance'
  if (name === 'parallel-workstreams.md') return 'workstreams'
  if (name === 'merge-orchestrator.md') return 'orchestration'
  if (name.startsWith('subagents/')) return 'subagent-report'
  return 'other'
}

export function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

/** The intent directory's documents (text only, two levels deep, nothing hidden or huge). */
async function readDocuments(dir: string): Promise<Map<string, string>> {
  const docs = new Map<string, string>()
  const walk = async (current: string, relative: string, depth: number) => {
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const full = path.join(current, entry.name)
      const rel = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (depth < 2) await walk(full, rel, depth + 1)
      } else if (DOCUMENT_FILE.test(entry.name)) {
        const info = await stat(full).catch(() => undefined)
        if (!info || info.size > MAX_DOCUMENT_BYTES) continue
        const content = await readFile(full, 'utf8').catch(() => undefined)
        if (content !== undefined) docs.set(rel, content)
      }
    }
  }
  await walk(dir, '', 0)
  return docs
}

/** Everything the intents row holds, read from an intent's documents. */
export function summarizeIntent(dirId: string, docs: Map<string, string>) {
  const text = (name: string) => (docs.get(name)?.trim() ? docs.get(name) : undefined)
  const review = /Code Review Status:\s*\**\s*(APPROVED|CHANGES[_ ]REQUESTED)/i.exec(text('code-review.md') ?? '')?.[1]
  const tasks = text('tasks.md')
  const hasImplementation = Boolean(text('code-review.md') || text('merge-orchestrator.md')) || /^\s*-\s+\[[xX]\]/m.test(tasks ?? '')
  const { status, verification, delivery } = featureStatus({
    spec: text('spec.md'), plan: text('plan.md'), tasks, verification: text('verification-report.md'),
    acceptance: text(ACCEPTANCE_FILE), delivery: text('delivery-report.md'), hasImplementation,
  })
  const acceptance = text(ACCEPTANCE_FILE) ? parseAcceptance(text(ACCEPTANCE_FILE)!) : undefined
  const all = tasks ? parseTaskProgress(tasks) : { done: 0, total: 0 }
  const implementation = tasks ? implementationTaskProgress(tasks) : { done: 0, total: 0 }
  const number = Number.parseInt(dirId.split('-')[0] ?? '', 10)
  return {
    title: featureTitle(text('spec.md'), dirId),
    number: Number.isFinite(number) ? number : null,
    status,
    codeReviewStatus: review ? (/^approved$/i.test(review) ? 'approved' as const : 'changes_requested' as const) : null,
    verificationStatus: verification ?? null,
    verificationSummary: text('verification-report.md') ? summarizeVerification(text('verification-report.md')!) ?? null : null,
    deliveryStatus: delivery ?? null,
    acceptedBy: acceptance?.acceptedBy ?? null,
    acceptedAt: acceptance?.acceptedAt ?? null,
    acceptedNote: acceptance?.note ?? null,
    acceptedVerification: acceptance?.verificationStatus ?? null,
    tasksDone: all.done,
    tasksTotal: all.total,
    implementationDone: implementation.done,
    implementationTotal: implementation.total,
  }
}

const TRACKED_FIELDS = ['status', 'codeReviewStatus', 'verificationStatus', 'deliveryStatus', 'acceptedBy', 'title'] as const
const COLUMN: Record<(typeof TRACKED_FIELDS)[number], string> = {
  status: 'status', codeReviewStatus: 'code_review_status', verificationStatus: 'verification_status',
  deliveryStatus: 'delivery_status', acceptedBy: 'accepted_by', title: 'title',
}

const INTENT_COLS = `
  intent_id AS "intentId", project_id AS "projectId", dir_id AS "dirId", number, title, status,
  code_review_status AS "codeReviewStatus", verification_status AS "verificationStatus",
  verification_summary AS "verificationSummary", delivery_status AS "deliveryStatus",
  accepted_by AS "acceptedBy", accepted_at AS "acceptedAt", accepted_note AS "acceptedNote",
  accepted_verification AS "acceptedVerification", tasks_done AS "tasksDone", tasks_total AS "tasksTotal",
  implementation_done AS "implementationDone", implementation_total AS "implementationTotal",
  active, synced_at AS "syncedAt", created_at AS "createdAt", updated_at AS "updatedAt"`

function toRecord(row: Record<string, unknown>): IntentRecord {
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v))
  return { ...(row as unknown as IntentRecord), acceptedAt: iso(row.acceptedAt), syncedAt: iso(row.syncedAt), createdAt: iso(row.createdAt)!, updatedAt: iso(row.updatedAt)! }
}

/** The project's intents that were not deleted, newest first. */
export async function listIntents(projectId: string): Promise<IntentRecord[]> {
  const sql = getDb()
  const rows = await sql`SELECT ${sql.unsafe(INTENT_COLS)} FROM intents WHERE project_id = ${projectId} AND deleted_at IS NULL ORDER BY dir_id DESC`
  return rows.map((r) => toRecord(r as Record<string, unknown>))
}

export async function getIntentDocuments(intentId: string): Promise<IntentDocument[]> {
  const rows = await getDb()<Array<IntentDocument & { updatedAt: Date }>>`
    SELECT path, kind, content, sha256, bytes, updated_by AS "updatedBy", updated_at AS "updatedAt"
      FROM intent_documents WHERE intent_id = ${intentId} ORDER BY path
  `
  return rows.map((r) => ({ ...r, updatedAt: new Date(r.updatedAt).toISOString() }))
}

export interface SyncResult { intents: number; documentsChanged: number; statusChanges: number }

/**
 * Sync a project's intent directories into the database. `by` says what made
 * the change: 'agent' after a stage, 'import' for the first sync, or
 * 'person:<name>' after an action in Spaces.
 */
export async function syncProjectIntents(projectId: string, projectRoot: string, by = 'agent'): Promise<SyncResult> {
  const sql = getDb()
  const dirs = featureDirNames(projectRoot)
  const active = activeFeatureId(projectRoot)
  let documentsChanged = 0
  let statusChanges = 0
  for (const dirId of dirs) {
    const docs = await readDocuments(path.join(projectRoot, 'specs', dirId))
    if (docs.size === 0) continue
    const summary = summarizeIntent(dirId, docs)
    await sql.begin(async (tx) => {
      const [existing] = await tx`SELECT ${tx.unsafe(INTENT_COLS)}, deleted_at AS "deletedAt" FROM intents WHERE project_id = ${projectId} AND dir_id = ${dirId} FOR UPDATE`
      // Deleted by a person: a copy left on some branch does not bring it back.
      if (existing?.deletedAt) return
      const intentId = (existing?.intentId as string | undefined) ?? randomUUID()
      if (!existing) {
        await tx`INSERT INTO intents (intent_id, project_id, dir_id, title, status) VALUES (${intentId}, ${projectId}, ${dirId}, ${summary.title}, ${summary.status})`
      }
      if (dirId === active) await tx`UPDATE intents SET active = false WHERE project_id = ${projectId} AND active AND intent_id <> ${intentId}`
      await tx`
        UPDATE intents SET
          number = ${summary.number}, title = ${summary.title}, status = ${summary.status},
          code_review_status = ${summary.codeReviewStatus}, verification_status = ${summary.verificationStatus},
          verification_summary = ${summary.verificationSummary ? tx.json(summary.verificationSummary as never) : null},
          delivery_status = ${summary.deliveryStatus}, accepted_by = ${summary.acceptedBy}, accepted_at = ${summary.acceptedAt},
          accepted_note = ${summary.acceptedNote}, accepted_verification = ${summary.acceptedVerification},
          tasks_done = ${summary.tasksDone}, tasks_total = ${summary.tasksTotal},
          implementation_done = ${summary.implementationDone}, implementation_total = ${summary.implementationTotal},
          active = ${dirId === active}, synced_at = now(), updated_at = now()
        WHERE intent_id = ${intentId}
      `
      for (const field of TRACKED_FIELDS) {
        const before = existing ? (existing[field] as string | null) ?? null : null
        const after = summary[field] ?? null
        if (before !== after && (existing || after !== null)) {
          await tx`INSERT INTO intent_status_events (intent_id, field, from_value, to_value, by) VALUES (${intentId}, ${COLUMN[field]}, ${before}, ${after}, ${existing ? by : 'import'})`
          statusChanges += 1
        }
      }
      const stored = new Map((await tx<Array<{ path: string; sha256: string }>>`SELECT path, sha256 FROM intent_documents WHERE intent_id = ${intentId}`).map((d) => [d.path, d.sha256]))
      for (const [rel, content] of docs) {
        const hash = sha256(content)
        if (stored.get(rel) === hash) continue
        await tx`
          INSERT INTO intent_documents (intent_id, path, kind, content, sha256, bytes, updated_by)
          VALUES (${intentId}, ${rel}, ${documentKind(rel)}, ${content}, ${hash}, ${Buffer.byteLength(content)}, ${existing ? by : 'import'})
          ON CONFLICT (intent_id, path) DO UPDATE
            SET kind = EXCLUDED.kind, content = EXCLUDED.content, sha256 = EXCLUDED.sha256, bytes = EXCLUDED.bytes,
                updated_by = EXCLUDED.updated_by, updated_at = now()
        `
        documentsChanged += 1
      }
    })
  }
  if (statusChanges || documentsChanged) storeLog.info('intents synced', { projectId, intents: dirs.length, documentsChanged, statusChanges, by })
  return { intents: dirs.length, documentsChanged, statusChanges }
}

/** Sync without letting a database or disk problem fail the caller (a stage, a request). */
export async function syncProjectIntentsQuietly(projectId: string | null | undefined, projectRoot: string | null | undefined, by = 'agent'): Promise<void> {
  if (!projectId || !projectRoot) return
  await syncProjectIntents(projectId, projectRoot, by).catch((error) =>
    storeLog.warn('intent sync failed', { projectId, error: error instanceof Error ? error.message : String(error) }))
}

/** A person deleted the intent: it leaves the record (kept with its history, never resurrected by a sync). */
export async function markIntentDeleted(projectId: string, dirId: string, by: string): Promise<void> {
  const sql = getDb()
  await sql.begin(async (tx) => {
    const [row] = await tx<Array<{ intentId: string }>>`
      UPDATE intents SET deleted_at = now(), active = false, updated_at = now()
       WHERE project_id = ${projectId} AND dir_id = ${dirId} AND deleted_at IS NULL
       RETURNING intent_id AS "intentId"
    `
    if (row) await tx`INSERT INTO intent_status_events (intent_id, field, from_value, to_value, by) VALUES (${row.intentId}, 'deleted', NULL, 'deleted', ${by})`
  })
}
