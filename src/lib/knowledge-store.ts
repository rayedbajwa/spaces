/**
 * Organization knowledge store (RAG).
 *
 * Sources (Confluence spaces, Jira projects, Linear teams, GitHub repos and
 * issues, web pages, hand-written notes) are synced in the background into
 * documents, split into chunks and indexed twice: a Postgres full-text index
 * always, and a pgvector embedding when an embedding model and the extension
 * are available. Search fuses both rankings (reciprocal rank fusion), so it
 * works — a little less well — on a database without pgvector or without an
 * embedding key.
 *
 * Scope: a source belongs to the organization (team_id NULL, visible to every
 * team) or to one team. Queries always see organization sources plus the
 * caller's teams.
 */

import { createHash, randomUUID } from 'node:crypto'
import { chunkText } from './chunker'
import { envWithProviderKeys } from './provider-keys'
import { getDb, vectorSearchAvailable } from './db'
import { EMBEDDING_DIMENSIONS, embedQuery, embedTexts, embeddingModel, embeddingsAvailable, toVectorLiteral } from './embeddings'
import { log } from './logger'

const storeLog = log.child({ mod: 'knowledge-store' })

export type KnowledgeSourceKind = 'confluence' | 'jira' | 'linear' | 'github_repo' | 'github_issues' | 'url' | 'manual'
export const KNOWLEDGE_SOURCE_KINDS: KnowledgeSourceKind[] = ['confluence', 'jira', 'linear', 'github_repo', 'github_issues', 'url', 'manual']
export const KNOWLEDGE_KIND_LABEL: Record<KnowledgeSourceKind, string> = {
  confluence: 'Confluence space',
  jira: 'Jira project',
  linear: 'Linear team',
  github_repo: 'GitHub repository docs',
  github_issues: 'GitHub issues & PRs',
  url: 'Web pages',
  manual: 'Notes',
}

export type SyncStatus = 'running' | 'ok' | 'error'

export interface KnowledgeSourceRow {
  orgId: string
  sourceId: string
  teamId: string | null
  teamName: string | null
  kind: KnowledgeSourceKind
  label: string
  config: Record<string, unknown>
  enabled: boolean
  syncIntervalMinutes: number
  cursor: Record<string, unknown>
  syncRequestedAt: string | null
  lastSyncStartedAt: string | null
  lastSyncFinishedAt: string | null
  lastSyncStatus: SyncStatus | null
  lastSyncError: string | null
  lastSyncStats: Record<string, unknown>
  documentCount: number
  chunkCount: number
  createdAt: string
  updatedAt: string
}

export interface KnowledgeDocumentRow {
  documentId: string
  sourceId: string
  externalId: string
  title: string
  url: string | null
  contentLength: number
  sourceUpdatedAt: string | null
  fetchedAt: string
  indexedAt: string | null
  embeddingStatus: 'pending' | 'done' | 'skipped' | 'error'
  embeddingError: string | null
  chunkCount: number
}

export interface KnowledgeDocumentInput {
  /** Stable id inside the source: page id, issue key, file path, URL. */
  externalId: string
  title: string
  url?: string
  content: string
  metadata?: Record<string, unknown>
  sourceUpdatedAt?: string
}

/** Which sources a caller may see: organization-wide ones plus these teams (or everything). */
export interface KnowledgeScope {
  /** Organization the search runs in; sources of other organizations are never visible. */
  orgId: string
  teamIds: string[] | 'all'
  sourceIds?: string[]
}

export interface KnowledgeHit {
  chunkId: number
  documentId: string
  sourceId: string
  sourceKind: KnowledgeSourceKind
  sourceLabel: string
  teamId: string | null
  title: string
  url: string | null
  headingPath: string[]
  content: string
  score: number
  matchedBy: Array<'vector' | 'text'>
}

