import { useCallback, useEffect, useState } from 'react'
import { json, navigate, useAuth, type MeTeam } from './auth'
import { OrgKnowledgePanel } from './knowledge'
import { IntegrationsPanel } from './integrations'

/**
 * Organization page at /organization: the layer every team shares.
 *
 * Overview (teams, projects, knowledge, pending promotions), organization
 * memory, the knowledge base (imports and search), promotion proposals from
 * projects into org-wide guidance, and the list of teams with a way to start
 * a new one. Owners and admins of any team can edit; everyone can read.
 */

interface OrgMemory { name: string; manualText: string; updatedAt: string }

interface PromotionProposal {
  id: string
  projectNamespace: string
  title: string
  content: string
  targetFile: string
  status: 'pending' | 'approved' | 'rejected'
  createdAt: string
  decidedAt?: string
  decisionNotes?: string
}

interface KnowledgeStatus { sources: number; documents: number; chunks: number; embeddings: { available: boolean; model: string }; vectorSearch: boolean; lastSyncAt: string | null }

type Section = 'overview' | 'memory' | 'knowledge' | 'integrations' | 'promotions' | 'teams'

const SECTIONS: Array<{ id: Section; label: string; hint: string }> = [
  { id: 'overview', label: 'Overview', hint: 'Teams, projects, knowledge' },
  { id: 'memory', label: 'Memory', hint: 'Shared by every agent' },
  { id: 'knowledge', label: 'Knowledge base', hint: 'Imports and search' },
  { id: 'integrations', label: 'Integrations', hint: 'App credentials and connections' },
  { id: 'promotions', label: 'Promotions', hint: 'Project learnings going org-wide' },
  { id: 'teams', label: 'Teams', hint: 'Spaces and a new one' },
]

