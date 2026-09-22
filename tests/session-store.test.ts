import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { getDatabaseUrl, getDb } from '../src/lib/db'
import { restoreRunSession, saveRunSession } from '../src/lib/session-store'

async function isDbReachable(): Promise<boolean> {
  try {
    await getDb()`SELECT 1 FROM run_sessions LIMIT 0`
    return true
  } catch {
    return false
  }
}

const dbAvailable = await isDbReachable()
const dbSuite = dbAvailable ? describe : describe.skip
if (!dbAvailable) test.skip(`session-store DB tests skipped: DATABASE_URL not reachable or schema not applied (${getDatabaseUrl()})`, () => {})

dbSuite('run session copies in Postgres', () => {
  const projectId = randomUUID()
  const runId = randomUUID()
  let dir = ''
  let file = ''
  const content = Array.from({ length: 500 }, (_, i) => JSON.stringify({ i, text: 'conversation line '.repeat(8) })).join('\n') + '\n'

  beforeAll(async () => {
    const sql = getDb()
    await sql`INSERT INTO projects (project_id, name, slug, description) VALUES (${projectId}, 'session store test', ${`test-session-${projectId.slice(0, 8)}`}, 'created by session-store.test.ts')`
    await sql`
      INSERT INTO pipeline_runs (run_id, project_id, project_namespace, project_label, project_path, pipeline_name, template_json, options_json, status)
      VALUES (${runId}, ${projectId}, ${`test-session-${projectId.slice(0, 8)}`}, 'test', '/tmp/test', 'session-store-test', '{}'::jsonb, '{}'::jsonb, 'paused')
    `
    dir = await mkdtemp(path.join(tmpdir(), 'session-store-'))
    file = path.join(dir, 'sessions', 'run.jsonl')
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, content)
  })

  afterAll(async () => {
    await getDb()`DELETE FROM projects WHERE project_id = ${projectId}` // cascades to the run and its session copy
    await rm(dir, { recursive: true, force: true })
  })

  test('saves once, skips an unchanged file, saves again after a change', async () => {
    expect(await saveRunSession(runId, file)).toBe('saved')
    expect(await saveRunSession(runId, file)).toBe('unchanged')
    await writeFile(file, content + '{"more":true}\n')
    expect(await saveRunSession(runId, file)).toBe('saved')
    expect(await saveRunSession(runId, path.join(dir, 'nope.jsonl'))).toBe('missing')
  })

  test('restores only when the local file is gone, byte for byte', async () => {
    expect(await restoreRunSession(runId, file)).toBe(false)
    const before = await readFile(file, 'utf8')
    await rm(path.join(dir, 'sessions'), { recursive: true })
    expect(await restoreRunSession(runId, file)).toBe(true)
    expect(await readFile(file, 'utf8')).toBe(before)
    expect(await restoreRunSession(randomUUID(), path.join(dir, 'other.jsonl'))).toBe(false)
  })
})
