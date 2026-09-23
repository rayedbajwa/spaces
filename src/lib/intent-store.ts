import { createHash, randomUUID } from 'node:crypto'
import type { TransactionSql } from 'postgres'
import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseAcceptance } from './acceptance'
import { ACCEPTANCE_FILE } from './acceptance-file'
import { ACTIVE_FEATURE_FILE, activeFeatureId, featureDirNames, isFeatureId } from './active-feature'
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
        // lstat, not stat: a symlink named like a document could point anywhere
        // outside the intent, and its target would be copied into the database.
        const info = await lstat(full).catch(() => undefined)
        if (!info?.isFile() || info.size > MAX_DOCUMENT_BYTES) continue
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

type Tx = TransactionSql<Record<string, never>>

async function hasActiveIntent(tx: Tx, projectId: string): Promise<boolean> {
  const [row] = await tx`SELECT 1 FROM intents WHERE project_id = ${projectId} AND active AND deleted_at IS NULL`
  return Boolean(row)
}

/**
 * Write an intent's statuses from its summary and record each change. `active`
 * is left alone when undefined. Returns how many tracked statuses changed.
 */
async function writeSummary(
  tx: Tx,
  intentId: string,
  existing: Record<string, unknown> | undefined,
  summary: ReturnType<typeof summarizeIntent>,
  by: string,
  active?: boolean,
): Promise<number> {
  await tx`
    UPDATE intents SET
      number = ${summary.number}, title = ${summary.title}, status = ${summary.status},
      code_review_status = ${summary.codeReviewStatus}, verification_status = ${summary.verificationStatus},
      verification_summary = ${summary.verificationSummary ? tx.json(summary.verificationSummary as never) : null},
      delivery_status = ${summary.deliveryStatus}, accepted_by = ${summary.acceptedBy}, accepted_at = ${summary.acceptedAt},
      accepted_note = ${summary.acceptedNote}, accepted_verification = ${summary.acceptedVerification},
      tasks_done = ${summary.tasksDone}, tasks_total = ${summary.tasksTotal},
      implementation_done = ${summary.implementationDone}, implementation_total = ${summary.implementationTotal},
      active = COALESCE(${active ?? null}::boolean, active), synced_at = now(), updated_at = now()
    WHERE intent_id = ${intentId}
  `
  let changes = 0
  for (const field of TRACKED_FIELDS) {
    const before = existing ? (existing[field] as string | null) ?? null : null
    const after = summary[field] ?? null
    if (before !== after && (existing || after !== null)) {
      await tx`INSERT INTO intent_status_events (intent_id, field, from_value, to_value, by) VALUES (${intentId}, ${COLUMN[field]}, ${before}, ${after}, ${by})`
      changes += 1
    }
  }
  return changes
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
      // The active intent is the database's to say (a person's choice). A sync
      // only sets it when nothing is active yet, or when this directory is a
      // new intent the agent just started — starting one makes it current.
      const makeActive = dirId === active && (!existing || !(await hasActiveIntent(tx, projectId)))
      if (makeActive) await tx`UPDATE intents SET active = false WHERE project_id = ${projectId} AND active AND intent_id <> ${intentId}`
      statusChanges += await writeSummary(tx, intentId, existing, summary, existing ? by : 'import', makeActive || undefined)
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
  // The folders on disk may have changed (a new intent, a branch switch that
  // brought back a deleted one), so the pointer is re-derived from the database.
  if (dirs.length > 0) await projectActiveIntent(projectId, projectRoot)
  if (statusChanges || documentsChanged) storeLog.info('intents synced', { projectId, intents: dirs.length, documentsChanged, statusChanges, by })
  return { intents: dirs.length, documentsChanged, statusChanges }
}

/** Sync without letting a database or disk problem fail the caller (a stage, a request). */
export async function syncProjectIntentsQuietly(projectId: string | null | undefined, projectRoot: string | null | undefined, by = 'agent'): Promise<void> {
  if (!projectId || !projectRoot) return
  await syncProjectIntents(projectId, projectRoot, by).catch((error) =>
    storeLog.warn('intent sync failed', { projectId, error: error instanceof Error ? error.message : String(error) }))
}

/**
 * A person deleted the intent: it leaves the record (kept with its history,
 * never resurrected by a sync). An intent no sync has recorded yet gets a
 * deleted row all the same, so a copy of it on another branch stays deleted.
 */
