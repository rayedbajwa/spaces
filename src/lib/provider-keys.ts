/**
 * LLM provider API keys (Anthropic, OpenAI, OpenRouter), managed in the app
 * and scoped per organization.
 *
 * Keys live in Postgres sealed with ENCRYPTION_KEY and are edited under
 * Organization → Models. They are never applied to the process environment:
 * a deployment hosts many organizations, so every model runtime, embedding
 * call and routing decision loads the keys of the organization it works for
 * (`loadProviderKeys(orgId)` / `envWithProviderKeys(orgId)`).
 */

import { decryptSecret, encryptSecret } from './crypto-vault'
import { getDb } from './db'
import { PROVIDER_ENV_KEYS, type ProviderId } from './default-model'
import { log } from './logger'

const keysLog = log.child({ mod: 'provider-keys' })

export const PROVIDER_IDS = Object.keys(PROVIDER_ENV_KEYS) as ProviderId[]
export const PROVIDER_LABEL: Record<ProviderId, string> = { anthropic: 'Anthropic', openai: 'OpenAI', openrouter: 'OpenRouter' }
export const PROVIDER_CONSOLE: Record<ProviderId, string> = {
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
  openrouter: 'https://openrouter.ai/settings/keys',
}

export type VerifyStatus = 'ok' | 'rejected' | 'forbidden' | 'unreachable' | 'unknown'

export type ProviderKeys = Partial<Record<ProviderId, string>>

export interface ProviderKeySummary {
  provider: ProviderId
  label: string
  consoleUrl: string
  configured: boolean
  keyMasked: string | null
  updatedAt: string | null
  updatedByName: string | null
  lastVerifiedAt: string | null
  lastVerifyStatus: VerifyStatus | null
  lastVerifyError: string | null
  /** True when a variable with this name is still set in the process environment file. */
  envLeftover: boolean
}

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as string[]).includes(value)
}

// ---------------------------------------------------------------------------
// Storage (per organization)
// ---------------------------------------------------------------------------

export async function listProviderKeys(orgId: string): Promise<ProviderKeySummary[]> {
  const rows = await getDb()<Array<{ provider: ProviderId; keyEnc: string; updatedAt: string; updatedByName: string | null; lastVerifiedAt: string | null; lastVerifyStatus: VerifyStatus | null; lastVerifyError: string | null }>>`
    SELECT k.provider, k.key_enc AS "keyEnc", k.updated_at AS "updatedAt", u.name AS "updatedByName",
           k.last_verified_at AS "lastVerifiedAt", k.last_verify_status AS "lastVerifyStatus", k.last_verify_error AS "lastVerifyError"
    FROM provider_keys k LEFT JOIN users u ON u.user_id = k.updated_by WHERE k.org_id = ${orgId}
  `.catch(() => [])
  const byProvider = new Map(rows.map((r) => [r.provider, r]))
  return PROVIDER_IDS.map((provider) => {
    const row = byProvider.get(provider)
    let masked: string | null = null
    if (row) {
      try { masked = mask(decryptSecret(row.keyEnc)) } catch { masked = '(cannot decrypt — ENCRYPTION_KEY changed; enter the key again)' }
    }
    return {
      provider,
      label: PROVIDER_LABEL[provider],
      consoleUrl: PROVIDER_CONSOLE[provider],
      configured: Boolean(row) && masked !== null && !masked.startsWith('('),
      keyMasked: masked,
      updatedAt: row?.updatedAt ?? null,
      updatedByName: row?.updatedByName ?? null,
      lastVerifiedAt: row?.lastVerifiedAt ?? null,
      lastVerifyStatus: row?.lastVerifyStatus ?? null,
      lastVerifyError: row?.lastVerifyError ?? null,
      envLeftover: Boolean(envFileValues[PROVIDER_ENV_KEYS[provider]]),
    }
  })
}

const keyCache = new Map<string, { at: number; keys: ProviderKeys }>()
const KEY_CACHE_MS = 30_000