const SOURCE_COLS = `
  s.source_id AS "sourceId", s.org_id AS "orgId", s.team_id AS "teamId", t.name AS "teamName", s.kind, s.label,
  s.config_json AS "config", s.enabled, s.sync_interval_minutes AS "syncIntervalMinutes", s.cursor_json AS "cursor",
  s.sync_requested_at AS "syncRequestedAt", s.last_sync_started_at AS "lastSyncStartedAt", s.last_sync_finished_at AS "lastSyncFinishedAt",
  s.last_sync_status AS "lastSyncStatus", s.last_sync_error AS "lastSyncError", s.last_sync_stats AS "lastSyncStats",
  (SELECT count(*)::int FROM knowledge_documents d WHERE d.source_id = s.source_id) AS "documentCount",
  (SELECT count(*)::int FROM knowledge_chunks c WHERE c.source_id = s.source_id) AS "chunkCount",
  s.created_at AS "createdAt", s.updated_at AS "updatedAt"
`

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export async function listKnowledgeSources(scope: KnowledgeScope): Promise<KnowledgeSourceRow[]> {
  const sql = getDb()
  const teamFilter = scope.teamIds === 'all' ? sql`TRUE` : sql`(s.team_id IS NULL OR s.team_id = ANY(${scope.teamIds}::uuid[]))`
  return sql<KnowledgeSourceRow[]>`
    SELECT ${sql.unsafe(SOURCE_COLS)}
    FROM knowledge_sources s LEFT JOIN teams t ON t.team_id = s.team_id
    WHERE s.org_id = ${scope.orgId} AND ${teamFilter}
    ORDER BY s.team_id NULLS FIRST, s.created_at ASC
  `
}

export async function getKnowledgeSource(sourceId: string): Promise<KnowledgeSourceRow | undefined> {
  const sql = getDb()
  const [row] = await sql<KnowledgeSourceRow[]>`
    SELECT ${sql.unsafe(SOURCE_COLS)} FROM knowledge_sources s LEFT JOIN teams t ON t.team_id = s.team_id WHERE s.source_id = ${sourceId}
  `
  return row
}

export async function createKnowledgeSource(input: {
  orgId: string
  kind: KnowledgeSourceKind
  label: string
  config?: Record<string, unknown>
  teamId?: string | null
  syncIntervalMinutes?: number
  createdBy?: string | null
}): Promise<KnowledgeSourceRow> {
  const sql = getDb()
  const sourceId = randomUUID()
  await sql`
    INSERT INTO knowledge_sources (source_id, org_id, team_id, kind, label, config_json, sync_interval_minutes, created_by, sync_requested_at)
    VALUES (${sourceId}, ${input.orgId}, ${input.teamId ?? null}, ${input.kind}, ${input.label.trim()}, ${sql.json((input.config ?? {}) as never)},
            ${clampInterval(input.syncIntervalMinutes)}, ${input.createdBy ?? null}, ${input.kind === 'manual' ? null : sql`now()`})
  `
  return (await getKnowledgeSource(sourceId))!
}

export async function updateKnowledgeSource(sourceId: string, patch: {
  label?: string
  config?: Record<string, unknown>
  enabled?: boolean
  syncIntervalMinutes?: number
}): Promise<KnowledgeSourceRow | undefined> {
  const sql = getDb()
  const current = await getKnowledgeSource(sourceId)
  if (!current) return undefined
  const configChanged = patch.config !== undefined && JSON.stringify(patch.config) !== JSON.stringify(current.config)
  await sql`
    UPDATE knowledge_sources SET
      label = ${patch.label?.trim() || current.label},
      config_json = ${sql.json((patch.config ?? current.config) as never)},
      enabled = ${patch.enabled ?? current.enabled},
      sync_interval_minutes = ${patch.syncIntervalMinutes === undefined ? current.syncIntervalMinutes : clampInterval(patch.syncIntervalMinutes)},
      -- A changed configuration means a different set of documents: start over.
      cursor_json = ${configChanged ? sql`'{}'::jsonb` : sql`cursor_json`},
      sync_requested_at = ${configChanged && current.kind !== 'manual' ? sql`now()` : sql`sync_requested_at`},
      updated_at = now()
    WHERE source_id = ${sourceId}
  `
  return getKnowledgeSource(sourceId)
}

