/**
 * Inbound connectors (012-inbound-outbound-slack, US1/R1/R2).
 *
 * One connector per source with a shared shape: fetch since a cursor, normalize
 * to the common intake item, return the next cursor. Jira and Linear reuse the
 * existing Atlassian/Linear clients and their pagination; Datadog is a token
 * integration. Deduplication and storm aggregation happen in `upsertIntakeItem`,
 * not here. A failed fetch marks the source unhealthy and keeps queued items.
 */

import { getAppIntegrationCredentials } from './app-integrations'
import { getIntegrationAccessToken } from './integration-token'
import { atlassianAccess, atlassianFetchJson, linearGraphQL, LINEAR_ISSUE_FIELDS, adfToText, type JiraIssue, type LinearIssueNode } from './integration-sources'
import { getDb } from './db'
import { log } from './logger'
import { listDatadogEvents, severityToPriority, type DatadogCredentials } from './datadog'
import {
  dueIntakeSources,
  markSourceSyncFinished,
  markSourceSyncStarted,
  upsertIntakeItem,
  type IntakeItem,
  type IntakeSourceRow,
} from './intake-store'
import type { IntakeItemInput, IntakePriority, IntakeSource } from './intake-types'

const connectorLog = log.child({ mod: 'intake-connectors' })

export interface ConnectorItem extends IntakeItemInput {
  orgId: string
}

export interface ConnectorResult {
  items: ConnectorItem[]
  nextCursor: Record<string, unknown>
}

interface JiraConfig { jql?: string; projects?: string[] }
interface LinearConfig { teamKey?: string; teamId?: string }
interface DatadogConfig { site?: string; tags?: string[]; severity?: string }

function priorityFromLabel(label: string | undefined): IntakePriority {
  switch ((label ?? '').toLowerCase()) {
    case 'urgent': case 'p0': case 'critical': return 'urgent'
    case 'high': case 'p1': return 'high'
    case 'low': case 'p4': case 'minor': return 'low'
    default: return 'normal'
  }
}

// ---------------------------------------------------------------------------
// Jira
// ---------------------------------------------------------------------------

export async function fetchJiraItems(orgId: string, config: JiraConfig, cursor: Record<string, unknown>): Promise<ConnectorResult> {
  const access = await atlassianAccess(orgId, 'jira')
  const projects = (config.projects ?? []).filter(Boolean)
  const updatedSince = typeof cursor.updatedAt === 'string' ? cursor.updatedAt : undefined
  const clauses: string[] = []
  if (projects.length) clauses.push(`project in (${projects.map((p) => `"${p}"`).join(', ')})`)
  if (updatedSince) clauses.push(`updated >= "${updatedSince}"`)
  const jql = config.jql?.trim() || (clauses.length ? `${clauses.join(' AND ')} ORDER BY updated ASC` : 'ORDER BY updated ASC')
  const fields = 'summary,description,status,issuetype,priority,assignee,reporter,updated'
  const base = `https://api.atlassian.com/ex/jira/${access.cloudId}/rest/api/3`
  let issues: JiraIssue[]
  try {
    const data = await atlassianFetchJson<{ issues: JiraIssue[] }>(orgId, 'jira', `${base}/search/jql?jql=${encodeURIComponent(jql)}&maxResults=50&fields=${fields}`)
    issues = data.issues
  } catch {
    const data = await atlassianFetchJson<{ issues: JiraIssue[] }>(orgId, 'jira', `${base}/search?jql=${encodeURIComponent(jql)}&maxResults=50&fields=${fields}`)
    issues = data.issues
  }
  let latest = updatedSince ?? ''
  const items: ConnectorItem[] = issues.map((issue) => {
    if (issue.fields.updated && issue.fields.updated > latest) latest = issue.fields.updated
    return {
      orgId,
      source: 'jira' as const,
      externalRef: issue.key,
      externalUrl: `${access.siteUrl}/browse/${issue.key}`,
      sourceScope: issue.fields.status?.name ?? null,
      title: issue.fields.summary,
      summary: adfToText(issue.fields.description).trim().slice(0, 4000) || null,
      requesterName: issue.fields.reporter?.displayName ?? issue.fields.assignee?.displayName ?? null,
      requesterEmail: null,
      priority: priorityFromLabel(issue.fields.priority?.name),
      raw: { status: issue.fields.status?.name, type: issue.fields.issuetype?.name, labels: issue.fields.labels ?? [], updated: issue.fields.updated },
    }
  })
  return { items, nextCursor: { ...cursor, updatedAt: latest || undefined } }
}

