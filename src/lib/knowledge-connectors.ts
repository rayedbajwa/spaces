/**
 * Connectors that turn a knowledge source into documents, and catalogs that
 * list what each integration offers to import (Confluence spaces, Jira
 * projects, Linear teams/projects/initiatives, GitHub repositories).
 *
 * Each connector returns one batch: the documents it fetched, the cursor to
 * persist for the next incremental import, `hasMore` when it stopped at the
 * batch cap, and `complete` when the batch enumerated the whole source (only
 * then may documents missing from it be deleted). Connectors reuse the OAuth
 * clients of the on-demand integration tools, so the same connected apps feed
 * both.
 */

import {
  adfToText,
  atlassianAccess,
  atlassianFetchJson,
  githubFetchJson,
  htmlToText,
  LINEAR_ISSUE_FIELDS,
  linearGraphQL,
  type ConfluencePage,
  type JiraIssue,
  type LinearIssueNode,
} from './integration-sources'
import type { KnowledgeDocumentInput, KnowledgeSourceKind, KnowledgeSourceRow } from './knowledge-store'

export interface SyncBatch {
  documents: KnowledgeDocumentInput[]
  cursor: Record<string, unknown>
  /** The batch listed every current item of the source. */
  complete: boolean
  /** Stopped at the batch cap; run again right away. */
  hasMore: boolean
  /** Items seen but deliberately not indexed (too large, binary, unreachable). */
  skipped?: number
}

/** Documents per batch; keeps one import bounded in time and memory. */
export const MAX_DOCS_PER_BATCH = 300

export async function fetchSourceBatch(source: KnowledgeSourceRow): Promise<SyncBatch> {
  switch (source.kind) {
    case 'confluence': return importConfluence(source)
    case 'jira': return importJira(source)
    case 'linear': return importLinear(source)
    case 'github_repo': return importGitHubRepo(source)
    case 'github_issues': return importGitHubIssues(source)
    case 'url': return importUrls(source)
    case 'manual': return { documents: [], cursor: source.cursor, complete: false, hasMore: false }
  }
}

/** Human-readable check of a source configuration; returns an error message or undefined. */
export function validateSourceConfig(kind: KnowledgeSourceKind, config: Record<string, unknown>): string | undefined {
  const list = (key: string) => strings(config[key])
  switch (kind) {
    case 'confluence': return list('spaces').length ? undefined : 'Pick at least one Confluence space.'
    case 'jira': return list('projects').length || typeof config.jql === 'string' ? undefined : 'Pick at least one Jira project or give a JQL filter.'
    case 'linear': return list('teams').length || list('projects').length || list('initiatives').length ? undefined : 'Pick at least one Linear team, project or initiative.'
    case 'github_repo': return /^[\w.-]+\/[\w.-]+$/.test(String(config.repo ?? '')) ? undefined : 'Repository must be owner/name.'
    case 'github_issues': return /^[\w.-]+\/[\w.-]+$/.test(String(config.repo ?? '')) ? undefined : 'Repository must be owner/name.'
    case 'url': {
      const urls = list('urls')
      if (!urls.length) return 'Add at least one URL.'
      const bad = urls.find((u) => !/^https?:\/\//i.test(u))
      return bad ? `"${bad}" is not an http(s) URL.` : undefined
    }
    case 'manual': return undefined
  }
}

function strings(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean)
  if (typeof value === 'string') return value.split(/[,\n]/).map((v) => v.trim()).filter(Boolean)
  return []
}

const quote = (s: string) => `"${s.replace(/"/g, '\\"')}"`

// ---------------------------------------------------------------------------
// Catalogs: what can be imported from each connected integration
// ---------------------------------------------------------------------------

export interface CatalogEntry {
  id: string
  name: string
  description?: string
  /** For Linear: which picker this belongs to. */
  group?: 'teams' | 'projects' | 'initiatives'
}

export type CatalogIntegration = 'confluence' | 'jira' | 'linear' | 'github'

