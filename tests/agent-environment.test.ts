import { describe, expect, test } from 'bun:test'
import { renderAgentEnvironment, type AgentEnvironment } from '../src/lib/agent-environment'

/**
 * Agents decide what they can verify from this description, so it has to be
 * unambiguous about what exists and what to use instead when it does not.
 */

const base: AgentEnvironment = { docker: false, dockerCompose: false, psql: false, testPort: 3100 }

describe('agent environment description', () => {
  test('a full machine invites the agent to use everything', () => {
    const text = renderAgentEnvironment({
      ...base,
      docker: true,
      dockerCompose: true,
      psql: true,
      browser: '/ms-playwright/chromium-1234/chrome-linux/chrome',
      testDatabaseUrl: 'postgres://user:pw@db:5432/agent_spaces',
    })
    expect(text).toContain('Docker**: available with `docker compose`')
    expect(text).toContain('agent_spaces')
    expect(text).toContain('PORT=3100')
    expect(text).toContain('/ms-playwright/chromium-1234/chrome-linux/chrome')
  })

  test('without Docker it names the reason and points at the database instead', () => {
    const text = renderAgentEnvironment({ ...base, dockerDetail: 'docker is not installed here', testDatabaseUrl: 'postgres://user:pw@db:5432/agent_x' })
    expect(text).toContain('docker is not installed here')
    expect(text).toContain('Do not try `docker compose up`')
    expect(text).toContain('agent_x')
  })

  test('with nothing available it tells the agent to skip rather than fail', () => {
    const text = renderAgentEnvironment(base)
    expect(text).toContain('expected to skip')
    expect(text).not.toContain('undefined')
  })

  test('never suggests the port serving the application', () => {
    expect(renderAgentEnvironment(base)).toContain('Port 3000 is taken')
  })
})

describe('checkout environment', () => {
  test('points the checkout at the assigned database and port', async () => {
    const { mkdtemp, readFile, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const path = await import('node:path')
    const { prepareCheckoutEnvironment } = await import('../src/lib/agent-environment')

    const dir = await mkdtemp(path.join(tmpdir(), 'checkout-'))
    await writeFile(path.join(dir, '.env.example'), 'DATABASE_URL=postgres://user:pw@localhost:5432/dev\n# PORT=3000\nENCRYPTION_KEY=\nUNRELATED=keep-me\n')

    const applied = await prepareCheckoutEnvironment(dir, {
      docker: false, dockerCompose: false, psql: true, testPort: 3123,
      testDatabaseUrl: 'postgres://user:pw@localhost:5432/agent_thing',
    })
    const written = await readFile(path.join(dir, '.env'), 'utf8')

    expect(applied.sort()).toEqual(['DATABASE_URL', 'ENCRYPTION_KEY', 'PORT'])
    expect(written).toContain('DATABASE_URL=postgres://user:pw@localhost:5432/agent_thing')
    expect(written).toContain('PORT=3123')
    expect(written).toContain('UNRELATED=keep-me')
    expect(written).not.toContain('ENCRYPTION_KEY=\n')
  })

  test('leaves a project own values alone and sets nothing it does not declare', async () => {
    const { mkdtemp, readFile, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const path = await import('node:path')
    const { prepareCheckoutEnvironment } = await import('../src/lib/agent-environment')

    const dir = await mkdtemp(path.join(tmpdir(), 'checkout-'))
    await writeFile(path.join(dir, '.env.example'), 'API_TOKEN=\n')
    await writeFile(path.join(dir, '.env'), 'API_TOKEN=mine\n')

    const applied = await prepareCheckoutEnvironment(dir, {
      docker: false, dockerCompose: false, psql: false, testPort: 3123,
      testDatabaseUrl: 'postgres://user:pw@localhost:5432/agent_thing',
    })
    expect(applied).toEqual([])
    expect(await readFile(path.join(dir, '.env'), 'utf8')).toBe('API_TOKEN=mine\n')
  })

  test('evidence rules name the assigned database and forbid the ambient one', async () => {
    const { evidenceRules } = await import('../src/lib/agent-environment')
    const text = evidenceRules({ docker: false, dockerCompose: false, psql: false, testPort: 3100, testDatabaseUrl: 'postgres://u:p@h:5432/agent_x' })
    expect(text).toContain('agent_x')
    expect(text).toContain("belongs to the application running you")
    expect(text).toContain('committed with the work')
  })
})