// ---------------------------------------------------------------------------
// Linear
// ---------------------------------------------------------------------------

export async function fetchLinearItems(orgId: string, config: LinearConfig, cursor: Record<string, unknown>): Promise<ConnectorResult> {
  const updatedSince = typeof cursor.updatedAt === 'string' ? cursor.updatedAt : undefined
  const filter: Record<string, unknown> = {}
  if (config.teamKey) filter.team = { key: { eq: config.teamKey } }
  else if (config.teamId) filter.team = { id: { eq: config.teamId } }
  if (updatedSince) filter.updatedAt = { gt: updatedSince }
  const data = await linearGraphQL<{ issues: { nodes: LinearIssueNode[] } }>(
    orgId,
    `query Intake($first: Int!, $filter: IssueFilter) { issues(first: $first, filter: $filter, orderBy: updatedAt) { nodes { ${LINEAR_ISSUE_FIELDS} } } }`,
    { first: 50, filter: Object.keys(filter).length ? filter : null },
  )
  let latest = updatedSince ?? ''
  const items: ConnectorItem[] = (data.issues?.nodes ?? []).map((issue) => {
    if (issue.updatedAt && issue.updatedAt > latest) latest = issue.updatedAt
    return {
      orgId,
      source: 'linear' as const,
      externalRef: issue.identifier,
      externalUrl: issue.url,
      sourceScope: issue.team?.key ?? null,
      title: issue.title,
      summary: (issue.description ?? '').trim().slice(0, 4000) || null,
      requesterName: issue.assignee?.name ?? null,
      requesterEmail: null,
      priority: priorityFromLabel(issue.priorityLabel),
      raw: { status: issue.state?.name, labels: issue.labels?.nodes?.map((l) => l.name) ?? [], updated: issue.updatedAt, uuid: issue.id },
    }
  })
  return { items, nextCursor: { ...cursor, updatedAt: latest || undefined } }
}

// ---------------------------------------------------------------------------
// Datadog
// ---------------------------------------------------------------------------

export async function fetchDatadogItems(orgId: string, config: DatadogConfig, cursor: Record<string, unknown>): Promise<ConnectorResult> {
  const creds = await getAppIntegrationCredentials(orgId, 'datadog')
  if (!creds || typeof creds.api_key !== 'string' || typeof creds.app_key !== 'string') {
    throw new Error('Datadog is not connected, or its stored credentials can no longer be read.')
  }
  const credentials: DatadogCredentials = { apiKey: creds.api_key, appKey: creds.app_key, site: (config.site as string | undefined) ?? (creds.site as string | undefined) }
  const since = typeof cursor.since === 'number' ? cursor.since : undefined
  const events = await listDatadogEvents({ credentials, since, tags: config.tags, severity: config.severity })
  let latest = since ?? 0
  const items: ConnectorItem[] = events.map((event) => {
    if (event.timestamp > latest) latest = event.timestamp
    return {
      orgId,
      source: 'datadog' as const,
      externalRef: event.externalRef,
      externalUrl: event.link,
      sourceScope: event.service,
      title: event.title,
      summary: event.summary.slice(0, 4000) || null,
      requesterName: 'Datadog',
      requesterEmail: null,
      priority: event.priority,
      raw: { severity: event.severity, service: event.service, timestamp: event.timestamp },
    }
  })
  return { items, nextCursor: { ...cursor, since: latest || undefined } }
}

// ---------------------------------------------------------------------------
// Source sync
// ---------------------------------------------------------------------------

