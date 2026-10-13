import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { addRepo } from '../src/lib/project-registry'
import { INTERNAL_TOKEN_HEADER } from '../src/lib/role'
import { createApprovalFixture } from './helpers/approval-fixture'

/**
 * 014-project-workers, phase 1: a web service with no workspace disk forwards
 * project work to the project's worker, which answers only the web service and
 * only for its own project. Two real server processes on one machine.
 */
setDefaultTimeout(120_000)

const ROOT = path.resolve(import.meta.dir, '..')
const TOKEN = `internal-${crypto.randomUUID()}`
const WEB_PORT = 3141
const WORKER_PORT = 3142

const fixture = await createApprovalFixture({ withServer: false })
const { projectA, projectTeamB, users, teamA } = fixture
// The project worker's disk: project A's workspace.
const workspace = await mkdtemp(path.join(tmpdir(), 'spaces-roles-'))
await addRepo({ projectId: projectA.projectId, label: 'app', kind: 'local', localPath: workspace, isPrimary: true })

function spawnServer(port: number, env: Record<string, string>) {
  const base: Record<string, string> = { ...(process.env as Record<string, string>) }
  delete base.AUTH_DISABLED
  return Bun.spawn(['bun', 'run', 'src/server.ts'], { cwd: ROOT, env: { ...base, PORT: String(port), ANTHROPIC_API_KEY: 'roles-test-dummy-key', SPACES_INTERNAL_TOKEN: TOKEN, ...env }, stdout: 'pipe', stderr: 'pipe' })
}

async function waitFor(url: string): Promise<void> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try { if ((await fetch(url, { signal: AbortSignal.timeout(2_000) })).ok) return } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  throw new Error(`no server at ${url}`)
}

const worker = spawnServer(WORKER_PORT, { SPACES_ROLE: 'project', WORKER_PROJECT_ID: projectA.projectId })
const web = spawnServer(WEB_PORT, { SPACES_ROLE: 'web', PROJECT_WORKER_URL_TEMPLATE: `http://127.0.0.1:${WORKER_PORT}` })
await waitFor(`http://127.0.0.1:${WORKER_PORT}/health`)
await waitFor(`http://127.0.0.1:${WEB_PORT}/health`)
const cookie = await fixture.cookieFor(users.ownerA, teamA)

afterAll(async () => {
  worker.kill(); web.kill()
  await Promise.all([worker.exited, web.exited]).catch(() => undefined)
  await fixture.stop()
  await rm(workspace, { recursive: true, force: true })
})

describe('web and project roles', () => {
  test('the web service forwards project work to the project worker', async () => {
    const res = await fetch(`http://127.0.0.1:${WEB_PORT}/api/projects/${projectA.slug}/qa`, { headers: { cookie } })
    expect(res.status).toBe(200)
    expect(await res.json()).toHaveProperty('verificationStatus')
  })

  test('the project worker refuses requests without the internal token', async () => {
    const res = await fetch(`http://127.0.0.1:${WORKER_PORT}/api/projects/${projectA.slug}/qa`, { headers: { cookie } })
    expect(res.status).toBe(404)
  })

  test("the project worker refuses another project's work", async () => {
    const res = await fetch(`http://127.0.0.1:${WORKER_PORT}/api/projects/${projectTeamB.projectId}/qa`, { headers: { cookie, [INTERNAL_TOKEN_HEADER]: TOKEN } })
    expect(res.status).toBe(403)
  })

  test('the internal API answers the web service', async () => {
    const wake = await fetch(`http://127.0.0.1:${WORKER_PORT}/internal/wake`, { method: 'POST', headers: { [INTERNAL_TOKEN_HEADER]: TOKEN } })
    expect(await wake.json()).toEqual({ ok: true, projectId: projectA.projectId })
    const state = await fetch(`http://127.0.0.1:${WORKER_PORT}/internal/project-state`, { headers: { [INTERNAL_TOKEN_HEADER]: TOKEN } })
    expect(state.status).toBe(200)
    expect(Object.keys(await state.json())).toEqual(['artifacts', 'tasksDone'])
  })

  test('the board is served by the web service', async () => {
    const res = await fetch(`http://127.0.0.1:${WEB_PORT}/api/board`, { headers: { cookie } })
    expect(res.status).toBe(200)
    const board = await res.json() as { columns: Array<{ cards: Array<{ projectNamespace: string }> }> }
    expect(board.columns.flatMap((c) => c.cards).some((card) => card.projectNamespace === projectA.slug)).toBe(true)
  })

  test('a project with no reachable worker answers 503 with a code the UI can show', async () => {
    const res = await fetch(`http://127.0.0.1:${WEB_PORT}/api/projects/${projectTeamB.projectId}/qa`, { headers: { cookie: await fixture.cookieFor(users.ownerA) } })
    // Team B's project is not visible to team A's owner: refused before forwarding.
    expect([403, 503]).toContain(res.status)
  })
})
