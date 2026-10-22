/**
 * Re-seal every stored secret with the current ENCRYPTION_KEY.
 *
 *   ENCRYPTION_KEY=<new> ENCRYPTION_KEY_PREVIOUS=<old> bun run scripts/rotate-encryption-key.ts           # dry run
 *   ENCRYPTION_KEY=<new> ENCRYPTION_KEY_PREVIOUS=<old> bun run scripts/rotate-encryption-key.ts --apply   # write
 *
 * Covers provider keys, OAuth app secrets (and the GitHub App key, webhook and
 * Slack signing secrets in their config), app and project integration
 * credentials, and run guardrail vaults. One transaction: if any value opens
 * with neither key, nothing is written. A dry run does the same work and rolls
 * back, so its counts are exact. Afterwards ENCRYPTION_KEY_PREVIOUS can go.
 */

import { closeDb, getDb } from '../src/lib/db'
import { resealSecret, sealedWithCurrentKey } from '../src/lib/crypto-vault'

type Counts = { checked: number; current: number; resealed: number; unreadable: string[] }

const apply = process.argv.includes('--apply')
if (!process.env.ENCRYPTION_KEY_PREVIOUS?.trim()) {
  console.error('Set ENCRYPTION_KEY_PREVIOUS to the old key (and ENCRYPTION_KEY to the new one).')
  process.exit(1)
}

/** A secret as stored: re-sealed with the current key, unchanged if it already is. */
function reseal(value: string, where: string, counts: Counts): string {
  counts.checked += 1
  if (sealedWithCurrentKey(value)) { counts.current += 1; return value }
  try {
    const next = resealSecret(value)
    counts.resealed += 1
    return next
  } catch {
    counts.unreadable.push(where)
    return value
  }
}

// Text columns holding one sealed value.
const TEXT = [['provider_keys', 'key_enc'], ['oauth_apps', 'client_secret_enc'], ['run_guard_vaults', 'sealed']] as const
// JSONB columns holding { enc, v: 1 } (crypto-vault sealCredentials).
const SEALED_JSON = [['app_integrations', 'credentials_json'], ['project_integrations', 'credentials_json']] as const
// JSONB columns with sealed values in named fields.
const JSON_FIELDS = [['oauth_apps', 'config_json', ['pemEnc', 'webhookSecretEnc', 'signingSecretEnc']]] as const

class DryRun extends Error {}

const totals: Record<string, Counts> = {}
const sql = getDb()
try {
  await sql.begin(async (tx) => {
    for (const [table, column] of TEXT) {
      const counts = (totals[`${table}.${column}`] = { checked: 0, current: 0, resealed: 0, unreadable: [] })
      const rows = await tx.unsafe(`SELECT ctid::text AS ctid, ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL FOR UPDATE`)
      for (const row of rows) {
        const next = reseal(row.v, `${table} ${row.ctid}`, counts)
        if (next !== row.v) await tx.unsafe(`UPDATE ${table} SET ${column} = $1 WHERE ctid = $2::tid`, [next, row.ctid])
      }
    }
    for (const [table, column] of SEALED_JSON) {
      const counts = (totals[`${table}.${column}`] = { checked: 0, current: 0, resealed: 0, unreadable: [] })
      const rows = await tx.unsafe(`SELECT ctid::text AS ctid, ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL FOR UPDATE`)
      for (const row of rows) {
        const sealed = row.v as { enc?: string; v?: number }
        if (!sealed?.enc || sealed.v !== 1) continue
        const enc = reseal(sealed.enc, `${table} ${row.ctid}`, counts)
        if (enc !== sealed.enc) await tx.unsafe(`UPDATE ${table} SET ${column} = $1::text::jsonb WHERE ctid = $2::tid`, [JSON.stringify({ ...sealed, enc }), row.ctid])
      }
    }
    for (const [table, column, fields] of JSON_FIELDS) {
      const counts = (totals[`${table}.${column}`] = { checked: 0, current: 0, resealed: 0, unreadable: [] })
      const rows = await tx.unsafe(`SELECT ctid::text AS ctid, ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL FOR UPDATE`)
      for (const row of rows) {
        const config = { ...(row.v as Record<string, unknown>) }
        let changed = false
        for (const field of fields) {
          const value = config[field]
          if (typeof value !== 'string' || !value) continue
          const next = reseal(value, `${table} ${row.ctid} ${field}`, counts)
          if (next !== value) { config[field] = next; changed = true }
        }
        if (changed) await tx.unsafe(`UPDATE ${table} SET ${column} = $1::text::jsonb WHERE ctid = $2::tid`, [JSON.stringify(config), row.ctid])
      }
    }
    const unreadable = Object.values(totals).flatMap((c) => c.unreadable)
    if (unreadable.length) throw new Error(`${unreadable.length} value(s) open with neither key; nothing was written: ${unreadable.slice(0, 10).join(', ')}`)
    if (!apply) throw new DryRun()
  })
  console.log('Applied: every stored secret is now sealed with the current ENCRYPTION_KEY.')
} catch (error) {
  if (!(error instanceof DryRun)) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  } else {
    console.log('Dry run (nothing written). Run again with --apply to write.')
  }
} finally {
  for (const [where, c] of Object.entries(totals)) console.log(`  ${where}: ${c.checked} checked, ${c.resealed} to re-seal, ${c.current} already current, ${c.unreadable.length} unreadable`)
  await closeDb()
}
