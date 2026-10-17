import { describe, expect, test } from 'bun:test'
import { describeProviderError, humanizeProviderError } from '../src/lib/provider-error'

// The OpenRouter error a run recorded on Oct 17 (key id replaced), cut off as stored.
const PREV = '{"code":402,"message":"This request requires more credits, or fewer max_tokens. You requested up to 30000 tokens, but can only afford 26306. To increase, visit https://openrouter.ai/workspaces/default/keys/KEY and adjust the key\'s total limit"}'
const OPENROUTER_RAW = `402: {"message":"This request would exceed your available credits given your current in-flight requests. Retry after in-flight requests settle, or add credits.","code":402,"metadata":{"reason":"in_flight_budget_exhausted","limit_source":"openrouter_in_flight_budget","remedy_hint":"Retry after your in-flight requests settle (see the Retry-After header). Adding credits at https://openrouter.ai/settings/credits raises your in-flight budget, up to a capped ceiling.","headers":{"Retry-After":"120"},"provider_name":null,"previous_errors":[${PREV},${PREV}`

describe('humanizeProviderError', () => {
  test('an OpenRouter credit error becomes one line naming the provider', () => {
    expect(humanizeProviderError(OPENROUTER_RAW)).toBe(
      'OpenRouter 402: This request would exceed your available credits given your current in-flight requests. Retry after in-flight requests settle, or add credits. (retry after 120s)',
    )
  })

  test('the Anthropic shape keeps its spend-limit hint', () => {
    const raw = '400 {"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits. You will regain access on 2026-11-01. Monthly spend limit reached."},"request_id":"req_1"}'
    expect(humanizeProviderError(raw)).toStartWith('Anthropic 400: You have reached your specified API usage limits.')
    expect(humanizeProviderError(raw)).toContain('Usage limits.')
  })

  test('plain text passes through', () => {
    expect(humanizeProviderError('Connection error.')).toBe('Connection error.')
  })
})

describe('describeProviderError', () => {
  test('credits: a short title, the message, retry time and the billing link', () => {
    const view = describeProviderError(`LLM provider error: ${humanizeProviderError(OPENROUTER_RAW)}`)!
    expect(view).toMatchObject({ provider: 'openrouter', kind: 'credits', status: 402, title: 'Out of OpenRouter credits', retryAfterSeconds: 120 })
    expect(view.message).toStartWith('This request would exceed your available credits')
    expect(view.links[0]).toEqual({ label: 'Add credits on OpenRouter', href: 'https://openrouter.ai/settings/credits' })
  })

  test('errors recorded before the worker humanized them read the same', () => {
    const view = describeProviderError(`Error: LLM provider error: ${OPENROUTER_RAW}`)!
    expect(view.title).toBe('Out of OpenRouter credits')
    expect(view.message).not.toContain('previous_errors')
    expect(view.retryAfterSeconds).toBe(120)
  })

  test('a bad OpenAI key links to the keys page', () => {
    const view = describeProviderError('LLM provider error: 401 {"error":{"message":"Incorrect API key provided: sk-…. You can find your API key at https://platform.openai.com/account/api-keys.","type":"invalid_request_error","code":"invalid_api_key"}}')!
    expect(view).toMatchObject({ kind: 'auth', title: 'OpenAI rejected the API key' })
    expect(view.links).toEqual([{ label: 'Manage OpenAI keys', href: 'https://platform.openai.com/api-keys' }])
  })

  test('a 429 that mentions credits is a rate limit; other errors are left alone', () => {
    expect(describeProviderError('LLM provider error: OpenRouter 429: Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day')?.kind).toBe('rate_limit')
    expect(describeProviderError('git push failed: permission denied')).toBeUndefined()
  })
})
