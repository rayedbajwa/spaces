import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { getDb } from './db'
import { log } from './logger'

/**
 * A durable copy of each run's agent session file, in Postgres.
 *
 * The session file is the agent's whole conversation for the run. It lives on
 * the worker's disk, so a run that resumes where that file is missing — a new
 * volume today, another worker host later — would have to start its stage over
 * instead of continuing the conversation (answering a gate reopens it; so does
 * a rerun). Feature documents need no copy here: the pipeline commits and
 * pushes them with the feature branch.
 *
 * The file is gzip-compressed (JSON lines compress well) and skipped when it
 * has not changed since the last copy. Very large sessions are not copied; the
 * run then behaves as before when the file is gone.
 */

const sessionLog = log.child({ mod: 'session-store' })

/** Largest compressed session kept in the database. */
export const MAX_SESSION_GZIP_BYTES = 32 * 1024 * 1024

export function sha256(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex')
}

/** Copy the run's session file into the database. Returns what happened. */
export async function saveRunSession(runId: string, sessionFile: string): Promise<'saved' | 'unchanged' | 'missing' | 'too_large'> {
  const body = await readFile(sessionFile).catch(() => undefined)
  if (!body) return 'missing'
  const hash = sha256(body)
  const sql = getDb()
  const [current] = await sql<Array<{ sha256: string }>>`SELECT sha256 FROM run_sessions WHERE run_id = ${runId}`
  if (current?.sha256 === hash) return 'unchanged'
  const gzip = Bun.gzipSync(body)
  if (gzip.byteLength > MAX_SESSION_GZIP_BYTES) {
    sessionLog.warn('session too large to keep a copy', { runId, bytes: body.byteLength, gzipBytes: gzip.byteLength })
    return 'too_large'
  }
  await sql`
    INSERT INTO run_sessions (run_id, session_file, content_gzip, sha256, bytes, updated_at)
    VALUES (${runId}, ${sessionFile}, ${Buffer.from(gzip)}, ${hash}, ${body.byteLength}, now())
    ON CONFLICT (run_id) DO UPDATE
      SET session_file = EXCLUDED.session_file, content_gzip = EXCLUDED.content_gzip,
          sha256 = EXCLUDED.sha256, bytes = EXCLUDED.bytes, updated_at = now()
  `
  return 'saved'
}

/**
 * Put the session file back where the run expects it, when the local copy is
 * gone and the database has one. An existing local file is never overwritten.
 */
export async function restoreRunSession(runId: string, sessionFile: string): Promise<boolean> {
  if (await stat(sessionFile).then(() => true).catch(() => false)) return false
  const [row] = await getDb()<Array<{ content: Uint8Array }>>`SELECT content_gzip AS content FROM run_sessions WHERE run_id = ${runId}`
  if (!row) return false
  await mkdir(path.dirname(sessionFile), { recursive: true })
  await writeFile(sessionFile, Bun.gunzipSync(new Uint8Array(row.content)))
  return true
}
