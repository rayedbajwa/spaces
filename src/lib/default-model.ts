/**
 * Provider credentials and model-spec helpers.
 *
 * Which model runs is decided by model-policy.ts (automatic routing per
 * provider by cost and speed); this module only knows which providers have
 * keys and how to read a `provider/model` spec.
 */

/** Providers we can authenticate with an API key, and the variable that holds it. */
export const PROVIDER_ENV_KEYS = {
  anthropic: 'ANTHROPIC_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  openai: 'OPENAI_API_KEY',
} as const
export type ProviderId = keyof typeof PROVIDER_ENV_KEYS

export type ModelTier = 'small' | 'medium' | 'large'

type Env = Record<string, string | undefined>

const trimmed = (value: string | undefined): string | undefined => {
  const v = value?.trim()
  return v ? v : undefined
}

/** Providers with an API key present. */
export function configuredProviders(env: Env = process.env): ProviderId[] {
  return (Object.keys(PROVIDER_ENV_KEYS) as ProviderId[]).filter((p) => Boolean(trimmed(env[PROVIDER_ENV_KEYS[p]])))
}

/** `provider` part of a `provider/model` spec, lower-cased. */
export function providerOfModel(spec: string): string | undefined {
  const slash = spec.indexOf('/')
  return slash > 0 ? spec.slice(0, slash).toLowerCase() : undefined
}

/**
 * True when we hold credentials for the model's provider. Providers we do not
 * key by environment (OAuth-backed ones, custom models.json entries) return true
 * so the Pi runtime can make the call.
 */
export function isProviderConfigured(spec: string, env: Env = process.env): boolean {
  const provider = providerOfModel(spec)
  if (!provider || !(provider in PROVIDER_ENV_KEYS)) return true
  return Boolean(trimmed(env[PROVIDER_ENV_KEYS[provider as ProviderId]]))
}

/**
 * Tier a model belongs to, judged by its name. Used to substitute an
 * equivalent when a template pins a model whose provider we cannot call.
 */
export function tierOfModel(spec: string): ModelTier {
  const id = spec.toLowerCase()
  if (/haiku|mini|nano|flash|lite|small/.test(id)) return 'small'
  if (/opus|pro\b|-pro|max|large/.test(id)) return 'large'
  return 'medium'
}
