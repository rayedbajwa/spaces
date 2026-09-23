import { test, expect, describe } from 'bun:test'
import { beginAuthorization, consumeState, type OAuthProviderConfig, PROVIDER_TEMPLATES } from '../src/lib/oauth'

/**
 * The oauth module holds a module-level `pendingStates` Map. Every test here
 * generates its own state token (via beginAuthorization) so ordering does not
 * matter as long as we do not reuse the same state string across tests.
 */

function makeConfig(overrides: Partial<OAuthProviderConfig> = {}): OAuthProviderConfig {
  return {
    provider: 'test-provider',
    authorizeUrl: 'https://example.com/authorize',
    tokenUrl: 'https://example.com/token',
    clientId: 'test-client-id-123',
    clientSecret: 'test-client-secret-shhh',
    scopes: ['read:things', 'write:things', 'offline_access'],
    ...overrides,
  }
}

describe('beginAuthorization: redirect URL contents', () => {
  test('contains client_id, encoded callback URL, state, and all scopes', () => {
    const cfg = makeConfig()
    const callbackUrl = 'https://app.example.com/oauth/callback?src=web'
    const { redirectUrl, state } = beginAuthorization(cfg, 'project-xyz', callbackUrl)

    // state is non-empty and used later
    expect(state.length).toBeGreaterThan(0)

    const url = new URL(redirectUrl)
    expect(url.origin + url.pathname).toBe(cfg.authorizeUrl)

    // Parse the query string so we assert on decoded values.
    expect(url.searchParams.get('client_id')).toBe(cfg.clientId)
    expect(url.searchParams.get('redirect_uri')).toBe(callbackUrl)
    expect(url.searchParams.get('state')).toBe(state)
    expect(url.searchParams.get('response_type')).toBe('code')

    // Also check the raw string carries a URL-encoded callback so consumers
    // that read redirectUrl as text see it encoded.
    expect(redirectUrl).toContain(encodeURIComponent(callbackUrl))

    const scopeParam = url.searchParams.get('scope') ?? ''
    for (const s of cfg.scopes) {
      expect(scopeParam.split(' ')).toContain(s)
    }
  })

  test('propagates extraAuthorizeParams into the URL', () => {
    const cfg = makeConfig({
      extraAuthorizeParams: { audience: 'api.example.com', prompt: 'consent' },
    })
    const { redirectUrl } = beginAuthorization(cfg, 'p1', 'https://cb.example.com/cb')
    const url = new URL(redirectUrl)
    expect(url.searchParams.get('audience')).toBe('api.example.com')
    expect(url.searchParams.get('prompt')).toBe('consent')
  })
})

describe('consumeState: single-use + missing lookup', () => {
  test('state can be consumed exactly once — second call returns undefined', () => {
    const cfg = makeConfig()
    const { state } = beginAuthorization(cfg, 'project-abc', 'https://cb.example.com/cb')

    const first = consumeState(state)
    expect(first).toBeDefined()
    expect(first?.state).toBe(state)
    expect(first?.projectId).toBe('project-abc')
    expect(first?.provider).toBe(cfg.provider)
    expect(typeof first?.createdAt).toBe('number')

    const second = consumeState(state)
    expect(second).toBeUndefined()
  })

  test("consumeState('nonexistent') returns undefined without throwing", () => {
    expect(() => consumeState('this-state-was-never-issued-xyz')).not.toThrow()
    expect(consumeState('another-missing-state-abc')).toBeUndefined()
  })
})

/**
 * Expiry test: the module does not export `pendingStates` or a clock hook, so
 * we cannot cleanly manipulate `createdAt` from outside without reaching into
 * private state. We skip with a note so future readers know why and can wire
 * a test hook if they choose to expose one.
 */
test.skip('expired state (older than 10 min) is not returned — skipped: no exported hook to backdate createdAt or advance clock', () => {
  // To enable this: export `pendingStates` (or a `__setNow` hook) from oauth.ts.
  // Then set createdAt = Date.now() - 11 * 60_000 and assert consumeState returns undefined.
})

describe('Figma provider template: granular OAuth scopes', () => {
  const figma = PROVIDER_TEMPLATES.figma
  const expectedScopes = ['file_content:read', 'library_content:read', 'current_user:read']

  test('scopes request exactly the granular read-only scopes (no legacy scope)', () => {
    expect(figma.scopes).toEqual(expectedScopes)
  })

  test('scopes cover file/node contents, published styles/components, and identity', () => {
    expect(figma.scopes).toContain('file_content:read') // /files/:key + /nodes
    expect(figma.scopes).toContain('library_content:read') // /styles + /components
    expect(figma.scopes).toContain('current_user:read') // /v1/me identity check
  })

  // The pre-fix scope list was ['files:read', 'file_variables:read']. The first fix
  // removed only the Enterprise-only file_variables:read; this fix also replaces the
  // deprecated files:read umbrella scope with Figma's granular equivalents.
  const removedScopes = ['files:read', 'file_variables:read']
  for (const scope of removedScopes) {
    test(`scopes exclude the deprecated/Enterprise-only scope ${scope}`, () => {
      expect(figma.scopes).not.toContain(scope)
    })
  }

  test('scopes exclude any deprecated file_read identifier', () => {
    expect(figma.scopes.some((s) => s.includes('file_read'))).toBe(false)
    expect(figma.scopes.some((s) => s.includes('files:read'))).toBe(false)
  })

  test('notes name the granular scopes to enable', () => {
    for (const scope of expectedScopes) {
      expect(figma.notes ?? '').toContain(scope)
    }
  })

  test('notes do not advertise the legacy files:read or Enterprise-only file_variables:read', () => {
    expect(figma.notes ?? '').not.toContain('files:read')
    expect(figma.notes ?? '').not.toContain('file_variables:read')
  })

  test('the Figma authorization URL requests the granular scopes only', () => {
    const figmaConfig: OAuthProviderConfig = {
      provider: 'figma',
      authorizeUrl: figma.authorizeUrl,
      tokenUrl: figma.tokenUrl,
      clientId: 'dummy-figma-client-id',
      clientSecret: 'dummy-figma-client-secret',
      scopes: figma.scopes,
    }
    const { redirectUrl } = beginAuthorization(figmaConfig, 'project-figma', 'https://cb.example.com/oauth/callback')
    const url = new URL(redirectUrl)
    expect(url.searchParams.get('scope')).toBe('file_content:read library_content:read current_user:read')
  })
})
