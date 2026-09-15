import { getDb } from './db'
import { sealCredentials, unsealCredentials } from './crypto-vault'

export type AppIntegrationKind = 'github' | 'jira' | 'confluence' | 'slack' | 'linear'
export type AppIntegrationStatus = 'not_connected' | 'pending' | 'connected' | 'error'

export interface AppIntegrationRow {
  kind: AppIntegrationKind
  status: AppIntegrationStatus
  displayName?: string
  configJson: Record<string, unknown>
  lastSyncedAt?: string
  lastSyncError?: string
  createdAt: string
  updatedAt: string
}

const COLS = `
  kind, status,
  display_name AS "displayName",
  config_json  AS "configJson",
  last_synced_at AS "lastSyncedAt",
  last_sync_error AS "lastSyncError",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`

export async function listAppIntegrations(): Promise<AppIntegrationRow[]> {
  const sql = getDb()
  return await sql<AppIntegrationRow[]>`SELECT ${sql.unsafe(COLS)} FROM app_integrations ORDER BY kind`
}

export async function getAppIntegration(kind: AppIntegrationKind): Promise<AppIntegrationRow | undefined> {
  const sql = getDb()
  const [row] = await sql<AppIntegrationRow[]>`SELECT ${sql.unsafe(COLS)} FROM app_integrations WHERE kind = ${kind}`
  return row
}

export async function upsertAppIntegration(input: {
  kind: AppIntegrationKind
  status?: AppIntegrationStatus
  displayName?: string
  config?: Record<string, unknown>
  credentials?: Record<string, unknown>
}): Promise<AppIntegrationRow> {
  const sql = getDb()
  const sealed = input.credentials ? sealCredentials(input.credentials) : null
  const [row] = await sql<AppIntegrationRow[]>`
    INSERT INTO app_integrations (kind, status, display_name, config_json, credentials_json)
    VALUES (
      ${input.kind}, ${input.status ?? 'not_connected'}, ${input.displayName ?? null},
      ${sql.json((input.config ?? {}) as never)},
      ${sealed ? sql.json(sealed as never) : null}
    )
    ON CONFLICT (kind) DO UPDATE SET
      status = EXCLUDED.status,
      display_name = COALESCE(EXCLUDED.display_name, app_integrations.display_name),
      config_json = app_integrations.config_json || EXCLUDED.config_json,
      credentials_json = COALESCE(EXCLUDED.credentials_json, app_integrations.credentials_json)
    RETURNING ${sql.unsafe(COLS)}
  `
  return row
}

export async function disconnectAppIntegration(kind: AppIntegrationKind): Promise<void> {
  const sql = getDb()
  await sql`
    UPDATE app_integrations
       SET status = 'not_connected', credentials_json = NULL, last_sync_error = NULL
     WHERE kind = ${kind}
  `
}

export async function getAppIntegrationCredentials(kind: AppIntegrationKind): Promise<Record<string, unknown> | undefined> {
  const sql = getDb()
  const [row] = await sql<Array<{ credentialsJson: unknown }>>`
    SELECT credentials_json AS "credentialsJson" FROM app_integrations WHERE kind = ${kind}
  `
  return row?.credentialsJson ? unsealCredentials(row.credentialsJson) : undefined
}