export async function deleteKnowledgeSource(sourceId: string): Promise<boolean> {
  const rows = await getDb()`DELETE FROM knowledge_sources WHERE source_id = ${sourceId} RETURNING source_id`
  return rows.length > 0
}

/** Reset the cursor so the next sync re-enumerates everything (and prunes deleted items). */
export async function resetKnowledgeSourceCursor(sourceId: string): Promise<void> {
  await getDb()`UPDATE knowledge_sources SET cursor_json = '{}'::jsonb, updated_at = now() WHERE source_id = ${sourceId}`
}

function clampInterval(minutes: number | undefined): number {
  if (minutes === undefined || !Number.isFinite(minutes)) return 360
  return Math.max(5, Math.min(Math.round(minutes), 7 * 24 * 60))
}

// ---------------------------------------------------------------------------
// Documents + chunks
// ---------------------------------------------------------------------------

export async function listKnowledgeDocuments(sourceId: string, limit = 200): Promise<KnowledgeDocumentRow[]> {
  return getDb()<KnowledgeDocumentRow[]>`
    SELECT d.document_id AS "documentId", d.source_id AS "sourceId", d.external_id AS "externalId", d.title, d.url,
           length(d.content) AS "contentLength", d.source_updated_at AS "sourceUpdatedAt", d.fetched_at AS "fetchedAt",
           d.indexed_at AS "indexedAt", d.embedding_status AS "embeddingStatus", d.embedding_error AS "embeddingError",
           (SELECT count(*)::int FROM knowledge_chunks c WHERE c.document_id = d.document_id) AS "chunkCount"
    FROM knowledge_documents d WHERE d.source_id = ${sourceId}
    ORDER BY d.fetched_at DESC LIMIT ${Math.max(1, Math.min(limit, 1000))}
  `
}

export async function deleteKnowledgeDocument(documentId: string): Promise<boolean> {
  const rows = await getDb()`DELETE FROM knowledge_documents WHERE document_id = ${documentId} RETURNING document_id`
  return rows.length > 0
}

export type IndexOutcome = 'indexed' | 'unchanged' | 'empty'

export interface IndexResult {
  outcome: IndexOutcome
  documentId?: string
  chunks: number
  embedded: boolean
  embeddingError?: string
}

/**
 * Upsert one document: skip when its content is unchanged and already indexed,
 * otherwise re-chunk, (re-)embed and replace its chunks in one transaction.
 */
