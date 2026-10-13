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
 *
 * SPACES_ROLE (specs/014-project-workers) picks what runs: `all` (default) the
 * server and the supervisor; `web` the server only (no workspace disk);
 * `project` the server for one project plus that project's worker, which never
 * idles out (the platform sleeps the whole service instead).
 */

import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { drainBudget } from './lib/drain'

const srcDir = path.dirname(fileURLToPath(import.meta.url))
const children: Array<{ name: string; child: ChildProcess }> = []
let shuttingDown = false

function start(name: string, script: string, env: Record<string, string> = {}): void {
  const child = spawn(process.execPath, ['run', path.join(srcDir, script)], {
    cwd: path.dirname(srcDir),
    env: { ...process.env, ...env },
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

function stop(child: ChildProcess, signal: NodeJS.Signals, waitMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, waitMs)
    child.once('exit', () => { clearTimeout(timer); resolve() })
    child.kill(signal)
  })
}

async function shutdown(reason: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  const budget = drainBudget()
  const waitMs = reason === 'SIGTERM' ? budget.standaloneMs : 25_000
  console.log(`[standalone] shutting down (${reason}); waiting up to ${Math.round(waitMs / 1000)}s for workers`)
  // Workers first: with a drain budget they finish their running stages, and the
  // server keeps serving (the old version) until they are gone.
  const workers = children.filter((c) => c.name !== 'server').map((c) => c.child)
  const server = children.find((c) => c.name === 'server')?.child
  await Promise.all(workers.map((child) => stop(child, reason === 'SIGINT' ? 'SIGINT' : 'SIGTERM', waitMs)))
  if (server) await stop(server, 'SIGTERM', 5_000)
  process.exit(exitCode)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

// The server applies the database schema at boot; give it a head start so the
// supervisor's first queries see the tables on a fresh database.
const role = process.env.SPACES_ROLE?.trim().toLowerCase()
start('server', 'server.ts')
if (role !== 'web') {
  setTimeout(() => {
    if (shuttingDown) return
    if (role === 'project') {
      const projectId = process.env.WORKER_PROJECT_ID?.trim() ?? ''
      start('worker', 'worker.ts', { WORKER_PROJECT_ID: projectId, WORKER_IDLE_EXIT_SECONDS: '0' })
    } else {
      start('supervisor', 'supervisor.ts')
    }
  }, Number(process.env.STANDALONE_SUPERVISOR_DELAY_MS ?? '4000'))
}
