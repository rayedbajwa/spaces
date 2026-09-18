import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { getAppIntegration, getAppIntegrationCredentials, upsertAppIntegration, type AppIntegrationKind } from './app-integrations'
import { getDb } from './db'
import { getIntegrationAccessToken, refreshIntegrationTokens } from './integration-token'
import { getProject, listRepos, type ProjectKnowledgeConfig } from './project-registry'
import { hasOrgKnowledge, renderKnowledgeHits, searchOrgKnowledge } from './knowledge-store'

/**
 * Effective knowledge scope for one project: which sources are exposed and how
 * queries are narrowed. Resolved from the project's knowledge_json plus its
 * registered GitHub repos.
 */
export interface KnowledgeScope {
  /** Sources the project allows (already intersected with what is connected). */
  sources: KnowledgeSource[]
  jiraProjects: string[]
  linearTeams: string[]
  linearProjects: string[]
  confluenceSpaces: string[]
  githubRepos: string[]
}

export async function resolveKnowledgeScope(projectId?: string): Promise<KnowledgeScope> {
  const connected = await listConnectedKnowledgeSources()
  if (!projectId) {
    return { sources: connected, jiraProjects: [], linearTeams: [], linearProjects: [], confluenceSpaces: [], githubRepos: [] }
  }
  const project = await getProject(projectId)
  const config: ProjectKnowledgeConfig = project?.knowledgeJson ?? {}
  const repos = await listRepos(projectId)
  const registeredRepos = repos.map((r) => r.githubRepo).filter((r): r is string => Boolean(r))
  const allowed = config.sources?.length ? connected.filter((s) => config.sources!.includes(s)) : connected
  return {
    sources: allowed,
    jiraProjects: config.jira?.projects?.map((p) => p.trim().toUpperCase()).filter(Boolean) ?? [],
    linearTeams: config.linear?.teams?.map((t) => t.trim().toUpperCase()).filter(Boolean) ?? [],
    linearProjects: config.linear?.projects?.map((p) => p.trim()).filter(Boolean) ?? [],
    confluenceSpaces: config.confluence?.spaces?.map((s) => s.trim().toUpperCase()).filter(Boolean) ?? [],
    githubRepos: config.github?.repos?.length ? config.github.repos : registeredRepos,
  }
}

function describeScope(scope: KnowledgeScope): string {
  const parts: string[] = []
  if (scope.sources.includes('jira')) parts.push(`Jira${scope.jiraProjects.length ? ` (projects ${scope.jiraProjects.join(', ')})` : ''}`)
  if (scope.sources.includes('linear')) parts.push(`Linear${scope.linearTeams.length ? ` (teams ${scope.linearTeams.join(', ')})` : ''}${scope.linearProjects.length ? ` (projects ${scope.linearProjects.join(', ')})` : ''}`)
  if (scope.sources.includes('confluence')) parts.push(`Confluence${scope.confluenceSpaces.length ? ` (spaces ${scope.confluenceSpaces.join(', ')})` : ''}`)
  if (scope.sources.includes('github')) parts.push(`GitHub${scope.githubRepos.length ? ` (${scope.githubRepos.join(', ')})` : ''}`)
  return parts.join('; ')
}

/**
 * Integrations as knowledge. One small, uniform surface over Jira, Confluence,
 * Linear and GitHub issues that (a) the server exposes for "import from …" flows
 * and (b) agents get as `integration_search` / `integration_get` tools, so they pull
 * ticket and doc context on demand instead of having everything dumped into the
 * prompt. Only connected integrations are exposed; tool descriptions say which.
 */

export type KnowledgeSource = 'jira' | 'confluence' | 'linear' | 'github'

export interface KnowledgeHit {
  source: KnowledgeSource
  id: string
  title: string
  url?: string
  snippet?: string
  type?: string
  status?: string
  updatedAt?: string
}

export interface KnowledgeDoc {
  source: KnowledgeSource
  id: string
  title: string
  url?: string
  type: string
  content: string
  metadata: Record<string, unknown>
}

export class KnowledgeSourceNotConnectedError extends Error {
  constructor(public readonly source: KnowledgeSource) {
    super(`${SOURCE_LABEL[source]} is not connected. Connect it under Integrations first.`)
    this.name = 'KnowledgeSourceNotConnectedError'
  }
}

