import { useCallback, useEffect, useMemo, useState } from 'react'
import { json, navigate } from './auth'
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
interface SourceRow { sourceId: string; kind: string; label: string; enabled: boolean; scopeKey: string; lastSyncStatus: string | null; lastSyncError: string | null; lastSyncFinishedAt: string | null }
interface ProjectOption { projectId: string; name: string; slug: string }

const PRIORITIES: Priority[] = ['urgent', 'high', 'normal', 'low']
const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, normal: 2, low: 3 }
const PRIORITY_LABEL: Record<Priority, string> = { urgent: 'Urgent', high: 'High', normal: 'Normal', low: 'Low' }

export function IntakePage() {
  const [items, setItems] = useState<IntakeItem[]>([])
  const [sources, setSources] = useState<SourceRow[]>([])
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [view, setView] = useState<State>('new')
  const [sourceFilter, setSourceFilter] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

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
      <PageHead title="Intake" count={items.length ? String(items.length) : undefined} subtitle="Inbound work from Jira, Linear, Slack and Datadog, in one prioritized queue.">
        <div className="segmented" role="tablist" aria-label="Queue state">
          {(['new', 'converted', 'dismissed', 'merged'] as State[]).map((s) => (
            <button key={s} type="button" role="tab" aria-selected={view === s} className={view === s ? 'active' : ''} onClick={() => setView(s)}>{s}</button>
          ))}
        </div>
      </PageHead>

      {message && <div className="toast" role="status"><span>{message}</span><button type="button" className="ghost-button toast-close" onClick={() => setMessage(null)} aria-label="Dismiss">×</button></div>}

      <section className="panel card intake-sources" aria-label="Source health">
        <h2 className="section-title">Sources</h2>
        {sources.length === 0 && <p className="muted">No intake sources configured. An org admin can add one under Intake sources.</p>}
        <div className="intake-source-list">
          {sources.map((source) => (
            <button key={source.sourceId} type="button" className={`intake-source ${sourceFilter === source.kind ? 'active' : ''}`} onClick={() => setSourceFilter(sourceFilter === source.kind ? '' : source.kind)}>
              <span className={`status-dot ${source.lastSyncStatus === 'ok' ? 'ok' : source.lastSyncStatus === 'error' ? 'off' : 'partial'}`} aria-hidden="true" />
              <span className="intake-source-name">{source.label}</span>
              <span className="intake-source-kind">{source.kind}</span>
              {source.lastSyncError && <span className="intake-source-error" title={source.lastSyncError}>sync error</span>}
            </button>
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
