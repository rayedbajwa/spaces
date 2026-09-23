import { describe, expect, test } from 'bun:test'
import { createActivityLog, createLineStamper, describeToolCall, redactSecrets } from '../src/lib/agent-activity'

const text = (delta: string) => ({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } })
const start = (id: string, toolName: string, args: unknown) => ({ type: 'tool_execution_start', toolCallId: id, toolName, args })
const end = (id: string, toolName: string, output: string, isError = false) => ({ type: 'tool_execution_end', toolCallId: id, toolName, isError, result: { content: [{ type: 'text', text: output }] } })

const at = () => new Date('2026-09-23T03:41:05Z')

function play(events: Array<{ type: string }>, label?: string): string {
  const log = createActivityLog(label ? { label, now: at } : {})
  return events.map((e) => log.onEvent(e) ?? '').join('')
}

describe('agent activity log', () => {
  test('the agent\'s text, then a line per tool call and how a command ended', () => {
    const out = play([
      text('Now T002 — add unit tests.'),
      start('1', 'edit', { path: 'tests/version.test.ts' }),
      end('1', 'edit', 'Edited'),
      start('2', 'bash', { command: 'bun test tests/version.test.ts' }),
      end('2', 'bash', 'running…\n\n 9 pass\n 3 fail\n'),
      text('\nT002 red confirmed.\n'),
      start('3', 'bash', { command: 'docker build .' }),
      end('3', 'bash', 'docker: command not found', true),
    ])
    const lines = out.split('\n')
    expect(lines[0]).toBe('Now T002 — add unit tests.')
    expect(lines[1]).toBe('▸ edit tests/version.test.ts')
    expect(lines[2]).toBe('▸ $ bun test tests/version.test.ts')
    expect(lines[3]).toMatch(/^ {2}✓ \d+ms · 3 fail$/)
    expect(lines[4]).toBe('')
    expect(lines[5]).toBe('T002 red confirmed.')
    expect(lines[6]).toBe('▸ $ docker build .')
    expect(lines[7]).toMatch(/^ {2}✗ \d+ms · docker: command not found$/)
  })

  test('describes each tool briefly', () => {
    expect(describeToolCall('read', { path: 'src/a.ts', offset: 40 })).toBe('read src/a.ts (from line 40)')
    expect(describeToolCall('grep', { pattern: 'TODO', path: 'src' })).toBe('grep "TODO" in src')
    expect(describeToolCall('ls', {})).toBe('ls .')
    expect(describeToolCall('search_knowledge', { query: 'auth flow', limit: 5 })).toBe('search_knowledge query=auth flow limit=5')
    expect(describeToolCall('bash', { command: `echo ${'x'.repeat(300)}` }).length).toBeLessThanOrEqual(162)
  })

  test('masks credentials in commands and outputs', () => {
    const out = play([
      start('1', 'bash', { command: 'git push https://x-access-token:ghs_abcdefghijklmnopqrstuvwxyz0123@github.com/o/r.git' }),
      end('1', 'bash', 'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 set'),
    ])
    expect(out).not.toContain('ghs_abcdefghijklmnopqrstuvwxyz0123')
    expect(out).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
    expect(redactSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz')).toBe('Authorization: Bearer [redacted]')
    expect(redactSecrets('OPENROUTER_API_KEY=sk-or-v1-abcdef1234567890abcdef')).toBe('OPENROUTER_API_KEY=[redacted]')
  })

  test('a sub-agent\'s lines are stamped with the time and its name', () => {
    const out = play([text('Starting the API work.\nReading'), text(' the plan.\n'), start('1', 'read', { path: 'plan.md' })], 'WS-1 API')
    expect(out).toBe('[03:41:05Z WS-1 API] Starting the API work.\n[03:41:05Z WS-1 API] Reading the plan.\n[03:41:05Z WS-1 API] ▸ read plan.md\n')
  })

  test('the run log stamper marks each line where it begins, with the current agent, and keeps stamps already there', () => {
    let agent = 'spaces'
    const stamper = createLineStamper({ label: () => agent, now: at })
    let out = stamper.stamp('[setup] ready\nI\'ll start')
    agent = 'implement/developer'
    out += stamper.stamp(' by reading.\n\n')
    out += stamper.stamp('[03:41:05Z WS-1] mirrored line\n')
    out += stamper.stamp('▸ $ bun test\n')
    expect(out).toBe([
      '[03:41:05Z spaces] [setup] ready',
      "[03:41:05Z spaces] I'll start by reading.",
      '',
      '[03:41:05Z WS-1] mirrored line',
      '[03:41:05Z implement/developer] ▸ $ bun test',
      '',
    ].join('\n'))
  })
})