export async function listImportCatalog(integration: CatalogIntegration): Promise<CatalogEntry[]> {
  switch (integration) {
    case 'confluence': {
      // Atlassian retired the v1 /space listing; site search with `type = space`
      // still works with the classic scopes and returns every visible space.
      const access = await atlassianAccess('confluence')
      const out: CatalogEntry[] = []
      let start = 0
      for (;;) {
        const page = await atlassianFetchJson<{ results: Array<{ space?: { key: string; name: string; type?: string } }>; size: number; _links?: { next?: string } }>(
          'confluence', `https://api.atlassian.com/ex/confluence/${access.cloudId}/wiki/rest/api/search?cql=${encodeURIComponent('type = space ORDER BY title')}&limit=100&start=${start}`,
        )
        for (const r of page.results) {
          if (!r.space) continue
          out.push({ id: r.space.key, name: `${r.space.name} (${r.space.key})`, description: r.space.type === 'personal' ? 'Personal space' : r.space.type && r.space.type !== 'global' ? r.space.type : undefined })
        }
        start += page.results.length
        if (!page._links?.next || page.results.length === 0 || out.length >= 500) break
      }
      return out.sort((a, b) => a.name.localeCompare(b.name))
    }
    case 'jira': {
      const access = await atlassianAccess('jira')
      const out: CatalogEntry[] = []
      let startAt = 0
      for (;;) {
        const page = await atlassianFetchJson<{ values: Array<{ key: string; name: string; projectTypeKey?: string }>; isLast?: boolean; total?: number }>(
          'jira', `https://api.atlassian.com/ex/jira/${access.cloudId}/rest/api/3/project/search?maxResults=100&startAt=${startAt}&orderBy=name`,
        )
        for (const p of page.values) out.push({ id: p.key, name: `${p.name} (${p.key})`, description: p.projectTypeKey })
        startAt += page.values.length
        if (page.isLast || page.values.length === 0 || out.length >= 500) break
      }
      return out
    }
    case 'linear': {
      const data = await linearGraphQL<{
        teams: { nodes: Array<{ key: string; name: string }> }
        projects: { nodes: Array<{ id: string; name: string; state?: string }> }
        initiatives: { nodes: Array<{ id: string; name: string; status?: string }> }
      }>(
        `query Catalog { teams(first: 50) { nodes { key name } } projects(first: 100) { nodes { id name state } } initiatives(first: 50) { nodes { id name status } } }`,
        {},
      )
      return [
        ...data.teams.nodes.map((t) => ({ id: t.key, name: `${t.name} (${t.key})`, group: 'teams' as const })),
        ...data.projects.nodes.map((p) => ({ id: p.name, name: p.name, description: p.state, group: 'projects' as const })),
        ...data.initiatives.nodes.map((i) => ({ id: i.id, name: i.name, description: i.status, group: 'initiatives' as const })),
      ]
    }
    case 'github': {
      const { listRepoCatalog } = await import('./governance')
      const rows = await listRepoCatalog(500)
      if (rows.length > 0) return rows.map((r) => ({ id: r.fullName, name: r.fullName, description: r.usecase ?? r.description ?? undefined }))
      const { listGitHubRepos } = await import('./github')
      return (await listGitHubRepos({ maxPages: 3 })).map((r) => ({ id: r.fullName, name: r.fullName, description: r.description ?? undefined }))
    }
  }
}

// ---------------------------------------------------------------------------
// Confluence: every page of the chosen spaces, incremental by lastmodified
// ---------------------------------------------------------------------------

async function importConfluence(source: KnowledgeSourceRow): Promise<SyncBatch> {
  const spaces = strings(source.config.spaces).map((s) => s.toUpperCase())
  const since = typeof source.cursor.lastModified === 'string' ? source.cursor.lastModified : undefined
  const access = await atlassianAccess('confluence')
  const clauses = [`type = page`, `space in (${spaces.map(quote).join(', ')})`]
  // CQL takes "yyyy-MM-dd HH:mm"; step back an hour so clock skew cannot skip a page.
  if (since) clauses.push(`lastmodified >= "${cqlDate(new Date(new Date(since).getTime() - 60 * 60_000))}"`)
  const cql = `${clauses.join(' AND ')} ORDER BY lastmodified ASC`

  const documents: KnowledgeDocumentInput[] = []
  let start = 0
  let hasMore = false
  let lastModified = since
  for (;;) {
    const page = await atlassianFetchJson<{ results: ConfluencePage[]; _links?: { next?: string } }>(
      'confluence',
      `https://api.atlassian.com/ex/confluence/${access.cloudId}/wiki/rest/api/content/search?cql=${encodeURIComponent(cql)}&start=${start}&limit=25&expand=body.storage,version,space`,
    )
    for (const p of page.results) {
      const text = htmlToText(p.body?.storage?.value ?? '')
      documents.push({
        externalId: p.id,
        title: p.title,
        url: p._links?.webui ? `${access.siteUrl}/wiki${p._links.webui}` : undefined,
        content: `${p.space?.name ? `Space: ${p.space.name}\n\n` : ''}${text || '_Empty page._'}`,
        metadata: { space: p.space?.name, type: p.type },
        sourceUpdatedAt: p.version?.when,
      })
      if (p.version?.when && (!lastModified || p.version.when > lastModified)) lastModified = p.version.when
    }
    start += page.results.length
    if (page.results.length === 0 || !page._links?.next) break
    if (documents.length >= MAX_DOCS_PER_BATCH) { hasMore = true; break }
  }
  return { documents, cursor: { ...source.cursor, lastModified }, complete: !since && !hasMore, hasMore }
}

function cqlDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

// ---------------------------------------------------------------------------
// Jira: issues of the chosen projects (or a JQL filter), incremental by updated
// ---------------------------------------------------------------------------

async function importJira(source: KnowledgeSourceRow): Promise<SyncBatch> {
  const projects = strings(source.config.projects).map((p) => p.toUpperCase())
  const customJql = typeof source.config.jql === 'string' && source.config.jql.trim() ? source.config.jql.trim() : undefined
  const since = typeof source.cursor.updated === 'string' ? source.cursor.updated : undefined
  const access = await atlassianAccess('jira')
  const where: string[] = []
  if (customJql) where.push(`(${customJql.replace(/\s+ORDER\s+BY[\s\S]*$/i, '')})`)
  else where.push(`project in (${projects.map(quote).join(', ')})`)
  // JQL dates are read in the account's timezone; a day of slack covers any offset.
  if (since) where.push(`updated >= "${jqlDate(new Date(new Date(since).getTime() - 24 * 60 * 60_000))}"`)
  const jql = `${where.join(' AND ')} ORDER BY updated ASC`
  const fields = 'summary,description,status,issuetype,priority,labels,assignee,updated,comment'
  const base = `https://api.atlassian.com/ex/jira/${access.cloudId}/rest/api/3`

  const documents: KnowledgeDocumentInput[] = []
  let updated = since
  let hasMore = false
  let nextPageToken: string | undefined
  let startAt = 0
  let legacy = false
  for (;;) {
    let issues: JiraIssue[] = []
    let last = true
    if (!legacy) {
      try {
        const data = await atlassianFetchJson<{ issues: JiraIssue[]; nextPageToken?: string; isLast?: boolean }>(
          'jira', `${base}/search/jql?jql=${encodeURIComponent(jql)}&maxResults=50&fields=${fields}${nextPageToken ? `&nextPageToken=${encodeURIComponent(nextPageToken)}` : ''}`,
        )
        issues = data.issues
        nextPageToken = data.nextPageToken
        last = data.isLast ?? !data.nextPageToken
      } catch {
        legacy = true
      }
    }
    if (legacy) {
      const data = await atlassianFetchJson<{ issues: JiraIssue[]; total: number }>('jira', `${base}/search?jql=${encodeURIComponent(jql)}&maxResults=50&startAt=${startAt}&fields=${fields}`)
      issues = data.issues
      startAt += issues.length
      last = startAt >= data.total || issues.length === 0
    }
    for (const issue of issues) {
      documents.push(jiraIssueDocument(issue, access.siteUrl))
      if (issue.fields.updated && (!updated || issue.fields.updated > updated)) updated = issue.fields.updated
    }
    if (last) break
    if (documents.length >= MAX_DOCS_PER_BATCH) { hasMore = true; break }
  }
  return { documents, cursor: { ...source.cursor, updated }, complete: !since && !hasMore, hasMore }
}

function jqlDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

function jiraIssueDocument(issue: JiraIssue, siteUrl: string): KnowledgeDocumentInput {
  const comments = issue.fields.comment?.comments ?? []
  const content = [
    `Type: ${issue.fields.issuetype?.name ?? '?'} · Status: ${issue.fields.status?.name ?? '?'} · Priority: ${issue.fields.priority?.name ?? '—'} · Assignee: ${issue.fields.assignee?.displayName ?? 'unassigned'}`,
    issue.fields.labels?.length ? `Labels: ${issue.fields.labels.join(', ')}` : '',
    '',
    adfToText(issue.fields.description).trim() || '_No description._',
    comments.length ? `\n## Comments\n${comments.slice(-20).map((c) => `- **${c.author?.displayName ?? 'someone'}** (${c.created}): ${adfToText(c.body).trim()}`).join('\n')}` : '',
  ].filter((line) => line !== '').join('\n')
  return {
    externalId: issue.key,
    title: `${issue.key}: ${issue.fields.summary}`,
    url: `${siteUrl}/browse/${issue.key}`,
    content,
    metadata: { status: issue.fields.status?.name, type: issue.fields.issuetype?.name, labels: issue.fields.labels ?? [] },
    sourceUpdatedAt: issue.fields.updated,
  }
}

