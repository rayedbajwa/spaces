import process from 'node:process'
import { PROVIDER_ENV_KEYS, configuredProviders, resolveTierModels, type ProviderId } from './default-model'

type Log = { warn: (msg: string, meta?: Record<string, unknown>) => void; info: (msg: string, meta?: Record<string, unknown>) => void }

/** A cheap authenticated GET per provider; 401 means the key is wrong. */
const PROBES: Record<ProviderId, (key: string) => Promise<Response>> = {
  anthropic: (key) => fetch('https://api.anthropic.com/v1/models?limit=1', {
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    signal: AbortSignal.timeout(8_000),
  }),
  openrouter: (key) => fetch('https://openrouter.ai/api/v1/auth/key', {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(8_000),
  }),
  openai: (key) => fetch('https://api.openai.com/v1/models?limit=1', {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(8_000),
  }),
}

const LOOKS_LIKE_PLACEHOLDER: Record<ProviderId, (key: string) => boolean> = {
  anthropic: (key) => key.length < 40 || !key.startsWith('sk-ant-'),
  openrouter: (key) => key.length < 40 || !key.startsWith('sk-or-'),
  openai: (key) => key.length < 40 || !key.startsWith('sk-'),
}

/**
 * Boot-time sanity check for LLM provider keys. A shell variable silently
 * overrides `.env`, so a process started with a placeholder key (e.g. from a
 * test shell) makes every agent call fail with 401 while nothing in the UI
 * explains why. This surfaces that at startup, and logs which models the
 * deployment will use by default.
 */
export async function checkProviderKeys(log: Log): Promise<void> {
  const providers = configuredProviders()
  const tiers = resolveTierModels()
  log.info('default models', { provider: providers[0] ?? '(none)', small: tiers.small, medium: tiers.medium, large: tiers.large })
  if (providers.length === 0) {
    log.warn('No LLM provider key is set (ANTHROPIC_API_KEY, OPENROUTER_API_KEY or OPENAI_API_KEY); every agent step will fail.')
    return
  }
  await Promise.all(providers.map((provider) => verifyKey(provider, log)))
}

/** @deprecated use checkProviderKeys — kept so older imports keep working. */
export const checkAnthropicKey = checkProviderKeys

async function verifyKey(provider: ProviderId, log: Log): Promise<void> {
  const envKey = PROVIDER_ENV_KEYS[provider]
  const key = process.env[envKey]!.trim()
  if (LOOKS_LIKE_PLACEHOLDER[provider](key)) {
    log.warn(`${envKey} does not look like a real key (placeholder from the shell?). It overrides .env — unset it or fix it, then restart.`, { length: key.length })
  }
  try {
    const response = await PROBES[provider](key)
    if (response.status === 401) {
      log.warn(`${envKey} was rejected (401). Every agent step on ${provider} will fail until the process is restarted with a valid key.`, { length: key.length })
    } else if (response.status === 403) {
      log.warn(`${envKey} is valid but not permitted (403); check the key's workspace and plan.`)
    } else if (!response.ok) {
      log.warn(`${provider} key check returned an unexpected status`, { status: response.status })
    } else {
      log.info(`${provider} API key verified`, { length: key.length })
    }
  } catch (error) {
    log.warn(`Could not reach ${provider} to verify the API key (offline?)`, { error: error instanceof Error ? error.message : String(error) })
  }
}
