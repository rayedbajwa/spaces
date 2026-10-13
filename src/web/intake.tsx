import { useCallback, useEffect, useMemo, useState } from 'react'
import { json, navigate, useAuth } from './auth'
import { LoadingBlock } from './loading'
import { PageHead } from './shell'

/**
 * Intake queue (012-inbound-outbound-slack, US1/US2/US5).
 *
 * Organization-scoped inbound work from Jira, Linear, Slack and Datadog,
 * ordered by priority then arrival. A triager can change priority, dismiss with
 * a reason, restore, merge duplicates and convert an item into project work,
 * which starts the existing `specify` stage with feature/bugfix scope. Source
 * health is shown so a failing connector is visible without hiding queued work.
 */

type Priority = 'urgent' | 'high' | 'normal' | 'low'
type State = 'new' | 'converted' | 'dismissed' | 'merged'

interface Suggestion { projectId: string | null; teamId: string | null; priority: Priority | null; ruleId: string; ruleLabel: string }
interface IntakeItem {
  intakeId: string; source: string; externalRef: string; externalUrl: string | null
  sourceScope: string | null; title: string; summary: string | null
  requesterName: string | null; requesterEmail: string | null
  priority: Priority; state: State; repeatCount: number; sourceAvailable: boolean
  matchedRuleId: string | null; ruleOverridden: boolean
  suggestedProjectId: string | null; suggestedTeamId: string | null; suggestedPriority: Priority | null
  firstSeenAt: string; lastSeenAt: string | null
}
interface SourceRow { sourceId: string; kind: string; label: string; enabled: boolean; scopeKey: string; config: Record<string, unknown>; syncIntervalMinutes: number; lastSyncStatus: string | null; lastSyncError: string | null; lastSyncFinishedAt: string | null }

const SOURCE_KINDS = ['jira', 'linear', 'datadog', 'slack'] as const
const SOURCE_LABEL: Record<string, string> = { jira: 'Jira', linear: 'Linear', datadog: 'Datadog', slack: 'Slack' }
const SOURCE_SCOPE_HINT: Record<string, string> = {
  jira: 'Project key(s), comma-separated — e.g. OPS, ENG',
  linear: 'Team key — e.g. ENG',
  datadog: 'Tag filter — e.g. env:prod (blank watches all)',
  slack: 'Workspace label — Slack files work on demand',
}

/** Map the single "watched scope" field onto the config each connector reads. */
function configForSource(kind: string, scope: string): Record<string, unknown> {
  const value = scope.trim()
  switch (kind) {
    case 'jira': return value ? { projects: value.split(',').map((p) => p.trim()).filter(Boolean) } : {}
    case 'linear': return value ? { teamKey: value } : {}
    case 'datadog': return value ? { tags: [value] } : {}
    default: return {}
  }
}
interface ProjectOption { projectId: string; name: string; slug: string }

const PRIORITIES: Priority[] = ['urgent', 'high', 'normal', 'low']
const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, normal: 2, low: 3 }
const PRIORITY_LABEL: Record<Priority, string> = { urgent: 'Urgent', high: 'High', normal: 'Normal', low: 'Low' }

