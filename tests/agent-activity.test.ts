import { describe, expect, test } from 'bun:test'
import { createActivityLog, createLineStamper, createSecretRedactor, describeToolCall, redactSecrets } from '../src/lib/agent-activity'

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

describe('secret masking', () => {
  test('database URLs of any scheme, and exported connection strings', () => {
    const line = 'export DATABASE_URL="postgresql://postgres:MPBdzwutCaZnzhSxLbjk@postgres.railway.internal:5432/agent_db"'
    const out = redactSecrets(line)
    expect(out).not.toContain('MPBdzwutCaZnzhSxLbjk')
    expect(out).toContain('postgres.railway.internal')
    for (const url of ['mysql://app:hunter2secret@db:3306/x', 'redis://default:s3cretPass@cache:6379', 'mongodb+srv://u:p4ssw0rd@c.mongodb.net/db', 'amqp://guest:guestpass@mq//']) {
      expect(redactSecrets(url)).toMatch(/:\[redacted\]@/)
    }
  })

  test('query parameters, JSON keys, variable names, AWS keys, JWTs and private keys', () => {
    expect(redactSecrets('https://host/x?user=a&password=abc123&x=1')).toBe('https://host/x?user=a&password=[redacted]&x=1')
    expect(redactSecrets('{"password": "abc123", "user": "sam"}')).toBe('{"password": "[redacted]", "user": "sam"}')
    expect(redactSecrets('ENCRYPTION_KEY=0123456789abcdef PGPASSWORD=pw DB_PASS=x')).toBe('ENCRYPTION_KEY=[redacted] PGPASSWORD=[redacted] DB_PASS=[redacted]')
    expect(redactSecrets('AKIAABCDEFGHIJKLMNOP')).toBe('[redacted]')
    expect(redactSecrets('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U')).toBe('[redacted jwt]')
    expect(redactSecrets('-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----')).toBe('[redacted private key]')
  })

  test('ordinary text is left alone', () => {
    const text = 'Run bun test; DATABASE_URL points at /railway. See https://github.com/o/r/pull/4 and user=sam.'
    expect(redactSecrets(text)).toBe(text)
  })
})

describe('masking streamed text', () => {
  const secretLine = 'export DATABASE_URL="postgresql://postgres:MPBdzwutCaZnzhSx@db:5432/app" && eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U\n'

  test('a secret split across chunks at any point is masked', () => {
    for (let cut = 1; cut < secretLine.length; cut += 3) {
      const r = createSecretRedactor()
      const out = r.push(secretLine.slice(0, cut)) + r.push(secretLine.slice(cut)) + r.flush()
      expect(out).not.toContain('MPBdzwutCaZnzhSx')
      expect(out).not.toContain('dozjgNryP4J3jVmNHl0w5N')
    }
  })

  test('a private key block spanning lines and chunks is dropped whole', () => {
    const r = createSecretRedactor()
    const out = [
      'before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIB',
      'AAKCAQEA\nabcdef\n-----END RSA PRIVATE ',
      'KEY-----\nafter\n',
    ].map((c) => r.push(c)).join('') + r.flush()
    expect(out).toContain('before\n[redacted private key]')
    expect(out.endsWith('after\n')).toBe(true)
    for (const material of ['MIIEowIB', 'AAKCAQEA', 'abcdef']) expect(out).not.toContain(material)
  })

  test('a partial line waits for its newline or a flush', () => {
    const r = createSecretRedactor()
    expect(r.push('PGPASSWORD=hunt')).toBe('')
    expect(r.pending).toBe(true)
    expect(r.push('er2 psql\n')).toBe('PGPASSWORD=[redacted] psql\n')
    expect(r.push('tail without newline')).toBe('')
    expect(r.flush()).toBe('tail without newline')
  })

  test('the agent\'s own text in a task transcript is masked, even split across deltas', () => {
    const log = createActivityLog({ label: 'task T001', now: () => new Date('2026-09-23T03:41:05Z') })
    const out = [text('I will set PASSWORD=sup'), text('ersecret99 now.\nDone')].map((e) => log.onEvent(e) ?? '').join('') + log.flush()
    expect(out).not.toContain('supersecret99')
    expect(out).toBe('[03:41:05Z task T001] I will set PASSWORD=[redacted] now.\n[03:41:05Z task T001] Done')
  })
})
