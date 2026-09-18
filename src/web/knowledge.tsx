import { useCallback, useEffect, useMemo, useState } from 'react'
import { json, type MeTeam } from './auth'

/**
 * Organization knowledge base panel (inside the Organization dialog).
 *
 *  Import from…  pick Confluence spaces, Jira projects, Linear teams/projects/
 *                initiatives or GitHub repositories from the connected
 *                integration's catalog, or add web pages and notes; choose
 *                whether the organization or one team owns the result.
 *  Sources       what has been imported, with status, counts, re-import,
 *                documents and delete.
 *  Search        try a question against the base the way agents do.
 */

type Kind = 'confluence' | 'jira' | 'linear' | 'github_repo' | 'github_issues' | 'url' | 'manual'

interface Source {
  sourceId: string
  teamId: string | null
  teamName: string | null
  kind: Kind
  label: string
  config: Record<string, unknown>
  enabled: boolean
  lastSyncStartedAt: string | null
  lastSyncFinishedAt: string | null
  lastSyncStatus: 'running' | 'ok' | 'error' | null
  lastSyncError: string | null
  lastSyncStats: Record<string, number>
  documentCount: number
  chunkCount: number
}

interface Status {
  sources: number
  documents: number
  chunks: number
  embeddedChunks: number
  pendingEmbeddings: number
  embeddings: { available: boolean; model: string }
  vectorSearch: boolean
}

interface CatalogEntry { id: string; name: string; description?: string; group?: 'teams' | 'projects' | 'initiatives' }

interface Hit { chunkId: number; title: string; url: string | null; sourceLabel: string; sourceKind: Kind; headingPath: string[]; content: string; score: number; matchedBy: string[] }

interface Doc { documentId: string; title: string; url: string | null; externalId: string; chunkCount: number; embeddingStatus: string; fetchedAt: string }

type ImportTab = 'confluence' | 'jira' | 'linear' | 'github' | 'url' | 'manual'

const TABS: Array<{ id: ImportTab; label: string }> = [
  { id: 'confluence', label: 'Confluence spaces' },
  { id: 'jira', label: 'Jira projects' },
  { id: 'linear', label: 'Linear' },
  { id: 'github', label: 'GitHub repositories' },
  { id: 'url', label: 'Web pages' },
  { id: 'manual', label: 'Notes' },
]

const KIND_LABEL: Record<Kind, string> = {
  confluence: 'Confluence',
  jira: 'Jira',
  linear: 'Linear',
  github_repo: 'GitHub docs',
  github_issues: 'GitHub issues & PRs',
  url: 'Web pages',
  manual: 'Notes',
}