export async function markIntentDeleted(projectId: string, dirId: string, by: string, title = dirId): Promise<void> {
  const sql = getDb()
  await sql.begin(async (tx) => {
    const [row] = await tx<Array<{ intentId: string }>>`
      INSERT INTO intents (intent_id, project_id, dir_id, title, status, deleted_at)
      VALUES (${randomUUID()}, ${projectId}, ${dirId}, ${title}, 'specified', now())
      ON CONFLICT (project_id, dir_id) DO UPDATE SET deleted_at = now(), active = false, updated_at = now()
        WHERE intents.deleted_at IS NULL
      RETURNING intent_id AS "intentId"
    `
    if (row) await tx`INSERT INTO intent_status_events (intent_id, field, from_value, to_value, by) VALUES (${row.intentId}, 'deleted', NULL, 'deleted', ${by})`
  })
}

/** Documents a person opens, in the order and with the names the interface shows. */
export const DOCUMENT_LABELS: Array<[string, string]> = [
  ['spec.md', 'Spec'],
  ['plan.md', 'Plan'],
  ['tasks.md', 'Tasks'],
  ['test-plan.md', 'Test plan'],
  ['code-review.md', 'Code review'],
  ['verification-report.md', 'Verification report'],
  [ACCEPTANCE_FILE, 'Acceptance'],
  ['delivery-report.md', 'Delivery report'],
]

/** Which documents each intent has (path and when it last changed), for many intents in one query. */
export async function listDocumentIndex(intentIds: string[]): Promise<Map<string, Array<{ path: string; updatedAt: string }>>> {
  const index = new Map<string, Array<{ path: string; updatedAt: string }>>()
  if (intentIds.length === 0) return index
  const rows = await getDb()<Array<{ intentId: string; path: string; updatedAt: Date }>>`
    SELECT intent_id AS "intentId", path, updated_at AS "updatedAt" FROM intent_documents WHERE intent_id = ANY(${intentIds}::uuid[]) ORDER BY path
  `
  for (const row of rows) index.set(row.intentId, [...(index.get(row.intentId) ?? []), { path: row.path, updatedAt: new Date(row.updatedAt).toISOString() }])
  return index
}

/** One document of an intent, by the intent's directory name and the document's path inside it. */
export async function getIntentDocument(projectId: string, dirId: string, relativePath: string): Promise<IntentDocument | undefined> {
  const [row] = await getDb()<Array<IntentDocument & { updatedAt: Date }>>`
    SELECT d.path, d.kind, d.content, d.sha256, d.bytes, d.updated_by AS "updatedBy", d.updated_at AS "updatedAt"
      FROM intent_documents d JOIN intents i ON i.intent_id = d.intent_id
     WHERE i.project_id = ${projectId} AND i.dir_id = ${dirId} AND i.deleted_at IS NULL AND d.path = ${relativePath}
  `
  return row ? { ...row, updatedAt: new Date(row.updatedAt).toISOString() } : undefined
}

/** Import a project the first time its intents are needed (later syncs follow stages and actions). */
export async function ensureIntentsSynced(projectId: string, projectRoot: string): Promise<void> {
  const [row] = await getDb()<Array<{ n: number }>>`SELECT count(*)::int AS n FROM intents WHERE project_id = ${projectId}`
  if ((row?.n ?? 0) === 0 && featureDirNames(projectRoot).length > 0) await syncProjectIntents(projectId, projectRoot, 'import')
}

/** The intents list as the interface shows it (lib/features.ts FeatureSummary), from the database. */
export async function listIntentSummaries(projectId: string, projectRoot: string): Promise<import('./features').FeatureSummary[]> {
  await ensureIntentsSynced(projectId, projectRoot).catch(() => undefined)
  const intents = await listIntents(projectId)
  const docs = await listDocumentIndex(intents.map((i) => i.intentId))
  // No active flag yet (e.g. every intent imported before one was chosen): the newest is current.
  const current = intents.find((i) => i.active)?.intentId ?? intents[0]?.intentId
  return intents.map((i) => {
    const present = new Set((docs.get(i.intentId) ?? []).map((d) => d.path))
    return {
      id: i.dirId,
      relativePath: `specs/${i.dirId}`,
      title: i.title,
      current: i.intentId === current,
      status: i.status,
      ...(i.codeReviewStatus ? { codeReview: i.codeReviewStatus } : {}),
      ...(i.verificationStatus ? { verification: i.verificationStatus } : {}),
      ...(i.deliveryStatus ? { delivery: i.deliveryStatus } : {}),
      documents: DOCUMENT_LABELS.filter(([file]) => present.has(file)).map(([file, label]) => ({ label, path: `specs/${i.dirId}/${file}` })),
    }
  })
}

