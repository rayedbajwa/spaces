import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { $ } from 'bun'
import { decryptSecret, encryptSecret, resealSecret, sealCredentials, sealedWithCurrentKey } from '../src/lib/crypto-vault'
import { hasInternalToken, INTERNAL_TOKEN_HEADER } from '../src/lib/role'
import { applySchema, getDb } from '../src/lib/db'

const OLD = 'old-encryption-key-0123456789'
const NEW = 'new-encryption-key-9876543210'
const saved = { key: process.env.ENCRYPTION_KEY, prev: process.env.ENCRYPTION_KEY_PREVIOUS, token: process.env.SPACES_INTERNAL_TOKEN, tokenPrev: process.env.SPACES_INTERNAL_TOKEN_PREVIOUS }
afterEach(() => {
  process.env.ENCRYPTION_KEY = saved.key
  if (saved.prev === undefined) delete process.env.ENCRYPTION_KEY_PREVIOUS; else process.env.ENCRYPTION_KEY_PREVIOUS = saved.prev
  process.env.SPACES_INTERNAL_TOKEN = saved.token
  if (saved.tokenPrev === undefined) delete process.env.SPACES_INTERNAL_TOKEN_PREVIOUS; else process.env.SPACES_INTERNAL_TOKEN_PREVIOUS = saved.tokenPrev
})

describe('encryption key rotation', () => {
  test('during a rotation, values sealed with either key open; new ones use the new key', () => {
    process.env.ENCRYPTION_KEY = OLD
    const old = encryptSecret('sk-or-secret')
    process.env.ENCRYPTION_KEY = NEW
    delete process.env.ENCRYPTION_KEY_PREVIOUS
    expect(() => decryptSecret(old)).toThrow()
    process.env.ENCRYPTION_KEY_PREVIOUS = OLD
    expect(decryptSecret(old)).toBe('sk-or-secret')
    expect(sealedWithCurrentKey(old)).toBe(false)
    const resealed = resealSecret(old)
    expect(sealedWithCurrentKey(resealed)).toBe(true)
    delete process.env.ENCRYPTION_KEY_PREVIOUS
    expect(decryptSecret(resealed)).toBe('sk-or-secret')
  })
})

describe('internal token rotation', () => {
  const req = (token: string) => new Request('http://worker/internal/x', { headers: { [INTERNAL_TOKEN_HEADER]: token } })
  test('the previous token is accepted only while it is set', () => {
    process.env.SPACES_INTERNAL_TOKEN = 'new-internal-token'
    delete process.env.SPACES_INTERNAL_TOKEN_PREVIOUS
    expect(hasInternalToken(req('new-internal-token'))).toBe(true)
    expect(hasInternalToken(req('old-internal-token'))).toBe(false)
    process.env.SPACES_INTERNAL_TOKEN_PREVIOUS = 'old-internal-token'
    expect(hasInternalToken(req('old-internal-token'))).toBe(true)
    expect(hasInternalToken(req('something-else-entirely'))).toBe(false)
  })
})

// The migration against a real database (skipped without one).
const hasDb = Boolean(process.env.DATABASE_URL)
describe.skipIf(!hasDb)('scripts/rotate-encryption-key.ts', () => {
  const org = crypto.randomUUID()
  beforeAll(async () => {
    await applySchema()
    process.env.ENCRYPTION_KEY = OLD
    const sql = getDb()
    await sql`INSERT INTO organizations (org_id, name, slug) VALUES (${org}, 'Rotation test', ${`rotation-${org.slice(0, 8)}`})`
    await sql`INSERT INTO provider_keys (org_id, provider, key_enc) VALUES (${org}, 'openrouter', ${encryptSecret('sk-or-1')}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO oauth_apps (org_id, provider, client_id, client_secret_enc, config_json) VALUES (${org}, 'github', 'cid', ${encryptSecret('gh-secret')}, ${sql.json({ pemEnc: encryptSecret('-----PEM-----'), appSlug: 'x' } as never)}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO app_integrations (org_id, kind, credentials_json) VALUES (${org}, 'jira', ${sql.json(sealCredentials({ token: 'jira-token' }) as never)}) ON CONFLICT DO NOTHING`.catch(() => undefined)
  })
  afterAll(async () => {
    const sql = getDb()
    await sql`DELETE FROM provider_keys WHERE org_id = ${org}`
    await sql`DELETE FROM oauth_apps WHERE org_id = ${org}`
    await sql`DELETE FROM app_integrations WHERE org_id = ${org}`.catch(() => undefined)
    await sql`DELETE FROM organizations WHERE org_id = ${org}`
  })

  test('dry run writes nothing; --apply re-seals everything with the new key', async () => {
    const env = { ...process.env, ENCRYPTION_KEY: NEW, ENCRYPTION_KEY_PREVIOUS: OLD }
    const dry = await $`bun run scripts/rotate-encryption-key.ts`.env(env).text()
    expect(dry).toContain('Dry run')
    process.env.ENCRYPTION_KEY = NEW
    delete process.env.ENCRYPTION_KEY_PREVIOUS
    const sql = getDb()
    const [before] = await sql`SELECT key_enc FROM provider_keys WHERE org_id = ${org}`
    expect(sealedWithCurrentKey(before!.key_enc)).toBe(false)

    const applied = await $`bun run scripts/rotate-encryption-key.ts --apply`.env(env).text()
    expect(applied).toContain('Applied')
    const [key] = await sql`SELECT key_enc FROM provider_keys WHERE org_id = ${org}`
    const [app] = await sql`SELECT client_secret_enc, config_json FROM oauth_apps WHERE org_id = ${org}`
    expect(decryptSecret(key!.key_enc)).toBe('sk-or-1')
    expect(decryptSecret(app!.client_secret_enc)).toBe('gh-secret')
    expect(decryptSecret(app!.config_json.pemEnc)).toBe('-----PEM-----')
    expect(app!.config_json.appSlug).toBe('x')
    // JSON columns stay objects (not a JSON string) after the rewrite.
    const [types] = await sql`SELECT jsonb_typeof(config_json) AS t FROM oauth_apps WHERE org_id = ${org}`
    expect(types!.t).toBe('object')
  })
})
