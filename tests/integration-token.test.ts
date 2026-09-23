import { describe, expect, test } from 'bun:test'
import { KIND_PROVIDER, tokenExpiresSoon, withExpiry } from '../src/lib/integration-token'

describe('integration tokens', () => {
  test('withExpiry records an absolute expiry from expires_in', () => {
    const at = Date.parse('2026-09-18T12:00:00Z')
    const t = withExpiry({ access_token: 'a', expires_in: 28800 }, at)
    expect(t.expires_at).toBe('2026-09-18T20:00:00.000Z')
    expect(withExpiry({ access_token: 'a' }).expires_at).toBeUndefined()
    expect(withExpiry({ access_token: 'a', expires_in: 0 }).expires_at).toBeUndefined()
  })

  test('tokens are treated as expiring shortly before the deadline', () => {
    expect(tokenExpiresSoon({ expires_at: new Date(Date.now() + 30_000).toISOString() })).toBe(true)
    expect(tokenExpiresSoon({ expires_at: new Date(Date.now() + 3_600_000).toISOString() })).toBe(false)
    expect(tokenExpiresSoon({ access_token: 'never-expires' })).toBe(false)
    expect(tokenExpiresSoon(undefined)).toBe(false)
  })

  test('Jira and Confluence share the Atlassian app', () => {
    expect(KIND_PROVIDER.jira).toBe('atlassian')
    expect(KIND_PROVIDER.confluence).toBe('atlassian')
    expect(KIND_PROVIDER.github).toBe('github')
    expect(KIND_PROVIDER.figma).toBe('figma')
  })
})
