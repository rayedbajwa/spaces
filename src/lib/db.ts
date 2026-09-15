import postgres from 'postgres'

const DEFAULT_URL = 'postgres://aidlc:aidlc@localhost:5432/aidlc'

let client: postgres.Sql | undefined

export function getDb(): postgres.Sql {
  if (!client) {
    client = postgres(process.env.DATABASE_URL ?? DEFAULT_URL, {
      max: 10,
      idle_timeout: 30,
      onnotice: () => undefined,
      types: {
        // Return TIMESTAMPTZ / TIMESTAMP as ISO strings so RunRow.createdAt/updatedAt
        // are consistent with the string types used by RunSnapshot and downstream sorts.
        timestamptz: {
          to: 1184,
          from: [1184],
          serialize: (v: Date | string) => (v instanceof Date ? v.toISOString() : v),
          parse: (v: string) => new Date(v).toISOString(),
        },
        timestamp: {
          to: 1114,
          from: [1114],
          serialize: (v: Date | string) => (v instanceof Date ? v.toISOString() : v),
          parse: (v: string) => new Date(v).toISOString(),
        },
      },
    })
  }
  return client
}

export function getDatabaseUrl(): string {
  return process.env.DATABASE_URL ?? DEFAULT_URL
}

/**
 * Apply db-schema.sql. Every statement in it is idempotent (IF NOT EXISTS /
 * ADD COLUMN IF NOT EXISTS), so this is safe to run on every server boot and
 * keeps a running database in step with the code without a manual migrate step.
 */
export async function applySchema(): Promise<void> {
  const { readFile } = await import('node:fs/promises')
  const { dirname, join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const schemaPath = join(dirname(fileURLToPath(import.meta.url)), 'db-schema.sql')
  const ddl = await readFile(schemaPath, 'utf8')
  await getDb().unsafe(ddl)
}

export async function closeDb(): Promise<void> {
  if (client) {
    await client.end({ timeout: 5 })
    client = undefined
  }
}
