import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { forgetAgentEnvironment, freePortFor } from '../src/lib/agent-environment'
import { installCommandTimeLimit, listenersOn, stopStageLeftovers } from '../src/lib/stage-limits'
import { testTierInstruction } from '../src/lib/test-tiers'

describe('keeping long work from holding the machine', () => {
  test('checkouts get different test ports, and a port is not handed out twice', async () => {
    forgetAgentEnvironment()
    const a = await freePortFor('spaces-3f701200')
    const b = await freePortFor('run-api-governance')
    const again = await freePortFor('spaces-3f701200')
    expect(a).not.toBe(b)
    expect(again).not.toBe(a) // reserved: the first is still "in use"
    for (const p of [a, b, again]) expect(p >= 3100 && p < 3900).toBe(true)
    forgetAgentEnvironment()
  })

  test('each stage is told which tests to run', () => {
    expect(testTierInstruction('implement', { testPort: 3456 })).toContain('only what you changed')
    expect(testTierInstruction('implement', { testPort: 3456 })).toContain('Do not run the whole suite')
    expect(testTierInstruction('review', { testPort: 3456 })).toContain('the full suite, once')
    expect(testTierInstruction('verify', { testPort: 3456 })).toContain('PORT=3456')
    expect(testTierInstruction('plan', { testPort: 3456 })).toBe('')
  })

  test("a shell command's timeout is capped, a shorter one kept", async () => {
    let seen: unknown
    const agent = { beforeToolCall: async (ctx: { args: unknown }) => { seen = ctx.args; return undefined } }
    installCommandTimeLimit({ agent }, 600)
    const call = (args: object) => (agent.beforeToolCall as unknown as (c: unknown) => Promise<unknown>)({ toolCall: { name: 'bash' }, args })
    await call({ command: 'bun test' }); expect(seen).toEqual({ command: 'bun test', timeout: 600 })
    await call({ command: 'x', timeout: 5000 }); expect(seen).toEqual({ command: 'x', timeout: 600 })
    await call({ command: 'y', timeout: 30 }); expect(seen).toEqual({ command: 'y', timeout: 30 })
  })

  test('a server left on the test port is stopped when the stage ends', async () => {
    const port = 3990
    const server = spawn(process.execPath, ['-e', `Bun.serve({ port: ${port}, fetch: () => new Response('ok') }); setInterval(() => {}, 1000)`], { stdio: 'ignore', detached: true })
    for (let i = 0; i < 50 && (await listenersOn(port)).length === 0; i++) await new Promise((r) => setTimeout(r, 100))
    if ((await listenersOn(port)).length === 0) { server.kill('SIGKILL'); return } // no lsof/fuser here: nothing to assert
    const stopped = await stopStageLeftovers({ testPort: port, containerProjects: [], docker: false })
    expect(stopped.join(' ')).toContain(`on port ${port}`)
    expect(await listenersOn(port)).toEqual([])
  }, 20_000)
})
