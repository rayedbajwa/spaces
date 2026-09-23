import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { log } from './logger'

/**
 * Keeping long work from holding the machine.
 *
 * A test run, a container build or a server someone forgot to stop can hold a
 * worker — and the slot other projects wait for — until a person notices. Two
 * limits apply to every agent:
 * - each shell command has a maximum run time (AGENT_COMMAND_TIMEOUT_SECONDS,
 *   default 20 minutes): a longer or missing timeout is capped before it runs;
 * - when a code stage ends, what it left running is stopped: anything still
 *   listening on the checkout's test port, and the checkout's Docker Compose
 *   containers.
 */

const run = promisify(execFile)
const limitLog = log.child({ mod: 'stage-limits' })

export function commandTimeLimitSeconds(): number {
  const configured = Number(process.env.AGENT_COMMAND_TIMEOUT_SECONDS)
  return Number.isFinite(configured) && configured >= 60 ? Math.floor(configured) : 20 * 60
}

/** Cap every bash command's timeout on this session (chained with any hook already installed). */
export function installCommandTimeLimit(session: { agent: unknown }, seconds = commandTimeLimitSeconds()): void {
  const agent = session.agent as {
    beforeToolCall?: (ctx: { toolCall: { name: string }; args: unknown }, signal?: AbortSignal) => Promise<{ block?: boolean; reason?: string } | undefined>
  }
  const before = agent.beforeToolCall
  agent.beforeToolCall = async (ctx, signal) => {
    if (ctx.toolCall.name === 'bash' && ctx.args && typeof ctx.args === 'object') {
      const args = ctx.args as { timeout?: number }
      if (typeof args.timeout !== 'number' || !(args.timeout > 0) || args.timeout > seconds) args.timeout = seconds
    }
    return before ? before(ctx, signal) : undefined
  }
}

async function output(command: string, args: string[]): Promise<string> {
  return await run(command, args, { timeout: 15_000 }).then((r) => String(r.stdout).trim()).catch(() => '')
}

/** Process ids listening on a TCP port (lsof, else fuser); empty when neither tool can tell. */
export async function listenersOn(port: number): Promise<number[]> {
  const fromLsof = await output('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'])
  const text = fromLsof || await output('fuser', [`${port}/tcp`])
  return [...new Set(text.split(/\s+/).map(Number).filter((pid) => Number.isInteger(pid) && pid > 1 && pid !== process.pid))]
}

/**
 * Stop what a stage left running: the app on the test port, and the
 * checkout's Compose containers. Returns what was stopped, for the run log.
 */
export async function stopStageLeftovers(input: { testPort: number; containerProjects: string[]; docker: boolean }): Promise<string[]> {
  const stopped: string[] = []
  const pids = await listenersOn(input.testPort)
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); stopped.push(`process ${pid} on port ${input.testPort}`) } catch { /* already gone */ }
  }
  if (pids.length) {
    await new Promise((r) => setTimeout(r, 2000))
    for (const pid of await listenersOn(input.testPort)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
  }
  if (input.docker) {
    for (const project of new Set(input.containerProjects)) {
      const ids = (await output('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`])).split(/\s+/).filter(Boolean)
      if (!ids.length) continue
      await output('docker', ['rm', '-f', ...ids])
      stopped.push(`${ids.length} container${ids.length === 1 ? '' : 's'} of ${project}`)
    }
  }
  if (stopped.length) limitLog.info('stopped what a stage left running', { stopped })
  return stopped
}
