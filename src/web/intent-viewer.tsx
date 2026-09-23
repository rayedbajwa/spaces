import { useEffect, useMemo, useState } from 'react'
import { json } from './auth'
import { LoadingBlock } from './loading'
import { renderMarkdown } from './markdown'
import { scopeLabel } from '../lib/intent-scope'

/**
 * One intent, everything it produced: a navigation of its documents grouped
 * by where they come from in the pipeline (specification, build, quality,
 * delivery), each previewed in place, and its history — every status change
 * with who made it and when, and when each document last changed. Documents
 * come from the database, so an intent whose files are on another branch (or
 * gone) can still be reviewed.
 */

interface IntentDetail {
  intent: {
    dirId: string
    title: string
    status: string
    scope: string | null
    codeReviewStatus: string | null
    verificationStatus: string | null
    deliveryStatus: string | null
    acceptedBy: string | null
    tasksDone: number
    tasksTotal: number
    active: boolean
    createdAt: string
    updatedAt: string
  }
  documents: Array<{ path: string; kind: string; bytes: number; updatedBy: string; updatedAt: string }>
  events: Array<{ field: string; from: string | null; to: string | null; by: string; at: string }>
}

type Doc = IntentDetail['documents'][number]

const HISTORY = '#history'

const GROUPS: Array<{ title: string; match: (path: string) => boolean }> = [
  { title: 'Specification', match: (p) => /^(spec|research|data-model|quickstart|clarifications?)\.md$/i.test(p) || p.startsWith('contracts/') || p.startsWith('checklists/') },
  { title: 'Planning', match: (p) => /^(plan|tasks|test-plan|parallel-workstreams)\.md$/i.test(p) },
  { title: 'Build', match: (p) => /^(merge-orchestrator)\.md$/i.test(p) || p.startsWith('subagents/') },
  { title: 'Quality', match: (p) => /^(code-review|verification-report|acceptance)\.md$/i.test(p) },
  { title: 'Delivery', match: (p) => /^delivery-(report|status)\.md$/i.test(p) },
]

const LABELS: Record<string, string> = {
  'spec.md': 'Spec', 'plan.md': 'Plan', 'tasks.md': 'Tasks', 'test-plan.md': 'Test plan', 'research.md': 'Research',
  'data-model.md': 'Data model', 'quickstart.md': 'Quickstart', 'parallel-workstreams.md': 'Workstreams',
  'merge-orchestrator.md': 'Merge orchestration', 'code-review.md': 'Code review', 'verification-report.md': 'Verification report',
  'acceptance.md': 'Acceptance', 'delivery-report.md': 'Delivery report', 'delivery-status.md': 'Delivery status',
}

/** Pipeline order inside a group, then by name. */
const ORDER = ['spec.md', 'research.md', 'data-model.md', 'quickstart.md', 'plan.md', 'tasks.md', 'test-plan.md', 'parallel-workstreams.md', 'merge-orchestrator.md', 'code-review.md', 'verification-report.md', 'acceptance.md', 'delivery-report.md', 'delivery-status.md']

function docLabel(path: string): string {
  if (LABELS[path]) return LABELS[path]!
  const name = path.split('/').pop()!.replace(/\.(md|json|ya?ml|txt)$/i, '').replace(/[-_]+/g, ' ')
  return name.charAt(0).toUpperCase() + name.slice(1)
}

function who(by: string): string {
  if (by.startsWith('person:')) return by.slice('person:'.length)
  return ({ agent: 'Agent', import: 'Imported' } as Record<string, string>)[by] ?? by
}