export const SOURCE_LABEL: Record<KnowledgeSource, string> = {
  jira: 'Jira',
  confluence: 'Confluence',
  linear: 'Linear',
  github: 'GitHub',
}

const SOURCE_KIND: Record<KnowledgeSource, AppIntegrationKind> = {
  jira: 'jira',
  confluence: 'confluence',
  linear: 'linear',
  github: 'github',
}

export async function listConnectedKnowledgeSources(): Promise<KnowledgeSource[]> {
  const out: KnowledgeSource[] = []
  for (const source of Object.keys(SOURCE_KIND) as KnowledgeSource[]) {
    const row = await getAppIntegration(SOURCE_KIND[source])
    if (row?.status === 'connected') out.push(source)
  }
  return out
}

async function requireToken(source: KnowledgeSource): Promise<string> {
  const kind = SOURCE_KIND[source]
  const row = await getAppIntegration(kind)
  if (row?.status !== 'connected') throw new KnowledgeSourceNotConnectedError(source)
  // Refreshes expiring tokens (Atlassian hourly, GitHub App user tokens every
  // 8h); throws IntegrationCredentialsError when the stored token cannot be read.
  return getIntegrationAccessToken(kind)
}

function clip(text: string, max: number): string {
  const trimmed = text.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

// ---------------------------------------------------------------------------
// Linear (GraphQL)
// ---------------------------------------------------------------------------

export async function linearGraphQL<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const token = await requireToken('linear')
  const response = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Linear API ${response.status}: ${text.slice(0, 300)}`)
  }
  const payload = (await response.json()) as { data?: T; errors?: Array<{ message: string }> }
  if (payload.errors?.length) throw new Error(`Linear API: ${payload.errors.map((e) => e.message).join('; ')}`)
  if (!payload.data) throw new Error('Linear API returned no data.')
  return payload.data
}

export interface LinearIssueNode {
  id: string
  identifier: string
  title: string
  description?: string | null
  url: string
  updatedAt?: string
  priorityLabel?: string
  state?: { name: string } | null
  team?: { key: string; name: string } | null
  project?: { name: string } | null
  assignee?: { name: string } | null
  labels?: { nodes: Array<{ name: string }> }
}

export const LINEAR_ISSUE_FIELDS = `
  id identifier title description url updatedAt priorityLabel
  state { name } team { key name } project { name } assignee { name } labels { nodes { name } }
`

async function linearSearch(query: string, limit: number, scope?: KnowledgeScope): Promise<KnowledgeHit[]> {
  // Exact identifier (ENG-123) → fetch directly; otherwise full-text search.
  if (/^[A-Z][A-Z0-9]+-\d+$/i.test(query.trim())) {
    try {
      const doc = await linearGet(query.trim())
      return [{ source: 'linear', id: doc.id, title: doc.title, url: doc.url, snippet: clip(doc.content, 240), type: 'issue', status: String(doc.metadata.status ?? '') }]
    } catch {
      // fall through to search
    }
  }
  // Project scope → narrow to the selected teams/projects.
  const filter: Record<string, unknown> = {}
  if (scope?.linearTeams.length) filter.team = { key: { in: scope.linearTeams } }
  if (scope?.linearProjects.length) filter.project = { name: { in: scope.linearProjects } }
  const data = await linearGraphQL<{ searchIssues: { nodes: LinearIssueNode[] } }>(
    `query Search($term: String!, $first: Int!, $filter: IssueFilter) { searchIssues(term: $term, first: $first, filter: $filter) { nodes { ${LINEAR_ISSUE_FIELDS} } } }`,
    { term: query, first: limit, filter: Object.keys(filter).length ? filter : null },
  )
  return data.searchIssues.nodes.map((n) => ({
    source: 'linear' as const,
    id: n.identifier,
    title: n.title,
    url: n.url,
    snippet: clip(n.description ?? '', 240),
    type: 'issue',
    status: n.state?.name,
    updatedAt: n.updatedAt,
  }))
}

async function linearGet(identifier: string): Promise<KnowledgeDoc> {
  const data = await linearGraphQL<{ issue: LinearIssueNode | null }>(
    `query Issue($id: String!) { issue(id: $id) { ${LINEAR_ISSUE_FIELDS} comments(first: 20) { nodes { body createdAt user { name } } } } }`,
    { id: identifier },
  )
  const issue = data.issue as (LinearIssueNode & { comments?: { nodes: Array<{ body: string; createdAt: string; user?: { name: string } | null }> } }) | null
  if (!issue) throw new Error(`Linear issue "${identifier}" not found.`)
  const comments = issue.comments?.nodes ?? []
  const content = [
    `# ${issue.identifier}: ${issue.title}`,
    `State: ${issue.state?.name ?? 'unknown'} · Team: ${issue.team?.name ?? '?'} · Project: ${issue.project?.name ?? '—'} · Priority: ${issue.priorityLabel ?? '—'} · Assignee: ${issue.assignee?.name ?? 'unassigned'}`,
    issue.labels?.nodes.length ? `Labels: ${issue.labels.nodes.map((l) => l.name).join(', ')}` : '',
    '',
    issue.description?.trim() || '_No description._',
    comments.length ? `\n## Comments\n${comments.map((c) => `- **${c.user?.name ?? 'someone'}** (${c.createdAt}): ${c.body.trim()}`).join('\n')}` : '',
  ].filter((line) => line !== '').join('\n')
  return {
    source: 'linear',
    id: issue.identifier,
    title: issue.title,
    url: issue.url,
    type: 'issue',
    content,
    metadata: { status: issue.state?.name, team: issue.team?.key, project: issue.project?.name, priority: issue.priorityLabel, uuid: issue.id },
  }
}

