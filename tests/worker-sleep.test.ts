import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { getDb } from '../src/lib/db'
import { addRepo } from '../src/lib/project-registry'
import { markProjectStateStale, saveProjectState } from '../src/lib/project-state'
import { isProjectWorkerAwake } from '../src/lib/worker-wake'
import { createApprovalFixture } from './helpers/approval-fixture'

/**
 * Idle project workers must be able to sleep: any request to a sleeping worker
 * wakes it (Railway), and the board refreshes every 10 s. So the board asks a
 * worker for project state and open pull requests only while its job process
 * is running (it heartbeats); otherwise the stored state stands.
 */
setDefaultTimeout(120_000)
const ROOT = path.resolve(import.meta.dir, '..')
const WEB_PORT = 3151
const TOKEN = 'worker-sleep-test-token'

const fixture = await createApprovalFixture({ withServer: false })
const { projectA, users, teamA } = fixture
const workspace = await mkdtemp(path.join(tmpdir(), 'spaces-sleep-'))
await addRepo({ projectId: projectA.projectId, label: 'app', kind: 'local', localPath: workspace, isPrimary: true })

const artifacts = { initialized: true, specified: true, planned: false, tasked: false, verifiedPass: false, verificationStatus: 'missing', links: [] }
// A stand-in project worker that counts what it is asked.
const asked: string[] = []
const fakeWorker = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url)
    asked.push(url.pathname)
    if (url.pathname === '/internal/project-state') return Response.json({ artifacts, tasksDone: 0 })
    if (url.pathname === '/internal/open-pull-requests') return Response.json([])
    return Response.json({ ok: true })
  },
})
await getDb()`
  INSERT INTO project_workers (project_id, internal_url, platform, state)
  VALUES (${projectA.projectId}, ${`http://127.0.0.1:${fakeWorker.port}`}, 'railway', 'ready')
  ON CONFLICT (project_id) DO UPDATE SET internal_url = EXCLUDED.internal_url, state = 'ready'
`

const base: Record<string, string> = { ...(process.env as Record<string, string>) }
delete base.AUTH_DISABLED
const web = Bun.spawn(['bun', 'run', 'src/server.ts'], { cwd: ROOT, env: { ...base, PORT: String(WEB_PORT), SPACES_ROLE: 'web', SPACES_INTERNAL_TOKEN: TOKEN, ANTHROPIC_API_KEY: 'sleep-test-dummy-key' }, stdout: 'pipe', stderr: 'pipe' })
const deadline = Date.now() + 60_000
for (;;) {
  try { if ((await fetch(`http://127.0.0.1:${WEB_PORT}/health`, { signal: AbortSignal.timeout(2_000) })).ok) break } catch { /* starting */ }
  if (Date.now() > deadline) throw new Error('web service did not start')
  await new Promise((resolve) => setTimeout(resolve, 400))
}
const cookie = await fixture.cookieFor(users.ownerA, teamA)
const workerId = `sleep-test-${randomUUID().slice(0, 8)}`

afterAll(async () => {
  web.kill()
  await web.exited.catch(() => undefined)
  fakeWorker.stop(true)
  await getDb()`DELETE FROM workers WHERE worker_id = ${workerId}`
  await getDb()`DELETE FROM project_workers WHERE project_id = ${projectA.projectId}`
  await fixture.stop()
  await rm(workspace, { recursive: true, force: true })
})

const board = async () => {
  const res = await fetch(`http://127.0.0.1:${WEB_PORT}/api/board`, { headers: { cookie } })
  expect(res.status).toBe(200)
}

describe('idle project workers are left to sleep', () => {
  test('the board does not ask a worker whose job process is not running; its stored state stands', async () => {
    await saveProjectState(projectA.projectId, workspace, artifacts, 0, new Date(Date.now() - 60 * 60_000))
    await markProjectStateStale(projectA.projectId)
    asked.length = 0
    await board()
    await board()
    expect(asked.filter((p) => p.startsWith('/internal/'))).toEqual([])
  })

  test('while the worker runs (heartbeats) the board refreshes from it', async () => {
    await getDb()`INSERT INTO workers (worker_id, project_id, last_heartbeat_at) VALUES (${workerId}, ${projectA.projectId}, now())`
    // The web service caches who is awake for 5 s.
    await new Promise((resolve) => setTimeout(resolve, 5_500))
    asked.length = 0
    await board()
    expect(asked).toContain('/internal/project-state')
  })

  test('awake projects are read once per few seconds, not per project', async () => {
    let loads = 0
    const load = async () => { loads++; return ['p1'] }
    const now = Date.now() + 60_000 // past any cached value
    expect(await isProjectWorkerAwake('p1', now, load)).toBe(true)
    expect(await isProjectWorkerAwake('p2', now + 1_000, load)).toBe(false)
    expect(loads).toBe(1)
    expect(await isProjectWorkerAwake('p1', now + 6_000, load)).toBe(true)
    expect(loads).toBe(2)
  })
})