/**
 * Person actions write the database first; the files are then brought in line
 * (the working copy agents read). A file that cannot be written is logged, not
 * fatal: the record is already right, and the next stage restores it.
 */

/** The intent the project is working on: the active one, else the newest, else what the files say. */
export async function currentIntentDirId(projectId: string, projectRoot: string): Promise<string | null> {
  await ensureIntentsSynced(projectId, projectRoot).catch(() => undefined)
  const [row] = await getDb()<Array<{ dirId: string }>>`
    SELECT dir_id AS "dirId" FROM intents WHERE project_id = ${projectId} AND deleted_at IS NULL
     ORDER BY active DESC, dir_id DESC LIMIT 1
  `.catch(() => [] as Array<{ dirId: string }>)
  return row?.dirId ?? activeFeatureId(projectRoot)
}

async function intentRowFor(projectId: string, projectRoot: string, dirId: string): Promise<{ intentId: string } | undefined> {
  const find = async () => (await getDb()<Array<{ intentId: string }>>`
    SELECT intent_id AS "intentId" FROM intents WHERE project_id = ${projectId} AND dir_id = ${dirId} AND deleted_at IS NULL
  `)[0]
  // Not in the database yet (a directory created since the last sync): bring it in.
  return (await find()) ?? (await syncProjectIntents(projectId, projectRoot, 'import').then(find))
}

/** One of an intent's documents: the database copy, else the working file. */
export async function readIntentDocument(projectId: string, projectRoot: string, dirId: string, relativePath: string): Promise<string | undefined> {
  // Ids and paths come from URLs: never read outside the intent's directory.
  if (!isFeatureId(dirId) || relativePath.split('/').some((part) => !part || part === '..' || part.startsWith('.'))) return undefined
  const stored = await getIntentDocument(projectId, dirId, relativePath).catch(() => undefined)
  if (stored) return stored.content
  return readFile(path.join(projectRoot, 'specs', dirId, relativePath), 'utf8').catch(() => undefined)
}

/**
 * Change an intent's documents (`null` removes one) as a person: stored and
 * the statuses recomputed in one transaction, then the files written.
 */
export async function changeIntentDocuments(input: {
  projectId: string
  projectRoot: string
  dirId: string
  changes: Map<string, string | null>
  by: string
}): Promise<IntentRecord> {
  const { projectId, projectRoot, dirId, changes, by } = input
  if (!isFeatureId(dirId)) throw new Error('Invalid intent id.')
  for (const rel of changes.keys()) {
    if (rel.split('/').some((part) => !part || part === '..' || part.startsWith('.'))) throw new Error(`Invalid document path ${rel}.`)
  }
  const row = await intentRowFor(projectId, projectRoot, dirId)
  if (!row) throw new Error(`Intent ${dirId} does not exist.`)
  const sql = getDb()
  await sql.begin(async (tx) => {
    const [existing] = await tx`SELECT ${tx.unsafe(INTENT_COLS)} FROM intents WHERE intent_id = ${row.intentId} FOR UPDATE`
    for (const [rel, content] of changes) {
      if (content === null) {
        await tx`DELETE FROM intent_documents WHERE intent_id = ${row.intentId} AND path = ${rel}`
        continue
      }
      await tx`
        INSERT INTO intent_documents (intent_id, path, kind, content, sha256, bytes, updated_by)
        VALUES (${row.intentId}, ${rel}, ${documentKind(rel)}, ${content}, ${sha256(content)}, ${Buffer.byteLength(content)}, ${by})
        ON CONFLICT (intent_id, path) DO UPDATE
          SET kind = EXCLUDED.kind, content = EXCLUDED.content, sha256 = EXCLUDED.sha256, bytes = EXCLUDED.bytes,
              updated_by = EXCLUDED.updated_by, updated_at = now()
      `
    }
    const docs = new Map((await tx<Array<{ path: string; content: string }>>`SELECT path, content FROM intent_documents WHERE intent_id = ${row.intentId}`).map((d) => [d.path, d.content]))
    await writeSummary(tx, row.intentId, existing as Record<string, unknown>, summarizeIntent(dirId, docs), by)
  })
  const dir = path.join(projectRoot, 'specs', dirId)
  for (const [rel, content] of changes) {
    const file = path.join(dir, rel)
    await (content === null
      ? rm(file, { force: true })
      : mkdir(path.dirname(file), { recursive: true }).then(() => writeFile(file, content))
    ).catch((error) => storeLog.warn('intent file not written', { projectId, file, error: error instanceof Error ? error.message : String(error) }))
  }
  const [updated] = await sql`SELECT ${sql.unsafe(INTENT_COLS)} FROM intents WHERE intent_id = ${row.intentId}`
  return toRecord(updated as Record<string, unknown>)
}