export function OrgKnowledgePanel({ canEdit, teams }: { canEdit: boolean; teams: MeTeam[] }) {
  const [status, setStatus] = useState<Status | null>(null)
  const [sources, setSources] = useState<Source[]>([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [tab, setTab] = useState<ImportTab>('confluence')
  const [scopeTeam, setScopeTeam] = useState<string>('')
  const [openDocs, setOpenDocs] = useState<{ sourceId: string; docs: Doc[] } | null>(null)

  const editableTeams = useMemo(() => teams.filter((t) => t.role === 'owner' || t.role === 'admin'), [teams])

  const reload = useCallback(async () => {
    try {
      const [s, list] = await Promise.all([json<Status>('/api/org/knowledge/status'), json<{ sources: Source[] }>('/api/org/knowledge/sources')])
      setStatus(s)
      setSources(list.sources)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  // Poll while an import is running so counts and status move without a click.
  const importing = sources.some((s) => s.lastSyncStatus === 'running')
  useEffect(() => {
    if (!importing) return
    const timer = setInterval(() => { void reload() }, 3_000)
    return () => clearInterval(timer)
  }, [importing, reload])

  const flash = (message: string) => { setNotice(message); setError(''); setTimeout(() => setNotice(''), 4_000) }

  async function createSource(body: { kind: Kind; label: string; config: Record<string, unknown> }) {
    try {
      await json('/api/org/knowledge/sources', { method: 'POST', body: JSON.stringify({ ...body, teamId: scopeTeam || null }) })
      flash(body.kind === 'manual' ? 'Notes source created.' : `Importing "${body.label}"…`)
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function act(sourceId: string, action: 'import' | 'full' | 'delete') {
    try {
      if (action === 'delete') {
        if (!window.confirm('Remove this source and everything imported from it?')) return
        await json(`/api/org/knowledge/sources/${sourceId}`, { method: 'DELETE' })
        if (openDocs?.sourceId === sourceId) setOpenDocs(null)
      } else {
        await json(`/api/org/knowledge/sources/${sourceId}/import`, { method: 'POST', body: JSON.stringify({ full: action === 'full' }) })
      }
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function showDocs(sourceId: string) {
    if (openDocs?.sourceId === sourceId) { setOpenDocs(null); return }
    try {
      const r = await json<{ documents: Doc[] }>(`/api/org/knowledge/sources/${sourceId}?limit=100`)
      setOpenDocs({ sourceId, docs: r.documents })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function deleteDoc(sourceId: string, documentId: string) {
    try {
      await json(`/api/org/knowledge/sources/${sourceId}/documents/${documentId}`, { method: 'DELETE' })
      await showDocs(sourceId)
      await showDocs(sourceId)
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <section className="card panel slim-panel knowledge-panel">
      <div className="knowledge-panel-intro">
        <h3 style={{ margin: 0 }}>Knowledge base</h3>
        <p className="panel-subtitle">Import spaces, projects, initiatives, repositories, web pages and notes. Agents search it (<code>org_knowledge_search</code>) and every stage starts with the excerpts relevant to its project.</p>
      </div>
      {status && (
        <div className="knowledge-stats">
          <span>{status.sources} source{status.sources === 1 ? '' : 's'}</span>
          <span>{status.documents} document{status.documents === 1 ? '' : 's'}</span>
          <span>{status.chunks} chunks{status.vectorSearch ? ` · ${status.embeddedChunks} embedded` : ''}</span>
          <span>{status.embeddings.available && status.vectorSearch ? `semantic + keyword search (${status.embeddings.model})` : status.vectorSearch ? 'keyword search only — add an OpenAI or OpenRouter key under Organization → Models for semantic search' : 'keyword search only — pgvector extension not installed'}</span>
          {status.pendingEmbeddings > 0 && status.embeddings.available && <span>{status.pendingEmbeddings} awaiting embeddings</span>}
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
      {notice && <p className="panel-subtitle">{notice}</p>}

      {canEdit && (
        <div className="knowledge-inline-form">
          <div className="button-row" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <strong>Import from</strong>
            <div className="knowledge-tabs">
              {TABS.map((t) => <button key={t.id} type="button" className={`secondary-button${tab === t.id ? ' active' : ''}`} onClick={() => setTab(t.id)}>{t.label}</button>)}
            </div>
            <label style={{ marginLeft: 'auto' }}>
              Owner{' '}
              <select value={scopeTeam} onChange={(e) => setScopeTeam(e.target.value)}>
                {teams.length === 0 || teams.some((t) => t.role === 'owner' || t.role === 'admin') ? <option value="">Organization (every team)</option> : null}
                {editableTeams.map((t) => <option key={t.teamId} value={t.teamId}>Team: {t.name}</option>)}
              </select>
            </label>
          </div>
          {(tab === 'confluence' || tab === 'jira' || tab === 'linear' || tab === 'github') && (
            <CatalogImport integration={tab} onImport={createSource} />
          )}
          {tab === 'url' && <UrlImport onImport={createSource} />}
          {tab === 'manual' && <NoteImport teamId={scopeTeam || null} onDone={async (m) => { flash(m); await reload() }} onError={setError} />}
        </div>
      )}

      <div className="ks-list" role="table" aria-label="Knowledge sources">
        <div className="ks-row ks-head" role="row">
          <span>Source</span><span>Type</span><span>Owner</span><span>Content</span><span>Last import</span><span className="ks-actions">{canEdit ? 'Actions' : ''}</span>
        </div>
        {sources.length === 0 && <div className="ks-empty">Nothing imported yet. Pick something above to get started.</div>}
        {sources.map((s) => {
          const open = openDocs?.sourceId === s.sourceId
          return (
            <div key={s.sourceId} className={`ks-item ${open ? 'open' : ''} ${s.lastSyncStatus ?? ''}`}>
              <div className="ks-row" role="row">
                <div className="ks-source">
                  <button type="button" className="ks-name" onClick={() => void showDocs(s.sourceId)} title={open ? 'Hide documents' : 'Show documents'}>
                    <span className="dock-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>{s.label}
                  </button>
                  <span className="ks-config">{describeConfig(s)}</span>
                </div>
                <span><span className={`ks-kind ${s.kind}`}>{KIND_LABEL[s.kind]}</span></span>
                <span className="ks-owner">{s.teamName ? <><span className="text-subtle">Team</span> {s.teamName}</> : 'Organization'}</span>
                <span className="ks-content"><strong>{s.documentCount}</strong> docs <span className="text-subtle">·</span> <strong>{s.chunkCount}</strong> chunks</span>
                <div className="ks-status">
                  {s.lastSyncStatus === 'running' && <span className="mini-badge running">importing…</span>}
                  {s.lastSyncStatus === 'ok' && <span className="mini-badge completed">ok</span>}
                  {s.lastSyncStatus === 'error' && <span className="mini-badge error">failed</span>}
                  {!s.lastSyncStatus && s.kind !== 'manual' && <span className="mini-badge idle">queued</span>}
                  {!s.lastSyncStatus && s.kind === 'manual' && <span className="mini-badge idle">manual</span>}
                  {s.lastSyncFinishedAt && <span className="ks-time">{new Date(s.lastSyncFinishedAt).toLocaleString()}</span>}
                  {s.lastSyncStatus !== 'error' && summarizeStats(s.lastSyncStats) && <span className="ks-time">{summarizeStats(s.lastSyncStats)}</span>}
                </div>
                <div className="ks-actions">
                  {canEdit && s.kind !== 'manual' && <button type="button" className="secondary-button ks-button" disabled={s.lastSyncStatus === 'running'} onClick={() => void act(s.sourceId, 'import')} title="Fetch what changed since the last import">Re-import</button>}
                  {canEdit && s.kind !== 'manual' && <button type="button" className="ghost-button ks-button" disabled={s.lastSyncStatus === 'running'} onClick={() => void act(s.sourceId, 'full')} title="Re-enumerate everything and prune removed items">Full</button>}
                  {canEdit && <button type="button" className="ghost-button ks-button ks-danger" onClick={() => void act(s.sourceId, 'delete')}>Delete</button>}
                </div>
              </div>
              {s.lastSyncError && <div className="ks-error"><strong>Last import failed:</strong> {s.lastSyncError}</div>}
              {open && (
                <div className="ks-docs">
                  {openDocs!.docs.length === 0 && <span className="panel-subtitle">No documents yet.</span>}
                  {openDocs!.docs.map((d) => (
                    <div key={d.documentId} className="ks-doc">
                      <span className="ks-doc-title">{d.url ? <a href={d.url} target="_blank" rel="noreferrer">{d.title}</a> : d.title}</span>
                      <span className="ks-doc-meta">{d.chunkCount} chunk{d.chunkCount === 1 ? '' : 's'} · <span className={d.embeddingStatus === 'done' ? 'ks-ok' : 'text-subtle'}>{d.embeddingStatus === 'done' ? 'embedded' : d.embeddingStatus}</span> · {new Date(d.fetchedAt).toLocaleDateString()}</span>
                      {canEdit && <button type="button" className="ghost-button ks-button" onClick={() => void deleteDoc(s.sourceId, d.documentId)}>Remove</button>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <KnowledgeSearch />
    </section>
  )
}

function describeConfig(s: Source): string {
  const list = (v: unknown) => Array.isArray(v) ? v.map(String).join(', ') : typeof v === 'string' ? v : ''
  switch (s.kind) {
    case 'confluence': return `Spaces: ${list(s.config.spaces)}`
    case 'jira': return s.config.jql ? `JQL: ${String(s.config.jql)}` : `Projects: ${list(s.config.projects)}`
    case 'linear': return [list(s.config.teams) && `Teams: ${list(s.config.teams)}`, list(s.config.projects) && `Projects: ${list(s.config.projects)}`, Array.isArray(s.config.initiatives) && s.config.initiatives.length ? `${s.config.initiatives.length} initiative(s)` : ''].filter(Boolean).join(' · ')
    case 'github_repo': return `${String(s.config.repo)}${s.config.branch ? `@${String(s.config.branch)}` : ''}${list(s.config.include) ? ` · ${list(s.config.include)}` : ' · docs files'}`
    case 'github_issues': return `${String(s.config.repo)} · issues & pull requests`
    case 'url': return list(s.config.urls)
    case 'manual': return 'Typed or pasted notes'
  }
}

function summarizeStats(stats: Record<string, number> | undefined): string {
  if (!stats || stats.fetched === undefined) return ''
  const parts = [`${stats.indexed ?? 0} indexed`, `${stats.unchanged ?? 0} unchanged`]
  if (stats.deleted) parts.push(`${stats.deleted} removed`)
  if (stats.skipped) parts.push(`${stats.skipped} skipped`)
  return parts.join(', ')
}

// ---------------------------------------------------------------------------
// Catalog-driven import (Confluence, Jira, Linear, GitHub)
// ---------------------------------------------------------------------------

function CatalogImport({ integration, onImport }: { integration: 'confluence' | 'jira' | 'linear' | 'github'; onImport: (body: { kind: Kind; label: string; config: Record<string, unknown> }) => Promise<void> }) {
  const [entries, setEntries] = useState<CatalogEntry[] | null>(null)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [githubMode, setGithubMode] = useState<'docs' | 'issues'>('docs')
  const [include, setInclude] = useState('')
  const [jql, setJql] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setEntries(null); setError(''); setSelected(new Set()); setFilter('')
    json<{ entries: CatalogEntry[] }>(`/api/org/knowledge/catalog?integration=${integration}`)
      .then((r) => setEntries(r.entries))
      .catch((e) => { setEntries([]); setError(e instanceof Error ? e.message : String(e)) })
  }, [integration])

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return (entries ?? []).filter((e) => !q || e.name.toLowerCase().includes(q) || (e.description ?? '').toLowerCase().includes(q))
  }, [entries, filter])

  const toggle = (id: string) => setSelected((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })

  async function submit() {
    setBusy(true)
    try {
      const ids = [...selected]
      const named = (id: string) => entries?.find((e) => e.id === id)?.name ?? id
      if (integration === 'confluence') {
        await onImport({ kind: 'confluence', label: `Confluence: ${ids.map(named).join(', ')}`, config: { spaces: ids } })
      } else if (integration === 'jira') {
        if (jql.trim()) await onImport({ kind: 'jira', label: `Jira: ${jql.trim().slice(0, 60)}`, config: { jql: jql.trim() } })
        else await onImport({ kind: 'jira', label: `Jira: ${ids.map(named).join(', ')}`, config: { projects: ids } })
      } else if (integration === 'linear') {
        const byGroup = (g: CatalogEntry['group']) => ids.filter((id) => entries?.find((e) => e.id === id && e.group === g))
        const teams = byGroup('teams'); const projects = byGroup('projects'); const initiatives = byGroup('initiatives')
        const labelBits = [teams.length && `teams ${teams.join(', ')}`, projects.length && `projects ${projects.join(', ')}`, initiatives.length && `${initiatives.length} initiative(s)`].filter(Boolean)
        await onImport({ kind: 'linear', label: `Linear: ${labelBits.join('; ')}`, config: { teams, projects, initiatives } })
      } else {
        // GitHub: one source per repository so each can be re-imported on its own.
        for (const repo of ids) {
          if (githubMode === 'docs') await onImport({ kind: 'github_repo', label: `${repo} docs`, config: { repo, include: include.split(',').map((s) => s.trim()).filter(Boolean) } })
          else await onImport({ kind: 'github_issues', label: `${repo} issues & PRs`, config: { repo } })
        }
      }
      setSelected(new Set())
    } finally {
      setBusy(false)
    }
  }

  const groups: Array<{ group: CatalogEntry['group']; title: string }> = integration === 'linear'
    ? [{ group: 'teams', title: 'Teams' }, { group: 'projects', title: 'Projects' }, { group: 'initiatives', title: 'Initiatives' }]
    : [{ group: undefined, title: '' }]

  const canSubmit = selected.size > 0 || (integration === 'jira' && jql.trim().length > 0)

  return (
    <div className="knowledge-inline-form">
      {error && <p className="error-text">{error}</p>}
      {entries === null && !error && <span className="panel-subtitle">Loading catalog…</span>}
      {entries && entries.length > 0 && (
        <>
          <div className="button-row">
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Filter ${entries.length} entries…`} />
            {integration === 'github' && (
              <select value={githubMode} onChange={(e) => setGithubMode(e.target.value as 'docs' | 'issues')}>
                <option value="docs">Documentation files</option>
                <option value="issues">Issues &amp; pull requests</option>
              </select>
            )}
            {integration === 'github' && githubMode === 'docs' && <input value={include} onChange={(e) => setInclude(e.target.value)} placeholder="Include patterns (default *.md, *.rst, *.txt): docs/, *.mdx, README*" style={{ flex: 1 }} />}
          </div>
          <div className="picker" role="table" aria-label={`${integration} catalog`}>
            <div className="picker-row picker-head" role="row">
              <span className="picker-check">
                <input type="checkbox" aria-label="Select all shown" checked={visible.length > 0 && visible.every((e) => selected.has(e.id))} onChange={(e) => setSelected((prev) => { const next = new Set(prev); for (const v of visible) { if (e.target.checked) next.add(v.id); else next.delete(v.id) } return next })} />
              </span>
              <span>Name</span>
              <span>Details</span>
              <span className="picker-count">{selected.size ? `${selected.size} selected` : `${visible.length} shown`}</span>
            </div>
            <div className="picker-body">
              {groups.map(({ group, title }) => {
                const rows = visible.filter((e) => e.group === group)
                if (rows.length === 0) return null
                return (
                  <div key={title || 'all'}>
                    {title && <div className="picker-group">{title} <span className="text-subtle">· {rows.length}</span></div>}
                    {rows.map((e) => (
                      <label key={e.id} className={`picker-row ${selected.has(e.id) ? 'selected' : ''}`} role="row">
                        <span className="picker-check"><input type="checkbox" checked={selected.has(e.id)} onChange={() => toggle(e.id)} /></span>
                        <span className="picker-name">{e.name}</span>
                        <span className="picker-desc">{e.description ?? ''}</span>
                        <span className="picker-id"><code>{e.id.length > 24 ? `${e.id.slice(0, 22)}…` : e.id}</code></span>
                      </label>
                    ))}
                  </div>
                )
              })}
              {visible.length === 0 && <div className="ks-empty">No matches.</div>}
            </div>
          </div>
        </>
      )}
      {integration === 'jira' && <input value={jql} onChange={(e) => setJql(e.target.value)} placeholder="…or a JQL filter instead, e.g. project = PAY AND type = Epic" />}
      <div className="button-row">
        <button type="button" className="primary-button" disabled={busy || !canSubmit} onClick={() => void submit()}>
          {busy ? 'Starting…' : `Import ${selected.size || ''}`.trim()}
        </button>
        <span className="panel-subtitle">{integration === 'linear' ? 'Initiatives bring their projects; projects and teams bring their issues.' : integration === 'github' ? 'One source per repository.' : 'Imports run in the background; re-import later picks up changes.'}</span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Web pages
// ---------------------------------------------------------------------------

function UrlImport({ onImport }: { onImport: (body: { kind: Kind; label: string; config: Record<string, unknown> }) => Promise<void> }) {
  const [text, setText] = useState('')
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const urls = text.split(/\s+/).map((s) => s.trim()).filter(Boolean)
  return (
    <div className="knowledge-inline-form">
      <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={'One URL per line\nhttps://handbook.example.com/engineering\nhttps://example.com/adr/0007-auth.md'} />
      <div className="button-row">
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (optional)" />
        <button type="button" className="primary-button" disabled={busy || urls.length === 0} onClick={async () => { setBusy(true); try { await onImport({ kind: 'url', label: label.trim() || `Web: ${urls[0]}${urls.length > 1 ? ` +${urls.length - 1}` : ''}`, config: { urls } }); setText(''); setLabel('') } finally { setBusy(false) } }}>Import {urls.length || ''}</button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

function NoteImport({ teamId, onDone, onError }: { teamId: string | null; onDone: (message: string) => Promise<void>; onError: (message: string) => void }) {
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <div className="knowledge-inline-form">
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title, e.g. Incident review process" />
      <textarea value={content} onChange={(e) => setContent(e.target.value)} placeholder="Paste or type the knowledge to remember: standards, decisions, runbooks, glossary…" />
      <div className="button-row">
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Reference link (optional)" />
        <button type="button" className="primary-button" disabled={busy || !title.trim() || !content.trim()} onClick={async () => {
          setBusy(true)
          try {
            await json('/api/org/knowledge/notes', { method: 'POST', body: JSON.stringify({ title, content, url: url || undefined, teamId }) })
            setTitle(''); setContent(''); setUrl('')
            await onDone('Note added to the knowledge base.')
          } catch (e) { onError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
        }}>Add note</button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function KnowledgeSearch() {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<Hit[] | null>(null)
  const [mode, setMode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function run() {
    if (!q.trim()) return
    setBusy(true); setError('')
    try {
      const r = await json<{ hits: Hit[]; mode: string }>(`/api/org/knowledge/search?q=${encodeURIComponent(q.trim())}&limit=6`)
      setHits(r.hits); setMode(r.mode)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  return (
    <div className="knowledge-inline-form">
      <div className="button-row">
        <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void run() }} placeholder="Ask the knowledge base, e.g. how do we handle database migrations?" style={{ flex: 1 }} />
        <button type="button" className="secondary-button" disabled={busy || !q.trim()} onClick={() => void run()}>{busy ? 'Searching…' : 'Search'}</button>
      </div>
      {error && <p className="error-text">{error}</p>}
      {hits && hits.length === 0 && <span className="panel-subtitle">No matches.</span>}
      {hits && hits.length > 0 && <span className="panel-subtitle">{hits.length} excerpts · {mode === 'hybrid' ? 'semantic + keyword' : 'keyword'} search</span>}
      {hits?.map((h) => (
        <div key={h.chunkId} className="knowledge-hit">
          <h4>{h.url ? <a href={h.url} target="_blank" rel="noreferrer">{h.title}</a> : h.title}</h4>
          <div className="where">{[KIND_LABEL[h.sourceKind], h.sourceLabel, ...h.headingPath].join(' › ')} · matched by {h.matchedBy.join(' + ')}</div>
          <pre>{h.content.length > 700 ? `${h.content.slice(0, 700)}…` : h.content}</pre>
        </div>
      ))}
    </div>
  )
}