export function connectorFor(kind: IntakeSource): ((orgId: string, config: Record<string, unknown>, cursor: Record<string, unknown>) => Promise<ConnectorResult>) | undefined {
  switch (kind) {
    case 'jira': return fetchJiraItems as never
    case 'linear': return fetchLinearItems as never
    case 'datadog': return fetchDatadogItems as never
    default: return undefined
  }
}

export interface SyncOutcome {
  sourceId: string
  ok: boolean
  inserted: number
  updated: number
  error?: string
}

/** Sync one configured source: health, fetch, upsert, cursor. Never throws. */
export async function syncIntakeSource(source: IntakeSourceRow): Promise<SyncOutcome> {
  const connector = connectorFor(source.kind)
  if (!connector) return { sourceId: source.sourceId, ok: true, inserted: 0, updated: 0 }
  await markSourceSyncStarted(source.sourceId, source.orgId)
  try {
    const result = await connector(source.orgId, source.config, source.cursor)
    let inserted = 0
    let updated = 0
    for (const input of result.items) {
      const before = await existingItem(source.orgId, input.source, input.externalRef)
      const item = await upsertIntakeItem(input)
      if (before) updated += 1
      else inserted += 1
      void item
    }
    await markSourceSyncFinished({ sourceId: source.sourceId, orgId: source.orgId, status: 'ok', cursor: result.nextCursor, stats: { fetched: result.items.length, inserted, updated } })
    if (inserted || updated) connectorLog.info('intake source synced', { sourceId: source.sourceId, kind: source.kind, inserted, updated })
    return { sourceId: source.sourceId, ok: true, inserted, updated }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await markSourceSyncFinished({ sourceId: source.sourceId, orgId: source.orgId, status: 'error', error: message, stats: {} })
    connectorLog.warn('intake source sync failed', { sourceId: source.sourceId, kind: source.kind, error: message })
    return { sourceId: source.sourceId, ok: false, inserted: 0, updated: 0, error: message }
  }
}

async function existingItem(orgId: string, source: string, externalRef: string): Promise<boolean> {
  const [row] = await getDb()<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM intake_items WHERE org_id = ${orgId} AND source = ${source} AND external_ref = ${externalRef}
  `
  return (row?.n ?? 0) > 0
}

/** Worker entry: sync enabled sources whose interval has elapsed. */
export async function runIntakeSync(limit = 20): Promise<SyncOutcome[]> {
  const sources = await dueIntakeSources(limit)
  const out: SyncOutcome[] = []
  for (const source of sources) out.push(await syncIntakeSource(source))
  return out
}

/** The converted item's work link, used for the best-effort source update. */
export async function pushIntakeSourceUpdate(link: { intakeId: string; workKind: string }, item: IntakeItem): Promise<{ state: 'updated' | 'failed' | 'unsupported'; error?: string }> {
  const note = `Converted in Spaces to ${link.workKind} work.`
  if (item.source === 'jira') {
    try {
      const access = await atlassianAccess(item.orgId, 'jira')
      const token = await getIntegrationAccessToken(item.orgId, 'jira')
      const response = await fetch(
        `https://api.atlassian.com/ex/jira/${access.cloudId}/rest/api/3/issue/${encodeURIComponent(item.externalRef)}/comment`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: note }] }] } }),
        },
      )
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        return { state: 'failed', error: `Jira ${response.status}: ${text.slice(0, 200)}` }
      }
      return { state: 'updated' }
    } catch (error) {
      return { state: 'failed', error: error instanceof Error ? error.message : String(error) }
    }
  }
  if (item.source === 'linear') {
    const uuid = (item.raw as { uuid?: string } | undefined)?.uuid
    if (!uuid) return { state: 'unsupported' }
    try {
      const data = await linearGraphQL<{ commentCreate: { success: boolean } }>(
        item.orgId,
        `mutation Intake($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
        { input: { issueId: uuid, body: note } },
      )
      return data.commentCreate?.success ? { state: 'updated' } : { state: 'failed', error: 'Linear commentCreate failed.' }
    } catch (error) {
      return { state: 'failed', error: error instanceof Error ? error.message : String(error) }
    }
  }
  // Slack/Datadog items have no writable source ticket.
  return { state: 'unsupported' }
}

export { severityToPriority }
