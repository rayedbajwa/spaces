import { test, expect, describe, afterAll } from 'bun:test'
import { closeDb, getDb } from '../src/lib/db'
import { encryptSecret } from '../src/lib/crypto-vault'

/**
 * HTTP smoke tests. We do NOT embed src/server.ts (it has top-level side
 * effects: schema apply, port bind, static bundle) — instead we hit an
 * externally-running server. If the server isn't reachable, the whole
 * suite skips with a hint on how to start one.
 *
 * To run locally:
 *   Terminal 1: bun run web
 *   Terminal 2: bun test tests/smoke.test.ts
 */

const BASE_URL = process.env.SMOKE_BASE_URL ?? 'http://localhost:3000'

async function isServerReachable(): Promise<boolean> {
  try {
    // /api/board is a cheap, unauthenticated GET; it always exists (no DB
    // dependency beyond project queries), so it's a reliable liveness probe.
    const res = await fetch(`${BASE_URL}/api/board`, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

const serverUp = await isServerReachable()
const suite = serverUp ? describe : describe.skip

if (!serverUp) {
  test.skip(`smoke tests skipped: no server responding at ${BASE_URL}. Start one with \`bun run web\` in another terminal, then re-run \`bun test tests/smoke.test.ts\`.`, () => {})
}

// Creating a project requires a stored model provider key (the server answers
// 409 no_provider_key otherwise). CI has no real key, and a dummy one would be
// rejected by the provider's verification, so seed the row directly — the
// server reloads keys on the provider_keys NOTIFY. Removed again in afterAll.
let seededProviderKey = false
if (serverUp) {
  try {
    const sql = getDb()
    const [{ n }] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM provider_keys`
    if (n === 0) {
      await sql`INSERT INTO provider_keys (provider, key_enc, updated_at, last_verified_at, last_verify_status)
                VALUES ('anthropic', ${encryptSecret('smoke-test-dummy-key-never-called')}, now(), now(), 'unknown')
                ON CONFLICT (provider) DO NOTHING`
      await sql`SELECT pg_notify('provider_keys', 'anthropic')`
      seededProviderKey = true
      await new Promise((r) => setTimeout(r, 500))
    }
  } catch {
    // No DB access: the create-project tests will report the 409 themselves.
  }
}

// Tracks projects created by the suite so afterAll can guarantee cleanup even
// if a test fails mid-way and doesn't reach its inline DELETE.
const createdProjectIds = new Set<string>()

async function cleanupProject(projectId: string): Promise<void> {
  // Prefer the API endpoint (it lives at /api/projects/:uuid, matched by a
  // strict UUID regex in server.ts). Fall back to direct SQL if the endpoint
  // returns anything unexpected — the DB is shared with the server so this
  // still results in a clean state.
  try {
    const res = await fetch(`${BASE_URL}/api/projects/${projectId}`, { method: 'DELETE' })
    if (res.ok || res.status === 204) return
  } catch {
    // fall through to SQL fallback
  }
  try {
    const sql = getDb()
    await sql`DELETE FROM projects WHERE project_id = ${projectId}`
  } catch {
    // give up — test is already over, DB may be unreachable in CI teardown.
  }
}

suite('smoke: basic liveness endpoints', () => {
  test('GET /health returns 200 { ok: true }', async () => {
    const res = await fetch(`${BASE_URL}/health`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true })
  })

  test('GET /api/board returns 200 with { columns: Array<...> }', async () => {
    const res = await fetch(`${BASE_URL}/api/board`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.columns)).toBe(true)
    // Each column should have id/title/cards shape (see BoardColumn in server.ts).
    for (const col of body.columns) {
      expect(typeof col.id).toBe('string')
      expect(typeof col.title).toBe('string')
      expect(Array.isArray(col.cards)).toBe(true)
    }
  })

  test('GET /api/projects returns 200 with an Array', async () => {
    const res = await fetch(`${BASE_URL}/api/projects`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
  })

  test('GET /api/integrations returns 200 with an Array', async () => {
    const res = await fetch(`${BASE_URL}/api/integrations`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
  })
})

suite('smoke: project create + orchestrator config lifecycle', () => {
  // Full round-trip: create → read orchestrator → patch speedMode → read again.
  // Cleanup runs even on failure via the module-level afterAll below.

  test('POST /api/projects → GET/PATCH orchestrator → DELETE (or SQL fallback)', async () => {
    const uniqueName = `smoke-test-${Date.now()}`
    const createRes = await fetch(`${BASE_URL}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: uniqueName, description: 'created by smoke.test.ts' }),
    })
    // POST /api/projects returns 201 on success (see server.ts:180).
    expect([200, 201]).toContain(createRes.status)
    const created = await createRes.json()
    expect(typeof created.projectId).toBe('string')
    expect(typeof created.slug).toBe('string')
    createdProjectIds.add(created.projectId)
    const { slug, projectId } = created

    try {
      // Orchestrator: fresh project defaults to speedMode='balanced' (server.ts:604).
      const getRes = await fetch(`${BASE_URL}/api/projects/${slug}/orchestrator`)
      expect(getRes.status).toBe(200)
      const orch = await getRes.json()
      expect(orch.speedMode).toBe('balanced')

      // PATCH speedMode to 'fast' — stored under config_json.speed_mode.
      const patchRes = await fetch(`${BASE_URL}/api/projects/${slug}/orchestrator`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ speedMode: 'fast' }),
      })
      expect(patchRes.status).toBe(200)
      const patched = await patchRes.json()
      expect(patched.speedMode).toBe('fast')

      // Verify the change actually persisted with a fresh GET.
      const getRes2 = await fetch(`${BASE_URL}/api/projects/${slug}/orchestrator`)
      expect(getRes2.status).toBe(200)
      const orch2 = await getRes2.json()
      expect(orch2.speedMode).toBe('fast')
    } finally {
      await cleanupProject(projectId)
      createdProjectIds.delete(projectId)
    }
  })
})

