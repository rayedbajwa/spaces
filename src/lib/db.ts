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
  await applyVectorSchema()
}

let vectorSchemaReady: boolean | undefined

/**
 * pgvector is optional: the extension needs superuser rights to create and is
 * missing from plain postgres images. Applied separately from db-schema.sql so
 * a failure here only disables vector search (knowledge falls back to
 * full-text search) instead of aborting the whole schema.
 */
export async function applyVectorSchema(): Promise<boolean> {
  const { EMBEDDING_DIMENSIONS } = await import('./embeddings')
  try {
    await getDb().unsafe(`
      CREATE EXTENSION IF NOT EXISTS vector;
      ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS embedding vector(${EMBEDDING_DIMENSIONS});
      CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_idx ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);
    `)
    vectorSchemaReady = true
  } catch (error) {
    vectorSchemaReady = false
    // eslint-disable-next-line no-console
    console.warn(`[db] pgvector unavailable; organization knowledge uses full-text search only (${error instanceof Error ? error.message : String(error)})`)
  }
  return vectorSchemaReady
}

/** True when knowledge_chunks.embedding exists (pgvector installed and schema applied). */
export async function vectorSearchAvailable(): Promise<boolean> {
  if (vectorSchemaReady !== undefined) return vectorSchemaReady
  try {
    const [row] = await getDb()<Array<{ ok: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns WHERE table_name = 'knowledge_chunks' AND column_name = 'embedding'
      ) AS ok`
    vectorSchemaReady = Boolean(row?.ok)
  } catch {
    vectorSchemaReady = false
  }
  return vectorSchemaReady
}

export async function closeDb(): Promise<void> {
  if (client) {
    await client.end({ timeout: 5 })
    client = undefined
  }
}
