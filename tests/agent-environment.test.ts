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
