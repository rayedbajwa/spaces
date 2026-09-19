import { describe, expect, test } from 'bun:test'
import { PROVIDER_RETRY_DELAYS_MS, isTransientProviderError } from '../src/lib/aidlc'

describe('transient provider errors', () => {
  test('network, overload and 5xx errors are retried', () => {
    for (const m of ['Connection error.', 'fetch failed', '429 {"error":{"message":"Rate limit exceeded"}}', '503 Service Unavailable', 'Overloaded', 'socket hang up', 'request timed out']) {
      expect(isTransientProviderError(m)).toBe(true)
    }
  })
  test('auth, billing and invalid-request errors are not', () => {
    for (const m of ['401 {"error":{"message":"invalid x-api-key"}}', 'Insufficient credits', 'monthly spend limit reached', '400 invalid_request_error: max_tokens', '404 model not found']) {
      expect(isTransientProviderError(m)).toBe(false)
    }
  })
  test('backoff grows and stays bounded', () => {
    expect(PROVIDER_RETRY_DELAYS_MS.length).toBe(3)
    expect(PROVIDER_RETRY_DELAYS_MS).toEqual([...PROVIDER_RETRY_DELAYS_MS].sort((a, b) => a - b))
  })
})