/** Decrypted keys of an organization (cached briefly; invalidated on change through NOTIFY). */
export async function loadProviderKeys(orgId: string): Promise<ProviderKeys> {
  const cached = keyCache.get(orgId)
  if (cached && Date.now() - cached.at < KEY_CACHE_MS) return cached.keys
  const rows = await getDb()<Array<{ provider: ProviderId; keyEnc: string }>>`SELECT provider, key_enc AS "keyEnc" FROM provider_keys WHERE org_id = ${orgId}`.catch(() => [])
  const out: ProviderKeys = {}
  for (const row of rows) {
    try { out[row.provider] = decryptSecret(row.keyEnc) } catch { keysLog.warn('stored provider key cannot be decrypted (ENCRYPTION_KEY changed?)', { orgId, provider: row.provider }) }
  }
  keyCache.set(orgId, { at: Date.now(), keys: out })
  return out
}

/** Providers an organization has a key for. */
export async function configuredProvidersFor(orgId: string): Promise<ProviderId[]> {
  const keys = await loadProviderKeys(orgId)
  return PROVIDER_IDS.filter((p) => Boolean(keys[p]))
}

/** A process-environment-like object with the organization's keys set, for code that reads `*_API_KEY` from an env. */
export async function envWithProviderKeys(orgId: string, base: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  const keys = await loadProviderKeys(orgId)
  const env: NodeJS.ProcessEnv = { ...base }
  for (const provider of PROVIDER_IDS) {
    const envKey = PROVIDER_ENV_KEYS[provider]
    if (keys[provider]) env[envKey] = keys[provider]
    else delete env[envKey]
  }
  return env
}

export async function saveProviderKey(orgId: string, provider: ProviderId, key: string, updatedBy?: string | null): Promise<{ status: VerifyStatus; message?: string }> {
  const trimmed = key.trim()
  if (!trimmed) throw new Error('The key is empty.')
  const verification = await verifyProviderKey(provider, trimmed)
  if (verification.status === 'rejected') throw new Error(`${PROVIDER_LABEL[provider]} rejected this key (401). Check that it was copied completely and is not revoked.`)
  const sql = getDb()
  await sql`
    INSERT INTO provider_keys (org_id, provider, key_enc, updated_by, updated_at, last_verified_at, last_verify_status, last_verify_error)
    VALUES (${orgId}, ${provider}, ${encryptSecret(trimmed)}, ${updatedBy ?? null}, now(), now(), ${verification.status}, ${verification.message ?? null})
    ON CONFLICT (org_id, provider) DO UPDATE SET key_enc = EXCLUDED.key_enc, updated_by = EXCLUDED.updated_by, updated_at = now(),
      last_verified_at = now(), last_verify_status = EXCLUDED.last_verify_status, last_verify_error = EXCLUDED.last_verify_error
  `
  await notifyKeyChange(orgId, provider)
  keysLog.info('provider key saved', { orgId, provider, status: verification.status })
  return verification
}

export async function deleteProviderKey(orgId: string, provider: ProviderId): Promise<boolean> {
  const sql = getDb()
  const rows = await sql`DELETE FROM provider_keys WHERE org_id = ${orgId} AND provider = ${provider} RETURNING provider`
  await notifyKeyChange(orgId, provider)
  return rows.length > 0
}

/** Re-check a stored key against the provider and record the outcome. */
export async function reverifyProviderKey(orgId: string, provider: ProviderId): Promise<{ status: VerifyStatus; message?: string }> {
  const keys = await loadProviderKeys(orgId)
  const key = keys[provider]
  if (!key) return { status: 'unknown', message: 'No key stored.' }
  const verification = await verifyProviderKey(provider, key)
  await getDb()`UPDATE provider_keys SET last_verified_at = now(), last_verify_status = ${verification.status}, last_verify_error = ${verification.message ?? null} WHERE org_id = ${orgId} AND provider = ${provider}`
  return verification
}

async function notifyKeyChange(orgId: string, provider: ProviderId): Promise<void> {
  keyCache.delete(orgId)
  const { invalidateTierModels } = await import('./model-policy')
  invalidateTierModels(orgId)
  await getDb()`SELECT pg_notify('provider_keys', ${`${orgId}:${provider}`})`
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

const PROBES: Record<ProviderId, (key: string) => Promise<Response>> = {
  anthropic: (key) => fetch('https://api.anthropic.com/v1/models?limit=1', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(8_000) }),
  openrouter: (key) => fetch('https://openrouter.ai/api/v1/auth/key', { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8_000) }),
  openai: (key) => fetch('https://api.openai.com/v1/models?limit=1', { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8_000) }),
}