// ---------------------------------------------------------------------------
// Atlassian (Jira + Confluence share one OAuth token)
// ---------------------------------------------------------------------------

interface AtlassianAccess {
  token: string
  cloudId: string
  siteUrl: string
}

export async function atlassianAccess(source: 'jira' | 'confluence'): Promise<AtlassianAccess> {
  const token = await requireToken(source)
  const row = await getAppIntegration(source)
  const cached = row?.configJson as { cloudId?: string; siteUrl?: string } | undefined
  if (cached?.cloudId && cached.siteUrl) return { token, cloudId: cached.cloudId, siteUrl: cached.siteUrl }

  const resources = await atlassianFetchJson<Array<{ id: string; url: string; scopes: string[] }>>(
    source,
    'https://api.atlassian.com/oauth/token/accessible-resources',
  )
  const wanted = source === 'jira' ? /jira/ : /confluence/
  const site = resources.find((r) => r.scopes.some((s) => wanted.test(s))) ?? resources[0]
  if (!site) throw new Error('Atlassian account has no accessible sites for this token.')
  await upsertAppIntegration({ kind: source, status: 'connected', config: { cloudId: site.id, siteUrl: site.url } })
  return { token, cloudId: site.id, siteUrl: site.url }
}

/** GET with one automatic token refresh on 401 (Atlassian access tokens last an hour). */
export async function atlassianFetchJson<T>(source: 'jira' | 'confluence', url: string, attempt = 0): Promise<T> {
  const token = await requireToken(source)
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } })
  if (response.status === 401 && attempt === 0) {
    const creds = await getAppIntegrationCredentials(source)
    if (typeof creds?.refresh_token === 'string' && creds.refresh_token) {
      await refreshIntegrationTokens(source, creds)
      return atlassianFetchJson<T>(source, url, 1)
    }
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    if (response.status === 410) {
      throw new Error(`${SOURCE_LABEL[source]} has retired the API endpoint this feature used (${url.replace(/\?.*$/, '')}). Please report this so it can be moved to the replacement endpoint.`)
    }
    if (response.status === 401 && /scope does not match/i.test(text)) {
      const needed = source === 'confluence'
        ? 'read:confluence-content.all, read:confluence-content.summary, read:confluence-space.summary, search:confluence'
        : 'read:jira-work, read:jira-user'
      throw new Error(`${SOURCE_LABEL[source]} refused the request because the Atlassian app's token lacks a required scope. In the Atlassian developer console give the app these ${SOURCE_LABEL[source]} scopes (${needed}), then disconnect and reconnect Atlassian under Integrations so a new token is issued.`)
    }
    throw new Error(`${SOURCE_LABEL[source]} API ${response.status}: ${text.slice(0, 300)}`)
  }
  return (await response.json()) as T
}