suite('smoke: execute-step validation surfaces field errors', () => {
  test('POST /api/projects/:slug/execute-step { step: "specify" } (no feature) → 400 with field:"feature"', async () => {
    // Need a project to hit the endpoint. Create + tear down inside the test.
    const uniqueName = `smoke-validation-${Date.now()}`
    const createRes = await fetch(`${BASE_URL}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: uniqueName, description: 'created by smoke.test.ts (validation case)' }),
    })
    expect([200, 201]).toContain(createRes.status)
    const created = await createRes.json()
    createdProjectIds.add(created.projectId)
    const { slug, projectId } = created

    try {
      const res = await fetch(`${BASE_URL}/api/projects/${slug}/execute-step`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ step: 'specify' }),
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      // Server-side error shape: { error: "...", field: "feature" } (server.ts:748).
      expect(body.field).toBe('feature')
      expect(typeof body.error).toBe('string')
    } finally {
      await cleanupProject(projectId)
      createdProjectIds.delete(projectId)
    }
  })
})

suite('smoke: rerun on a nonexistent run → 404', () => {
  test('POST /api/runs/:zero-uuid/rerun returns 404 (run not found)', async () => {
    // The all-zeros UUID is a syntactically valid v4 that will never collide
    // with real generated IDs — the server should look it up, miss, and 404.
    const res = await fetch(`${BASE_URL}/api/runs/00000000-0000-0000-0000-000000000000/rerun`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(typeof body.error).toBe('string')
  })
})

// Belt-and-suspenders cleanup: any project the suite created that survived
// its own inline cleanup gets purged here. Also drops the db pool.
afterAll(async () => {
  if (seededProviderKey) {
    try {
      const sql = getDb()
      await sql`DELETE FROM provider_keys WHERE provider = 'anthropic' AND last_verify_status = 'unknown'`
      await sql`SELECT pg_notify('provider_keys', 'anthropic')`
    } catch { /* teardown best effort */ }
  }
  for (const projectId of createdProjectIds) {
    await cleanupProject(projectId)
  }
  await closeDb()
})