export function IntakePage() {
  const { me } = useAuth()
  const isAdmin = !me?.authEnabled || (me?.teams ?? []).some((t) => t.role === 'owner' || t.role === 'admin')
  const [items, setItems] = useState<IntakeItem[]>([])
  const [sources, setSources] = useState<SourceRow[]>([])
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [view, setView] = useState<State>('new')
  const [sourceFilter, setSourceFilter] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [showSourceForm, setShowSourceForm] = useState(false)
  const [sourceKind, setSourceKind] = useState<string>('jira')
  const [sourceLabel, setSourceLabel] = useState('')
  const [sourceScope, setSourceScope] = useState('')
  const [savingSource, setSavingSource] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const query = new URLSearchParams({ state: view })
      if (sourceFilter) query.set('source', sourceFilter)
      const data = await json<{ items: IntakeItem[]; sources: SourceRow[] }>(`/api/intake?${query.toString()}`)
      setItems(data.items)
      setSources(data.sources)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [view, sourceFilter])

  useEffect(() => { void load() }, [load])
  useEffect(() => { void json<ProjectOption[]>('/api/projects').then(setProjects).catch(() => setProjects([])) }, [])

  const ordered = useMemo(() => [...items].sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || Date.parse(a.firstSeenAt) - Date.parse(b.firstSeenAt)), [items])

  const act = async (id: string, path: string, body?: unknown): Promise<void> => {
    setBusy(id)
    setMessage(null)
    try {
      await json(`/api/intake/${encodeURIComponent(id)}${path}`, { method: 'POST', body: JSON.stringify(body ?? {}) })
      await load()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  const setPriority = async (item: IntakeItem, priority: Priority): Promise<void> => {
    setBusy(item.intakeId)
    setMessage(null)
    try {
      await json(`/api/intake/${encodeURIComponent(item.intakeId)}`, { method: 'PATCH', body: JSON.stringify({ priority }) })
      await load()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  const saveSource = async (): Promise<void> => {
    setSavingSource(true)
    setMessage(null)
    try {
      await json('/api/intake/sources', {
        method: 'PUT',
        body: JSON.stringify({
          kind: sourceKind,
          label: sourceLabel.trim() || SOURCE_LABEL[sourceKind],
          scopeKey: sourceScope.trim() || 'all',
          config: configForSource(sourceKind, sourceScope),
          enabled: true,
        }),
      })
      setMessage(`${SOURCE_LABEL[sourceKind]} source added. New work will appear here as it syncs.`)
      setShowSourceForm(false)
      setSourceLabel('')
      setSourceScope('')
      await load()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setSavingSource(false)
    }
  }

  const toggleSource = async (source: SourceRow): Promise<void> => {
    setBusy(source.sourceId)
    setMessage(null)
    try {
      await json('/api/intake/sources', {
        method: 'PUT',
        body: JSON.stringify({ kind: source.kind, label: source.label, scopeKey: source.scopeKey, config: source.config, enabled: !source.enabled, syncIntervalMinutes: source.syncIntervalMinutes }),
      })
      await load()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  const removeSource = async (source: SourceRow): Promise<void> => {
    if (!window.confirm(`Remove the ${source.label} source? Queued items stay, but new work stops arriving from it.`)) return
    setBusy(source.sourceId)
    setMessage(null)
    try {
      await json(`/api/intake/sources/${encodeURIComponent(source.sourceId)}`, { method: 'DELETE' })
      await load()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  const convert = async (item: IntakeItem, projectId: string, workKind: 'feature' | 'bugfix'): Promise<void> => {
    if (!projectId) { setMessage('Choose a project to convert this item into.'); return }
    setBusy(item.intakeId)
    setMessage(null)
    try {
      await json(`/api/intake/${encodeURIComponent(item.intakeId)}/convert`, { method: 'POST', body: JSON.stringify({ projectId, workKind }) })
      setMessage('Converted. A specify run has been queued; the work link is on the item.')
      await load()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <PageHead title="Work inbox" count={items.length ? String(items.length) : undefined} subtitle="Everything your connected tools raise, in one prioritized queue — triage it into project work or dismiss it.">
        <div className="segmented" role="tablist" aria-label="Queue state">
          {(['new', 'converted', 'dismissed', 'merged'] as State[]).map((s) => (
            <button key={s} type="button" role="tab" aria-selected={view === s} className={view === s ? 'active' : ''} onClick={() => setView(s)}>{s}</button>
          ))}
        </div>
      </PageHead>

      {message && <div className="toast" role="status"><span>{message}</span><button type="button" className="ghost-button toast-close" onClick={() => setMessage(null)} aria-label="Dismiss">×</button></div>}

      <section className="panel card intake-sources" aria-label="Source health">
        <div className="intake-sources-head">
          <h2 className="section-title">Sources</h2>
          {isAdmin && <button type="button" className="secondary-button" onClick={() => setShowSourceForm((open) => !open)}>{showSourceForm ? 'Cancel' : 'Add source'}</button>}
        </div>
        <p className="panel-subtitle">Connection health for the tools that feed this inbox. Add a watched scope below; new work arrives automatically as that scope syncs.</p>
        {isAdmin && showSourceForm && (
          <form className="intake-source-form" onSubmit={(e) => { e.preventDefault(); void saveSource() }}>
            <label className="intake-action">
              Source
              <select value={sourceKind} onChange={(e) => setSourceKind(e.target.value)}>
                {SOURCE_KINDS.map((kind) => <option key={kind} value={kind}>{SOURCE_LABEL[kind]}</option>)}
              </select>
            </label>
            <label className="intake-action">
              Label
              <input value={sourceLabel} placeholder={SOURCE_LABEL[sourceKind]} onChange={(e) => setSourceLabel(e.target.value)} />
            </label>
            <label className="intake-action grow">
              Watched scope
              <input value={sourceScope} placeholder={SOURCE_SCOPE_HINT[sourceKind]} onChange={(e) => setSourceScope(e.target.value)} />
            </label>
            <button type="submit" className="primary-button" disabled={savingSource}>{savingSource ? 'Adding…' : 'Add watched scope'}</button>
          </form>
        )}
        {sources.length === 0 && (
          <div className="intake-source-empty">
            <p className="muted">No sources connected yet. {isAdmin ? 'Add a watched scope above' : 'Ask a team owner or admin to add one'} — or connect Jira, Linear, Slack or Datadog under Integrations first.</p>
            <button type="button" className="secondary-button" onClick={() => navigate('/organization?section=integrations')}>Open integrations</button>
          </div>
        )}
        <div className="intake-source-list">
          {sources.map((source) => (
            <div key={source.sourceId} className={`intake-source-row ${source.enabled ? '' : 'disabled'}`}>
              <button type="button" className={`intake-source ${sourceFilter === source.kind ? 'active' : ''}`} onClick={() => setSourceFilter(sourceFilter === source.kind ? '' : source.kind)}>
                <span className={`status-dot ${source.lastSyncStatus === 'ok' ? 'ok' : source.lastSyncStatus === 'error' ? 'off' : 'partial'}`} aria-hidden="true" />
                <span className="intake-source-name">{source.label}</span>
                <span className="intake-source-kind">{source.kind}</span>
                {!source.enabled && <span className="intake-source-kind">disabled</span>}
                {source.lastSyncError && <span className="intake-source-error" title={source.lastSyncError}>sync error</span>}
              </button>
              {isAdmin && (
                <span className="intake-source-actions">
                  <button type="button" className="link-button" disabled={busy === source.sourceId} onClick={() => void toggleSource(source)}>{source.enabled ? 'Disable' : 'Enable'}</button>
                  <button type="button" className="link-button" disabled={busy === source.sourceId} onClick={() => void removeSource(source)}>Remove</button>
                </span>
              )}
            </div>
          ))}
        </div>
      </section>

      {loading && items.length === 0 ? <LoadingBlock label="Loading intake…" /> : (
        <section className="panel card intake-queue" aria-label="Intake queue">
          {ordered.length === 0 && <p className="muted">Nothing in this view. New items appear here as sources sync, or when someone files one from Slack.</p>}
          {ordered.map((item) => (
            <article key={item.intakeId} className={`intake-item priority-${item.priority}`}>
              <div className="intake-item-head">
                <span className={`priority-badge priority-${item.priority}`}>{PRIORITY_LABEL[item.priority]}</span>
                <span className="intake-item-source">{item.source}{item.sourceScope ? ` · ${item.sourceScope}` : ''}</span>
                {item.repeatCount > 1 && <span className="intake-repeat" title="Repeated deliveries aggregated into one item">×{item.repeatCount}</span>}
                {!item.sourceAvailable && <span className="intake-unavailable">source gone</span>}
                <span className="intake-item-time">{new Date(item.firstSeenAt).toLocaleString()}</span>
              </div>
              <h3 className="intake-item-title">
                {item.externalUrl ? <a href={item.externalUrl} target="_blank" rel="noreferrer">{item.title}</a> : item.title}
                <span className="intake-ref"> {item.externalRef}</span>
              </h3>
              {item.summary && <p className="intake-item-summary">{item.summary.slice(0, 400)}</p>}
              <div className="intake-item-meta">
                {item.requesterName && <span>From {item.requesterName}</span>}
                {(item.suggestedPriority || item.suggestedProjectId) && !item.ruleOverridden && (
                  <span className="intake-rule">
                    Suggested: {item.suggestedPriority ?? item.priority}
                    {item.suggestedProjectId ? ` · ${projects.find((p) => p.projectId === item.suggestedProjectId)?.name ?? 'project'}` : ''}
                  </span>
                )}
                {item.matchedRuleId && !item.ruleOverridden && <span className="intake-rule">matched by routing rule</span>}
                {item.ruleOverridden && <span className="intake-rule overridden">Manual override</span>}
              </div>
              {view === 'new' && (
                <div className="intake-item-actions">
                  <label className="intake-action">
                    Priority
                    <select value={item.priority} disabled={busy === item.intakeId} onChange={(e) => void setPriority(item, e.target.value as Priority)}>
                      {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
                    </select>
                  </label>
                  <label className="intake-action">
                    Convert to
                    <select defaultValue="" disabled={busy === item.intakeId} onChange={(e) => { void convert(item, e.target.value.split(':')[0]!, e.target.value.split(':')[1] as 'feature' | 'bugfix') }}>
                      <option value="" disabled>Choose project…</option>
                      {projects.map((project) => (
                        <optgroup key={project.projectId} label={project.name}>
                          <option value={`${project.projectId}:feature`}>{project.name} — feature</option>
                          <option value={`${project.projectId}:bugfix`}>{project.name} — bugfix</option>
                        </optgroup>
                      ))}
                    </select>
                  </label>
                  <button type="button" className="secondary-button" disabled={busy === item.intakeId} onClick={() => { const reason = window.prompt('Why dismiss this item?')?.trim(); if (reason) void act(item.intakeId, '/dismiss', { reason }) }}>Dismiss</button>
                  {ordered.some((other) => other.intakeId !== item.intakeId) && (
                    <label className="intake-action">
                      Merge into
                      <select defaultValue="" disabled={busy === item.intakeId} onChange={(e) => { if (e.target.value) void act(item.intakeId, '/merge', { intoId: e.target.value, reason: 'duplicate' }) }}>
                        <option value="" disabled>Choose item…</option>
                        {ordered.filter((other) => other.intakeId !== item.intakeId).map((other) => (
                          <option key={other.intakeId} value={other.intakeId}>{other.title.slice(0, 60)}</option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
              )}
              {view === 'dismissed' && (
                <div className="intake-item-actions">
                  <button type="button" className="secondary-button" disabled={busy === item.intakeId} onClick={() => void act(item.intakeId, '/restore')}>Restore</button>
                </div>
              )}
            </article>
          ))}
        </section>
      )}

      <p className="muted intake-back"><button type="button" className="link-button" onClick={() => navigate('/')}>← Back to projects</button></p>
    </>
  )
}
