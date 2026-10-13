/**
 * Create (or check) Arize Phoenix on Railway and point Spaces at it, by hand:
 *
 *   RAILWAY_PROVISIONER_TOKEN=… RAILWAY_PROVISIONER_TOKEN_TYPE=workspace \
 *   RAILWAY_PROJECT_ID=… RAILWAY_ENVIRONMENT_ID=… RAILWAY_SERVICE_ID=<spaces> \
 *   DATABASE_URL=… bun run phoenix:provision
 *
 * The same thing the web service does on start-up with PHOENIX_AUTO_PROVISION=1
 * (src/lib/phoenix-provision.ts). Safe to run again.
 */

import { ensurePhoenix } from '../src/lib/phoenix-provision'
import { closeDb } from '../src/lib/db'

const result = await ensurePhoenix({ ...process.env, PHOENIX_AUTO_PROVISION: '1' })
await closeDb().catch(() => undefined)
if (!result) {
  console.error('Phoenix was not provisioned; see the log above.')
  process.exit(1)
}
console.log(`Phoenix ${result.created ? 'created' : 'already there'}: service ${result.serviceId}`)
console.log(`  UI:        ${result.domain ? `https://${result.domain}` : '(no domain)'} (login admin@localhost; password in the service's PHOENIX_DEFAULT_ADMIN_INITIAL_PASSWORD)`)
console.log(`  Traces to: ${result.endpoint}`)
console.log(`  Workers given the tracing variables: ${result.workers}`)
