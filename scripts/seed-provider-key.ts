/**
 * Store a provider key for the default organization without asking the
 * provider whether it is real.
 *
 * Provider keys belong to an organization and are normally added through
 * Organization → Models, which verifies them against the provider first. Tests
 * and demo environments need a key present so the paths that require one (for
 * example creating a project) behave like production, but they never call the
 * model. This writes the row directly, marked unverified.
 *
 *   bun run scripts/seed-provider-key.ts [provider] [key]
 *
 * Defaults to anthropic and a throwaway value. Refuses to run unless
 * ALLOW_UNVERIFIED_PROVIDER_KEY=1 is set, so it cannot be used by accident
 * against a real deployment.
 */

import { encryptSecret } from '../src/lib/crypto-vault'
import { getDb, closeDb } from '../src/lib/db'
import { getDefaultOrgId } from '../src/lib/orgs'
import { isProviderId } from '../src/lib/provider-keys'

const provider = process.argv[2] ?? 'anthropic'
const key = process.argv[3] ?? 'seeded-not-a-real-key'

if (process.env.ALLOW_UNVERIFIED_PROVIDER_KEY !== '1') {
  console.error('Refusing to store an unverified provider key. Set ALLOW_UNVERIFIED_PROVIDER_KEY=1 if this is a test environment.')
  process.exit(1)
}
if (!isProviderId(provider)) {
  console.error(`Unknown provider "${provider}".`)
  process.exit(1)
}

const orgId = await getDefaultOrgId()
await getDb()`
  INSERT INTO provider_keys (org_id, provider, key_enc, updated_at, last_verified_at, last_verify_status)
  VALUES (${orgId}, ${provider}, ${encryptSecret(key)}, now(), now(), 'unknown')
  ON CONFLICT (org_id, provider) DO UPDATE SET key_enc = EXCLUDED.key_enc, updated_at = now()
`
console.log(`stored an unverified ${provider} key for the default organization (${orgId})`)
await closeDb()
