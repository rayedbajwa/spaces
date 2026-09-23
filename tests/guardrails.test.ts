import { describe, expect, test } from 'bun:test'
import { AgentGuard, findSensitive, maskOutput } from '../src/lib/guardrails'

describe('detecting sensitive values', () => {
  test('personal data: emails, phones, SSNs, valid card numbers and IBANs', () => {
    const text = 'Contact jane.doe@acme.io or +1 (415) 555-0132; SSN 123-45-6789; card 4111 1111 1111 1111; IBAN GB82 WEST 1234 5698 7654 32'
    expect(findSensitive(text).map((s) => [s.kind, s.value])).toEqual([
      ['EMAIL', 'jane.doe@acme.io'],
      ['PHONE', '+1 (415) 555-0132'],
      ['SSN', '123-45-6789'],
      ['CARD', '4111 1111 1111 1111'],
      ['IBAN', 'GB82 WEST 1234 5698 7654 32'],
    ])
  })

  test('not personal data: git remotes, no-reply senders, versions, dates, ids, invalid card numbers', () => {
    const text = 'git@github.com:o/r.git noreply@anthropic.com v1.2.3 2026-09-23 12:30:45 build 4111111111111112 port 5432 uuid 6a77b944-cc4c-48e4-9f36-67ce08ba04bd'
    expect(findSensitive(text)).toEqual([])
  })

  test('secrets: connection string passwords, keys and NAME=value secrets, with the user kept', () => {
    const spans = findSensitive('DATABASE_URL="postgresql://postgres:MPBdzwutCaZnzhSx@db:5432/x" GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789')
    expect(spans.map((s) => [s.kind, s.value])).toEqual([['SECRET', 'MPBdzwutCaZnzhSx'], ['SECRET', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789']])
  })

  test('the allowlist keeps chosen values', () => {
    expect(findSensitive('support@acme.io', ['support@acme.io'])).toEqual([])
    expect(findSensitive('a@acme.io b@acme.io', [/@acme\.io$/])).toEqual([])
  })

  test('one-way masking for outputs', () => {
    expect(maskOutput('mail jane@acme.io, key sk-or-v1-abcdefghijklmnop1234')).toBe('mail [email], key [redacted]')
    expect(maskOutput('mail jane@acme.io', { mode: 'warn', allow: [] })).toBe('mail jane@acme.io')
  })
})

describe('an agent session\'s guard', () => {
  test('masks with stable tokens and restores them', () => {
    const guard = new AgentGuard()
    const masked = guard.mask('Email jane@acme.io, then jane@acme.io again; DB postgres://app:pw12345@db/x')
    expect(masked).toBe('Email <EMAIL_1>, then <EMAIL_1> again; DB postgres://app:<SECRET_1>@db/x')
    expect(guard.mask(masked)).toBe(masked) // tokens are left alone
    expect(guard.unmask('echo <EMAIL_1> && psql postgres://app:<SECRET_1>@db/x <EMAIL_9>')).toBe('echo jane@acme.io && psql postgres://app:pw12345@db/x <EMAIL_9>')
    expect(guard.counts).toMatchObject({ EMAIL: 1, SECRET: 1 })
    expect(guard.report()).toBe('[guardrails] 1 secret, 1 email kept from the model\n')
    expect(guard.report()).toBeUndefined()
  })

  test('warn mode counts but changes nothing; off does nothing', () => {
    const warn = new AgentGuard({ mode: 'warn', allow: [] })
    expect(warn.mask('jane@acme.io')).toBe('jane@acme.io')
    expect(warn.counts.EMAIL).toBe(1)
    const off = new AgentGuard({ mode: 'off', allow: [] })
    expect(off.mask('jane@acme.io')).toBe('jane@acme.io')
    expect(off.counts.EMAIL).toBe(0)
  })

  test('every value of a secret file is a secret, whatever its name', () => {
    const guard = new AgentGuard()
    expect(guard.maskSecretFile('APP_ID=12345\nexport REGION="us-east-1"\n# comment\n')).toBe('APP_ID=<SECRET_1>\nexport REGION=<SECRET_2>\n# comment\n')
  })

  test('strict mode blocks secret files and environment dumps, not ordinary work', () => {
    const guard = new AgentGuard({ mode: 'strict', allow: [] })
    expect(guard.blockReason('read', { path: '/w/app/.env' })).toContain('strict mode')
    expect(guard.blockReason('bash', { command: 'cat .env.production | grep DB' })).toContain('strict mode')
    expect(guard.blockReason('bash', { command: 'printenv' })).toContain('strict mode')
    expect(guard.blockReason('bash', { command: 'env | sort' })).toContain('strict mode')
    expect(guard.blockReason('read', { path: 'keys/server.pem' })).toContain('strict mode')
    expect(guard.blockReason('read', { path: '.env.example' })).toBeUndefined()
    expect(guard.blockReason('bash', { command: 'bun test && env NODE_ENV=test bun run build' })).toBeUndefined()
    expect(guard.blockReason('bash', { command: 'psql "$DATABASE_URL" -c "select 1"' })).toBeUndefined()
    expect(new AgentGuard().blockReason('read', { path: '.env' })).toBeUndefined()
  })

  test('installed on a session: provider requests are masked, tool calls get real values, secret files are tokenized', async () => {
    const guard = new AgentGuard()
    let sent: { systemPrompt?: string; messages?: unknown[] } | undefined
    let ran: Record<string, unknown> | undefined
    const agent = {
      streamFn: (_model: unknown, context: { systemPrompt?: string; messages?: unknown[] }) => { sent = context; return 'stream' },
      beforeToolCall: async (ctx: { args: unknown }) => { ran = ctx.args as Record<string, unknown>; return undefined },
      afterToolCall: undefined as unknown,
    }
    guard.install({ agent })
    const history = [
      { role: 'user', content: 'Fix the signup for jane@acme.io' },
      { role: 'toolResult', content: [{ type: 'text', text: 'DATABASE_URL=postgres://u:secretpw1@h/db' }] },
      { role: 'assistant', content: [{ type: 'toolCall', name: 'bash', arguments: { command: 'echo <EMAIL_1>' } }] },
    ]
    expect((agent.streamFn as (m: unknown, c: unknown) => unknown)('model', { systemPrompt: 'Owner: sam@acme.io', messages: history })).toBe('stream')
    expect(JSON.stringify(sent)).not.toContain('jane@acme.io')
    expect(JSON.stringify(sent)).not.toContain('secretpw1')
    expect(JSON.stringify(sent)).not.toContain('sam@acme.io')
    expect((history[0] as { content: string }).content).toBe('Fix the signup for jane@acme.io') // the session's own history is untouched
    const jane = guard.mask('jane@acme.io') // the token the model was given for her
    expect(JSON.stringify(sent)).toContain(jane)
    const args = { command: `git log --author=${jane}` }
    await (agent.beforeToolCall as unknown as (c: unknown) => Promise<unknown>)({ toolCall: { name: 'bash' }, args })
    expect(ran).toEqual({ command: 'git log --author=jane@acme.io' })
    const after = await (agent.afterToolCall as (c: unknown) => Promise<{ content: Array<{ text: string }> }>)({ toolCall: { name: 'read' }, args: { path: '.env' }, result: { content: [{ type: 'text', text: 'REGION=us-east-1\n' }] }, isError: false })
    expect(after.content[0]!.text).toMatch(/^REGION=<SECRET_\d+>\n$/)
  })
})
