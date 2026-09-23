import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { beginAuthorization, consumeState, exchangeCode, refreshAccessToken, type OAuthProviderConfig, PROVIDER_TEMPLATES } from '../src/lib/oauth'

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
  const expectedScopes = ['current_user:read', 'file_content:read', 'library_assets:read', 'library_content:read']

  test('scopes request exactly the granular read-only scopes (no deprecated umbrella)', () => {
    expect(figma.scopes).toEqual(expectedScopes)
  })

  test('scopes cover identity, file/node content, and published styles/components', () => {
    expect(figma.scopes).toContain('current_user:read') // GET /v1/me
    expect(figma.scopes).toContain('file_content:read') // GET /files/:key + /nodes
    expect(figma.scopes).toContain('library_assets:read') // GET /files/:key/styles + /components
    expect(figma.scopes).toContain('library_content:read') // published components/styles of files
  })

  test('scopes exclude the deprecated files:read umbrella scope', () => {
    expect(figma.scopes).not.toContain('files:read')
  })

  test('scopes exclude the Enterprise-only file_variables:read scope', () => {
    expect(figma.scopes).not.toContain('file_variables:read')
  })

  test('notes list the granular scopes to enable', () => {
    for (const scope of expectedScopes) {
      expect(figma.notes ?? '').toContain(scope)
    }
  })

  test('notes do not advertise the deprecated files:read or Enterprise-only file_variables:read', () => {
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
    expect(url.searchParams.get('scope')).toBe(expectedScopes.join(' '))
  })
})

describe('Figma provider template: OAuth endpoints and auth', () => {
  const figma = PROVIDER_TEMPLATES.figma

  test('token exchange uses the current v1 endpoint (not the removed www.figma.com/api path)', () => {
    expect(figma.tokenUrl).toBe('https://api.figma.com/v1/oauth/token')
  })

  test('token exchange authenticates with HTTP Basic auth (credentials not in body)', () => {
    expect(figma.tokenAuth).toBe('basic')
  })

  test('refresh uses the separate v1 refresh endpoint', () => {
    expect(figma.tokenRefreshUrl).toBe('https://api.figma.com/v1/oauth/refresh')
  })

  test('refresh omits grant_type (Figma sends only refresh_token)', () => {
    expect(figma.refreshOmitsGrantType).toBe(true)
  })
})

/**
 * exchangeCode/refreshAccessToken are pure HTTP helpers; we mock global.fetch
 * to assert the exact URL, auth scheme, and body each provider sends. This
 * guards the Figma 404 regression (removed www.figma.com/api token path) and
 * the Basic-auth/refresh-endpoint contract.
 */
describe('Figma token exchange and refresh request shape', () => {
  const captured: { url: string; init: RequestInit }[] = []
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    captured.length = 0
    originalFetch = globalThis.fetch
    globalThis.fetch = (async (input, init) => {
      captured.push({ url: String(input), init: init ?? {} })
      return new Response(JSON.stringify({ access_token: 'tok', token_type: 'bearer', refresh_token: 'rt' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function figmaConfig(): OAuthProviderConfig {
    const figma = PROVIDER_TEMPLATES.figma
    return { ...figma, clientId: 'cid', clientSecret: 'csecret' }
  }

  test('exchangeCode POSTs to the v1 token endpoint with Basic auth and no body credentials', async () => {
    await exchangeCode(figmaConfig(), 'the-code', 'https://cb.example.com/oauth/callback')

    expect(captured).toHaveLength(1)
    const { url, init } = captured[0]
    expect(url).toBe('https://api.figma.com/v1/oauth/token')
    expect(init.method).toBe('POST')
    const headers = new Headers(init.headers)
    expect(headers.get('authorization')).toBe('Basic ' + Buffer.from('cid:csecret').toString('base64'))

    const params = new URLSearchParams(init.body as string)
    expect(params.get('grant_type')).toBe('authorization_code')
    expect(params.get('code')).toBe('the-code')
    expect(params.get('redirect_uri')).toBe('https://cb.example.com/oauth/callback')
    expect(params.get('client_id')).toBeNull()
    expect(params.get('client_secret')).toBeNull()
  })

  test('refreshAccessToken POSTs to the separate refresh endpoint with Basic auth and only refresh_token', async () => {
    await refreshAccessToken(figmaConfig(), 'rt-123')

    expect(captured).toHaveLength(1)
    const { url, init } = captured[0]
    expect(url).toBe('https://api.figma.com/v1/oauth/refresh')
    expect(init.method).toBe('POST')
    const headers = new Headers(init.headers)
    expect(headers.get('authorization')).toBe('Basic ' + Buffer.from('cid:csecret').toString('base64'))

    const params = new URLSearchParams(init.body as string)
    expect(params.get('refresh_token')).toBe('rt-123')
    expect(params.get('grant_type')).toBeNull()
    expect(params.get('client_id')).toBeNull()
    expect(params.get('client_secret')).toBeNull()
  })
})