/** Flatten Atlassian Document Format (Jira v3 descriptions/comments) to plain text. */
export function adfToText(node: unknown): string {
  if (!node || typeof node !== 'object') return ''
  const n = node as { type?: string; text?: string; content?: unknown[]; attrs?: Record<string, unknown> }
  if (n.type === 'text') return n.text ?? ''
  if (n.type === 'hardBreak') return '\n'
  if (n.type === 'mention') return String(n.attrs?.text ?? '@someone')
  const inner = (n.content ?? []).map(adfToText).join(n.type === 'paragraph' || n.type === 'heading' || n.type === 'listItem' || n.type === 'tableRow' ? '' : '')
  switch (n.type) {
    case 'paragraph': return `${inner}\n`
    case 'heading': return `\n${'#'.repeat(Number(n.attrs?.level ?? 2))} ${inner}\n`
    case 'bulletList': case 'orderedList': return `${inner}\n`
    case 'listItem': return `- ${inner.trim()}\n`
    case 'codeBlock': return `\n\`\`\`\n${inner}\n\`\`\`\n`
    case 'tableRow': return `| ${(n.content ?? []).map((c) => adfToText(c).trim()).join(' | ')} |\n`
    case 'tableCell': case 'tableHeader': return inner
    default: return inner
  }
}

export interface JiraIssue {
  key: string
  fields: {
    summary: string
    description?: unknown
    status?: { name: string }
    issuetype?: { name: string }
    priority?: { name: string }
    labels?: string[]
    assignee?: { displayName: string } | null
    updated?: string
    comment?: { comments: Array<{ author?: { displayName: string }; created: string; body: unknown }> }
  }
}

/** Insert an extra AND clause into a JQL/CQL string, keeping any ORDER BY at the end. */
function withScopeClause(query: string, clause: string | undefined): string {
  if (!clause) return query
  const match = /\s+ORDER\s+BY\s+/i.exec(query)
  const where = match ? query.slice(0, match.index) : query
  const order = match ? query.slice(match.index) : ''
  return `(${where.trim()}) AND ${clause}${order}`
}

async function jiraSearch(query: string, limit: number, scope?: KnowledgeScope): Promise<KnowledgeHit[]> {
  const access = await atlassianAccess('jira')
  const isKey = /^[A-Z][A-Z0-9_]+-\d+$/i.test(query.trim())
  const rawJql = isKey
    ? `key = ${query.trim().toUpperCase()}`
    : /\b(=|~|ORDER BY|AND|OR)\b/i.test(query) ? query : `text ~ "${query.replace(/"/g, '\\"')}" ORDER BY updated DESC`
  const projectClause = scope?.jiraProjects.length && !isKey ? `project in (${scope.jiraProjects.map((p) => `"${p}"`).join(', ')})` : undefined
  const jql = withScopeClause(rawJql, projectClause)
  const fields = 'summary,status,issuetype,priority,updated'
  const base = `https://api.atlassian.com/ex/jira/${access.cloudId}/rest/api/3`
  let issues: JiraIssue[]
  try {
    const data = await atlassianFetchJson<{ issues: JiraIssue[] }>('jira', `${base}/search/jql?jql=${encodeURIComponent(jql)}&maxResults=${limit}&fields=${fields}`)
    issues = data.issues
  } catch {
    const data = await atlassianFetchJson<{ issues: JiraIssue[] }>('jira', `${base}/search?jql=${encodeURIComponent(jql)}&maxResults=${limit}&fields=${fields}`)
    issues = data.issues
  }
  return issues.map((i) => ({
    source: 'jira' as const,
    id: i.key,
    title: i.fields.summary,
    url: `${access.siteUrl}/browse/${i.key}`,
    type: i.fields.issuetype?.name ?? 'issue',
    status: i.fields.status?.name,
    updatedAt: i.fields.updated,
  }))
}