// ---------------------------------------------------------------------------
// Linear: teams, projects and initiatives. Initiatives and projects are
// indexed as documents themselves (their descriptions carry the "why"), then
// every issue under them, incremental by updatedAt.
// ---------------------------------------------------------------------------

type LinearSyncNode = LinearIssueNode & { comments?: { nodes: Array<{ body: string; createdAt: string; user?: { name: string } | null }> } }

async function importLinear(source: KnowledgeSourceRow): Promise<SyncBatch> {
  const teams = strings(source.config.teams).map((t) => t.toUpperCase())
  const projectNames = new Set(strings(source.config.projects))
  const initiativeIds = strings(source.config.initiatives)
  const since = typeof source.cursor.updatedAt === 'string' ? source.cursor.updatedAt : undefined
  const documents: KnowledgeDocumentInput[] = []

  // Initiatives: one document each, plus their projects join the project set.
  for (const id of initiativeIds) {
    const data = await linearGraphQL<{ initiative: { id: string; name: string; description?: string | null; content?: string | null; status?: string; url?: string; updatedAt?: string; projects: { nodes: Array<{ name: string }> } } | null }>(
      `query Initiative($id: String!) { initiative(id: $id) { id name description content status url updatedAt projects(first: 50) { nodes { name } } } }`,
      { id },
    )
    const initiative = data.initiative
    if (!initiative) continue
    for (const p of initiative.projects.nodes) projectNames.add(p.name)
    documents.push({
      externalId: `initiative:${initiative.id}`,
      title: `Initiative: ${initiative.name}`,
      url: initiative.url,
      content: [
        `Status: ${initiative.status ?? 'unknown'} · Projects: ${initiative.projects.nodes.map((p) => p.name).join(', ') || '—'}`,
        '',
        initiative.description?.trim() ?? '',
        initiative.content?.trim() ?? '',
      ].filter(Boolean).join('\n'),
      metadata: { kind: 'initiative', status: initiative.status },
      sourceUpdatedAt: initiative.updatedAt,
    })
  }

  // Projects: one document each (description + content).
  if (projectNames.size > 0) {
    const data = await linearGraphQL<{ projects: { nodes: Array<{ id: string; name: string; description?: string | null; content?: string | null; state?: string; url?: string; updatedAt?: string; lead?: { name: string } | null; teams: { nodes: Array<{ key: string }> } }> } }>(
      `query Projects($filter: ProjectFilter) { projects(first: 50, filter: $filter) { nodes { id name description content state url updatedAt lead { name } teams { nodes { key } } } } }`,
      { filter: { name: { in: [...projectNames] } } },
    )
    for (const p of data.projects.nodes) {
      documents.push({
        externalId: `project:${p.id}`,
        title: `Project: ${p.name}`,
        url: p.url,
        content: [
          `State: ${p.state ?? 'unknown'} · Lead: ${p.lead?.name ?? '—'} · Teams: ${p.teams.nodes.map((t) => t.key).join(', ') || '—'}`,
          '',
          p.description?.trim() ?? '',
          p.content?.trim() ?? '',
        ].filter(Boolean).join('\n'),
        metadata: { kind: 'project', state: p.state },
        sourceUpdatedAt: p.updatedAt,
      })
    }
  }

  // Issues under the chosen teams and/or projects.
  const filter: Record<string, unknown> = {}
  const or: Array<Record<string, unknown>> = []
  if (teams.length) or.push({ team: { key: { in: teams } } })
  if (projectNames.size) or.push({ project: { name: { in: [...projectNames] } } })
  if (or.length === 1) Object.assign(filter, or[0])
  else if (or.length > 1) filter.or = or
  if (since) filter.updatedAt = { gt: since }

  let updatedAt = since
  let after: string | undefined
  let hasMore = false
  if (or.length > 0) {
    for (;;) {
      // Linear caps query complexity at 10 000; 50 issues × 20 comments blew past it.
      const data = await linearGraphQL<{ issues: { nodes: LinearSyncNode[]; pageInfo: { hasNextPage: boolean; endCursor?: string } } }>(
        `query Sync($filter: IssueFilter, $after: String) {
           issues(filter: $filter, first: 20, after: $after, orderBy: updatedAt) {
             nodes { ${LINEAR_ISSUE_FIELDS} comments(first: 10) { nodes { body createdAt user { name } } } }
             pageInfo { hasNextPage endCursor }
           }
         }`,
        { filter, after: after ?? null },
      )
      for (const issue of data.issues.nodes) {
        const comments = issue.comments?.nodes ?? []
        documents.push({
          externalId: issue.identifier,
          title: `${issue.identifier}: ${issue.title}`,
          url: issue.url,
          content: [
            `State: ${issue.state?.name ?? 'unknown'} · Team: ${issue.team?.name ?? '?'} · Project: ${issue.project?.name ?? '—'} · Priority: ${issue.priorityLabel ?? '—'} · Assignee: ${issue.assignee?.name ?? 'unassigned'}`,
            issue.labels?.nodes.length ? `Labels: ${issue.labels.nodes.map((l) => l.name).join(', ')}` : '',
            '',
            issue.description?.trim() || '_No description._',
            comments.length ? `\n## Comments\n${comments.map((c) => `- **${c.user?.name ?? 'someone'}** (${c.createdAt}): ${c.body.trim()}`).join('\n')}` : '',
          ].filter((line) => line !== '').join('\n'),
          metadata: { kind: 'issue', status: issue.state?.name, team: issue.team?.key, project: issue.project?.name },
          sourceUpdatedAt: issue.updatedAt,
        })
        if (issue.updatedAt && (!updatedAt || issue.updatedAt > updatedAt)) updatedAt = issue.updatedAt
      }
      if (!data.issues.pageInfo.hasNextPage) break
      after = data.issues.pageInfo.endCursor
      if (documents.length >= MAX_DOCS_PER_BATCH) { hasMore = true; break }
    }
  }
  return { documents, cursor: { ...source.cursor, updatedAt }, complete: !since && !hasMore, hasMore }
}

