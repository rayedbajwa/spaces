import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

/**
 * AES-256-GCM at-rest encryption for OAuth credentials.
 *
 * Requires ENCRYPTION_KEY env var (any length string — derived to 32-byte key via scrypt).
 * If unset, throws loudly on first use so we never accidentally store secrets in plaintext.
 *
 * Ciphertext format: base64(iv || authTag || ciphertext)
 */

const ALGO = 'aes-256-gcm'
const IV_LEN = 12
const TAG_LEN = 16
// Frozen at v1 — changing this invalidates every previously-encrypted OAuth
// credential blob in the DB. To rotate, bump to v2 + write a migration that
// re-encrypts with the new salt.
const SALT = Buffer.from('pi-speckit-aidlc-v1', 'utf8')

let cachedKey: Buffer | undefined

function getKey(): Buffer {
  if (cachedKey) return cachedKey
  const raw = process.env.ENCRYPTION_KEY
  if (!raw || raw.length < 8) {
    throw new Error('ENCRYPTION_KEY env var must be set (>= 8 chars) before encrypting/decrypting credentials.')
  }
  cachedKey = scryptSync(raw, SALT, 32)
  return cachedKey
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv(ALGO, getKey(), iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, enc]).toString('base64')
}

export function decryptSecret(ciphertext: string): string {
  const buf = Buffer.from(ciphertext, 'base64')
  const iv = buf.subarray(0, IV_LEN)
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN)
  const enc = buf.subarray(IV_LEN + TAG_LEN)
  const decipher = createDecipheriv(ALGO, getKey(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
}

/** Encrypt an entire JSON credential blob for storage in JSONB. */
export function sealCredentials(payload: Record<string, unknown>): { enc: string; v: 1 } {
  return { enc: encryptSecret(JSON.stringify(payload)), v: 1 }
}

export function unsealCredentials(sealed: unknown): Record<string, unknown> | undefined {
  if (!sealed || typeof sealed !== 'object') return undefined
  const s = sealed as { enc?: string; v?: number }
  if (!s.enc || s.v !== 1) return undefined
  try {
    return JSON.parse(decryptSecret(s.enc)) as Record<string, unknown>
  } catch {
    return undefined
  }
}