async function jiraGet(key: string): Promise<KnowledgeDoc> {
  const access = await atlassianAccess('jira')
  const issue = await atlassianFetchJson<JiraIssue>(
    'jira',
    `https://api.atlassian.com/ex/jira/${access.cloudId}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,status,issuetype,priority,labels,assignee,updated,comment`,
  )
  const comments = issue.fields.comment?.comments ?? []
  const content = [
    `# ${issue.key}: ${issue.fields.summary}`,
    `Type: ${issue.fields.issuetype?.name ?? '?'} · Status: ${issue.fields.status?.name ?? '?'} · Priority: ${issue.fields.priority?.name ?? '—'} · Assignee: ${issue.fields.assignee?.displayName ?? 'unassigned'}`,
    issue.fields.labels?.length ? `Labels: ${issue.fields.labels.join(', ')}` : '',
    '',
    adfToText(issue.fields.description).trim() || '_No description._',
    comments.length ? `\n## Comments\n${comments.slice(-20).map((c) => `- **${c.author?.displayName ?? 'someone'}** (${c.created}): ${adfToText(c.body).trim()}`).join('\n')}` : '',
  ].filter((line) => line !== '').join('\n')
  return {
    source: 'jira',
    id: issue.key,
    title: issue.fields.summary,
    url: `${access.siteUrl}/browse/${issue.key}`,
    type: issue.fields.issuetype?.name ?? 'issue',
    content,
    metadata: { status: issue.fields.status?.name, priority: issue.fields.priority?.name, labels: issue.fields.labels ?? [] },
  }
}

export function htmlToText(html: string): string {
  return html
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export interface ConfluencePage {
  id: string
  title: string
  type?: string
  _links?: { webui?: string }
  body?: { storage?: { value: string } }
  version?: { when?: string }
  space?: { name?: string }
}

async function confluenceSearch(query: string, limit: number, scope?: KnowledgeScope): Promise<KnowledgeHit[]> {
  const access = await atlassianAccess('confluence')
  const rawCql = /\b(=|~|AND|OR|type)\b/.test(query) && /[=~]/.test(query) ? query : `text ~ "${query.replace(/"/g, '\\"')}" AND type = page ORDER BY lastmodified DESC`
  const spaceClause = scope?.confluenceSpaces.length ? `space in (${scope.confluenceSpaces.map((s) => `"${s}"`).join(', ')})` : undefined
  const cql = withScopeClause(rawCql, spaceClause)
  const data = await atlassianFetchJson<{ results: ConfluencePage[] }>(
    'confluence',
    `https://api.atlassian.com/ex/confluence/${access.cloudId}/wiki/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=${limit}&expand=version,space`,
  )
  return data.results.map((p) => ({
    source: 'confluence' as const,
    id: p.id,
    title: p.title,
    url: p._links?.webui ? `${access.siteUrl}/wiki${p._links.webui}` : undefined,
    type: p.type ?? 'page',
    snippet: p.space?.name ? `Space: ${p.space.name}` : undefined,
    updatedAt: p.version?.when,
  }))
}

async function confluenceGet(id: string): Promise<KnowledgeDoc> {
  const access = await atlassianAccess('confluence')
  // The v1 /content/{id} endpoint was retired; a CQL search by id returns the same page with its body.
  const data = await atlassianFetchJson<{ results: ConfluencePage[] }>(
    'confluence',
    `https://api.atlassian.com/ex/confluence/${access.cloudId}/wiki/rest/api/content/search?cql=${encodeURIComponent(`id = ${id.replace(/[^0-9]/g, '')}`)}&limit=1&expand=body.storage,version,space`,
  )
  const page = data.results[0]
  if (!page) throw new Error(`Confluence page "${id}" not found or not visible to the connected account.`)
  const text = htmlToText(page.body?.storage?.value ?? '')
  return {
    source: 'confluence',
    id: page.id,
    title: page.title,
    url: page._links?.webui ? `${access.siteUrl}/wiki${page._links.webui}` : undefined,
    type: page.type ?? 'page',
    content: `# ${page.title}\n${page.space?.name ? `Space: ${page.space.name}\n` : ''}\n${text || '_Empty page._'}`,
    metadata: { space: page.space?.name, updatedAt: page.version?.when },
  }
}

// ---------------------------------------------------------------------------
// GitHub issues / pull requests (scoped to the project's repos when known)
// ---------------------------------------------------------------------------

interface GitHubSearchItem {
  number: number
  title: string
  html_url: string
  state: string
  body?: string | null
  updated_at?: string
  pull_request?: unknown
  repository_url: string
}

export async function githubFetchJson<T>(url: string): Promise<T> {
  const token = await requireToken('github')
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'pi-speckit-pdlc' },
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`GitHub API ${response.status}: ${text.slice(0, 300)}`)
  }
  return (await response.json()) as T
}

