/**
 * OAuth app credentials (client id + secret) per provider, managed in the app.
 *
 * Stored in Postgres with the secret sealed by ENCRYPTION_KEY, so integrations
 * are self-serve. Where the provider allows it, the app is created for the
 * user (GitHub App manifest, Slack app manifest); otherwise the panel guides
 * them through the provider's console. This is the only source — nothing is
 * read from the environment.
 */

import { getDb } from './db'
import { decryptSecret, encryptSecret } from './crypto-vault'
import { githubAppInstallUrl, slackManifestUrl, type GitHubAppManifestResult } from './github-app'
import { PROVIDER_TEMPLATES, type OAuthProviderId } from './oauth'

export interface OAuthAppCredentials { clientId: string; clientSecret: string }

/** How the app was set up and what the provider knows about it. */
export interface OAuthAppConfig {
  /** manifest: created by Spaces through the provider's manifest flow; manual: credentials pasted in. */
  source?: 'manifest' | 'manual'
  appId?: number
  appSlug?: string
  appName?: string
  appUrl?: string
  ownerLogin?: string
  /** Sealed private key (GitHub App) — kept for future server-to-server use. */
  pemEnc?: string
  webhookSecretEnc?: string
  /** GitHub App installation ids seen through the setup redirect. */
  installationIds?: number[]
  installedAt?: string
}

export type OAuthSetupMethod = 'github-manifest' | 'slack-manifest' | 'console'

export interface OAuthAppSetup {
  /** Best available way to create the provider app. */
  method: OAuthSetupMethod
  /** Spaces route (GitHub) or provider URL (Slack) that creates the app; undefined when only the console is available. */
  createUrl?: string
  /** Where the user installs the created app (GitHub). */
  installUrl?: string
  installed: boolean
  appName?: string
  appUrl?: string
  appSlug?: string
  ownerLogin?: string
  source?: 'manifest' | 'manual'
}

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
  setup: OAuthAppSetup
  /** False when the provider no longer knows this app (deleted on their side); undefined when it cannot be checked. */
  availableAtProvider?: boolean
  /** Permissions the app is missing that agents need (GitHub only). */
  missingPermissions?: string[]
  /** Where to grant them. */
  permissionsUrl?: string
}

export const OAUTH_PROVIDER_IDS: OAuthProviderId[] = ['github', 'atlassian', 'slack', 'linear']

export function isOAuthProviderId(value: string): value is OAuthProviderId {
  return (OAUTH_PROVIDER_IDS as string[]).includes(value)
}

/** Credentials for a provider, or undefined when none were saved (or they cannot be decrypted). */
export async function getOAuthAppCredentials(orgId: string, provider: OAuthProviderId): Promise<(OAuthAppCredentials & { source: 'database' }) | undefined> {
  const sql = getDb()
  const [row] = await sql<Array<{ clientId: string; secretEnc: string }>>`
    SELECT client_id AS "clientId", client_secret_enc AS "secretEnc" FROM oauth_apps WHERE org_id = ${orgId} AND provider = ${provider}
  `.catch(() => [])
  if (!row) return undefined
  try {
    return { clientId: row.clientId, clientSecret: decryptSecret(row.secretEnc), source: 'database' }
  } catch {
    // ENCRYPTION_KEY changed since the secret was saved: treat as not configured so the UI asks for it again.
    return undefined
  }
}

export async function getOAuthAppConfig(orgId: string, provider: OAuthProviderId): Promise<OAuthAppConfig> {
  const [row] = await getDb()<Array<{ config: OAuthAppConfig | null }>>`SELECT config_json AS config FROM oauth_apps WHERE org_id = ${orgId} AND provider = ${provider}`.catch(() => [])
  return row?.config ?? {}
}

/**
 * Setup options for a provider given the deployment origin (needed for the
 * callback URLs baked into manifests).
 */
export function describeSetup(provider: OAuthProviderId, origin: string, config: OAuthAppConfig): OAuthAppSetup {
  const base = {
    installed: Boolean(config.installationIds?.length),
    appName: config.appName,
    appUrl: config.appUrl,
    appSlug: config.appSlug,
    ownerLogin: config.ownerLogin,
    source: config.source,
  }
  if (provider === 'github') {
    return {
      ...base,
      method: 'github-manifest',
      createUrl: '/api/oauth-apps/github/manifest',
      installUrl: config.appSlug ? githubAppInstallUrl(config.appSlug) : undefined,
    }
  }
  if (provider === 'slack') return { ...base, method: 'slack-manifest', createUrl: slackManifestUrl(origin) }
  return { ...base, method: 'console' }
}