export function OrgPage() {
  const { me, refresh } = useAuth()
  const teams: MeTeam[] = me?.teams ?? []
  const canEdit = !me?.authEnabled || teams.some((t) => t.role === 'owner' || t.role === 'admin')
  const [org, setOrg] = useState<OrgMemory | null>(null)
  const [knowledge, setKnowledge] = useState<KnowledgeStatus | null>(null)
  const [promotions, setPromotions] = useState<PromotionProposal[] | null>(null)
  const [section, setSection] = useState<Section>(() => {
    const wanted = new URLSearchParams(window.location.search).get('section')
    return SECTIONS.some((s) => s.id === wanted) ? (wanted as Section) : 'overview'
  })
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const [o, k, p] = await Promise.all([
        json<OrgMemory>('/api/org/memory'),
        json<KnowledgeStatus>('/api/org/knowledge/status').catch(() => null),
        json<PromotionProposal[]>('/api/org/promotions').catch(() => []),
      ])
      setOrg(o); setKnowledge(k); setPromotions(p)
      document.title = `${o.name} · Organization · Spaces`
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])
  useEffect(() => { void load() }, [load])

  const flash = (message: string) => { setNotice(message); setError(''); window.setTimeout(() => setNotice(''), 3500) }
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true); setError('')
    try { await fn(); await load(); if (done) flash(done) } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  const name = org?.name ?? me?.org?.name ?? 'Organization'
  const projectCount = teams.reduce((n, t) => n + t.projectCount, 0)
  const membershipCount = teams.reduce((n, t) => n + t.memberCount, 0)
  const pending = (promotions ?? []).filter((p) => p.status === 'pending')

  return (
    <section className="team-page org-page" aria-label={`${name} settings`}>
      <header className="team-hero card org-hero">
        <div className="team-hero-main">
          <div className="team-avatar org-avatar" aria-hidden="true">{initials(name)}</div>
          <div className="team-hero-text">
            <div className="breadcrumb">
              <button type="button" className="ghost-button" onClick={() => navigate('/')}>← Board</button>
              <span className="text-subtle">Organization · shared by every team</span>
            </div>
            <OrgName name={name} canEdit={canEdit} busy={busy} onRename={(next) => act(() => json('/api/org/memory', { method: 'PUT', body: JSON.stringify({ name: next, manualText: org?.manualText ?? '' }) }).then(() => refresh()), 'Organization renamed.')} />
            <div className="team-chips">
              <span className="chip"><strong>{teams.length}</strong> team{teams.length === 1 ? '' : 's'}</span>
              <span className="chip"><strong>{projectCount}</strong> project{projectCount === 1 ? '' : 's'}</span>
              <span className="chip"><strong>{membershipCount}</strong> membership{membershipCount === 1 ? '' : 's'}</span>
              {knowledge && <span className="chip"><strong>{knowledge.documents}</strong> knowledge doc{knowledge.documents === 1 ? '' : 's'}</span>}
              {pending.length > 0 && <span className="chip attention"><strong>{pending.length}</strong> promotion{pending.length === 1 ? '' : 's'} to review</span>}
            </div>
          </div>
        </div>
        <div className="team-hero-actions">
          {canEdit && <button type="button" className="primary-button" onClick={() => setSection('knowledge')}>Import knowledge</button>}
          <button type="button" className="secondary-button" onClick={() => navigate('/')}>Back to board</button>
        </div>
      </header>

      {error && <p className="error-text team-flash">{error}</p>}
      {notice && <p className="team-flash team-flash-ok">{notice}</p>}

      <div className="team-layout">
        <nav className="team-nav card" aria-label="Organization sections">
          {SECTIONS.map((s) => (
            <button key={s.id} type="button" className={`team-nav-item ${section === s.id ? 'active' : ''}`} onClick={() => setSection(s.id)} aria-current={section === s.id ? 'page' : undefined}>
              <span className="team-nav-label">{s.label}</span>
              <span className="team-nav-hint">{s.hint}</span>
              {s.id === 'promotions' && pending.length > 0 && <span className="team-nav-count">{pending.length}</span>}
            </button>
          ))}
        </nav>

        <div className="team-content">
          {section === 'overview' && (
            <>
              <div className="stat-grid">
                <Stat label="Teams" value={teams.length} sub={`${teams.filter((t) => t.role === 'owner' || t.role === 'admin').length} you manage`} />
                <Stat label="Projects" value={projectCount} sub="across all your teams" />
                <Stat label="Knowledge" value={knowledge?.documents ?? '—'} sub={knowledge ? (knowledge.embeddings.available && knowledge.vectorSearch ? 'semantic + keyword search' : 'keyword search') : 'unavailable'} />
                <Stat label="Promotions" value={pending.length} sub={pending.length ? 'waiting for a decision' : 'nothing pending'} />
              </div>
              <section className="card panel team-section">
                <div className="team-section-head">
                  <h3>Teams</h3>
                  <button type="button" className="ghost-button" onClick={() => setSection('teams')}>Manage</button>
                </div>
                <ul className="team-project-list">
                  {teams.map((t) => (
                    <li key={t.teamId}>
                      <button type="button" className="team-project" onClick={() => navigate(`/teams/${encodeURIComponent(t.slug)}`)}>
                        <span className="team-mini-avatar" aria-hidden="true">{initials(t.name)}</span>
                        <span className="team-project-name">{t.name}</span>
                        <span className="team-project-desc">{t.memberCount} member{t.memberCount === 1 ? '' : 's'} · {t.projectCount} project{t.projectCount === 1 ? '' : 's'}</span>
                        <span className="team-project-meta"><span className="chip role">{t.role}</span></span>
                      </button>
                    </li>
                  ))}
                  {teams.length === 0 && <li className="panel-subtitle">You are not in a team yet.</li>}
                </ul>
              </section>
              <section className="card panel team-section">
                <div className="team-section-head">
                  <h3>Organization memory</h3>
                  <button type="button" className="ghost-button" onClick={() => setSection('memory')}>{canEdit ? 'Edit' : 'Read'}</button>
                </div>
                <pre className="team-memory-preview">{org?.manualText.trim() || 'Nothing written yet. Organization memory reaches every agent, in every team, before anything else.'}</pre>
              </section>
            </>
          )}

          {section === 'memory' && org && (
            <MemorySection initial={org.manualText} updatedAt={org.updatedAt} name={org.name} readOnly={!canEdit} busy={busy} act={act} />
          )}

          {section === 'knowledge' && <OrgKnowledgePanel canEdit={canEdit} teams={teams} />}

          {section === 'integrations' && (
            <section className="card panel team-section">
              <div className="team-section-head">
                <h3>Integrations</h3>
                <span className="panel-subtitle">Shared by every team. Credentials first, then connect.</span>
              </div>
              <IntegrationsPanel embedded />
            </section>
          )}

          {section === 'promotions' && (
            <PromotionsSection proposals={promotions ?? []} canDecide={canEdit} busy={busy} act={act} />
          )}

          {section === 'teams' && (
            <TeamsSection teams={teams} busy={busy} act={act} onCreated={refresh} />
          )}
        </div>
      </div>
    </section>
  )
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const text = words.length >= 2 ? words.slice(0, 2).map((w) => w[0]!).join('') : name.slice(0, 2)
  return text.toUpperCase() || 'ORG'
}

