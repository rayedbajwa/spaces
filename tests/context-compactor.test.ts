import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { closeDb, getDatabaseUrl, getDb } from '../src/lib/db'
import { compactHandoff } from '../src/lib/context-compactor'

/**
 * context-compactor tests. Some are pure (no DB, no LLM); the cache-hit test
 * needs a live Postgres and skips gracefully if not reachable. The "cache
 * miss + no API key" test verifies the safe-fail path so an outage of the
 * compactor never breaks the pipeline.
 *
 * We deliberately never make a real Anthropic call from any test — the tests
 * either fall below the token threshold, hit the DB cache, or exercise the
 * missing-key fallback.
 */

function sha1(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex')
}

/**
 * ~230kB of repeated text — well above the 200-token compaction threshold
 * (Pi's estimateTokens divides char count by 4, so this is ~57k tokens).
 * Big enough that the compactor definitely takes the "should compact" branch.
 */
const LARGE_TAIL = 'The quick brown fox jumped over the lazy dog. '.repeat(5000)

async function isDbReachable(): Promise<boolean> {
  try {
    const sql = getDb()
    await sql`SELECT 1`
    return true
  } catch {
    return false
  }
}

describe('compactHandoff: below threshold → raw tail passthrough', () => {
  test('short input returns { compacted: false, text = raw tail, 40-char hex hash }', async () => {
    // A ~10-char string is far below the 200-token threshold, so the compactor
    // must skip the LLM entirely and return the tail verbatim.
    const tail = 'short text'
    const result = await compactHandoff({ stage: 'plan', stepId: 'test', tail })
    expect(result.compacted).toBe(false)
    expect(result.cached).toBe(false)
    expect(result.text).toBe(tail)
    // SHA-1 hex is exactly 40 chars, [0-9a-f].
    expect(result.hash).toMatch(/^[0-9a-f]{40}$/)
    expect(result.hash).toBe(sha1(tail))
  })

  test('hash is stable across repeated calls with the same tail', async () => {
    const tail = 'a stable string that we will hash twice'
    const a = await compactHandoff({ stage: 'plan', stepId: 't1', tail })
    const b = await compactHandoff({ stage: 'plan', stepId: 't2', tail })
    // Different stepIds must not affect the hash — it's a function of the tail only.
    expect(a.hash).toBe(b.hash)
  })
})

// ----- DB-dependent tests below. Skip cleanly if Postgres isn't reachable. ---

const dbAvailable = await isDbReachable()
const dbSuite = dbAvailable ? describe : describe.skip

if (!dbAvailable) {
  test.skip(`context-compactor DB tests skipped: DATABASE_URL not reachable (${getDatabaseUrl()})`, () => {})
}

dbSuite('compactHandoff: cache hit reuses stored summary', () => {
  // We insert a pipeline_run + a run_thread_entries row containing a known
  // summary + summary_hash. When compactHandoff sees a tail with that same
  // hash, it must short-circuit to the stored summary — no LLM call.
  const projectId = randomUUID()
  const projectSlug = `test-compactor-${projectId.slice(0, 8)}`
  const runId = randomUUID()

  // The "large tail" is above the token threshold so we enter the cache path.
  // We compute its sha1 up front and stash a summary under that hash.
  const tail = LARGE_TAIL
  const tailHash = sha1(tail)
  const CANNED_SUMMARY = 'This is the pre-stored summary of the tail — the compactor must return this verbatim.'

  beforeAll(async () => {
    const sql = getDb()
    await sql`
      INSERT INTO projects (project_id, name, slug, description)
      VALUES (${projectId}, ${'compactor cache test'}, ${projectSlug}, ${'created by context-compactor.test.ts'})
    `
    await sql`
      INSERT INTO pipeline_runs (
        run_id, project_id, project_namespace, project_label, project_path,
        pipeline_name, template_json, options_json, status
      ) VALUES (
        ${runId}, ${projectId}, ${projectSlug}, 'test', '/tmp/test',
        'compactor-cache-test', '{}'::jsonb, '{}'::jsonb, 'completed'
      )
    `
    // run_thread_entries has a FK to pipeline_runs (ON DELETE CASCADE) — the
    // cleanup below removes the project which cascades to the run which
    // cascades to this row.
    await sql`
      INSERT INTO run_thread_entries (
        run_id, step_index, step_id, stage, model, tail, summary, summary_hash
      ) VALUES (
        ${runId}, 0, 'cache-seed', 'plan', 'anthropic/claude-haiku-4-5',
        ${tail}, ${CANNED_SUMMARY}, ${tailHash}
      )
    `
  })

  afterAll(async () => {
    const sql = getDb()
    await sql`DELETE FROM projects WHERE project_id = ${projectId}`
    await closeDb()
  })

  test('a large tail whose sha1 matches a stored summary hash reuses that summary', async () => {
    const result = await compactHandoff({
      stage: 'plan',
      stepId: 'downstream-step',
      tail,
    })
    expect(result.cached).toBe(true)
    expect(result.compacted).toBe(true)
    expect(result.text).toBe(CANNED_SUMMARY)
    expect(result.hash).toBe(tailHash)
  })
})

/**
 * Cache miss + no ANTHROPIC_API_KEY → safe-fail to raw tail. We only reach
 * the LLM call branch when: (a) tail is large enough, (b) no cache entry
 * exists. With no API key, callAnthropicOnce throws and the outer try/catch
 * returns { compacted: false, text: input.tail }.
 *
 * Requires Postgres too — the cache lookup happens before the LLM call, and
 * without a reachable DB the lookup already returns undefined via its own
 * try/catch, which is a different code path. We want to test the LLM-fallback
 * path specifically, so we condition on DB availability.
 */
dbSuite('compactHandoff: cache miss + no ANTHROPIC_API_KEY safely falls back to raw tail', () => {
  const originalKey = process.env.ANTHROPIC_API_KEY

  beforeAll(() => {
    delete process.env.ANTHROPIC_API_KEY
  })

  afterAll(() => {
    if (originalKey !== undefined) process.env.ANTHROPIC_API_KEY = originalKey
    else delete process.env.ANTHROPIC_API_KEY
  })

  test('large tail with no cache row and no API key → { compacted: false, text = raw tail }', async () => {
    // Use a unique tail so the cache lookup misses — appending a random suffix
    // makes the hash unique to this test run.
    const uniqueTail = LARGE_TAIL + '\n\ncache-miss-marker-' + randomUUID()
    const result = await compactHandoff({
      stage: 'plan',
      stepId: 'no-key-test',
      tail: uniqueTail,
    })
    // Safe-fail: the LLM branch threw (missing key), caught by the outer
    // try/catch, which returns the raw tail with compacted: false.
    expect(result.compacted).toBe(false)
    expect(result.cached).toBe(false)
    expect(result.text).toBe(uniqueTail)
    expect(result.hash).toBe(sha1(uniqueTail))
  })
})