/**
 * Make an intent the one the project works on (`null`: none chosen, the newest
 * is current). The database holds the choice; specs/.active-feature follows it
 * for the agents and branch rules that read the working directory.
 */
export async function setActiveIntent(projectId: string, projectRoot: string, dirId: string | null, by: string): Promise<void> {
  const row = dirId ? await intentRowFor(projectId, projectRoot, dirId) : undefined
  if (dirId && !row) throw new Error(`Intent ${dirId} does not exist.`)
  await getDb().begin(async (tx) => {
    const [before] = await tx<Array<{ dirId: string }>>`SELECT dir_id AS "dirId" FROM intents WHERE project_id = ${projectId} AND active FOR UPDATE`
    await tx`UPDATE intents SET active = false, updated_at = now() WHERE project_id = ${projectId} AND active`
    if (row) await tx`UPDATE intents SET active = true, updated_at = now() WHERE intent_id = ${row.intentId}`
    if ((before?.dirId ?? null) !== dirId) {
      const target = row?.intentId ?? (before ? (await tx<Array<{ intentId: string }>>`SELECT intent_id AS "intentId" FROM intents WHERE project_id = ${projectId} AND dir_id = ${before.dirId}`)[0]?.intentId : undefined)
      if (target) await tx`INSERT INTO intent_status_events (intent_id, field, from_value, to_value, by) VALUES (${target}, 'active', ${before?.dirId ?? null}, ${dirId}, ${by})`
    }
  })
  await projectActiveIntent(projectId, projectRoot)
}

/** Write specs/.active-feature from the database (the working copy of the choice). */
export async function projectActiveIntent(projectId: string, projectRoot: string): Promise<void> {
  const [row] = await getDb()<Array<{ dirId: string }>>`SELECT dir_id AS "dirId" FROM intents WHERE project_id = ${projectId} AND active AND deleted_at IS NULL`
  const file = path.join(projectRoot, 'specs', ACTIVE_FEATURE_FILE)
  const newest = featureDirNames(projectRoot)[0]
  await (row && row.dirId !== newest
    ? mkdir(path.dirname(file), { recursive: true }).then(() => writeFile(file, `${row.dirId}\n`))
    : rm(file, { force: true })
  ).catch((error) => storeLog.warn('active intent file not written', { projectId, error: error instanceof Error ? error.message : String(error) }))
}

/**
 * Before a stage: put back the current intent's documents missing from the
 * working copy (a fresh clone, a new worker, a lost volume) and the
 * active-intent pointer, from the database. Only the current intent — other
 * intents' directories belong to their own branches. Files that exist are
 * never overwritten: they may hold work newer than the last sync. Returns how
 * many files were restored.
 */
export async function restoreIntentFiles(projectId: string, projectRoot: string): Promise<number> {
  await ensureIntentsSynced(projectId, projectRoot)
  const dirId = await currentIntentDirId(projectId, projectRoot)
  let restored = 0
  if (dirId && /^[\w.-]+$/.test(dirId) && !dirId.startsWith('.')) {
    const rows = await getDb()<Array<{ path: string; content: string }>>`
      SELECT d.path, d.content FROM intent_documents d JOIN intents i ON i.intent_id = d.intent_id
       WHERE i.project_id = ${projectId} AND i.dir_id = ${dirId} AND i.deleted_at IS NULL
    `
    for (const row of rows) {
      if (row.path.split('/').some((part) => !part || part === '..' || part.startsWith('.'))) continue
      const file = path.join(projectRoot, 'specs', dirId, row.path)
      if (await stat(file).then(() => true, () => false)) continue
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, row.content, { flag: 'wx' }).then(() => { restored += 1 }, () => undefined)
    }
  }
  await projectActiveIntent(projectId, projectRoot)
  if (restored) storeLog.info('intent files restored from the database', { projectId, intent: dirId, restored })
  return restored
}

/** Restore without letting a database or disk problem stop the stage. */
export async function restoreIntentFilesQuietly(projectId: string | null | undefined, projectRoot: string | null | undefined): Promise<void> {
  if (!projectId || !projectRoot) return
  await restoreIntentFiles(projectId, projectRoot).catch((error) =>
    storeLog.warn('intent files not restored', { projectId, error: error instanceof Error ? error.message : String(error) }))
}