function Stat({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  return (
    <div className="stat card">
      <span className="stat-label">{label}</span>
      <strong className="stat-value">{value}</strong>
      {sub && <span className="stat-sub">{sub}</span>}
    </div>
  )
}

function OrgName({ name, canEdit, busy, onRename }: { name: string; canEdit: boolean; busy: boolean; onRename: (name: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)
  useEffect(() => { setDraft(name) }, [name])
  if (!editing) {
    return (
      <h1 className="team-title">
        {name}
        {canEdit && <button type="button" className="ghost-button team-rename" onClick={() => setEditing(true)} title="Rename organization">Rename</button>}
      </h1>
    )
  }
  return (
    <form className="team-title-edit" onSubmit={(e) => { e.preventDefault(); if (draft.trim() && draft.trim() !== name) void onRename(draft.trim()); setEditing(false) }}>
      <input value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus aria-label="Organization name" />
      <button type="submit" className="primary-button" disabled={busy || !draft.trim()}>Save</button>
      <button type="button" className="ghost-button" onClick={() => { setDraft(name); setEditing(false) }}>Cancel</button>
    </form>
  )
}

function MemorySection({ initial, updatedAt, name, readOnly, busy, act }: { initial: string; updatedAt?: string; name: string; readOnly: boolean; busy: boolean; act: (fn: () => Promise<unknown>, done?: string) => Promise<void> }) {
  const [text, setText] = useState(initial)
  useEffect(() => { setText(initial) }, [initial])
  const dirty = text !== initial
  return (
    <section className="card panel team-section">
      <div className="team-section-head">
        <h3>Organization memory</h3>
        <span className="panel-subtitle">The first thing every agent reads, in every team and project. Team and project memory refine it.</span>
      </div>
      <div className="memory-hints">
        <span>Engineering principles</span><span>Security policies</span><span>Architecture standards</span><span>Definition of done</span><span>Compliance rules</span>
      </div>
      <textarea className="memory-editor team-memory-editor" value={text} onChange={(e) => setText(e.target.value)} readOnly={readOnly} placeholder={readOnly ? 'Nothing written yet.' : 'Company-wide rules in plain language: “All services log in JSON”, “No PII in logs”, “Every change ships behind a flag”…'} />
      <div className="button-row memory-footer">
        {!readOnly && <button type="button" className="primary-button" disabled={busy || !dirty} onClick={() => void act(() => json('/api/org/memory', { method: 'PUT', body: JSON.stringify({ name, manualText: text }) }), 'Organization memory saved.')}>{dirty ? 'Save changes' : 'Saved'}</button>}
        {!readOnly && dirty && <button type="button" className="ghost-button" onClick={() => setText(initial)}>Discard</button>}
        <span className="text-subtle" style={{ marginLeft: 'auto' }}>{text.length.toLocaleString()} characters{updatedAt ? ` · last saved ${new Date(updatedAt).toLocaleString()}` : ''}</span>
      </div>
    </section>
  )
}

function PromotionsSection({ proposals, canDecide, busy, act }: { proposals: PromotionProposal[]; canDecide: boolean; busy: boolean; act: (fn: () => Promise<unknown>, done?: string) => Promise<void> }) {
  const [filter, setFilter] = useState<'pending' | 'all'>('pending')
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [open, setOpen] = useState<string | null>(null)
  const shown = proposals.filter((p) => filter === 'all' || p.status === 'pending').sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const decide = (p: PromotionProposal, decision: 'approved' | 'rejected') => act(() => json(`/api/org/promotions/${encodeURIComponent(p.id)}/decision`, { method: 'POST', body: JSON.stringify({ decision, notes: notes[p.id] ?? '' }) }), decision === 'approved' ? `“${p.title}” promoted into ${p.targetFile}.` : `“${p.title}” rejected.`)
  return (
    <section className="card panel team-section">
      <div className="team-section-head">
        <h3>Promotion proposals</h3>
        <div className="segmented" role="tablist">
          <button type="button" className={filter === 'pending' ? 'active' : ''} onClick={() => setFilter('pending')} role="tab" aria-selected={filter === 'pending'}>Pending</button>
          <button type="button" className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')} role="tab" aria-selected={filter === 'all'}>All</button>
        </div>
      </div>
      <p className="panel-subtitle" style={{ marginTop: 0 }}>Projects propose learnings worth sharing: conventions, decisions, guidelines. Approving writes them into the organization's guidance files that every agent reads.</p>
      {shown.length === 0 && <p className="panel-subtitle">{filter === 'pending' ? 'Nothing waiting for a decision.' : 'No proposals yet.'}</p>}
      <ul className="promo-list">
        {shown.map((p) => (
          <li key={p.id} className={`promo ${p.status}`}>
            <button type="button" className="promo-head" onClick={() => setOpen(open === p.id ? null : p.id)} aria-expanded={open === p.id}>
              <span className={`mini-badge ${p.status === 'approved' ? 'completed' : p.status === 'rejected' ? 'error' : 'paused'}`}>{p.status}</span>
              <strong>{p.title}</strong>
              <span className="text-subtle">from {p.projectNamespace} → <code>{p.targetFile}</code> · {new Date(p.createdAt).toLocaleDateString()}</span>
              <span className="dock-chevron" aria-hidden="true">{open === p.id ? '▾' : '▸'}</span>
            </button>
            {open === p.id && (
              <div className="promo-body">
                <pre className="team-memory-preview">{p.content}</pre>
                {p.status !== 'pending' && <p className="text-subtle">Decided {p.decidedAt ? new Date(p.decidedAt).toLocaleString() : ''}{p.decisionNotes ? ` · ${p.decisionNotes}` : ''}</p>}
                {p.status === 'pending' && canDecide && (
                  <div className="promo-actions">
                    <input value={notes[p.id] ?? ''} onChange={(e) => setNotes({ ...notes, [p.id]: e.target.value })} placeholder="Decision notes (optional)" />
                    <button type="button" className="primary-button" disabled={busy} onClick={() => void decide(p, 'approved')}>Approve</button>
                    <button type="button" className="secondary-button" disabled={busy} onClick={() => void decide(p, 'rejected')}>Reject</button>
                  </div>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

function TeamsSection({ teams, busy, act, onCreated }: { teams: MeTeam[]; busy: boolean; act: (fn: () => Promise<unknown>, done?: string) => Promise<void>; onCreated: () => Promise<void> }) {
  const [name, setName] = useState('')
  return (
    <>
      <section className="card panel team-section">
        <div className="team-section-head">
          <h3>Your teams</h3>
          <span className="panel-subtitle">Each team is a space with its own projects, memory and knowledge defaults.</span>
        </div>
        <ul className="team-project-list">
          {teams.map((t) => (
            <li key={t.teamId}>
              <button type="button" className="team-project" onClick={() => navigate(`/teams/${encodeURIComponent(t.slug)}`)}>
                <span className="team-mini-avatar" aria-hidden="true">{initials(t.name)}</span>
                <span className="team-project-name">{t.name}</span>
                <span className="team-project-desc">{t.memberCount} member{t.memberCount === 1 ? '' : 's'} · {t.projectCount} project{t.projectCount === 1 ? '' : 's'} · /teams/{t.slug}</span>
                <span className="team-project-meta"><span className="chip role">{t.role}</span></span>
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section className="card panel team-section">
        <div className="team-section-head">
          <h3>Start a new team</h3>
          <span className="panel-subtitle">You become its owner and it becomes your active team; invite people from its settings page.</span>
        </div>
        <form className="invite-form" style={{ gridTemplateColumns: '1fr auto' }} onSubmit={(e) => {
          e.preventDefault()
          if (!name.trim()) return
          void act(async () => {
            const r = await json<{ team: { slug: string } }>('/api/teams', { method: 'POST', body: JSON.stringify({ name: name.trim() }) })
            setName('')
            await onCreated()
            navigate(`/teams/${encodeURIComponent(r.team.slug)}`)
          }, 'Team created.')
        }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Platform team" />
          <button type="submit" className="primary-button" disabled={busy || !name.trim()}>Create team</button>
        </form>
        <p className="panel-subtitle" style={{ marginTop: 10 }}>Project codes for the new team get a prefix from its name, for example “Platform team” → <code>PLAT-1</code>.</p>
      </section>
    </>
  )
}
