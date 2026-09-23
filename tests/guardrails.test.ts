import { describe, expect, test } from 'bun:test'
import { AgentGuard, findSensitive, isSecretFileName, maskOutput, redactSecretValues } from '../src/lib/guardrails'

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
    expect(guard.maskSecretFile('APP_ID=12345\nexport REGION="us-east-1"\n# comment\n')).toBe('APP_ID=<SECRET_1>\nexport REGION="<SECRET_2>"\n# comment\n')
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
      streamFunction: (_model: unknown, context: { systemPrompt?: string; messages?: unknown[] }) => { sent = context; return 'stream' },
      beforeToolCall: async (ctx: { args: unknown }) => { ran = ctx.args as Record<string, unknown>; return undefined },
      afterToolCall: undefined as unknown,
    }
    let prompted = ''
    const session = { agent, prompt: async (text: string) => { prompted = text } }
    guard.install(session)
    await session.prompt('Call +1 415 555 0132 about it')
    expect(prompted).toMatch(/^Call <PHONE_\d+> about it$/)
    const history = [
      { role: 'user', content: 'Fix the signup for jane@acme.io' },
      { role: 'toolResult', content: [{ type: 'text', text: 'DATABASE_URL=postgres://u:secretpw1@h/db' }] },
      { role: 'assistant', content: [{ type: 'toolCall', name: 'bash', arguments: { command: 'echo <EMAIL_1>' } }] },
    ]
    expect((agent.streamFunction as (m: unknown, c: unknown) => unknown)('model', { systemPrompt: 'Owner: sam@acme.io', messages: history })).toBe('stream')
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

  test('tool results are masked as they enter the history', async () => {
    const guard = new AgentGuard()
    const agent = { streamFunction: () => undefined, beforeToolCall: undefined as unknown, afterToolCall: undefined as unknown }
    guard.install({ agent })
    const after = await (agent.afterToolCall as (c: unknown) => Promise<{ content: Array<{ text: string }> }>)({ toolCall: { name: 'bash' }, args: { command: 'git log -1' }, result: { content: [{ type: 'text', text: 'Author: Jane <jane@acme.io>' }] }, isError: false })
    expect(after.content[0]!.text).toBe('Author: Jane <<EMAIL_1>>')
  })

  test('a resumed run maps its tokens to the same values', () => {
    const first = new AgentGuard()
    first.mask('jane@acme.io and postgres://a:pw123456@h/db')
    const vault = first.exportVault()
    const resumed = new AgentGuard(undefined, vault)
    expect(resumed.unmask('<EMAIL_1> <SECRET_1>')).toBe('jane@acme.io pw123456')
    expect(resumed.mask('bob@acme.io')).toBe('<EMAIL_2>')
  })

  test('masks every text field of a request (system prompt sections included), never structural ones', () => {
    const guard = new AgentGuard()
    const context = {
      messages: [
        { role: 'system', content: '', sections: { preamble: 'You help.', projectContext: 'Owner: sam@acme.io' } },
        { role: 'assistant', content: [{ type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'mail sam@acme.io' } }] },
      ],
    }
    const masked = guard.maskContext(context)
    expect(JSON.stringify(masked)).not.toContain('sam@acme.io')
    expect((masked.messages[1] as { content: Array<{ id: string; name: string }> }).content[0]).toMatchObject({ id: 'call_1', name: 'bash' })
    expect(Object.keys(masked)).toEqual(['messages']) // nothing added
  })
})

describe('review of #44: detection gaps', () => {
  const secrets = (text: string) => findSensitive(text).filter((s) => s.kind === 'SECRET').map((s) => s.value)

  test('connection strings with an empty user', () => {
    expect(secrets('redis://:s3cretPass@cache:6379/0')).toEqual(['s3cretPass'])
    expect(redactSecretValues('redis://:s3cretPass@cache:6379/0')).toBe('redis://:[redacted]@cache:6379/0')
  })

  test('lower-case names with literal values, not code', () => {
    expect(secrets('password=supersecret api_key=abc123 db_pass="p4ss word"')).toEqual(['supersecret', 'abc123', 'p4ss word'])
    expect(secrets('password = "hunter2"')).toEqual(['hunter2'])
    expect(secrets('const password = req.body.password; if (token == other) {}; bypass=1; author=jane; tokens=5')).toEqual([])
    expect(secrets('PGPASSWORD=pw DB_PASS=x ENCRYPTION_KEY=abc BYPASS=yes')).toEqual(['pw', 'x', 'abc'])
  })

  test('YAML and JSON keys, quoted or bare, but not types or expressions', () => {
    expect(secrets('password: abc123\nclient_secret: s3cr3t\n"token": "t0k3n"')).toEqual(['abc123', 's3cr3t', 't0k3n'])
    expect(secrets('interface Login { password: string; token: string | null }\nconst c = { password: this.password, token: process.env.TOKEN }')).toEqual([])
  })

  test('secret files by their whole name, whatever the extension; not source code', () => {
    for (const name of ['.env', '.env.production', 'credentials', 'credentials.yaml', 'credentials-prod', 'app.secrets.txt', 'k8s-secret.yaml', 'server.pem', 'id_ed25519', '.pgpass', '.npmrc', '/home/u/.git-credentials']) expect([name, isSecretFileName(name)]).toEqual([name, true])
    for (const name of ['.env.example', 'secrets.ts', 'secret-manager.py', 'id_rsa.pub', 'README.md', 'credentials.test.ts']) expect([name, isSecretFileName(name)]).toEqual([name, false])
  })

  test('strict mode blocks printenv with names, keeps env NAME=value command', () => {
    const guard = new AgentGuard({ mode: 'strict', allow: [] })
    expect(guard.blockReason('bash', { command: 'printenv DATABASE_URL' })).toContain('strict mode')
    expect(guard.blockReason('bash', { command: 'echo x && printenv -0' })).toContain('strict mode')
    expect(guard.blockReason('bash', { command: 'cat /proc/self/environ' })).toContain('strict mode')
    expect(guard.blockReason('bash', { command: 'cat app.secrets.txt' })).toContain('strict mode')
    expect(guard.blockReason('bash', { command: 'env NODE_ENV=test bun test' })).toBeUndefined()
    expect(guard.blockReason('bash', { command: 'grep -r "printenvironment" docs' })).toBeUndefined()
  })

  test('secret files in other layouts, and the allowlist inside them', () => {
    const guard = new AgentGuard({ mode: 'mask', allow: ['us-east-1'] })
    expect(guard.maskSecretFile('db.internal:5432:app:app_user:Pg$ecret\n', '/home/u/.pgpass')).toBe('db.internal:5432:app:app_user:<SECRET_1>\n')
    expect(guard.maskSecretFile('//registry.npmjs.org/:_authToken=npm_abcdef\n', '.npmrc')).not.toContain('npm_abcdef')
    expect(guard.maskSecretFile('[default]\naws_secret_access_key = wJalrXUtnFEMI\nregion: us-east-1\n', 'credentials')).toBe('[default]\naws_secret_access_key = <SECRET_3>\nregion: us-east-1\n')
    expect(guard.maskSecretFile('{\n  "clientSecret": "abc",\n  "nested": {\n}\n', 'credentials.json')).toContain('"clientSecret": "<SECRET_4>",')
  })
})
