/**
 * OAuth app credentials (client id + secret) per provider, managed in the app.
 *
 * Stored in Postgres with the secret sealed by ENCRYPTION_KEY, so integrations
 * are self-serve: an owner or admin pastes the credentials from the provider's
 * developer console into the Integrations panel. This is the only source —
 * nothing is read from the environment.
 */

import { getDb } from './db'
import { decryptSecret, encryptSecret } from './crypto-vault'
import { PROVIDER_TEMPLATES, type OAuthProviderId } from './oauth'

export interface OAuthAppCredentials { clientId: string; clientSecret: string }

export interface OAuthAppSummary {
  provider: OAuthProviderId
  label: string
  /** Integration kinds this provider powers (Atlassian → jira + confluence). */
  kinds: string[]
  configured: boolean
  source: 'database' | 'none'
  /** Client id with the middle masked, for display. */
  clientIdMasked: string | null
  scopes: string[]
  consoleUrl: string
  callbackPath: string
  notes?: string
  updatedAt: string | null
  updatedByName: string | null
}

export const OAUTH_PROVIDER_IDS: OAuthProviderId[] = ['github', 'atlassian', 'slack', 'linear']

export function isOAuthProviderId(value: string): value is OAuthProviderId {
  return (OAUTH_PROVIDER_IDS as string[]).includes(value)
}

/** Credentials for a provider, or undefined when none were saved (or they cannot be decrypted). */
export async function getOAuthAppCredentials(provider: OAuthProviderId): Promise<(OAuthAppCredentials & { source: 'database' }) | undefined> {
  const sql = getDb()
  const [row] = await sql<Array<{ clientId: string; secretEnc: string }>>`
    SELECT client_id AS "clientId", client_secret_enc AS "secretEnc" FROM oauth_apps WHERE provider = ${provider}
  `.catch(() => [])
  if (!row) return undefined
  try {
    return { clientId: row.clientId, clientSecret: decryptSecret(row.secretEnc), source: 'database' }
  } catch {
    // ENCRYPTION_KEY changed since the secret was saved: treat as not configured so the UI asks for it again.
    return undefined
  }
}

export async function listOAuthApps(): Promise<OAuthAppSummary[]> {
  const sql = getDb()
  const rows = await sql<Array<{ provider: OAuthProviderId; clientId: string; updatedAt: string; updatedByName: string | null }>>`
    SELECT a.provider, a.client_id AS "clientId", a.updated_at AS "updatedAt", u.name AS "updatedByName"
    FROM oauth_apps a LEFT JOIN users u ON u.user_id = a.updated_by
  `.catch(() => [])
  const byProvider = new Map(rows.map((r) => [r.provider, r]))
  const out: OAuthAppSummary[] = []
  for (const provider of OAUTH_PROVIDER_IDS) {
    const template = PROVIDER_TEMPLATES[provider]
    const stored = byProvider.get(provider)
    const creds = await getOAuthAppCredentials(provider)
    out.push({
      provider,
      label: template.label,
      kinds: template.kinds,
      configured: Boolean(creds),
      source: creds?.source ?? 'none',
      clientIdMasked: creds ? mask(creds.clientId) : null,
      scopes: template.scopes,
      consoleUrl: template.consoleUrl,
      callbackPath: `/api/oauth/${provider}/callback`,
      notes: template.notes,
      updatedAt: stored?.updatedAt ?? null,
      updatedByName: stored?.updatedByName ?? null,
    })
  }
  return out
}

/** Save credentials. An empty secret keeps the stored one (so the id alone can be corrected). */
export async function saveOAuthApp(provider: OAuthProviderId, input: { clientId: string; clientSecret?: string; updatedBy?: string | null }): Promise<void> {
  const sql = getDb()
  const clientId = input.clientId.trim()
  if (!clientId) throw new Error('Client id is required.')
  const secret = input.clientSecret?.trim()
  if (secret) {
    await sql`
      INSERT INTO oauth_apps (provider, client_id, client_secret_enc, updated_by, updated_at)
      VALUES (${provider}, ${clientId}, ${encryptSecret(secret)}, ${input.updatedBy ?? null}, now())
      ON CONFLICT (provider) DO UPDATE SET client_id = EXCLUDED.client_id, client_secret_enc = EXCLUDED.client_secret_enc, updated_by = EXCLUDED.updated_by, updated_at = now()
    `
    return
  }
  const rows = await sql`UPDATE oauth_apps SET client_id = ${clientId}, updated_by = ${input.updatedBy ?? null}, updated_at = now() WHERE provider = ${provider} RETURNING provider`
  if (rows.length === 0) throw new Error('Client secret is required the first time.')
}

export async function deleteOAuthApp(provider: OAuthProviderId): Promise<boolean> {
  const rows = await getDb()`DELETE FROM oauth_apps WHERE provider = ${provider} RETURNING provider`
  return rows.length > 0
}

function mask(value: string): string {
  if (value.length <= 8) return `${value.slice(0, 2)}…${value.slice(-2)}`
  return `${value.slice(0, 4)}…${value.slice(-4)}`
}
