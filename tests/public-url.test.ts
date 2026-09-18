import { afterEach, describe, expect, test } from 'bun:test'
import { publicOrigin } from '../src/lib/public-url'

const req = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers })

describe('publicOrigin', () => {
  const saved = process.env.PUBLIC_URL
  afterEach(() => { if (saved === undefined) delete process.env.PUBLIC_URL; else process.env.PUBLIC_URL = saved })

  test('plain requests use the request origin', () => {
    delete process.env.PUBLIC_URL
    expect(publicOrigin(req('http://localhost:3000/api/x'))).toBe('http://localhost:3000')
  })

  test('forwarded headers from a TLS-terminating proxy win', () => {
    delete process.env.PUBLIC_URL
    expect(publicOrigin(req('http://0.0.0.0:8080/api/x', { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'spaces.up.railway.app' }))).toBe('https://spaces.up.railway.app')
    expect(publicOrigin(req('http://spaces.up.railway.app/api/x', { 'x-forwarded-proto': 'https' }))).toBe('https://spaces.up.railway.app')
    expect(publicOrigin(req('http://0.0.0.0:8080/', { 'x-forwarded-host': 'a.example.com, proxy.internal', 'x-forwarded-proto': 'https, http' }))).toBe('https://a.example.com')
  })

  test('PUBLIC_URL overrides everything', () => {
    process.env.PUBLIC_URL = 'https://spaces.example.com/some/path'
    expect(publicOrigin(req('http://0.0.0.0:8080/api/x', { 'x-forwarded-host': 'other.example.com' }))).toBe('https://spaces.example.com')
    process.env.PUBLIC_URL = 'not a url'
    expect(publicOrigin(req('http://localhost:3000/'))).toBe('http://localhost:3000')
  })
})
