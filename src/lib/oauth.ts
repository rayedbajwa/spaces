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
  /** Separate endpoint for refreshing tokens; defaults to tokenUrl (Figma uses /v1/oauth/refresh). */
  tokenRefreshUrl?: string
  /** Omit `grant_type` from the refresh request (Figma's refresh endpoint takes only `refresh_token`). */
  refreshOmitsGrantType?: boolean
}

export interface OAuthState {
  state: string
  projectId: string
  provider: string
  createdAt: number
  /** Relative path to send the browser to after the callback stores the token. */
  returnTo?: string
  /** Organization the connection belongs to. */
  orgId?: string
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

export function beginAuthorization(cfg: OAuthProviderConfig, projectId: string, callbackUrl: string, returnTo?: string, orgId?: string): { redirectUrl: string; state: string } {
  pruneStates()
  const state = randomBytes(24).toString('base64url')
  pendingStates.set(state, { state, projectId, provider: cfg.provider, createdAt: Date.now(), ...(returnTo ? { returnTo } : {}), ...(orgId ? { orgId } : {}) })

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
  const data = (await response.json()) as OAuthTokenResponse & { ok?: boolean; error?: string }
  // Slack answers 200 with { ok: false, error } when the exchange fails.
  if (data.ok === false) throw new Error(`Token exchange failed: ${data.error ?? 'unknown error'}`)
  return data
}

// -------- Provider definitions --------

export type OAuthProviderId = 'github' | 'atlassian' | 'slack' | 'linear' | 'figma'

export interface OAuthProviderTemplate extends Omit<OAuthProviderConfig, 'clientId' | 'clientSecret' | 'provider'> {
  provider: OAuthProviderId
  label: string
  /** Integration kinds this provider powers. */
  kinds: string[]
  /** Where to register the OAuth app. */
  consoleUrl: string
  notes?: string
}

/** Everything about a provider except the credentials, which are set in the app (Organization → Integrations). */
export const PROVIDER_TEMPLATES: Record<OAuthProviderId, OAuthProviderTemplate> = {
  github: {
    provider: 'github',
    label: 'GitHub',
    kinds: ['github'],
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scopes: ['repo', 'read:org', 'read:user'],
    consoleUrl: 'https://github.com/settings/apps',
    notes: 'Created for you as a GitHub App (one click). A classic OAuth App also works: paste its client id and secret; scopes are requested at connect time.',
  },
  atlassian: {
    provider: 'atlassian',
    label: 'Atlassian (Jira + Confluence)',
    kinds: ['jira', 'confluence'],
    authorizeUrl: 'https://auth.atlassian.com/authorize',
    tokenUrl: 'https://auth.atlassian.com/oauth/token',
    scopes: [
      // Jira
      'read:jira-user', 'read:jira-work', 'write:jira-work',
      // Confluence: content.all reads page bodies; summary + search list spaces
      // and pages (the knowledge import and integration_search need them).
      'read:confluence-content.all', 'read:confluence-content.summary', 'read:confluence-space.summary', 'search:confluence', 'write:confluence-content',
      // Meta
      'offline_access',
    ],
    extraAuthorizeParams: { audience: 'api.atlassian.com', prompt: 'consent' },
    consoleUrl: 'https://developer.atlassian.com/console/myapps/',
    notes: 'OAuth 2.0 (3LO) app. Enable the same scopes under Permissions → Jira API / Confluence API, or Atlassian answers "scope does not match".',
  },
  slack: {
    provider: 'slack',
    label: 'Slack',
    kinds: ['slack'],
    authorizeUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    // A channel per project with run updates and approvals (lib/slack.ts SLACK_BOT_SCOPES).
    scopes: ['channels:manage', 'channels:read', 'channels:join', 'chat:write', 'users:read', 'users:read.email'],
    consoleUrl: 'https://api.slack.com/apps',
  },
  linear: {
    provider: 'linear',
    label: 'Linear',
    kinds: ['linear'],
    authorizeUrl: 'https://linear.app/oauth/authorize',
    tokenUrl: 'https://api.linear.app/oauth/token',
    // read: issues/projects/docs for knowledge; write: create issues/comments from tasks.
    scopes: ['read', 'write'],
    extraAuthorizeParams: { prompt: 'consent' },
    consoleUrl: 'https://linear.app/settings/api/applications',
  },
  figma: {
    provider: 'figma',
    label: 'Figma',
    kinds: ['figma'],
    authorizeUrl: 'https://www.figma.com/oauth',
    tokenUrl: 'https://api.figma.com/v1/oauth/token',
    // Figma authenticates the token exchange and refresh with HTTP Basic auth
    // (client_id:client_secret), not credentials in the body, and refreshes
    // tokens on a separate endpoint that takes only `refresh_token`.
    tokenAuth: 'basic',
    tokenRefreshUrl: 'https://api.figma.com/v1/oauth/refresh',
    refreshOmitsGrantType: true,
    // Granular read-only scopes. The legacy files:read umbrella scope is
    // deprecated by Figma (https://developers.figma.com/docs/rest-api/scopes/):
    //   current_user:read    -> GET /v1/me (identity check)
    //   file_content:read    -> GET /files/:key and /files/:key/nodes
    //   library_assets:read  -> GET /files/:key/styles and /components (published assets)
    //   library_content:read -> published components/styles of files
    // file_variables:read is Enterprise-only and not requested (least privilege).
    scopes: ['current_user:read', 'file_content:read', 'library_assets:read', 'library_content:read'],
    consoleUrl: 'https://www.figma.com/developers/apps',
    notes: 'OAuth 2.0 app. Enable the read-only scopes current_user:read, file_content:read, library_assets:read, and library_content:read in your Figma app settings.',
  },
}

/**
 * Provider config with credentials, or undefined when none are set. Credentials
 * come from the oauth_apps table, set in the Integrations panel.
 */
export async function resolveProvider(orgId: string, provider: string): Promise<OAuthProviderConfig | undefined> {
  if (!(provider in PROVIDER_TEMPLATES)) return undefined
  const id = provider as OAuthProviderId
  const { getOAuthAppCredentials } = await import('./oauth-apps')
  const creds = await getOAuthAppCredentials(orgId, id)
  if (!creds) return undefined
  const { label: _label, kinds: _kinds, consoleUrl: _console, notes: _notes, ...rest } = PROVIDER_TEMPLATES[id]
  return { ...rest, clientId: creds.clientId, clientSecret: creds.clientSecret }
}

/**
 * Credentials for "Continue with GitHub".
 *
 * Signing in identifies a person to the whole deployment, so it is never an
 * organization's data: it uses one GitHub OAuth app configured for the
 * deployment itself, through GITHUB_SIGNIN_CLIENT_ID and
 * GITHUB_SIGNIN_CLIENT_SECRET. No organization's integration app is ever used
 * for sign-in — without these the button is simply not offered, and people
 * sign in with email and password.
 */
export function resolveGitHubLoginProvider(): OAuthProviderConfig | undefined {
  const clientId = process.env.GITHUB_SIGNIN_CLIENT_ID?.trim()
  const clientSecret = process.env.GITHUB_SIGNIN_CLIENT_SECRET?.trim()
  if (!clientId || !clientSecret) return undefined
  const { label: _label, kinds: _kinds, consoleUrl: _console, notes: _notes, ...rest } = PROVIDER_TEMPLATES.github
  return { ...rest, clientId, clientSecret }
}

/**
 * Refresh an OAuth access token (Atlassian tokens expire hourly; Linear tokens
 * do not expire but may be revoked). Returns the new token response.
 */
export async function refreshAccessToken(cfg: OAuthProviderConfig, refreshToken: string): Promise<OAuthTokenResponse> {
  const params: Record<string, string> = { refresh_token: refreshToken }
  if (!cfg.refreshOmitsGrantType) params.grant_type = 'refresh_token'
  if (cfg.tokenAuth !== 'basic') {
    params.client_id = cfg.clientId
    params.client_secret = cfg.clientSecret
  }
  const body = new URLSearchParams(params)
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/x-www-form-urlencoded',
  }
  if (cfg.tokenAuth === 'basic') {
    headers.authorization = 'Basic ' + Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')
  }
  const response = await fetch(cfg.tokenRefreshUrl ?? cfg.tokenUrl, { method: 'POST', headers, body: body.toString() })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Token refresh failed (${response.status}): ${text.slice(0, 300)}`)
  }
  return (await response.json()) as OAuthTokenResponse
}
