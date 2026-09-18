/**
 * Default LLM model selection — one rule for the whole app.
 *
 * Every code path that needs a model when none was requested (new runs, one-off
 * step runs, sub-agents, onboarding, suggestions, and the model router's tiers)
 * goes through here. Precedence:
 *
 *   1. DEFAULT_MODEL / DEFAULT_MODEL_SMALL / DEFAULT_MODEL_LARGE from the
 *      environment. Setting only DEFAULT_MODEL uses that model for every tier.
 *   2. Otherwise the first provider we hold credentials for, in this order:
 *      Anthropic (ANTHROPIC_API_KEY), OpenRouter (OPENROUTER_API_KEY),
 *      OpenAI (OPENAI_API_KEY) — each with a built-in small/medium/large trio.
 *
 * Model specs are `provider/model-id` as the Pi SDK understands them, e.g.
 * `anthropic/claude-sonnet-4-5`, `openai/gpt-5.4`,
 * `openrouter/anthropic/claude-sonnet-4.5` or `openrouter/openrouter/auto`
 * (OpenRouter picks the model itself).
 */

export type ModelTier = 'small' | 'medium' | 'large'
export interface TierModels { small: string; medium: string; large: string }

/** Providers we can authenticate with an API key, and the variable that holds it. */
export const PROVIDER_ENV_KEYS = {
  anthropic: 'ANTHROPIC_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  openai: 'OPENAI_API_KEY',
} as const
export type ProviderId = keyof typeof PROVIDER_ENV_KEYS

/** Which provider wins when several keys are set and DEFAULT_MODEL is not. */
const PROVIDER_PREFERENCE: ProviderId[] = ['anthropic', 'openrouter', 'openai']

const BUILTIN_TIERS: Record<ProviderId, TierModels> = {
  anthropic: {
    small: 'anthropic/claude-haiku-4-5',
    medium: 'anthropic/claude-sonnet-4-5',
    large: 'anthropic/claude-opus-4-7',
  },
  openrouter: {
    small: 'openrouter/anthropic/claude-haiku-4.5',
    medium: 'openrouter/anthropic/claude-sonnet-4.5',
    large: 'openrouter/anthropic/claude-opus-4.7',
  },
  openai: {
    small: 'openai/gpt-5.4-mini',
    medium: 'openai/gpt-5.4',
    large: 'openai/gpt-5.5',
  },
}

type Env = Record<string, string | undefined>

const trimmed = (value: string | undefined): string | undefined => {
  const v = value?.trim()
  return v ? v : undefined
}

/** Providers with an API key present, in preference order. */
export function configuredProviders(env: Env = process.env): ProviderId[] {
  return PROVIDER_PREFERENCE.filter((p) => Boolean(trimmed(env[PROVIDER_ENV_KEYS[p]])))
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

/** The small/medium/large models the router and defaults use. */
export function resolveTierModels(env: Env = process.env): TierModels {
  const builtin = BUILTIN_TIERS[configuredProviders(env)[0] ?? 'anthropic']
  const everywhere = trimmed(env.DEFAULT_MODEL)
  return {
    small: trimmed(env.DEFAULT_MODEL_SMALL) ?? everywhere ?? builtin.small,
    medium: everywhere ?? builtin.medium,
    large: trimmed(env.DEFAULT_MODEL_LARGE) ?? everywhere ?? builtin.large,
  }
}

/** The model used whenever nothing more specific was requested. */
export function defaultModel(env: Env = process.env): string {
  return resolveTierModels(env).medium
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