// ---------------------------------------------------------------------------
// GitHub repository docs: text files of one branch, re-read when the head moves
// ---------------------------------------------------------------------------

const DEFAULT_INCLUDE = ['*.md', '*.mdx', '*.markdown', '*.rst', '*.adoc', '*.txt']
const MAX_FILE_BYTES = 200_000
const MAX_FILES = 500

async function importGitHubRepo(source: KnowledgeSourceRow): Promise<SyncBatch> {
  const repo = String(source.config.repo)
  const include = strings(source.config.include)
  const patterns = include.length ? include : DEFAULT_INCLUDE
  const info = await githubFetchJson<{ default_branch: string }>(`https://api.github.com/repos/${repo}`)
  const branch = typeof source.config.branch === 'string' && source.config.branch.trim() ? source.config.branch.trim() : info.default_branch
  const head = await githubFetchJson<{ commit: { sha: string } }>(`https://api.github.com/repos/${repo}/branches/${encodeURIComponent(branch)}`)
  const sha = head.commit.sha
  if (source.cursor.commitSha === sha) return { documents: [], cursor: source.cursor, complete: false, hasMore: false }

  const tree = await githubFetchJson<{ tree: Array<{ path: string; type: string; size?: number }>; truncated?: boolean }>(
    `https://api.github.com/repos/${repo}/git/trees/${sha}?recursive=1`,
  )
  const files = tree.tree.filter((e) => e.type === 'blob' && matchesAny(e.path, patterns))
  const eligible = files.filter((e) => (e.size ?? 0) <= MAX_FILE_BYTES).slice(0, MAX_FILES)
  const skipped = files.length - eligible.length

  const documents: KnowledgeDocumentInput[] = []
  // A few files at a time keeps us well inside GitHub's secondary rate limits.
  for (let i = 0; i < eligible.length; i += 4) {
    const slice = eligible.slice(i, i + 4)
    const fetched = await Promise.all(slice.map(async (entry) => {
      const blob = await githubFetchJson<{ content?: string; encoding?: string }>(`https://api.github.com/repos/${repo}/contents/${entry.path.split('/').map(encodeURIComponent).join('/')}?ref=${sha}`)
      const text = blob.encoding === 'base64' && blob.content ? Buffer.from(blob.content, 'base64').toString('utf8') : ''
      if (!text.trim() || looksBinary(text)) return undefined
      return {
        externalId: entry.path,
        title: firstHeading(text) ?? entry.path,
        url: `https://github.com/${repo}/blob/${branch}/${entry.path}`,
        content: `Path: ${entry.path}\n\n${text}`,
        metadata: { repo, branch, path: entry.path },
      } satisfies KnowledgeDocumentInput
    }))
    for (const doc of fetched) if (doc) documents.push(doc)
  }
  // The whole tree was enumerated (unless GitHub truncated it), so pruning is safe.
  return { documents, cursor: { ...source.cursor, commitSha: sha, branch }, complete: !tree.truncated, hasMore: false, skipped }
}