export async function indexKnowledgeDocument(source: { sourceId: string; teamId: string | null; orgId: string }, doc: KnowledgeDocumentInput): Promise<IndexResult> {
  const sql = getDb()
  const title = doc.title.trim() || doc.externalId
  const content = doc.content.replace(/\r\n?/g, '\n').trim()
  if (!content) return { outcome: 'empty', chunks: 0, embedded: false }
  const hash = sha1(`${title}\n${content}`)
  const env = await envWithProviderKeys(source.orgId)
  const wantEmbeddings = embeddingsAvailable(env) && (await vectorSearchAvailable())

  const [existing] = await sql<Array<{ documentId: string; contentHash: string; embeddingStatus: string }>>`
    SELECT document_id AS "documentId", content_hash AS "contentHash", embedding_status AS "embeddingStatus"
    FROM knowledge_documents WHERE source_id = ${source.sourceId} AND external_id = ${doc.externalId}
  `
  // Unchanged and already in the state we could reach now → only bump fetched_at.
  const satisfied = existing && existing.contentHash === hash && (existing.embeddingStatus === 'done' || (!wantEmbeddings && existing.embeddingStatus === 'skipped'))
  if (satisfied) {
    await sql`UPDATE knowledge_documents SET fetched_at = now(), source_updated_at = COALESCE(${doc.sourceUpdatedAt ?? null}, source_updated_at) WHERE document_id = ${existing.documentId}`
    return { outcome: 'unchanged', documentId: existing.documentId, chunks: 0, embedded: existing.embeddingStatus === 'done' }
  }

  // The title leads the first chunk so short pages are still findable by name.
  const chunks = chunkText(`# ${title}\n\n${content}`)
  let vectors: number[][] | undefined
  let embeddingError: string | undefined
  if (wantEmbeddings && chunks.length > 0) {
    try {
      vectors = await embedTexts(chunks.map((c) => c.text), env)
    } catch (error) {
      embeddingError = error instanceof Error ? error.message : String(error)
      storeLog.warn('embedding failed; document indexed for full-text search only', { externalId: doc.externalId, error: embeddingError })
    }
  }
  const embeddingStatus = vectors ? 'done' : wantEmbeddings ? 'error' : 'skipped'
  const model = vectors ? embeddingModel() : null
  const documentId = existing?.documentId ?? randomUUID()

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO knowledge_documents (document_id, source_id, external_id, title, url, content, content_hash, metadata_json, source_updated_at, fetched_at, indexed_at, embedding_status, embedding_error)
      VALUES (${documentId}, ${source.sourceId}, ${doc.externalId}, ${title}, ${doc.url ?? null}, ${content}, ${hash}, ${tx.json((doc.metadata ?? {}) as never)}, ${doc.sourceUpdatedAt ?? null}, now(), now(), ${embeddingStatus}, ${embeddingError ?? null})
      ON CONFLICT (source_id, external_id) DO UPDATE SET
        title = EXCLUDED.title, url = EXCLUDED.url, content = EXCLUDED.content, content_hash = EXCLUDED.content_hash,
        metadata_json = EXCLUDED.metadata_json, source_updated_at = EXCLUDED.source_updated_at, fetched_at = now(), indexed_at = now(),
        embedding_status = EXCLUDED.embedding_status, embedding_error = EXCLUDED.embedding_error
    `
    await tx`DELETE FROM knowledge_chunks WHERE document_id = ${documentId}`
    for (const chunk of chunks) {
      const vector = vectors?.[chunk.index]
      if (vector) {
        await tx`
          INSERT INTO knowledge_chunks (document_id, source_id, team_id, chunk_index, heading_path, content, embedding_model, embedding)
          VALUES (${documentId}, ${source.sourceId}, ${source.teamId}, ${chunk.index}, ${chunk.headingPath}, ${chunk.text}, ${model}, ${toVectorLiteral(vector)}::vector)
        `
      } else {
        await tx`
          INSERT INTO knowledge_chunks (document_id, source_id, team_id, chunk_index, heading_path, content)
          VALUES (${documentId}, ${source.sourceId}, ${source.teamId}, ${chunk.index}, ${chunk.headingPath}, ${chunk.text})
        `
      }
    }
  })
  return { outcome: 'indexed', documentId, chunks: chunks.length, embedded: Boolean(vectors), embeddingError }
}

/** Remove documents of a source that a full enumeration no longer returned. */
export async function deleteMissingDocuments(sourceId: string, keepExternalIds: string[]): Promise<number> {
  const rows = await getDb()`
    DELETE FROM knowledge_documents WHERE source_id = ${sourceId} AND NOT (external_id = ANY(${keepExternalIds}::text[])) RETURNING document_id
  `
  return rows.length
}

/**
 * Embed chunks of documents that were indexed without vectors (no key or a
 * failure at the time). Runs from the sync loop so enabling embeddings later
 * back-fills the index without a full resync.
 */
export async function embedPendingDocuments(orgId: string, limit = 25): Promise<{ documents: number; chunks: number }> {
  const env = await envWithProviderKeys(orgId)
  if (!embeddingsAvailable(env) || !(await vectorSearchAvailable())) return { documents: 0, chunks: 0 }
  const sql = getDb()
  const docs = await sql<Array<{ documentId: string }>>`
    SELECT d.document_id AS "documentId" FROM knowledge_documents d JOIN knowledge_sources s ON s.source_id = d.source_id
    WHERE s.org_id = ${orgId} AND d.embedding_status IN ('pending', 'skipped', 'error')
    ORDER BY d.fetched_at DESC LIMIT ${limit}
  `
  let chunkTotal = 0
  let done = 0
  for (const { documentId } of docs) {
    const chunks = await sql<Array<{ chunkId: number; content: string }>>`
      SELECT chunk_id AS "chunkId", content FROM knowledge_chunks WHERE document_id = ${documentId} AND embedding IS NULL ORDER BY chunk_index
    `
    try {
      const vectors = await embedTexts(chunks.map((c) => c.content), env)
      await sql.begin(async (tx) => {
        for (let i = 0; i < chunks.length; i++) {
          await tx`UPDATE knowledge_chunks SET embedding = ${toVectorLiteral(vectors[i]!)}::vector, embedding_model = ${embeddingModel(env)} WHERE chunk_id = ${chunks[i]!.chunkId}`
        }
        await tx`UPDATE knowledge_documents SET embedding_status = 'done', embedding_error = NULL, indexed_at = now() WHERE document_id = ${documentId}`
      })
      chunkTotal += chunks.length
      done += 1
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await sql`UPDATE knowledge_documents SET embedding_status = 'error', embedding_error = ${message} WHERE document_id = ${documentId}`
      storeLog.warn('back-fill embedding failed', { documentId, error: message })
      // A provider outage would fail every document the same way; stop early.
      if (/\b(401|429|5\d\d)\b|No API key/.test(message)) break
    }
  }
  return { documents: done, chunks: chunkTotal }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Reciprocal rank fusion: merge several ranked id lists into one score per id.
 * k=60 is the conventional constant; it keeps a top-3 in one list from being
 * swamped by a long tail in another.
 */
export function fuseRanks<T extends string | number>(lists: Array<{ label: string; ids: T[] }>, k = 60): Array<{ id: T; score: number; matchedBy: string[] }> {
  const scores = new Map<T, { score: number; matchedBy: string[] }>()
  for (const list of lists) {
    list.ids.forEach((id, index) => {
      const entry = scores.get(id) ?? { score: 0, matchedBy: [] }
      entry.score += 1 / (k + index + 1)
      entry.matchedBy.push(list.label)
      scores.set(id, entry)
    })
  }
  return [...scores.entries()].map(([id, v]) => ({ id, ...v })).sort((a, b) => b.score - a.score)
}

export async function searchOrgKnowledge(options: {
  query: string
  scope: KnowledgeScope
  limit?: number
  /** Keep only the best chunk of each document (default true). */
  perDocument?: boolean
}): Promise<{ hits: KnowledgeHit[]; mode: 'hybrid' | 'text' }> {
  const sql = getDb()
  const query = options.query.trim()
  const limit = Math.max(1, Math.min(options.limit ?? 8, 50))
  if (!query) return { hits: [], mode: 'text' }
  const candidates = limit * 4
  const teamFilter = options.scope.teamIds === 'all' ? sql`TRUE` : sql`(c.team_id IS NULL OR c.team_id = ANY(${options.scope.teamIds}::uuid[]))`
  const sourceFilter = options.scope.sourceIds?.length ? sql`c.source_id = ANY(${options.scope.sourceIds}::uuid[])` : sql`TRUE`
  const orgFilter = sql`c.source_id IN (SELECT source_id FROM knowledge_sources WHERE org_id = ${options.scope.orgId})`

  const textSearch = async (q: string) => (await sql<Array<{ chunkId: number }>>`
    SELECT c.chunk_id AS "chunkId"
    FROM knowledge_chunks c, websearch_to_tsquery('english', ${q}) q
    WHERE c.content_tsv @@ q AND ${orgFilter} AND ${teamFilter} AND ${sourceFilter}
    ORDER BY ts_rank_cd(c.content_tsv, q) DESC, c.chunk_id ASC
    LIMIT ${candidates}
  `).map((r) => Number(r.chunkId))
  // websearch syntax ANDs every word; a question with one stray word would
  // match nothing, so fall back to "any of the words", ranked by how many hit.
  let textIds = await textSearch(query)
  if (textIds.length === 0) {
    const words = query.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2)
    if (words.length > 1) textIds = await textSearch(words.join(' or '))
  }

  let vectorIds: number[] = []
  let mode: 'hybrid' | 'text' = 'text'
  const searchEnv = await envWithProviderKeys(options.scope.orgId)
  if (embeddingsAvailable(searchEnv) && (await vectorSearchAvailable())) {
    try {
      const literal = toVectorLiteral(await embedQuery(query, searchEnv))
      vectorIds = (await sql<Array<{ chunkId: number }>>`
        SELECT c.chunk_id AS "chunkId"
        FROM knowledge_chunks c
        WHERE c.embedding IS NOT NULL AND ${orgFilter} AND ${teamFilter} AND ${sourceFilter}
        ORDER BY c.embedding <=> ${literal}::vector
        LIMIT ${candidates}
      `).map((r) => Number(r.chunkId))
      mode = 'hybrid'
    } catch (error) {
      storeLog.warn('vector search unavailable for this query; using full-text only', { error: error instanceof Error ? error.message : String(error) })
    }
  }

  const fused = fuseRanks([{ label: 'vector', ids: vectorIds }, { label: 'text', ids: textIds }])
  if (fused.length === 0) return { hits: [], mode }
  const ids = fused.map((f) => f.id)
  const rows = await sql<Array<Omit<KnowledgeHit, 'score' | 'matchedBy'>>>`
    SELECT c.chunk_id AS "chunkId", c.document_id AS "documentId", c.source_id AS "sourceId", s.kind AS "sourceKind", s.label AS "sourceLabel",
           c.team_id AS "teamId", d.title, d.url, c.heading_path AS "headingPath", c.content
    FROM knowledge_chunks c
    JOIN knowledge_documents d ON d.document_id = c.document_id
    JOIN knowledge_sources s ON s.source_id = c.source_id
    WHERE c.chunk_id = ANY(${ids}::bigint[])
  `
  const byId = new Map(rows.map((r) => [Number(r.chunkId), r]))
  const hits: KnowledgeHit[] = []
  const seenDocs = new Set<string>()
  for (const f of fused) {
    const row = byId.get(f.id)
    if (!row) continue
    if (options.perDocument !== false) {
      if (seenDocs.has(row.documentId)) continue
      seenDocs.add(row.documentId)
    }
    hits.push({ ...row, chunkId: Number(row.chunkId), score: f.score, matchedBy: f.matchedBy as Array<'vector' | 'text'> })
    if (hits.length >= limit) break
  }
  return { hits, mode }
}

/** Markdown rendering shared by the agent tool and the context bundle. */
export function renderKnowledgeHits(hits: KnowledgeHit[], options: { maxCharsPerHit?: number } = {}): string {
  const max = options.maxCharsPerHit ?? 1_200
  return hits.map((h, i) => {
    const where = [h.sourceLabel, ...h.headingPath].filter(Boolean).join(' › ')
    const body = h.content.length > max ? `${h.content.slice(0, max - 1)}…` : h.content
    return `### ${i + 1}. ${h.title}${h.url ? ` — ${h.url}` : ''}\n_${KNOWLEDGE_KIND_LABEL[h.sourceKind]}: ${where}_\n\n${body.trim()}`
  }).join('\n\n')
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface KnowledgeStatus {
  sources: number
  enabledSources: number
  documents: number
  chunks: number
  embeddedChunks: number
  pendingEmbeddings: number
  embeddings: { available: boolean; model: string; dimensions: number }
  vectorSearch: boolean
  lastSyncAt: string | null
}

