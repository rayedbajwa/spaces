import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

/**
 * AES-256-GCM at-rest encryption for OAuth credentials.
 *
 * Requires ENCRYPTION_KEY env var (any length string — derived to 32-byte key via scrypt).
 * If unset, throws loudly on first use so we never accidentally store secrets in plaintext.
 *
 * Ciphertext format: base64(iv || authTag || ciphertext)
 *
 * Rotating the key: set the new key as ENCRYPTION_KEY and the old one as
 * ENCRYPTION_KEY_PREVIOUS. New values are sealed with the new key; values
 * sealed with either key still open. scripts/rotate-encryption-key.ts then
 * re-seals everything stored with the new key, after which
 * ENCRYPTION_KEY_PREVIOUS can be removed.
 */

const ALGO = 'aes-256-gcm'
const IV_LEN = 12
const TAG_LEN = 16
// Frozen at v1 — changing this invalidates every previously-encrypted OAuth
// credential blob in the DB. To rotate, bump to v2 + write a migration that
// re-encrypts with the new salt.
const SALT = Buffer.from('pi-speckit-aidlc-v1', 'utf8')

const derived = new Map<string, Buffer>()
const derive = (raw: string) => {
  let key = derived.get(raw)
  if (!key) { key = scryptSync(raw, SALT, 32); derived.set(raw, key) }
  return key
}

function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY
  if (!raw || raw.length < 8) {
    // User-facing: never name the variable. The startup check in env.ts tells the operator which one is missing.
    throw new Error('Secret storage is not configured on this server, so credentials cannot be saved or read. Ask an administrator to finish the server setup.')
  }
  return derive(raw)
}

/** The key values are sealed with, then the one being rotated out (if any). */
function getKeys(): Buffer[] {
  const previous = process.env.ENCRYPTION_KEY_PREVIOUS?.trim()
  return previous && previous.length >= 8 && previous !== process.env.ENCRYPTION_KEY ? [getKey(), derive(previous)] : [getKey()]
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv(ALGO, getKey(), iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, enc]).toString('base64')
}

function decryptWith(key: Buffer, ciphertext: string): string {
  const buf = Buffer.from(ciphertext, 'base64')
  const iv = buf.subarray(0, IV_LEN)
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN)
  const enc = buf.subarray(IV_LEN + TAG_LEN)
  const decipher = createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
}

/** Opens a value sealed with the current key or, during a rotation, the previous one. */
export function decryptSecret(ciphertext: string): string {
  const keys = getKeys()
  for (let i = 0; i < keys.length; i += 1) {
    try { return decryptWith(keys[i]!, ciphertext) } catch (error) { if (i === keys.length - 1) throw error }
  }
  throw new Error('unreachable')
}

/** Whether a value is already sealed with the current key (the rotation leaves those alone). */
export function sealedWithCurrentKey(ciphertext: string): boolean {
  try { decryptWith(getKey(), ciphertext); return true } catch { return false }
}

/** The same secret sealed with the current key. Throws if no key opens it. */
export function resealSecret(ciphertext: string): string {
  return encryptSecret(decryptSecret(ciphertext))
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