function looksBinary(text: string): boolean {
  return text.charCodeAt(0) === 0 || /[\x00-\x08]/.test(text.slice(0, 2000))
}

function matchesAny(path: string, patterns: string[]): boolean {
  const base = path.split('/').pop() ?? path
  return patterns.some((raw) => {
    const p = raw.trim()
    if (!p) return false
    if (p.startsWith('*.')) return base.toLowerCase().endsWith(p.slice(1).toLowerCase())
    if (p.endsWith('/')) return path.startsWith(p)
    if (p.endsWith('*')) return base.startsWith(p.slice(0, -1))
    return path === p || base === p
  })
}

function firstHeading(text: string): string | undefined {
  const match = /^#\s+(.+)$/m.exec(text)
  return match?.[1]?.trim()
}

// ---------------------------------------------------------------------------
// GitHub issues and pull requests of one repository, incremental by updated_at
// ---------------------------------------------------------------------------

async function importGitHubIssues(source: KnowledgeSourceRow): Promise<SyncBatch> {
  const repo = String(source.config.repo)
  const since = typeof source.cursor.since === 'string' ? source.cursor.since : undefined
  const documents: KnowledgeDocumentInput[] = []
  let newest = since
  let page = 1
  let hasMore = false
  for (;;) {
    const items = await githubFetchJson<Array<{ number: number; title: string; html_url: string; state: string; body?: string | null; updated_at: string; pull_request?: unknown; user?: { login: string }; labels?: Array<{ name: string }> }>>(
      `https://api.github.com/repos/${repo}/issues?state=all&sort=updated&direction=asc&per_page=100&page=${page}${since ? `&since=${encodeURIComponent(since)}` : ''}`,
    )
    for (const issue of items) {
      documents.push({
        externalId: `${repo}#${issue.number}`,
        title: `${repo}#${issue.number}: ${issue.title}`,
        url: issue.html_url,
        content: [
          `${issue.pull_request ? 'Pull request' : 'Issue'} · State: ${issue.state} · Author: ${issue.user?.login ?? '?'}${issue.labels?.length ? ` · Labels: ${issue.labels.map((l) => l.name).join(', ')}` : ''}`,
          '',
          issue.body?.trim() || '_No description._',
        ].join('\n'),
        metadata: { repo, number: issue.number, state: issue.state, kind: issue.pull_request ? 'pull_request' : 'issue' },
        sourceUpdatedAt: issue.updated_at,
      })
      if (!newest || issue.updated_at > newest) newest = issue.updated_at
    }
    if (items.length < 100) break
    page += 1
    if (documents.length >= MAX_DOCS_PER_BATCH) { hasMore = true; break }
  }
  return { documents, cursor: { ...source.cursor, since: newest }, complete: !since && !hasMore, hasMore }
}

// ---------------------------------------------------------------------------
// Web pages (misc)
// ---------------------------------------------------------------------------

async function importUrls(source: KnowledgeSourceRow): Promise<SyncBatch> {
  const urls = strings(source.config.urls)
  const documents: KnowledgeDocumentInput[] = []
  const errors: string[] = []
  for (const url of urls) {
    try {
      const response = await fetch(url, { headers: { 'user-agent': 'Spaces knowledge import', accept: 'text/html, text/markdown, text/plain;q=0.9, */*;q=0.5' }, redirect: 'follow', signal: AbortSignal.timeout(20_000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const type = response.headers.get('content-type') ?? ''
      const raw = await response.text()
      let title = url
      let content = raw
      if (/html/i.test(type) || /^\s*<(!doctype|html)/i.test(raw)) {
        title = /<title[^>]*>([^<]*)<\/title>/i.exec(raw)?.[1]?.trim() || title
        content = htmlToText(raw.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' '))
      }
      documents.push({ externalId: url, title, url, content: content.slice(0, 400_000), metadata: { contentType: type } })
    } catch (error) {
      errors.push(`${url}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  // Every configured URL was attempted; failed ones keep their previous copy.
  if (errors.length && documents.length === 0) throw new Error(errors.join('; '))
  return { documents, cursor: { ...source.cursor, errors }, complete: errors.length === 0, hasMore: false, skipped: errors.length }
}