function repoFromApiUrl(url: string): string {
  return url.replace(/^https:\/\/api\.github\.com\/repos\//, '')
}

async function githubSearch(query: string, limit: number, repos: string[]): Promise<KnowledgeHit[]> {
  const scope = repos.length ? repos.map((r) => `repo:${r}`).join(' ') : ''
  const q = /\brepo:/.test(query) || !scope ? query : `${query} ${scope}`
  const data = await githubFetchJson<{ items: GitHubSearchItem[] }>(`https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=${limit}&sort=updated`)
  return data.items.map((i) => ({
    source: 'github' as const,
    id: `${repoFromApiUrl(i.repository_url)}#${i.number}`,
    title: i.title,
    url: i.html_url,
    type: i.pull_request ? 'pull_request' : 'issue',
    status: i.state,
    snippet: clip(i.body ?? '', 240),
    updatedAt: i.updated_at,
  }))
}

async function githubGet(id: string, repos: string[]): Promise<KnowledgeDoc> {
  const match = /^(?:([\w.-]+\/[\w.-]+))?#?(\d+)$/.exec(id.trim())
  if (!match) throw new Error(`GitHub item id must look like owner/name#123 (got "${id}").`)
  const repo = match[1] ?? repos[0]
  if (!repo) throw new Error(`GitHub item "${id}" needs a repository (owner/name#number).`)
  const number = match[2]
  const issue = await githubFetchJson<GitHubSearchItem & { comments_url: string; user?: { login: string }; labels?: Array<{ name: string }> }>(`https://api.github.com/repos/${repo}/issues/${number}`)
  const comments = await githubFetchJson<Array<{ user?: { login: string }; created_at: string; body?: string | null }>>(`${issue.comments_url}?per_page=20`).catch(() => [])
  const content = [
    `# ${repo}#${issue.number}: ${issue.title}`,
    `${issue.pull_request ? 'Pull request' : 'Issue'} · State: ${issue.state} · Author: ${issue.user?.login ?? '?'}${issue.labels?.length ? ` · Labels: ${issue.labels.map((l) => l.name).join(', ')}` : ''}`,
    '',
    issue.body?.trim() || '_No description._',
    comments.length ? `\n## Comments\n${comments.map((c) => `- **${c.user?.login ?? 'someone'}** (${c.created_at}): ${(c.body ?? '').trim()}`).join('\n')}` : '',
  ].filter((line) => line !== '').join('\n')
  return {
    source: 'github',
    id: `${repo}#${issue.number}`,
    title: issue.title,
    url: issue.html_url,
    type: issue.pull_request ? 'pull_request' : 'issue',
    content,
    metadata: { state: issue.state, repo, number: issue.number },
  }
}

// ---------------------------------------------------------------------------
// Unified surface
// ---------------------------------------------------------------------------

export async function searchKnowledge(options: { source: KnowledgeSource; query: string; limit?: number; repos?: string[]; scope?: KnowledgeScope }): Promise<KnowledgeHit[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 10, 25))
  const query = options.query.trim()
  if (!query) return []
  if (options.scope && !options.scope.sources.includes(options.source)) {
    throw new Error(`${SOURCE_LABEL[options.source]} is not in this project's knowledge scope.`)
  }
  switch (options.source) {
    case 'linear': return linearSearch(query, limit, options.scope)
    case 'jira': return jiraSearch(query, limit, options.scope)
    case 'confluence': return confluenceSearch(query, limit, options.scope)
    case 'github': return githubSearch(query, limit, options.repos?.length ? options.repos : (options.scope?.githubRepos ?? []))
  }
}

export async function getKnowledgeItem(options: { source: KnowledgeSource; id: string; repos?: string[] }): Promise<KnowledgeDoc> {
  switch (options.source) {
    case 'linear': return linearGet(options.id)
    case 'jira': return jiraGet(options.id)
    case 'confluence': return confluenceGet(options.id)
    case 'github': return githubGet(options.id, options.repos ?? [])
  }
}

