import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createAgentSession, SessionManager } from '@earendil-works/pi-coding-agent'
import { createAgentSettings } from '../src/lib/agent-resources'

describe('an agent\'s shell', () => {
  test('never sees Spaces\' database, encryption key or provider keys; ordinary variables pass', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'shell-'))
    const saved = { ...process.env }
    Object.assign(process.env, { DATABASE_URL: 'postgres://prod:pw@db/railway', ENCRYPTION_KEY: 'k', OPENROUTER_API_KEY: 'sk-or-x', PGPASSWORD: 'pw', SOME_APP_SECRET: 's', HARMLESS_VAR: 'visible' })
    try {
      const { session } = await createAgentSession({ settingsManager: createAgentSettings(cwd), cwd, tools: ['bash'], sessionManager: SessionManager.inMemory(cwd) })
      const bash = (session.agent as unknown as { state: { tools: Array<{ name: string; execute: (id: string, args: unknown) => Promise<{ content: Array<{ text?: string }> }> }> } }).state.tools.find((t) => t.name === 'bash')!
      const result = await bash.execute('t1', { command: 'echo "db=${DATABASE_URL:-unset} key=${ENCRYPTION_KEY:-unset} or=${OPENROUTER_API_KEY:-unset} pg=${PGPASSWORD:-unset} s=${SOME_APP_SECRET:-unset} h=${HARMLESS_VAR:-unset}"' })
      expect(result.content.map((c) => c.text ?? '').join('')).toContain('db=unset key=unset or=unset pg=unset s=unset h=visible')
      session.dispose()
    } finally {
      for (const k of ['DATABASE_URL', 'ENCRYPTION_KEY', 'OPENROUTER_API_KEY', 'PGPASSWORD', 'SOME_APP_SECRET', 'HARMLESS_VAR']) delete process.env[k]
      Object.assign(process.env, saved)
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
