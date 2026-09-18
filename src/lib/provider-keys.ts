/**
 * LLM provider API keys (Anthropic, OpenAI, OpenRouter), managed in the app.
 *
 * Keys live in Postgres sealed with ENCRYPTION_KEY and are edited under
 * Organization → Models. Every process (web server, supervisor, workers) loads
 * them into its own environment at boot and again whenever a key changes
 * (Postgres NOTIFY), so the runtime, embeddings and compaction code keep
 * reading `process.env.*_API_KEY` — but the database is the only source.
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
// Storage
// ---------------------------------------------------------------------------

export async function listProviderKeys(): Promise<ProviderKeySummary[]> {
  const rows = await getDb()<Array<{ provider: ProviderId; keyEnc: string; updatedAt: string; updatedByName: string | null; lastVerifiedAt: string | null; lastVerifyStatus: VerifyStatus | null; lastVerifyError: string | null }>>`
    SELECT k.provider, k.key_enc AS "keyEnc", k.updated_at AS "updatedAt", u.name AS "updatedByName",
           k.last_verified_at AS "lastVerifiedAt", k.last_verify_status AS "lastVerifyStatus", k.last_verify_error AS "lastVerifyError"
    FROM provider_keys k LEFT JOIN users u ON u.user_id = k.updated_by
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

/** Decrypted keys for every configured provider. */
export async function loadProviderKeys(): Promise<Partial<Record<ProviderId, string>>> {
  const rows = await getDb()<Array<{ provider: ProviderId; keyEnc: string }>>`SELECT provider, key_enc AS "keyEnc" FROM provider_keys`.catch(() => [])
  const out: Partial<Record<ProviderId, string>> = {}
  for (const row of rows) {
    try { out[row.provider] = decryptSecret(row.keyEnc) } catch { keysLog.warn('stored provider key cannot be decrypted (ENCRYPTION_KEY changed?)', { provider: row.provider }) }
  }
  return out
}

export async function saveProviderKey(provider: ProviderId, key: string, updatedBy?: string | null): Promise<{ status: VerifyStatus; message?: string }> {
  const trimmed = key.trim()
  if (!trimmed) throw new Error('The key is empty.')
  const verification = await verifyProviderKey(provider, trimmed)
  if (verification.status === 'rejected') throw new Error(`${PROVIDER_LABEL[provider]} rejected this key (401). Check that it was copied completely and is not revoked.`)
  const sql = getDb()
  await sql`
    INSERT INTO provider_keys (provider, key_enc, updated_by, updated_at, last_verified_at, last_verify_status, last_verify_error)
    VALUES (${provider}, ${encryptSecret(trimmed)}, ${updatedBy ?? null}, now(), now(), ${verification.status}, ${verification.message ?? null})
    ON CONFLICT (provider) DO UPDATE SET key_enc = EXCLUDED.key_enc, updated_by = EXCLUDED.updated_by, updated_at = now(),
      last_verified_at = now(), last_verify_status = EXCLUDED.last_verify_status, last_verify_error = EXCLUDED.last_verify_error
  `
  await applyProviderKeysToEnv()
  await sql`SELECT pg_notify('provider_keys', ${provider})`
  keysLog.info('provider key saved', { provider, status: verification.status })
  return verification
}

export async function deleteProviderKey(provider: ProviderId): Promise<boolean> {
  const sql = getDb()
  const rows = await sql`DELETE FROM provider_keys WHERE provider = ${provider} RETURNING provider`
  await applyProviderKeysToEnv()
  await sql`SELECT pg_notify('provider_keys', ${provider})`
  return rows.length > 0
}

/** Re-check a stored key against the provider and record the outcome. */
export async function reverifyProviderKey(provider: ProviderId): Promise<{ status: VerifyStatus; message?: string }> {
  const keys = await loadProviderKeys()
  const key = keys[provider]
  if (!key) return { status: 'unknown', message: 'No key stored.' }
  const verification = await verifyProviderKey(provider, key)
  await getDb()`UPDATE provider_keys SET last_verified_at = now(), last_verify_status = ${verification.status}, last_verify_error = ${verification.message ?? null} WHERE provider = ${provider}`
  return verification
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
// Process environment bridge
// ---------------------------------------------------------------------------

/** Values the process started with (from .env or the shell), kept to detect leftovers. */
const envFileValues: Record<string, string | undefined> = Object.fromEntries(PROVIDER_IDS.map((p) => [PROVIDER_ENV_KEYS[p], process.env[PROVIDER_ENV_KEYS[p]]]))

/**
 * Make the database the only source of provider keys for this process: clear
 * any variables it started with and set the stored ones.
 */
export async function applyProviderKeysToEnv(): Promise<ProviderId[]> {
  const keys = await loadProviderKeys()
  for (const provider of PROVIDER_IDS) {
    const envKey = PROVIDER_ENV_KEYS[provider]
    if (keys[provider]) process.env[envKey] = keys[provider]
    else delete process.env[envKey]
  }
  const { invalidateTierModels } = await import('./model-policy')
  invalidateTierModels()
  return PROVIDER_IDS.filter((p) => Boolean(keys[p]))
}

/**
 * One-time migration: keys still present in the environment at boot are moved
 * into the database (when none is stored yet) so nothing breaks the first time
 * a deployment upgrades. Afterwards .env should lose them.
 */
export async function importProviderKeysFromEnv(): Promise<ProviderId[]> {
  const stored = await loadProviderKeys()
  const imported: ProviderId[] = []
  for (const provider of PROVIDER_IDS) {
    const value = envFileValues[PROVIDER_ENV_KEYS[provider]]?.trim()
    if (!value || stored[provider]) continue
    const verification = await verifyProviderKey(provider, value)
    if (verification.status === 'rejected') { keysLog.warn('environment key rejected by provider; not imported', { provider }); continue }
    await getDb()`
      INSERT INTO provider_keys (provider, key_enc, updated_at, last_verified_at, last_verify_status, last_verify_error)
      VALUES (${provider}, ${encryptSecret(value)}, now(), now(), ${verification.status}, ${verification.message ?? null})
      ON CONFLICT (provider) DO NOTHING
    `
    imported.push(provider)
  }
  if (imported.length) keysLog.warn('imported provider keys from the environment into the database; remove them from .env', { providers: imported })
  return imported
}

/** Reload keys when another process changes them. */
export async function listenProviderKeys(onChange?: (provider: string) => void): Promise<void> {
  const sql = getDb()
  await sql.listen('provider_keys', (provider) => {
    void applyProviderKeysToEnv().then(() => { keysLog.info('provider keys reloaded', { provider }); onChange?.(provider) }).catch(() => undefined)
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