function when(iso: string): string {
  const date = new Date(iso)
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function describeEvent(e: IntentDetail['events'][number]): string {
  const field = ({ status: 'Status', code_review_status: 'Code review', verification_status: 'Verification', delivery_status: 'Delivery', accepted_by: 'Acceptance', title: 'Title', scope: 'Scope' } as Record<string, string>)[e.field]
  if (e.field === 'deleted') return 'Deleted'
  if (e.field === 'active') return e.to ? `Made the current intent${e.from ? ` (was ${e.from})` : ''}` : 'No longer the current intent'
  if (e.field === 'accepted_by') return e.to ? `Accepted by ${e.to}` : 'Acceptance withdrawn'
  const show = (v: string | null) => (v === null ? 'none' : e.field === 'scope' ? scopeLabel(v) : v.replace(/_/g, ' '))
  return e.from === null ? `${field ?? e.field}: ${show(e.to)}` : `${field ?? e.field}: ${show(e.from)} → ${show(e.to)}`
}

export function IntentViewer({ projectNamespace, intentId, onClose }: { projectNamespace: string; intentId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<IntentDetail | null>(null)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<string>('spec.md')
  const [content, setContent] = useState<{ path: string; text: string } | null>(null)
  const [contentError, setContentError] = useState('')

  useEffect(() => {
    let cancelled = false
    setDetail(null); setError('')
    json<IntentDetail>(`/api/projects/${projectNamespace}/features/${encodeURIComponent(intentId)}`)
      .then((d) => {
        if (cancelled) return
        setDetail(d)
        // Open on the spec, else the first document, else the history.
        setSelected(d.documents.some((doc) => doc.path === 'spec.md') ? 'spec.md' : d.documents[0]?.path ?? HISTORY)
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true }
  }, [projectNamespace, intentId])

  const groups = useMemo(() => {
    const docs = detail?.documents ?? []
    const rank = (p: string) => (ORDER.indexOf(p) === -1 ? ORDER.length : ORDER.indexOf(p))
    const sorted = [...docs].sort((a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path))
    const used = new Set<string>()
    const out = GROUPS.map((g) => {
      const items = sorted.filter((d) => !used.has(d.path) && g.match(d.path))
      items.forEach((d) => used.add(d.path))
      return { title: g.title, items }
    })
    out.push({ title: 'Other', items: sorted.filter((d) => !used.has(d.path)) })
    return out.filter((g) => g.items.length > 0)
  }, [detail])

  // Previous / next in navigation order, history last.
  const sequence = useMemo(() => [...groups.flatMap((g) => g.items.map((d) => d.path)), HISTORY], [groups])
  const position = sequence.indexOf(selected)
  const go = (delta: number) => { const next = sequence[position + delta]; if (next) setSelected(next) }

  useEffect(() => {
    if (!detail || selected === HISTORY) return
    let cancelled = false
    setContent(null); setContentError('')
    const path = `specs/${detail.intent.dirId}/${selected}`
    fetch(`/api/projects/${projectNamespace}/artifact?path=${encodeURIComponent(path)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `${r.status}`)
        return r.text()
      })
      .then((text) => { if (!cancelled) setContent({ path: selected, text }) })
      .catch((e) => { if (!cancelled) setContentError(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true }
  }, [detail, selected, projectNamespace])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      const typing = e.target instanceof HTMLElement && /^(input|textarea|select)$/i.test(e.target.tagName)
      if (typing) return
      if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); go(1) }
      if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); go(-1) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const intent = detail?.intent
  const current = detail?.documents.find((d) => d.path === selected)
  const rawUrl = intent && selected !== HISTORY ? `/api/projects/${projectNamespace}/artifact?path=${encodeURIComponent(`specs/${intent.dirId}/${selected}`)}` : undefined

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-shell intent-viewer" role="dialog" aria-modal="true" aria-label={intent ? `Intent ${intent.title}` : 'Intent'} onClick={(e) => e.stopPropagation()}>
        <div className="intent-viewer-head">
          <div className="intent-viewer-title">
            <code>{intentId}</code>
            <h2>{intent?.title ?? 'Loading…'}</h2>
            {intent?.scope && <span className={`scope-badge scope-${intent.scope}`}>{scopeLabel(intent.scope)}</span>}
            {intent && <span className="mini-badge idle">{intent.status}</span>}
            {intent?.active && <span className="mini-badge running">current</span>}
          </div>
          <div className="intent-viewer-meta">
            {intent && [
              intent.tasksTotal ? `${intent.tasksDone}/${intent.tasksTotal} tasks` : null,
              intent.codeReviewStatus ? `review ${intent.codeReviewStatus.replace('_', ' ')}` : null,
              intent.verificationStatus ? `verification ${intent.verificationStatus}` : null,
              intent.acceptedBy ? `accepted by ${intent.acceptedBy}` : null,
              intent.deliveryStatus ? `delivery ${intent.deliveryStatus}` : null,
            ].filter(Boolean).join(' · ')}
          </div>
          <button type="button" className="ghost-button" onClick={onClose}>Close</button>
        </div>

        {error && <p className="empty-state">{error}</p>}
        {!detail && !error && <LoadingBlock label="Loading the intent…" />}
        {detail && (
          <div className="intent-viewer-body">
            <nav className="intent-viewer-nav" aria-label="Intent documents">
              {groups.map((group) => (
                <div key={group.title} className="intent-nav-group">
                  <div className="intent-nav-group-title">{group.title}</div>
                  {group.items.map((doc: Doc) => (
                    <button
                      key={doc.path}
                      type="button"
                      className={`intent-nav-item${selected === doc.path ? ' selected' : ''}`}
                      aria-current={selected === doc.path ? 'page' : undefined}
                      onClick={() => setSelected(doc.path)}
                      title={doc.path}
                    >
                      <span>{docLabel(doc.path)}</span>
                      <small>{who(doc.updatedBy)} · {when(doc.updatedAt)}</small>
                    </button>
                  ))}
                </div>
              ))}
              <div className="intent-nav-group">
                <div className="intent-nav-group-title">Review</div>
                <button type="button" className={`intent-nav-item${selected === HISTORY ? ' selected' : ''}`} aria-current={selected === HISTORY ? 'page' : undefined} onClick={() => setSelected(HISTORY)}>
                  <span>History</span>
                  <small>{detail.events.length} change{detail.events.length === 1 ? '' : 's'}</small>
                </button>
              </div>
              {detail.documents.length === 0 && <p className="text-subtle intent-nav-empty">No documents recorded yet.</p>}
            </nav>

            <section className="intent-viewer-content">
              {selected === HISTORY ? (
                <div className="intent-history">
                  <h3>History</h3>
                  {detail.events.length === 0
                    ? <p className="text-subtle">No changes recorded yet.</p>
                    : (
                      <ol className="intent-timeline">
                        {[...detail.events].reverse().map((e, i) => (
                          <li key={i}>
                            <time dateTime={e.at}>{when(e.at)}</time>
                            <span className="intent-timeline-what">{describeEvent(e)}</span>
                            <span className="intent-timeline-who">{who(e.by)}</span>
                          </li>
                        ))}
                      </ol>
                    )}
                  <h3>Documents</h3>
                  <ol className="intent-timeline">
                    {[...detail.documents].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((d) => (
                      <li key={d.path}>
                        <time dateTime={d.updatedAt}>{when(d.updatedAt)}</time>
                        <button type="button" className="link-button intent-timeline-what" onClick={() => setSelected(d.path)}>{docLabel(d.path)} last changed</button>
                        <span className="intent-timeline-who">{who(d.updatedBy)}</span>
                      </li>
                    ))}
                  </ol>
                  <p className="text-subtle intent-history-note">Created {when(intent!.createdAt)} · last updated {when(intent!.updatedAt)}</p>
                </div>
              ) : (
                <>
                  <div className="intent-doc-head">
                    <strong>{docLabel(selected)}</strong>
                    <span className="text-subtle">{current ? `specs/${intentId}/${current.path} · ${who(current.updatedBy)} · ${when(current.updatedAt)}` : ''}</span>
                    {rawUrl && <a className="ghost-button" href={rawUrl} target="_blank" rel="noreferrer">Open raw ↗</a>}
                  </div>
                  {contentError && <p className="empty-state">Could not load this document: {contentError}</p>}
                  {!content && !contentError && <LoadingBlock label="Loading…" />}
                  {content && content.path === selected && (
                    /\.md$/i.test(selected)
                      ? <div className="markdown intent-doc" dangerouslySetInnerHTML={{ __html: renderMarkdown(content.text) }} />
                      : <pre className="intent-doc intent-doc-raw">{content.text}</pre>
                  )}
                </>
              )}
              <div className="intent-viewer-pager">
                <button type="button" className="ghost-button" disabled={position <= 0} onClick={() => go(-1)}>← {position > 0 ? (sequence[position - 1] === HISTORY ? 'History' : docLabel(sequence[position - 1]!)) : 'Previous'}</button>
                <span className="text-subtle">{position + 1} / {sequence.length} · ↑↓ to move</span>
                <button type="button" className="ghost-button" disabled={position >= sequence.length - 1} onClick={() => go(1)}>{position < sequence.length - 1 ? (sequence[position + 1] === HISTORY ? 'History' : docLabel(sequence[position + 1]!)) : 'Next'} →</button>
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  )
}
