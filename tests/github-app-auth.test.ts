import { describe, expect, test } from 'bun:test'
import { createVerify, generateKeyPairSync } from 'node:crypto'
import { signAppJwt } from '../src/lib/github-app-auth'

describe('GitHub App JWT', () => {
  test('is RS256-signed with the app id as issuer and a short lifetime', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }) as string
    const now = 1_800_000_000
    const jwt = signAppJwt(12345, pem, now)
    const [h, p, sig] = jwt.split('.')
    const decode = (part: string) => JSON.parse(Buffer.from(part!.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString())
    expect(decode(h!)).toEqual({ alg: 'RS256', typ: 'JWT' })
    expect(decode(p!)).toEqual({ iat: now - 60, exp: now + 540, iss: '12345' })
    const verifier = createVerify('RSA-SHA256'); verifier.update(`${h}.${p}`)
    expect(verifier.verify(publicKey, Buffer.from(sig!.replace(/-/g, '+').replace(/_/g, '/'), 'base64'))).toBe(true)
  })
})
