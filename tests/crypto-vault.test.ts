import { test, expect, describe, beforeEach } from 'bun:test'

/**
 * The crypto-vault module caches a derived key in module scope on first use.
 * We need to import it AFTER ENCRYPTION_KEY is set, and we need a way to
 * reset the cached key when we test the "unset key" branch. We do that by
 * dropping and re-requiring the module via a dynamic import with a cache-bust
 * query string — Bun's loader treats each unique specifier as its own module.
 */

const TEST_KEY = 'unit-test-encryption-key-abcdefghijklmnop'

async function freshModule(): Promise<typeof import('../src/lib/crypto-vault')> {
  // Bun caches ESM by resolved URL; a query suffix is enough to force a fresh
  // module instance so the internal `cachedKey` is undefined again.
  return await import(`../src/lib/crypto-vault?t=${Date.now()}-${Math.random()}`)
}

describe('crypto-vault: sealCredentials / unsealCredentials roundtrip', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = TEST_KEY
  })

  test('roundtrips to the exact input object (deep equal)', async () => {
    const { sealCredentials, unsealCredentials } = await freshModule()
    const payload = {
      access_token: 'gho_secretvalue123',
      refresh_token: 'ghr_refresh456',
      expires_at: 1700000000,
      scope: ['repo', 'read:org'],
      nested: { foo: 'bar', n: 42, arr: [1, 2, 3] },
    }
    const sealed = sealCredentials(payload)
    expect(sealed.v).toBe(1)
    expect(typeof sealed.enc).toBe('string')
    expect(sealed.enc.length).toBeGreaterThan(0)

    const unsealed = unsealCredentials(sealed)
    expect(unsealed).toEqual(payload)
  })

  test('different plaintexts produce different ciphertexts', async () => {
    const { sealCredentials } = await freshModule()
    const a = sealCredentials({ token: 'aaaa' })
    const b = sealCredentials({ token: 'bbbb' })
    expect(a.enc).not.toBe(b.enc)
  })

  test('sealing the same plaintext twice produces different .enc strings (random IV)', async () => {
    const { sealCredentials } = await freshModule()
    const payload = { token: 'same-value', extra: 'stable' }
    const s1 = sealCredentials(payload)
    const s2 = sealCredentials(payload)
    expect(s1.enc).not.toBe(s2.enc)
  })
})

describe('crypto-vault: unsealCredentials rejects malformed input', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = TEST_KEY
  })

  test('returns undefined for null', async () => {
    const { unsealCredentials } = await freshModule()
    expect(unsealCredentials(null)).toBeUndefined()
  })

  test('returns undefined for {}', async () => {
    const { unsealCredentials } = await freshModule()
    expect(unsealCredentials({})).toBeUndefined()
  })

  test('returns undefined for garbage ciphertext', async () => {
    const { unsealCredentials } = await freshModule()
    expect(unsealCredentials({ enc: 'garbage', v: 1 })).toBeUndefined()
  })

  test('returns undefined for tampered but valid-looking base64', async () => {
    const { sealCredentials, unsealCredentials } = await freshModule()
    const sealed = sealCredentials({ ok: true })
    // Flip a byte deep in the ciphertext — GCM auth tag verification must fail.
    const buf = Buffer.from(sealed.enc, 'base64')
    buf[buf.length - 1] ^= 0xff
    const tampered = { enc: buf.toString('base64'), v: 1 as const }
    expect(unsealCredentials(tampered)).toBeUndefined()
  })

  test('returns undefined when v !== 1', async () => {
    const { sealCredentials, unsealCredentials } = await freshModule()
    const sealed = sealCredentials({ ok: true })
    expect(unsealCredentials({ enc: sealed.enc, v: 2 })).toBeUndefined()
    expect(unsealCredentials({ enc: sealed.enc, v: 0 })).toBeUndefined()
  })
})

describe('crypto-vault: getKey guards on ENCRYPTION_KEY', () => {
  const originalKey = process.env.ENCRYPTION_KEY

  test('throws a clear error when ENCRYPTION_KEY is unset', async () => {
    delete process.env.ENCRYPTION_KEY
    try {
      const { encryptSecret } = await freshModule()
      expect(() => encryptSecret('hi')).toThrow(/Secret storage is not configured/)
    } finally {
      // Restore so other tests still work.
      if (originalKey !== undefined) process.env.ENCRYPTION_KEY = originalKey
      else process.env.ENCRYPTION_KEY = TEST_KEY
    }
  })

  test('throws when ENCRYPTION_KEY is shorter than 8 chars', async () => {
    const saved = process.env.ENCRYPTION_KEY
    process.env.ENCRYPTION_KEY = 'short'
    try {
      const { encryptSecret } = await freshModule()
      expect(() => encryptSecret('hi')).toThrow(/Secret storage is not configured/)
    } finally {
      if (saved !== undefined) process.env.ENCRYPTION_KEY = saved
      else process.env.ENCRYPTION_KEY = TEST_KEY
    }
  })
})