/**
 * Persist an imported item as a project source snapshot so every later stage
 * sees it in the shared context bundle. Replaces an older snapshot of the same item.
 */
export async function saveKnowledgeSnapshot(projectId: string, doc: KnowledgeDoc, scope?: string): Promise<void> {
  const sql = getDb()
  await sql.begin(async (tx) => {
    await tx`DELETE FROM project_source_snapshots WHERE project_id = ${projectId} AND source = ${doc.source} AND entity_id = ${doc.id}`
    await tx`
      INSERT INTO project_source_snapshots (project_id, source, scope, entity_type, entity_id, title, content, url, metadata)
      VALUES (${projectId}, ${doc.source}, ${scope ?? null}, ${doc.type}, ${doc.id}, ${doc.title}, ${doc.content}, ${doc.url ?? null}, ${tx.json(doc.metadata as never)})
    `
  })
}

// ---------------------------------------------------------------------------
// Agent tools
// ---------------------------------------------------------------------------

function textResult(text: string, details: unknown = {}) {
  return { content: [{ type: 'text' as const, text }], details }
}

/**
 * `integration_search` + `integration_get` for agent sessions. Built per session so
 * the description reflects what is actually connected right now; when nothing is
 * connected no tools are added and the agent is not tempted to call them.
 */
export async function buildKnowledgeTools(options: { projectId?: string; repos?: string[] } = {}): Promise<ToolDefinition[]> {
  // Project scope decides which sources are exposed and how queries are narrowed;
  // without a project, every connected source is available unscoped.
  const scope = await resolveKnowledgeScope(options.projectId)
  const connected = scope.sources
  // The organization knowledge base (imported spaces, projects, repos, notes) is
  // searchable whenever it has content the project's team may see.
  const teamId = options.projectId ? (await getProject(options.projectId).catch(() => undefined))?.teamId ?? null : null
  const knowledgeScope = { teamIds: teamId ? [teamId] : [] }
  const orgKnowledge = await hasOrgKnowledge(knowledgeScope).catch(() => false)
  const tools: ToolDefinition[] = []
  if (orgKnowledge) tools.push(buildOrgKnowledgeTool(knowledgeScope))
  if (connected.length === 0) return tools
  const repos = options.repos?.length ? options.repos : scope.githubRepos
  const sourceList = describeScope(scope)
  const idHints: string[] = []
  if (connected.includes('jira')) idHints.push('Jira: issue key like PROJ-123')
  if (connected.includes('linear')) idHints.push('Linear: identifier like ENG-123')
  if (connected.includes('confluence')) idHints.push('Confluence: numeric page id')
  if (connected.includes('github')) idHints.push(`GitHub: owner/name#123${repos.length ? ` (defaults to ${repos[0]})` : ''}`)

  const sourceSchema = { type: 'string', enum: connected, description: `Which system to query. Connected: ${sourceList}.` }

  const search: ToolDefinition = {
    name: 'integration_search',
    label: 'Search connected knowledge',
    description: `Search the team's connected knowledge sources (${sourceList}) for tickets, epics, pull requests or documentation. Use it when the spec, plan or tasks reference a ticket key, a customer request, a design doc, or when you need requirements/acceptance criteria that are not in the repo. Prefer one targeted search over many broad ones; then call integration_get for the full text of the 1–3 most relevant hits.`,
    promptSnippet: `integration_search(source, query): find tickets/docs in ${sourceList}`,
    promptGuidelines: [
      `When a ticket key or doc is referenced (e.g. PROJ-123, ENG-45, a Confluence page), fetch it with integration_search/integration_get before designing or implementing — do not guess requirements.`,
      'Cite the source id (ticket key, page id, PR number) in artifacts you write so reviewers can trace decisions.',
    ],
    parameters: {
      type: 'object',
      properties: {
        source: sourceSchema,
        query: { type: 'string', description: 'Free text, an exact ticket key, or a native query (JQL for Jira, CQL for Confluence, GitHub search syntax).' },
        limit: { type: 'integer', minimum: 1, maximum: 25, description: 'Max results (default 10).' },
      },
      required: ['source', 'query'],
    } as unknown as ToolDefinition['parameters'],
    executionMode: 'parallel',
    async execute(_toolCallId, params) {
      const p = params as { source: KnowledgeSource; query: string; limit?: number }
      try {
        const hits = await searchKnowledge({ source: p.source, query: p.query, limit: p.limit, repos, scope })
        if (hits.length === 0) return textResult(`No ${SOURCE_LABEL[p.source]} results for "${p.query}".`, { hits: [] })
        const lines = hits.map((h) => `- [${h.id}] ${h.title}${h.status ? ` (${h.status})` : ''}${h.type ? ` · ${h.type}` : ''}${h.url ? ` · ${h.url}` : ''}${h.snippet ? `\n    ${h.snippet}` : ''}`)
        return textResult(`${hits.length} ${SOURCE_LABEL[p.source]} result${hits.length === 1 ? '' : 's'} for "${p.query}":\n${lines.join('\n')}\n\nCall integration_get(source, id) for full content.`, { hits })
      } catch (error) {
        return textResult(`integration_search failed: ${error instanceof Error ? error.message : String(error)}`, { error: true })
      }
    },
  }

  const get: ToolDefinition = {
    name: 'integration_get',
    label: 'Read a knowledge item',
    description: `Fetch the full content (description, status, comments) of one item from ${sourceList}. Ids: ${idHints.join('; ')}.`,
    promptSnippet: 'integration_get(source, id): full ticket/doc text',
    parameters: {
      type: 'object',
      properties: {
        source: sourceSchema,
        id: { type: 'string', description: `Item id. ${idHints.join('; ')}.` },
      },
      required: ['source', 'id'],
    } as unknown as ToolDefinition['parameters'],
    executionMode: 'parallel',
    async execute(_toolCallId, params) {
      const p = params as { source: KnowledgeSource; id: string }
      try {
        const doc = await getKnowledgeItem({ source: p.source, id: p.id, repos })
        return textResult(`${doc.url ? `Source: ${doc.url}\n\n` : ''}${clip(doc.content, 24_000)}`, { source: doc.source, id: doc.id, url: doc.url })
      } catch (error) {
        return textResult(`integration_get failed: ${error instanceof Error ? error.message : String(error)}`, { error: true })
      }
    },
  }

  tools.push(search, get)
  return tools
}

