/**
 * On-demand import of organization knowledge sources.
 *
 * Imports are started from the UI/API ("Import", "Re-import") and run inside
 * the web server, one at a time, off the request path. Progress and outcome
 * live on the knowledge_sources row (last_import_* columns), so the UI polls
 * the source list. A Postgres advisory lock guards each source, so two server
 * replicas cannot import the same source at once.
 */

import { getDb } from './db'
import { fetchSourceBatch } from './knowledge-connectors'
import {
  deleteMissingDocuments,
  embedPendingDocuments,
  getKnowledgeSource,
  indexKnowledgeDocument,
  type KnowledgeSourceRow,
} from './knowledge-store'
import { log } from './logger'

const importLog = log.child({ mod: 'knowledge-import' })

/** Advisory lock namespace (project job claims use 8140). */
const ADVISORY_NS = 8141
const MAX_BATCHES_PER_IMPORT = 10

export interface ImportStats {
  fetched: number
  indexed: number
  unchanged: number
  deleted: number
  embeddedChunks: number
  skipped: number
  batches: number
  durationMs: number
}

export type ImportResult =
  | { status: 'ok'; stats: ImportStats }
  | { status: 'error'; error: string; stats: ImportStats }
  | { status: 'locked' }
  | { status: 'missing' }

// ---------------------------------------------------------------------------
// In-process queue
// ---------------------------------------------------------------------------

const queued: string[] = []
let active: string | undefined
let draining = false

/** Queue an import; returns false when the source is already queued or running here. */
export function queueKnowledgeImport(sourceId: string): boolean {
  if (active === sourceId || queued.includes(sourceId)) return false
  queued.push(sourceId)
  void getDb()`UPDATE knowledge_sources SET sync_requested_at = now(), updated_at = now() WHERE source_id = ${sourceId}`.catch(() => undefined)
  void drain()
  return true
}

export function importQueueSnapshot(): { active: string | null; queued: string[] } {
  return { active: active ?? null, queued: [...queued] }
}

async function drain(): Promise<void> {
  if (draining) return
  draining = true
  try {
    const touchedOrgs = new Set<string>()
    while (queued.length > 0) {
      const sourceId = queued.shift()!
      active = sourceId
      try {
        const row = await getKnowledgeSource(sourceId).catch(() => undefined)
        if (row?.orgId) touchedOrgs.add(row.orgId)
        await importKnowledgeSource(sourceId)
      } catch (error) {
        importLog.error('import crashed', error instanceof Error ? error : new Error(String(error)))
      } finally {
        active = undefined
      }
    }
    // Documents indexed while no embedding key was set get their vectors now, per organization.
    for (const orgId of touchedOrgs) {
      const backfill = await embedPendingDocuments(orgId, 50).catch(() => ({ documents: 0, chunks: 0 }))
      if (backfill.documents > 0) importLog.info('back-filled embeddings', { orgId, ...backfill })
    }
  } finally {
    draining = false
  }
}

// ---------------------------------------------------------------------------
// The import itself
// ---------------------------------------------------------------------------

export async function importKnowledgeSource(sourceId: string): Promise<ImportResult> {
  const sql = getDb()
  const startedAt = Date.now()
  const stats: ImportStats = { fetched: 0, indexed: 0, unchanged: 0, deleted: 0, embeddedChunks: 0, skipped: 0, batches: 0, durationMs: 0 }

  // Advisory locks live on a connection; reserve one for the whole import.
  const conn = await sql.reserve()
  try {
    const [lock] = await conn<Array<{ ok: boolean }>>`SELECT pg_try_advisory_lock(${ADVISORY_NS}, hashtext(${sourceId})) AS ok`
    if (!lock?.ok) return { status: 'locked' }
    try {
      let source = await getKnowledgeSource(sourceId)
      if (!source) return { status: 'missing' }
      await sql`UPDATE knowledge_sources SET last_sync_started_at = now(), last_sync_status = 'running', last_sync_error = NULL, sync_requested_at = NULL, updated_at = now() WHERE source_id = ${sourceId}`
      importLog.info('import started', { sourceId, kind: source.kind, label: source.label })

      try {
        for (let batch = 0; batch < MAX_BATCHES_PER_IMPORT; batch++) {
          const result = await fetchSourceBatch(source)
          stats.batches += 1
          stats.fetched += result.documents.length
          stats.skipped += result.skipped ?? 0
          const seen: string[] = []
          for (const doc of result.documents) {
            seen.push(doc.externalId)
            const outcome = await indexKnowledgeDocument(source, doc)
            if (outcome.outcome === 'indexed') {
              stats.indexed += 1
              if (outcome.embedded) stats.embeddedChunks += outcome.chunks
            } else if (outcome.outcome === 'unchanged') {
              stats.unchanged += 1
            }
          }
          if (result.complete) stats.deleted += await deleteMissingDocuments(sourceId, seen)
          await sql`UPDATE knowledge_sources SET cursor_json = ${sql.json(result.cursor as never)}, last_sync_stats = ${sql.json({ ...stats, durationMs: Date.now() - startedAt } as never)}, updated_at = now() WHERE source_id = ${sourceId}`
          if (!result.hasMore) break
          source = { ...source, cursor: result.cursor } satisfies KnowledgeSourceRow
        }
        stats.durationMs = Date.now() - startedAt
        await sql`
          UPDATE knowledge_sources SET last_sync_finished_at = now(), last_sync_status = 'ok', last_sync_error = NULL,
                 last_sync_stats = ${sql.json(stats as never)}, updated_at = now() WHERE source_id = ${sourceId}
        `
        importLog.info('import finished', { sourceId, label: source.label, ...stats })
        return { status: 'ok', stats }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        stats.durationMs = Date.now() - startedAt
        await sql`
          UPDATE knowledge_sources SET last_sync_finished_at = now(), last_sync_status = 'error', last_sync_error = ${message.slice(0, 2000)},
                 last_sync_stats = ${sql.json(stats as never)}, updated_at = now() WHERE source_id = ${sourceId}
        `
        importLog.warn('import failed', { sourceId, label: source.label, error: message, ...stats })
        return { status: 'error', error: message, stats }
      }
    } finally {
      await conn`SELECT pg_advisory_unlock(${ADVISORY_NS}, hashtext(${sourceId}))`
    }
  } finally {
    conn.release()
  }
}

/**
 * Imports interrupted by a restart are left 'running' forever; on boot, mark
 * them as errors so the UI offers a re-import instead of an eternal spinner.
 */
export async function recoverInterruptedImports(): Promise<number> {
  const rows = await getDb()`
    UPDATE knowledge_sources SET last_sync_status = 'error', last_sync_error = 'Import interrupted by a server restart. Re-import to continue.', last_sync_finished_at = now(), updated_at = now()
    WHERE last_sync_status = 'running' RETURNING source_id
  `
  return rows.length
}
