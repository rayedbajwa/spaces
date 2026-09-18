/**
 * Single-service mode: the web server and the supervisor in one container.
 *
 * Platforms such as Railway attach a persistent volume to exactly one
 * service, while Spaces needs the app and the workers to share /data (cloned
 * repositories, governing workspaces, agent sessions). This entry point runs
 * both as child processes of one service, forwards shutdown signals, and
 * exits when either child dies so the platform restarts the whole service.
 *
 *   bun run src/standalone.ts        (railway.json uses this start command)
 */

import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const srcDir = path.dirname(fileURLToPath(import.meta.url))
const children: Array<{ name: string; child: ChildProcess }> = []
let shuttingDown = false

function start(name: string, script: string): void {
  const child = spawn(process.execPath, ['run', path.join(srcDir, script)], {
    cwd: path.dirname(srcDir),
    env: process.env,
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  children.push({ name, child })
  child.on('exit', (code, signal) => {
    if (shuttingDown) return
    console.error(`[standalone] ${name} exited (${signal ?? `code ${code}`}); stopping the service so the platform restarts it`)
    void shutdown('child-exit', code ?? 1)
  })
  console.log(`[standalone] ${name} started (pid ${child.pid})`)
}

async function shutdown(reason: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[standalone] shutting down (${reason})`)
  for (const { child } of children) if (child.exitCode === null) child.kill('SIGTERM')
  // The supervisor gives its workers up to 15 s to re-queue or pause their runs.
  await Promise.all(children.map(({ child }) => new Promise<void>((resolve) => {
    if (child.exitCode !== null) return resolve()
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 25_000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
  })))
  process.exit(exitCode)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

// The server applies the database schema at boot; give it a head start so the
// supervisor's first queries see the tables on a fresh database.
start('server', 'server.ts')
setTimeout(() => { if (!shuttingDown) start('supervisor', 'supervisor.ts') }, Number(process.env.STANDALONE_SUPERVISOR_DELAY_MS ?? '4000'))