export async function listOAuthApps(orgId: string, origin: string): Promise<OAuthAppSummary[]> {
  const sql = getDb()
  const rows = await sql<Array<{ provider: OAuthProviderId; clientId: string; config: OAuthAppConfig | null; updatedAt: string; updatedByName: string | null }>>`
    SELECT a.provider, a.client_id AS "clientId", a.config_json AS config, a.updated_at AS "updatedAt", u.name AS "updatedByName"
    FROM oauth_apps a LEFT JOIN users u ON u.user_id = a.updated_by WHERE a.org_id = ${orgId}
  `.catch(() => [])
  const byProvider = new Map(rows.map((r) => [r.provider, r]))
  const out: OAuthAppSummary[] = []
  for (const provider of OAUTH_PROVIDER_IDS) {
    const template = PROVIDER_TEMPLATES[provider]
    const stored = byProvider.get(provider)
    const creds = await getOAuthAppCredentials(orgId, provider)
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
      // Rows saved before setup tracking existed were pasted in by hand.
      setup: describeSetup(provider, origin, { ...(stored?.config ?? {}), source: stored?.config?.source ?? (stored ? 'manual' : undefined) }),
      availableAtProvider: provider === 'github' && creds
        ? await import('./github-app-auth').then((m) => m.githubAppAlive(orgId)).catch(() => undefined)
        : undefined,
      missingPermissions: provider === 'github' && creds
        ? await import('./github-app-auth').then((m) => m.missingAppPermissions(orgId)).catch(() => [])
        : undefined,
      permissionsUrl: provider === 'github' && stored?.config?.appSlug
        ? `https://github.com/settings/apps/${stored.config.appSlug}/permissions`
        : undefined,
    })
  }
  return out
}

/** Save pasted credentials. An empty secret keeps the stored one (so the id alone can be corrected). */
export async function saveOAuthApp(orgId: string, provider: OAuthProviderId, input: { clientId: string; clientSecret?: string; updatedBy?: string | null }): Promise<void> {
  const sql = getDb()
  const clientId = input.clientId.trim()
  if (!clientId) throw new Error('Client id is required.')
  const secret = input.clientSecret?.trim()
  const config: OAuthAppConfig = { source: 'manual' }
  if (secret) {
    await sql`
      INSERT INTO oauth_apps (org_id, provider, client_id, client_secret_enc, config_json, updated_by, updated_at)
      VALUES (${orgId}, ${provider}, ${clientId}, ${encryptSecret(secret)}, ${sql.json(config as never)}, ${input.updatedBy ?? null}, now())
      ON CONFLICT (org_id, provider) DO UPDATE SET client_id = EXCLUDED.client_id, client_secret_enc = EXCLUDED.client_secret_enc,
        config_json = EXCLUDED.config_json, updated_by = EXCLUDED.updated_by, updated_at = now()
    `
    return
  }
  const rows = await sql`UPDATE oauth_apps SET client_id = ${clientId}, updated_by = ${input.updatedBy ?? null}, updated_at = now() WHERE org_id = ${orgId} AND provider = ${provider} RETURNING provider`
  if (rows.length === 0) throw new Error('Client secret is required the first time.')
}

/** Store the GitHub App that the manifest flow just created. Replaces any pasted credentials. */
export async function saveGitHubAppFromManifest(orgId: string, app: GitHubAppManifestResult, updatedBy?: string | null): Promise<OAuthAppConfig> {
  const sql = getDb()
  const config: OAuthAppConfig = {
    source: 'manifest',
    appId: app.id,
    appSlug: app.slug,
    appName: app.name,
    appUrl: app.html_url,
    ownerLogin: app.owner?.login,
    pemEnc: app.pem ? encryptSecret(app.pem) : undefined,
    webhookSecretEnc: app.webhook_secret ? encryptSecret(app.webhook_secret) : undefined,
  }
  await sql`
    INSERT INTO oauth_apps (org_id, provider, client_id, client_secret_enc, config_json, updated_by, updated_at)
    VALUES (${orgId}, 'github', ${app.client_id}, ${encryptSecret(app.client_secret)}, ${sql.json(config as never)}, ${updatedBy ?? null}, now())
    ON CONFLICT (org_id, provider) DO UPDATE SET client_id = EXCLUDED.client_id, client_secret_enc = EXCLUDED.client_secret_enc,
      config_json = EXCLUDED.config_json, updated_by = EXCLUDED.updated_by, updated_at = now()
  `
  return config
}

/** Remember a GitHub App installation reported through the setup redirect. */
export async function recordGitHubInstallation(orgId: string, installationId: number): Promise<void> {
  const sql = getDb()
  const current = await getOAuthAppConfig(orgId, 'github')
  const ids = Array.from(new Set([...(current.installationIds ?? []), installationId]))
  const patch: OAuthAppConfig = { installationIds: ids, installedAt: new Date().toISOString() }
  await sql`UPDATE oauth_apps SET config_json = config_json || ${sql.json(patch as never)} WHERE org_id = ${orgId} AND provider = 'github'`
}

export async function deleteOAuthApp(orgId: string, provider: OAuthProviderId): Promise<boolean> {
  const rows = await getDb()`DELETE FROM oauth_apps WHERE org_id = ${orgId} AND provider = ${provider} RETURNING provider`
  return rows.length > 0
}

function mask(value: string): string {
  if (value.length <= 8) return `${value.slice(0, 2)}…${value.slice(-2)}`
  return `${value.slice(0, 4)}…${value.slice(-4)}`
}
