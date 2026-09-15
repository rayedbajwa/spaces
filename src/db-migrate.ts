#!/usr/bin/env bun
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeDb, getDb, getDatabaseUrl } from './lib/db'
import { log } from './lib/logger'

const migrateLog = log.child({ mod: 'db-migrate' })

const srcDir = dirname(fileURLToPath(import.meta.url))
const schemaPath = join(srcDir, 'lib', 'db-schema.sql')

const sql = getDb()

try {
  const ddl = await readFile(schemaPath, 'utf8')
  migrateLog.info('applying schema', { databaseUrl: getDatabaseUrl() })
  await sql.unsafe(ddl)
  migrateLog.info('schema applied')
} catch (error) {
  migrateLog.error('migration failed', error instanceof Error ? error : new Error(String(error)))
  process.exitCode = 1
} finally {
  await closeDb()
}