/**
 * `org_knowledge_search`: semantic + full-text search over the organization
 * knowledge base — Confluence spaces, Jira/Linear projects and initiatives,
 * repository docs, web pages and notes imported by the team.
 */
function buildOrgKnowledgeTool(scope: { teamIds: string[] }): ToolDefinition {
  return {
    name: 'org_knowledge_search',
    label: 'Search organization knowledge',
    description: 'Search the organization knowledge base (imported Confluence spaces, Jira and Linear projects and initiatives, repository documentation, web pages and team notes) with a natural-language question. Returns the most relevant excerpts with their source links. Use it for standards, architecture decisions, runbooks, product context and past decisions before designing or implementing; prefer it over guessing.',
    promptSnippet: 'org_knowledge_search(query): relevant excerpts from the organization knowledge base',
    promptGuidelines: [
      'Before proposing a design or convention, check org_knowledge_search for existing standards, ADRs and prior decisions; follow them or say why you deviate.',
      'Cite the excerpt source (title or link) in artifacts so reviewers can trace the decision.',
    ],
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A natural-language question or topic, e.g. "how do we roll back a payments deploy" or "authentication standards".' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Max excerpts (default 6).' },
      },
      required: ['query'],
    } as unknown as ToolDefinition['parameters'],
    executionMode: 'parallel',
    async execute(_toolCallId, params) {
      const p = params as { query: string; limit?: number }
      try {
        const { hits, mode } = await searchOrgKnowledge({ query: p.query, scope, limit: p.limit ?? 6 })
        if (hits.length === 0) return textResult(`No organization knowledge matched "${p.query}".`, { hits: [] })
        return textResult(`${hits.length} excerpt${hits.length === 1 ? '' : 's'} (${mode} search) for "${p.query}":\n\n${renderKnowledgeHits(hits, { maxCharsPerHit: 1_800 })}`, { hits: hits.map((h) => ({ title: h.title, url: h.url, source: h.sourceLabel, score: h.score })) })
      } catch (error) {
        return textResult(`org_knowledge_search failed: ${error instanceof Error ? error.message : String(error)}`, { error: true })
      }
    },
  }
}
