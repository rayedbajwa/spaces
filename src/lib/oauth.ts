import { randomBytes } from 'node:crypto'

/**
 * Generic OAuth 2.0 authorization-code flow helper. Each provider registers a
 * definition (client id/secret, urls, scopes). We generate an authorize URL,
 * store a state token for CSRF, and exchange the code on callback.
 */

export interface OAuthProviderConfig {
  provider: string
  authorizeUrl: string
  tokenUrl: string
  clientId: string
  clientSecret: string
  scopes: string[]
  /** Extra params added to the authorize URL, e.g. { audience: ... }. */
  extraAuthorizeParams?: Record<string, string>
  /** Header to use for the token request; some providers require Basic auth. */
  tokenAuth?: 'body' | 'basic'
}

export interface OAuthState {
  state: string
  projectId: string
  provider: string
  createdAt: number
}

// In-memory pending state store — 10 min expiry. Callback verifies + consumes.
const pendingStates = new Map<string, OAuthState>()
const STATE_TTL_MS = 10 * 60_000

function pruneStates(): void {
  const now = Date.now()
  for (const [k, v] of pendingStates) {
    if (now - v.createdAt > STATE_TTL_MS) pendingStates.delete(k)
  }
}

export function beginAuthorization(cfg: OAuthProviderConfig, projectId: string, callbackUrl: string): { redirectUrl: string; state: string } {
  pruneStates()
  const state = randomBytes(24).toString('base64url')
  pendingStates.set(state, { state, projectId, provider: cfg.provider, createdAt: Date.now() })

  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: callbackUrl,
    scope: cfg.scopes.join(' '),
    state,
    response_type: 'code',
    ...(cfg.extraAuthorizeParams ?? {}),
  })
  return { redirectUrl: `${cfg.authorizeUrl}?${params.toString()}`, state }
}

export function consumeState(state: string): OAuthState | undefined {
  pruneStates()
  const found = pendingStates.get(state)
  if (found) pendingStates.delete(state)
  return found
}

export interface OAuthTokenResponse {
  access_token: string
  token_type?: string
  scope?: string
  refresh_token?: string
  expires_in?: number
  [k: string]: unknown
}

export async function exchangeCode(cfg: OAuthProviderConfig, code: string, callbackUrl: string): Promise<OAuthTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: callbackUrl,
    ...(cfg.tokenAuth === 'basic' ? {} : { client_id: cfg.clientId, client_secret: cfg.clientSecret }),
  })

  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/x-www-form-urlencoded',
  }
  if (cfg.tokenAuth === 'basic') {
    headers.authorization = 'Basic ' + Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')
  }

  const response = await fetch(cfg.tokenUrl, { method: 'POST', headers, body: body.toString() })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Token exchange failed (${response.status}): ${text.slice(0, 300)}`)
  }
  return (await response.json()) as OAuthTokenResponse
}

// -------- Provider definitions --------

export function githubProvider(): OAuthProviderConfig | undefined {
  const clientId = process.env.GITHUB_CLIENT_ID
  const clientSecret = process.env.GITHUB_CLIENT_SECRET
  if (!clientId || !clientSecret) return undefined
  return {
    provider: 'github',
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    clientId,
    clientSecret,
    scopes: ['repo', 'read:org', 'read:user'],
  }
}

export function atlassianProvider(): OAuthProviderConfig | undefined {
  const clientId = process.env.ATLASSIAN_CLIENT_ID
  const clientSecret = process.env.ATLASSIAN_CLIENT_SECRET
  if (!clientId || !clientSecret) return undefined
  return {
    provider: 'atlassian',
    authorizeUrl: 'https://auth.atlassian.com/authorize',
    tokenUrl: 'https://auth.atlassian.com/oauth/token',
    clientId,
    clientSecret,
    scopes: [
      // Jira
      'read:jira-user', 'read:jira-work', 'write:jira-work',
      // Confluence
      'read:confluence-content.all', 'write:confluence-content',
      // Meta
      'offline_access',
    ],
    extraAuthorizeParams: { audience: 'api.atlassian.com', prompt: 'consent' },
  }
}

export function slackProvider(): OAuthProviderConfig | undefined {
  const clientId = process.env.SLACK_CLIENT_ID
  const clientSecret = process.env.SLACK_CLIENT_SECRET
  if (!clientId || !clientSecret) return undefined
  return {
    provider: 'slack',
    authorizeUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    clientId,
    clientSecret,
    scopes: ['channels:read', 'chat:write', 'users:read'],
  }
}

export function linearProvider(): OAuthProviderConfig | undefined {
  const clientId = process.env.LINEAR_CLIENT_ID
  const clientSecret = process.env.LINEAR_CLIENT_SECRET
  if (!clientId || !clientSecret) return undefined
  return {
    provider: 'linear',
    authorizeUrl: 'https://linear.app/oauth/authorize',
    tokenUrl: 'https://api.linear.app/oauth/token',
    clientId,
    clientSecret,
    // read: issues/projects/docs for knowledge; write: create issues/comments from tasks.
    scopes: ['read', 'write'],
    extraAuthorizeParams: { prompt: 'consent' },
  }
}

export function getProvider(provider: string): OAuthProviderConfig | undefined {
  switch (provider) {
    case 'github': return githubProvider()
    case 'atlassian': return atlassianProvider()
    case 'slack': return slackProvider()
    case 'linear': return linearProvider()
    default: return undefined
  }
}

/**
 * Refresh an OAuth access token (Atlassian tokens expire hourly; Linear tokens
 * do not expire but may be revoked). Returns the new token response.
 */
export async function refreshAccessToken(cfg: OAuthProviderConfig, refreshToken: string): Promise<OAuthTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    ...(cfg.tokenAuth === 'basic' ? {} : { client_id: cfg.clientId, client_secret: cfg.clientSecret }),
  })
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/x-www-form-urlencoded',
  }
  if (cfg.tokenAuth === 'basic') {
    headers.authorization = 'Basic ' + Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')
  }
  const response = await fetch(cfg.tokenUrl, { method: 'POST', headers, body: body.toString() })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Token refresh failed (${response.status}): ${text.slice(0, 300)}`)
  }
  return (await response.json()) as OAuthTokenResponse
}
