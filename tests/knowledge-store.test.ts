import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { closeDb, getDb } from '../src/lib/db'
import {
  createKnowledgeSource,
  deleteKnowledgeSource,
  deleteMissingDocuments,
  fuseRanks,
  getKnowledgeStatus,
  indexKnowledgeDocument,
  listKnowledgeDocuments,
  searchOrgKnowledge,
} from '../src/lib/knowledge-store'

/**
 * fuseRanks is pure. The rest needs a live Postgres at DATABASE_URL with the
 * schema applied; those tests skip when the database is unreachable. They use
 * a throwaway organization-level source and remove it afterwards. Embeddings
 * are exercised only when a key is configured (search still works without).
 */

describe('fuseRanks (reciprocal rank fusion)', () => {
  test('ids present in both lists outrank ids in one', () => {
    const fused = fuseRanks([
      { label: 'vector', ids: [1, 2, 3] },
      { label: 'text', ids: [3, 4, 5] },
    ])
    expect(fused[0]!.id).toBe(3)
    expect(fused[0]!.matchedBy.sort()).toEqual(['text', 'vector'])
    // Every id appears once with a positive score.
    expect(fused.map((f) => f.id).sort()).toEqual([1, 2, 3, 4, 5])
    for (const f of fused) expect(f.score).toBeGreaterThan(0)
  })

  test('within one list, earlier rank scores higher; empty lists are fine', () => {
    const fused = fuseRanks([{ label: 'text', ids: ['a', 'b'] }, { label: 'vector', ids: [] }])
    expect(fused.map((f) => f.id)).toEqual(['a', 'b'])
    expect(fused[0]!.score).toBeGreaterThan(fused[1]!.score)
    expect(fuseRanks([])).toEqual([])
  })
})

async function dbReachable(): Promise<boolean> {
  try { await getDb()`SELECT 1 FROM knowledge_sources LIMIT 1`; return true } catch { return false }
}

const live = await dbReachable()

describe.if(live)('knowledge store (live Postgres)', () => {
  let sourceId: string

  beforeAll(async () => {
    const source = await createKnowledgeSource({ kind: 'manual', label: `test-notes-${Date.now()}`, teamId: null })
    sourceId = source.sourceId
  })

  afterAll(async () => {
    if (sourceId) await deleteKnowledgeSource(sourceId)
    await closeDb()
  })

  test('index, search, unchanged skip, prune', async () => {
    const source = { sourceId, teamId: null }
    const first = await indexKnowledgeDocument(source, {
      externalId: 'runbook-rollback',
      title: 'Payments deploy rollback runbook',
      content: '# Rollback\n\nTo roll back the payments service, redeploy the previous image tag with `deploy --tag` and run the smoke tests. Notify #payments-oncall.',
    })
    expect(first.outcome).toBe('indexed')
    expect(first.chunks).toBeGreaterThan(0)

    const second = await indexKnowledgeDocument(source, {
      externalId: 'adr-auth',
      title: 'ADR 7: authentication uses OIDC',
      content: 'All internal services authenticate users through the central OIDC provider. Service-to-service calls use mTLS. Do not roll your own sessions.',
    })
    expect(second.outcome).toBe('indexed')

    // Same content again → unchanged, no re-chunking.
    const again = await indexKnowledgeDocument(source, {
      externalId: 'adr-auth',
      title: 'ADR 7: authentication uses OIDC',
      content: 'All internal services authenticate users through the central OIDC provider. Service-to-service calls use mTLS. Do not roll your own sessions.',
    })
    expect(again.outcome).toBe('unchanged')

    const docs = await listKnowledgeDocuments(sourceId)
    expect(docs.map((d) => d.externalId).sort()).toEqual(['adr-auth', 'runbook-rollback'])

    // Search scoped to this source finds the right document first, with either mode.
    const rollback = await searchOrgKnowledge({ query: 'how do we roll back a payments deploy', scope: { teamIds: [], sourceIds: [sourceId] }, limit: 2 })
    expect(rollback.hits.length).toBeGreaterThan(0)
    expect(rollback.hits[0]!.title).toContain('rollback')
    expect(['hybrid', 'text']).toContain(rollback.mode)

    const auth = await searchOrgKnowledge({ query: 'authentication OIDC mTLS', scope: { teamIds: [], sourceIds: [sourceId] }, limit: 2 })
    expect(auth.hits[0]!.title).toContain('ADR 7')

    // Organization-level sources are visible to any team scope.
    const anyTeam = await searchOrgKnowledge({ query: 'OIDC', scope: { teamIds: ['00000000-0000-0000-0000-000000000000'], sourceIds: [sourceId] }, limit: 1 })
    expect(anyTeam.hits.length).toBe(1)

    // Pruning keeps only the ids a full enumeration returned.
    const deleted = await deleteMissingDocuments(sourceId, ['adr-auth'])
    expect(deleted).toBe(1)
    expect((await listKnowledgeDocuments(sourceId)).map((d) => d.externalId)).toEqual(['adr-auth'])

    const status = await getKnowledgeStatus({ teamIds: 'all' })
    expect(status.documents).toBeGreaterThanOrEqual(1)
    expect(typeof status.vectorSearch).toBe('boolean')
  })
})
