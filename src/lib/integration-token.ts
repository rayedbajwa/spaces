/**
 * Access tokens for connected integrations, refreshed before they expire.
 *
 * GitHub App user tokens expire after eight hours (with a six-month refresh
 * token) and Atlassian tokens after one hour. The OAuth callback records
 * `expires_at`; this helper hands out the stored token while it is valid and
 * otherwise refreshes it through the provider's OAuth app, saving the new
 * token for every integration kind that shares it.
 */

import { getAppIntegration, getAppIntegrationCredentials, upsertAppIntegration, IntegrationCredentialsError, type AppIntegrationKind } from './app-integrations'
import { log } from './logger'
import { refreshAccessToken, resolveProvider, type OAuthProviderId } from './oauth'

const tokenLog = log.child({ mod: 'integration-token' })

/** OAuth provider behind each integration kind (Jira and Confluence share Atlassian). */
export const KIND_PROVIDER: Record<AppIntegrationKind, OAuthProviderId> = {
  github: 'github',
  jira: 'atlassian',
  confluence: 'atlassian',
  slack: 'slack',
  linear: 'linear',
}

const PROVIDER_KINDS: Record<OAuthProviderId, AppIntegrationKind[]> = {
  github: ['github'],
  atlassian: ['jira', 'confluence'],
  slack: ['slack'],
  linear: ['linear'],
}

/** Refresh a little early so a token never dies mid-request. */
const EXPIRY_MARGIN_MS = 90_000

/** Refreshes are serialized per provider so concurrent callers do not race. */
const inflight = new Map<OAuthProviderId, Promise<Record<string, unknown>>>()

/** Add `expires_at` (ISO) to a token response that carries `expires_in` seconds. */
export function withExpiry<T extends Record<string, unknown>>(tokens: T, issuedAt = Date.now()): T & { expires_at?: string } {
  const expiresIn = typeof tokens.expires_in === 'number' ? tokens.expires_in : Number(tokens.expires_in)
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) return tokens
  return { ...tokens, expires_at: new Date(issuedAt + expiresIn * 1000).toISOString() }
}

export function tokenExpiresSoon(creds: Record<string, unknown> | undefined): boolean {
  const raw = creds?.expires_at
  if (typeof raw !== 'string') return false
  const at = Date.parse(raw)
  return Number.isFinite(at) && at - Date.now() < EXPIRY_MARGIN_MS
}

export class IntegrationNotConnectedError extends Error {
  constructor(kind: AppIntegrationKind) {
    super(`${kind} is not connected. Connect it under Organization → Integrations first.`)
    this.name = 'IntegrationNotConnectedError'
  }
}

/**
 * The access token for a connected integration. Throws
 * IntegrationNotConnectedError when the integration is not connected and
 * IntegrationCredentialsError when its stored token cannot be read.
 */
export async function getIntegrationAccessToken(kind: AppIntegrationKind): Promise<string> {
  const row = await getAppIntegration(kind)
  if (row?.status !== 'connected') throw new IntegrationNotConnectedError(kind)
  let creds = await getAppIntegrationCredentials(kind)
  if (typeof creds?.access_token !== 'string' || !creds.access_token) throw new IntegrationCredentialsError(kind)
  if (tokenExpiresSoon(creds) && typeof creds.refresh_token === 'string' && creds.refresh_token) {
    creds = await refreshIntegrationTokens(kind, creds).catch((error) => {
      // A failed refresh is not fatal while the old token may still work; surface it once it is rejected.
      tokenLog.warn('token refresh failed; using the stored token', { kind, error: error instanceof Error ? error.message : String(error) })
      return creds!
    })
  }
  return creds.access_token as string
}

/**
 * Refresh the token for `kind`'s provider and store the result on every
 * integration kind that shares it. Returns the merged credentials.
 */
export async function refreshIntegrationTokens(kind: AppIntegrationKind, current?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const provider = KIND_PROVIDER[kind]
  const existing = inflight.get(provider)
  if (existing) return existing
  const task = (async () => {
    const creds = current ?? (await getAppIntegrationCredentials(kind))
    const refreshToken = creds?.refresh_token
    if (typeof refreshToken !== 'string' || !refreshToken) throw new Error(`${kind} has no refresh token; reconnect it under Integrations.`)
    const cfg = await resolveProvider(provider)
    if (!cfg) throw new Error(`${provider} no longer has app credentials; add them under Organization → Integrations.`)
    const refreshed = withExpiry(await refreshAccessToken(cfg, refreshToken))
    const merged: Record<string, unknown> = { ...creds, ...refreshed, refresh_token: refreshed.refresh_token ?? refreshToken }
    for (const k of PROVIDER_KINDS[provider]) {
      const row = await getAppIntegration(k)
      if (row?.status === 'connected') await upsertAppIntegration({ kind: k, status: 'connected', credentials: merged })
    }
    tokenLog.info('integration token refreshed', { provider })
    return merged
  })().finally(() => inflight.delete(provider))
  inflight.set(provider, task)
  return task
}
