import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { addRepo } from '../src/lib/project-registry'
import { appendEvent, createRun } from '../src/lib/run-store'
import { getDb } from '../src/lib/db'
import { createApprovalFixture } from './helpers/approval-fixture'

/**
 * 014-project-workers: a run's live log (SSE) streamed by the project's worker
 * through the web service stays open and carries every new event.
 */
setDefaultTimeout(120_000)

const ROOT = path.resolve(import.meta.dir, '..')
const TOKEN = `internal-${crypto.randomUUID()}`
const WEB_PORT = 3151
const WORKER_PORT = 3152
const fixture = await createApprovalFixture({ withServer: false })
const { projectA, users, teamA } = fixture
const workspace = await mkdtemp(path.join(tmpdir(), 'spaces-sse-'))
await addRepo({ projectId: projectA.projectId, label: 'app', kind: 'local', localPath: workspace, isPrimary: true })
await getDb()`INSERT INTO project_workers (project_id, active, state) VALUES (${projectA.projectId}, true, 'ready') ON CONFLICT (project_id) DO UPDATE SET active = true`

function spawnServer(port: number, env: Record<string, string>) {
  const base: Record<string, string> = { ...(process.env as Record<string, string>) }
  delete base.AUTH_DISABLED
  return Bun.spawn(['bun', 'run', 'src/server.ts'], { cwd: ROOT, env: { ...base, PORT: String(port), ANTHROPIC_API_KEY: 'sse-test-dummy', SPACES_INTERNAL_TOKEN: TOKEN, ...env }, stdout: 'ignore', stderr: 'ignore' })
}
async function waitFor(url: string) {
  for (let i = 0; i < 150; i += 1) { try { if ((await fetch(url)).ok) return } catch { /* starting */ } await new Promise((r) => setTimeout(r, 400)) }
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
  await getDb()`DELETE FROM project_workers WHERE project_id = ${projectA.projectId}`
  await fixture.stop()
  await rm(workspace, { recursive: true, force: true })
})

describe('live run log through the web service', () => {
  test('the stream stays open and delivers each new event', async () => {
    const run = await createRun({ projectNamespace: projectA.slug, projectLabel: 'SSE', projectPath: workspace, pipelineName: 'test', options: {} as never, template: { stages: [] } as never, projectId: projectA.projectId })
    await getDb()`UPDATE pipeline_runs SET status = 'running', current_stage = 'implement' WHERE run_id = ${run.runId}`
    const controller = new AbortController()
    const res = await fetch(`http://127.0.0.1:${WEB_PORT}/api/runs/${run.runId}/events`, { headers: { cookie, accept: 'text/event-stream' }, signal: controller.signal })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    let ended = false
    const reading = (async () => {
      for (;;) {
        const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }))
        if (done) { ended = true; return }
        text += decoder.decode(value)
      }
    })()
    for (let i = 0; i < 6; i += 1) {
      await new Promise((r) => setTimeout(r, 2_000))
      await appendEvent({ runId: run.runId, kind: 'log', payload: { text: `line ${i}` } })
    }
    await new Promise((r) => setTimeout(r, 4_000))
    const messages = text.split('\n\n').filter((m) => m.startsWith('data: ')).length
    expect(ended).toBe(false)
    expect(messages).toBeGreaterThanOrEqual(6)
    controller.abort()
    await reading
  })
})