export async function getKnowledgeStatus(scope: KnowledgeScope): Promise<KnowledgeStatus> {
  const sql = getDb()
  const teamFilter = scope.teamIds === 'all' ? sql`TRUE` : sql`(s.team_id IS NULL OR s.team_id = ANY(${scope.teamIds}::uuid[]))`
  // Chunks carry no org column; restrict them to the organization's sources.
  const orgSources = sql`(SELECT source_id FROM knowledge_sources WHERE org_id = ${scope.orgId})`
  const vector = await vectorSearchAvailable()
  const [row] = await sql<Array<{ sources: number; enabledSources: number; documents: number; chunks: number; embeddedChunks: number; pendingEmbeddings: number; lastSyncAt: string | null }>>`
    SELECT count(DISTINCT s.source_id)::int AS "sources",
           count(DISTINCT s.source_id) FILTER (WHERE s.enabled)::int AS "enabledSources",
           (SELECT count(*)::int FROM knowledge_documents d JOIN knowledge_sources s2 ON s2.source_id = d.source_id WHERE s2.org_id = ${scope.orgId} AND ${scope.teamIds === 'all' ? sql`TRUE` : sql`(s2.team_id IS NULL OR s2.team_id = ANY(${scope.teamIds}::uuid[]))`}) AS "documents",
           (SELECT count(*)::int FROM knowledge_chunks c WHERE c.source_id IN ${orgSources} AND ${scope.teamIds === 'all' ? sql`TRUE` : sql`(c.team_id IS NULL OR c.team_id = ANY(${scope.teamIds}::uuid[]))`}) AS "chunks",
           ${vector ? sql`(SELECT count(*)::int FROM knowledge_chunks c WHERE c.source_id IN ${orgSources} AND c.embedding IS NOT NULL AND ${scope.teamIds === 'all' ? sql`TRUE` : sql`(c.team_id IS NULL OR c.team_id = ANY(${scope.teamIds}::uuid[]))`})` : sql`0`} AS "embeddedChunks",
           (SELECT count(*)::int FROM knowledge_documents d JOIN knowledge_sources s3 ON s3.source_id = d.source_id WHERE s3.org_id = ${scope.orgId} AND d.embedding_status <> 'done' AND ${scope.teamIds === 'all' ? sql`TRUE` : sql`(s3.team_id IS NULL OR s3.team_id = ANY(${scope.teamIds}::uuid[]))`}) AS "pendingEmbeddings",
           max(s.last_sync_finished_at) AS "lastSyncAt"
    FROM knowledge_sources s WHERE s.org_id = ${scope.orgId} AND ${teamFilter}
  `
  return {
    sources: row?.sources ?? 0,
    enabledSources: row?.enabledSources ?? 0,
    documents: row?.documents ?? 0,
    chunks: row?.chunks ?? 0,
    embeddedChunks: row?.embeddedChunks ?? 0,
    pendingEmbeddings: row?.pendingEmbeddings ?? 0,
    embeddings: { available: embeddingsAvailable(await envWithProviderKeys(scope.orgId)), model: embeddingModel(), dimensions: EMBEDDING_DIMENSIONS },
    vectorSearch: vector,
    lastSyncAt: row?.lastSyncAt ?? null,
  }
}

/** Cheap check used to decide whether to offer the knowledge tool / prompt block at all. */
export async function hasOrgKnowledge(scope: KnowledgeScope): Promise<boolean> {
  const sql = getDb()
  const teamFilter = scope.teamIds === 'all' ? sql`TRUE` : sql`(c.team_id IS NULL OR c.team_id = ANY(${scope.teamIds}::uuid[]))`
  const [row] = await sql<Array<{ ok: boolean }>>`SELECT EXISTS (SELECT 1 FROM knowledge_chunks c WHERE c.source_id IN (SELECT source_id FROM knowledge_sources WHERE org_id = ${scope.orgId}) AND ${teamFilter}) AS ok`.catch(() => [])
  return Boolean(row?.ok)
}

function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex')
}
