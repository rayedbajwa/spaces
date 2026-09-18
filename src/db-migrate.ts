#!/usr/bin/env bun
import { applySchema, closeDb, getDatabaseUrl } from './lib/db'
import { log } from './lib/logger'

const migrateLog = log.child({ mod: 'db-migrate' })

try {
  migrateLog.info('applying schema', { databaseUrl: getDatabaseUrl() })
  // Same code path as the server's boot-time apply: db-schema.sql plus the
  // guarded pgvector step (extension, embedding column, HNSW index).
  const vector = await applySchema().then(() => import('./lib/db')).then((m) => m.vectorSearchAvailable())
  migrateLog.info('schema applied', { vectorSearch: vector })
} catch (error) {
  migrateLog.error('migration failed', error instanceof Error ? error : new Error(String(error)))
  process.exitCode = 1
} finally {
  await closeDb()
}