export async function verifyProviderKey(provider: ProviderId, key: string): Promise<{ status: VerifyStatus; message?: string }> {
  try {
    const response = await PROBES[provider](key)
    if (response.status === 401) return { status: 'rejected', message: 'Rejected by the provider (401).' }
    if (response.status === 403) return { status: 'forbidden', message: 'Valid but not permitted (403); check the key\'s workspace and plan.' }
    if (!response.ok) return { status: 'unknown', message: `Unexpected status ${response.status} from the provider.` }
    return { status: 'ok' }
  } catch (error) {
    return { status: 'unreachable', message: `Could not reach the provider: ${error instanceof Error ? error.message : String(error)}` }
  }
}

// ---------------------------------------------------------------------------
// Environment: one-time import, and never a source afterwards
// ---------------------------------------------------------------------------

/** Values the process started with (from .env or the shell), kept to detect leftovers. */
const envFileValues: Record<string, string | undefined> = Object.fromEntries(PROVIDER_IDS.map((p) => [PROVIDER_ENV_KEYS[p], process.env[PROVIDER_ENV_KEYS[p]]]))

/**
 * Keys are never read from the environment at run time: they belong to an
 * organization. Any `*_API_KEY` the process started with is cleared so no
 * library picks it up by accident.
 */
export function scrubProviderKeysFromEnv(): void {
  for (const provider of PROVIDER_IDS) delete process.env[PROVIDER_ENV_KEYS[provider]]
}

/**
 * One-time migration into the default organization: keys still present in
 * the environment at boot are stored (when that organization has none) so
 * nothing breaks the first time a deployment upgrades. Afterwards .env
 * should lose them.
 */
export async function importProviderKeysFromEnv(orgId: string): Promise<ProviderId[]> {
  const stored = await loadProviderKeys(orgId)
  const imported: ProviderId[] = []
  for (const provider of PROVIDER_IDS) {
    const value = envFileValues[PROVIDER_ENV_KEYS[provider]]?.trim()
    if (!value || stored[provider]) continue
    const verification = await verifyProviderKey(provider, value)
    if (verification.status === 'rejected') { keysLog.warn('environment key rejected by provider; not imported', { provider }); continue }
    await getDb()`
      INSERT INTO provider_keys (org_id, provider, key_enc, updated_at, last_verified_at, last_verify_status, last_verify_error)
      VALUES (${orgId}, ${provider}, ${encryptSecret(value)}, now(), now(), ${verification.status}, ${verification.message ?? null})
      ON CONFLICT (org_id, provider) DO NOTHING
    `
    imported.push(provider)
  }
  keyCache.delete(orgId)
  if (imported.length) keysLog.warn('imported provider keys from the environment into the database; remove them from .env', { providers: imported })
  return imported
}

/** Drop caches when another process changes keys (payload "orgId:provider"). */
export async function listenProviderKeys(onChange?: (orgId: string, provider: string) => void): Promise<void> {
  const sql = getDb()
  await sql.listen('provider_keys', (payload) => {
    const [orgId, provider] = payload.split(':')
    if (orgId) keyCache.delete(orgId)
    void import('./model-policy').then((m) => m.invalidateTierModels(orgId)).catch(() => undefined)
    keysLog.info('provider keys changed', { orgId, provider })
    onChange?.(orgId ?? '', provider ?? '')
  })
}

/** Variables still set in this process's environment file that the app now ignores. */
export function leftoverEnvKeys(): string[] {
  return PROVIDER_IDS.map((p) => PROVIDER_ENV_KEYS[p]).filter((k) => Boolean(envFileValues[k]))
}

function mask(value: string): string {
  if (value.length <= 10) return `${value.slice(0, 2)}…${value.slice(-2)}`
  return `${value.slice(0, 7)}…${value.slice(-4)}`
}
