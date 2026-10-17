/**
 * LLM provider errors, made readable. Providers answer failures with their own
 * JSON (OpenRouter: `{message, code, metadata}`; Anthropic and OpenAI:
 * `{error: {message, type}}`), which runs used to show verbatim, retries and
 * all. This reads the one message that matters, names the provider, and says
 * where to fix it: the billing page for credits, the keys page for a bad key.
 * Shared by the worker (what a failed run records) and the web app (how it
 * shows one), so errors recorded before this still display well.
 */

export type ProviderId = 'openrouter' | 'anthropic' | 'openai' | 'google'
export type ProviderErrorKind = 'credits' | 'auth' | 'rate_limit' | 'overloaded' | 'other'

const PROVIDERS: Record<ProviderId, { name: string; billing: string; keys: string; usage?: string }> = {
  openrouter: { name: 'OpenRouter', billing: 'https://openrouter.ai/settings/credits', keys: 'https://openrouter.ai/settings/keys' },
  anthropic: { name: 'Anthropic', billing: 'https://console.anthropic.com/settings/billing', keys: 'https://console.anthropic.com/settings/keys', usage: 'https://console.anthropic.com/settings/limits' },
  openai: { name: 'OpenAI', billing: 'https://platform.openai.com/settings/organization/billing/overview', keys: 'https://platform.openai.com/api-keys', usage: 'https://platform.openai.com/settings/organization/limits' },
  google: { name: 'Google AI Studio', billing: 'https://aistudio.google.com/usage', keys: 'https://aistudio.google.com/app/apikey' },
}

export type ProviderErrorView = {
  provider?: ProviderId
  providerName?: string
  kind: ProviderErrorKind
  status?: number
  title: string
  /** The provider's own message, one line, without the retry history. */
  message: string
  retryAfterSeconds?: number
  links: { label: string; href: string }[]
}

function detectProvider(text: string): ProviderId | undefined {
  if (/openrouter/i.test(text)) return 'openrouter'
  if (/openai|insufficient_quota/i.test(text)) return 'openai'
  if (/anthropic|"request_id"\s*:\s*"req_|\b(overloaded|rate_limit|authentication|permission)_error\b/i.test(text)) return 'anthropic'
  if (/generativelanguage|gemini|google/i.test(text)) return 'google'
  return undefined
}

function detectKind(text: string, status?: number): ProviderErrorKind {
  // The status decides when there is one: a 429 that mentions credits is still a rate limit.
  if (status === 402) return 'credits'
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate_limit'
  if (status && status >= 500) return 'overloaded'
  if (/credits?\b|insufficient_quota|quota|billing|spend limit|payment|afford/i.test(text)) return 'credits'
  if (/invalid (api )?key|authentication|unauthori[sz]ed|no auth credentials/i.test(text)) return 'auth'
  if (/rate.?limit|too many requests/i.test(text)) return 'rate_limit'
  if (/overloaded|unavailable|bad gateway/i.test(text)) return 'overloaded'
  return 'other'
}

type ProviderJson = {
  message?: string
  code?: number | string
  error?: { message?: string; type?: string; code?: number | string; metadata?: { raw?: string } }
  metadata?: { reason?: string; headers?: Record<string, string> }
}

/** The provider's message and status out of `LLM provider error: 402: {…}` or plain text. */
function readRaw(raw: string): { status?: number; message: string; retryAfterSeconds?: number; typeHint?: string } {
  let text = raw.trim().replace(/^Error:\s*/i, '').replace(/^LLM provider error:\s*/i, '')
  const jsonStart = text.indexOf('{')
  const head = jsonStart >= 0 ? text.slice(0, jsonStart) : text
  let status = Number(head.match(/\b([1-5]\d\d)\b/)?.[1]) || undefined
  if (jsonStart < 0) return { status, message: text }
  // Truncated bodies end mid-JSON; keep what parses, else the first message field.
  const body = text.slice(jsonStart)
  let parsed: ProviderJson | undefined
  try { parsed = JSON.parse(body) as ProviderJson } catch { /* truncated */ }
  const message = parsed?.error?.message ?? parsed?.message ?? body.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1]?.replace(/\\"/g, '"')
  const code = Number(parsed?.code ?? parsed?.error?.code)
  if (!status && code >= 100 && code < 600) status = code
  const retry = Number(parsed?.metadata?.headers?.['Retry-After'] ?? body.match(/"Retry-After"\s*:\s*"?(\d+)/)?.[1])
  text = message || head.trim() || body
  return { status, message: text, retryAfterSeconds: retry > 0 ? retry : undefined, typeHint: parsed?.error?.type ?? parsed?.metadata?.reason }
}

/**
 * What the worker records for a failed provider call: the provider, the status
 * and the provider's own message, e.g.
 * `OpenRouter 402: This request would exceed your available credits… (retry after 120s)`.
 */
export function humanizeProviderError(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.indexOf('{') < 0) return trimmed
  const { status, message, retryAfterSeconds, typeHint } = readRaw(trimmed)
  const provider = detectProvider(trimmed)
  const name = provider ? PROVIDERS[provider].name : ''
  const lead = [name, status].filter(Boolean).join(' ')
  const hint = /monthly spend limit/i.test(message)
    ? ' — increase your cap in the Anthropic Console → Settings → Billing → Usage limits.'
    : ''
  return `${lead ? `${lead}: ` : ''}${typeHint && !provider ? `[${typeHint}] ` : ''}${message}${hint}${retryAfterSeconds ? ` (retry after ${retryAfterSeconds}s)` : ''}`
}

/** A provider error as the UI shows it, or undefined when the error is something else. */
export function describeProviderError(error: string | undefined): ProviderErrorView | undefined {
  if (!error || !/LLM provider error|^\s*(openrouter|anthropic|openai|google ai studio)\b/i.test(error)) return undefined
  const { status, message, retryAfterSeconds } = readRaw(error)
  const provider = detectProvider(error)
  const info = provider ? PROVIDERS[provider] : undefined
  const kind = detectKind(error, status)
  const who = info?.name ?? 'The AI provider'
  // The worker's form leads with "OpenRouter 402:"; the view shows those separately.
  const text = message.replace(/^(OpenRouter|Anthropic|OpenAI|Google AI Studio)\s*(\d{3})?:\s*/i, '').replace(/\s*\(retry after \d+s\)$/, '')
  const retry = retryAfterSeconds ?? (Number(error.match(/retry after (\d+)s/i)?.[1]) || undefined)
  const title = {
    credits: info ? `Out of ${info.name} credits` : 'Out of AI provider credits',
    auth: `${who} rejected the API key`,
    rate_limit: `${who} rate limit reached`,
    overloaded: `${who} is overloaded or unavailable`,
    other: `${who} returned an error`,
  }[kind]
  const links: ProviderErrorView['links'] = []
  if (info && kind === 'credits') {
    links.push({ label: `Add credits on ${info.name}`, href: info.billing })
    links.push({ label: 'Check key limits', href: provider === 'openrouter' ? info.keys : info.usage ?? info.keys })
  } else if (info && kind === 'auth') {
    links.push({ label: `Manage ${info.name} keys`, href: info.keys })
  } else if (info && kind === 'rate_limit' && info.usage) {
    links.push({ label: `${info.name} rate limits`, href: info.usage })
  }
  return { provider, providerName: info?.name, kind, status, title, message: text, retryAfterSeconds: retry, links }
}
