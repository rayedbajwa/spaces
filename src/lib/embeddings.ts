/**
 * Text embeddings for organization knowledge (RAG).
 *
 * The Pi SDK has no embeddings API, so this is a small OpenAI-compatible
 * client. The model comes from EMBEDDING_MODEL (`provider/model-id`):
 *
 *   openai/text-embedding-3-small   (default) — via OPENAI_API_KEY, or through
 *                                    OpenRouter when only OPENROUTER_API_KEY is set
 *   openrouter/<vendor>/<model>     — any embedding model OpenRouter serves
 *
 * Vectors are stored as vector(EMBEDDING_DIMENSIONS) (default 1536, which the
 * text-embedding-3 family can be asked to produce). When no usable key exists,
 * `embeddingsAvailable()` is false and knowledge search falls back to Postgres
 * full-text search, so the feature degrades instead of failing.
 */

import { log } from './logger'

const embedLog = log.child({ mod: 'embeddings' })

export const DEFAULT_EMBEDDING_MODEL = 'openai/text-embedding-3-small'
export const EMBEDDING_DIMENSIONS = Number.parseInt(process.env.EMBEDDING_DIMENSIONS ?? '', 10) || 1536

/** Requests per call and characters per request stay under provider limits. */
const MAX_INPUTS_PER_REQUEST = 64
const MAX_CHARS_PER_REQUEST = 200_000
const MAX_ATTEMPTS = 4

interface Endpoint { url: string; key: string; model: string; provider: 'openai' | 'openrouter' }

type Env = Record<string, string | undefined>

export function embeddingModel(env: Env = process.env): string {
  return env.EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL
}

/** Where to send embedding requests, or undefined when no key can serve the model. */
export function resolveEmbeddingEndpoint(env: Env = process.env): Endpoint | undefined {
  const spec = embeddingModel(env)
  const slash = spec.indexOf('/')
  const provider = slash > 0 ? spec.slice(0, slash).toLowerCase() : ''
  const id = slash > 0 ? spec.slice(slash + 1) : spec
  const openaiKey = env.OPENAI_API_KEY?.trim()
  const openrouterKey = env.OPENROUTER_API_KEY?.trim()

  if (provider === 'openrouter') {
    return openrouterKey ? { url: 'https://openrouter.ai/api/v1/embeddings', key: openrouterKey, model: id, provider: 'openrouter' } : undefined
  }
  if (provider === 'openai') {
    if (openaiKey) return { url: 'https://api.openai.com/v1/embeddings', key: openaiKey, model: id, provider: 'openai' }
    // OpenRouter serves OpenAI's embedding models under their vendor-prefixed id.
    if (openrouterKey) return { url: 'https://openrouter.ai/api/v1/embeddings', key: openrouterKey, model: spec, provider: 'openrouter' }
  }
  return undefined
}

export function embeddingsAvailable(env: Env = process.env): boolean {
  return resolveEmbeddingEndpoint(env) !== undefined
}

/**
 * Embed texts in order. Batches requests, retries transient failures, and
 * throws (with the provider's message) when the model cannot be reached.
 */
export async function embedTexts(texts: string[], env: Env = process.env, options: { orgId?: string } = {}): Promise<number[][]> {
  if (texts.length === 0) return []
  const endpoint = resolveEmbeddingEndpoint(env)
  if (!endpoint) throw new Error(`No stored key can serve the embedding model "${embeddingModel(env)}". Add an OpenAI or OpenRouter key under Organization → Models.`)

  const out: number[][] = []
  // AI data guardrails, under the organization's setting (documents and queries
  // alike, so their vectors stay comparable); secrets are masked whatever it is.
  const { maskOutput, redactSecretValues } = await import('./guardrails')
  const { loadGuardPolicy } = await import('./guardrails-policy')
  const policy = await loadGuardPolicy(options.orgId)
  for (const batch of batches(texts.map((t) => maskOutput(redactSecretValues(t), policy)))) {
    const vectors = await requestWithRetry(endpoint, batch)
    out.push(...vectors)
  }
  return out
}

/** Embed one query string. */
export async function embedQuery(text: string, env: Env = process.env, options: { orgId?: string } = {}): Promise<number[]> {
  const [vector] = await embedTexts([text], env, options)
  return vector!
}

function* batches(texts: string[]): Generator<string[]> {
  let current: string[] = []
  let chars = 0
  for (const text of texts) {
    // Empty input is rejected by the API; a single space embeds fine.
    const item = text.trim() ? text : ' '
    if (current.length > 0 && (current.length >= MAX_INPUTS_PER_REQUEST || chars + item.length > MAX_CHARS_PER_REQUEST)) {
      yield current
      current = []
      chars = 0
    }
    current.push(item)
    chars += item.length
  }
  if (current.length) yield current
}

async function requestWithRetry(endpoint: Endpoint, input: string[]): Promise<number[][]> {
  let lastError: Error | undefined
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await requestOnce(endpoint, input)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      const retryable = /\b(429|5\d\d)\b|timed out|ECONNRESET|fetch failed/i.test(lastError.message)
      if (!retryable || attempt === MAX_ATTEMPTS) break
      const delay = 500 * 2 ** (attempt - 1)
      embedLog.warn('embedding request failed; retrying', { attempt, delay, error: lastError.message })
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  throw lastError
}

async function requestOnce(endpoint: Endpoint, input: string[]): Promise<number[][]> {
  const body: Record<string, unknown> = { model: endpoint.model, input }
  // text-embedding-3-* accept a target size; other models ignore or reject it,
  // so only send it where we know it is honoured.
  if (/text-embedding-3/.test(endpoint.model)) body.dimensions = EMBEDDING_DIMENSIONS
  const response = await fetch(endpoint.url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${endpoint.key}`,
      'content-type': 'application/json',
      ...(endpoint.provider === 'openrouter' ? { 'x-title': 'Spaces knowledge sync' } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`embeddings ${response.status} from ${endpoint.provider}: ${text.slice(0, 300)}`)
  }
  const data = (await response.json()) as { data?: Array<{ index: number; embedding: number[] }> }
  const rows = [...(data.data ?? [])].sort((a, b) => a.index - b.index)
  if (rows.length !== input.length) throw new Error(`embeddings: expected ${input.length} vectors, got ${rows.length}`)
  for (const row of rows) {
    if (row.embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(`embeddings: model ${endpoint.model} returned ${row.embedding.length} dimensions; EMBEDDING_DIMENSIONS is ${EMBEDDING_DIMENSIONS}`)
    }
  }
  return rows.map((row) => row.embedding)
}

/** pgvector text literal: '[0.1,0.2,...]'. */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`
}
