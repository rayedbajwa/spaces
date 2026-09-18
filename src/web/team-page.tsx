import { useCallback, useEffect, useMemo, useState } from 'react'
import { json, navigate, useAuth, type MeTeam, type TeamRole } from './auth'
import { PageHead } from './shell'

/**
 * Team (space) settings as a full page at /teams/<slug>.
 *
 * Layout: a hero with the team's code prefix, name and key numbers, a side
 * navigation, and one section at a time — Overview, Members, Invites, Memory,
 * Knowledge defaults. Everything the old dialog did, with room to breathe.
 */

interface TeamDetail {
  team: { teamId: string; name: string; slug: string; codePrefix?: string | null; createdAt?: string }
  role: TeamRole
  members: Array<{ userId: string; email: string; name: string; role: TeamRole; joinedAt: string }>
  invites: Array<{ inviteId: string; email: string; role: string; expiresAt: string; invitedByName?: string | null }>
  memory: { manualText: string; updatedAt: string }
}

interface TeamProject {
  projectId: string
  name: string
  slug: string
  code?: string | null
  description?: string | null
  archivedAt?: string | null
  pausedAt?: string | null
  updatedAt: string
}

interface KnowledgeConfig {
  sources?: Array<'jira' | 'linear' | 'confluence' | 'github'>
  jira?: { projects?: string[] }
  linear?: { teams?: string[]; projects?: string[] }
  confluence?: { spaces?: string[] }
  github?: { repos?: string[] }
}

type Section = 'overview' | 'members' | 'invites' | 'memory' | 'knowledge'

const SECTIONS: Array<{ id: Section; label: string; hint: string; adminOnly?: boolean; group: string }> = [
  { id: 'overview', label: 'Overview', hint: 'Projects and numbers', group: 'Team' },
  { id: 'members', label: 'Members', hint: 'People and roles', group: 'People' },
  { id: 'invites', label: 'Invites', hint: 'Bring people in', adminOnly: true, group: 'People' },
  { id: 'memory', label: 'Memory', hint: 'What every agent knows', group: 'Context' },
  { id: 'knowledge', label: 'Knowledge defaults', hint: 'Sources projects inherit', adminOnly: true, group: 'Context' },
]

const ROLE_HINT: Record<TeamRole, string> = {
  owner: 'Everything, including ownership transfer',
  admin: 'Manage members, invites, projects and knowledge',
  member: 'Create and run projects, edit memory',
  viewer: 'Read only',
}

export function TeamPage({ slug, teams }: { slug: string; teams: MeTeam[] }) {
  const { me, refresh } = useAuth()
  const team = teams.find((t) => t.slug === slug)
  const [detail, setDetail] = useState<TeamDetail | null>(null)
  const [projects, setProjects] = useState<TeamProject[] | null>(null)
  const [section, setSection] = useState<Section>(() => {
    const wanted = new URLSearchParams(window.location.search).get('section')
    return SECTIONS.some((s) => s.id === wanted) ? (wanted as Section) : 'overview'
  })
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (!team) return
    try {
      const [d, p] = await Promise.all([
        json<TeamDetail>(`/api/teams/${team.teamId}`),
        json<{ projects: TeamProject[] }>(`/api/teams/${team.teamId}/projects`).catch(() => ({ projects: [] })),
      ])
      setDetail(d)
      setProjects(p.projects)
      document.title = `${d.team.name} · Team · Spaces`
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [team?.teamId])

  useEffect(() => { void load() }, [load])

  const flash = (message: string) => { setNotice(message); setError(''); window.setTimeout(() => setNotice(''), 3500) }
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true); setError('')
    try { await fn(); await load(); if (done) flash(done) } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  if (!team) {
    return (
      <section className="team-page">
        <div className="team-empty card">
          <h2>Team not found</h2>
          <p className="panel-subtitle">You are not a member of a team called “{slug}”.</p>
          <button type="button" className="secondary-button" onClick={() => navigate('/')}>← Back to board</button>
        </div>
      </section>
    )
  }

  const role = detail?.role ?? team.role
  const canManage = role === 'owner' || role === 'admin'
  const members = detail?.members ?? []
  const active = (projects ?? []).filter((p) => !p.archivedAt)
  const archived = (projects ?? []).filter((p) => p.archivedAt)
  const visibleSections = SECTIONS.filter((s) => !s.adminOnly || canManage)

  return (
    <section className="team-page" aria-label={`${team.name} settings`}>
      <PageHead
        title={<TeamName name={detail?.team.name ?? team.name} canEdit={canManage} busy={busy} onRename={(name) => act(() => json(`/api/teams/${team.teamId}`, { method: 'PATCH', body: JSON.stringify({ name }) }).then(() => refresh()), 'Team renamed.')} />}
        eyebrow="Team space"
      >
        {canManage && <button type="button" className="primary-button" onClick={() => setSection('invites')}>Invite people</button>}
      </PageHead>
      <div className="team-chips page-chips">
        <span className="chip"><strong>{members.length}</strong> member{members.length === 1 ? '' : 's'}</span>
        <span className="chip"><strong>{active.length}</strong> active project{active.length === 1 ? '' : 's'}</span>
        {archived.length > 0 && <span className="chip muted"><strong>{archived.length}</strong> archived</span>}
        <span className="chip role" title={ROLE_HINT[role]}>you: {role}</span>
        {detail?.team.codePrefix && <span className="chip mono" title="Project codes start with this prefix">codes {detail.team.codePrefix}-…</span>}
      </div>

      {error && <p className="error-text team-flash">{error}</p>}
      {notice && <p className="team-flash team-flash-ok">{notice}</p>}

      <div className="tab-row page-tabs" role="tablist" aria-label="Team settings sections">
        {visibleSections.map((s) => (
          <button key={s.id} type="button" role="tab" className={`tab-button ${section === s.id ? 'active' : ''}`} aria-selected={section === s.id} onClick={() => setSection(s.id)}>
            {s.label}
            {s.id === 'invites' && (detail?.invites.length ?? 0) > 0 && <span className="tab-count">{detail!.invites.length}</span>}
          </button>
        ))}
      </div>

        <div className="team-content">
          {section === 'overview' && (
            <>
              <div className="stat-grid">
                <Stat label="Members" value={members.length} sub={`${members.filter((m) => m.role === 'owner' || m.role === 'admin').length} can manage`} />
                <Stat label="Projects" value={active.length} sub={active.filter((p) => p.pausedAt).length ? `${active.filter((p) => p.pausedAt).length} paused` : 'all running'} />
                <Stat label="Archived" value={archived.length} sub="kept, hidden from board" />
                <Stat label="Pending invites" value={detail?.invites.length ?? 0} sub={canManage ? 'expire after 14 days' : '—'} />
              </div>
              <section className="card panel team-section">
                <div className="team-section-head">
                  <h3>Projects</h3>
                  <span className="panel-subtitle">Codes open the project page.</span>
                </div>
                {projects === null && <p className="panel-subtitle">Loading…</p>}
                {projects && projects.length === 0 && <p className="panel-subtitle">No projects yet. Create one from the board.</p>}
                <ul className="team-project-list">
                  {[...active, ...archived].map((p) => (
                    <li key={p.projectId}>
                      <button type="button" className="team-project" onClick={() => navigate(`/spaces/${encodeURIComponent(p.code ?? p.slug)}`)}>
                        {p.code && <span className="code-badge">{p.code}</span>}
                        <span className="team-project-name">{p.name}</span>
                        {p.description && <span className="team-project-desc">{p.description}</span>}
                        <span className="team-project-meta">
                          {p.archivedAt && <span className="mini-badge archived">archived</span>}
                          {p.pausedAt && !p.archivedAt && <span className="mini-badge paused">paused</span>}
                          <span className="text-subtle">updated {new Date(p.updatedAt).toLocaleDateString()}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
              <section className="card panel team-section">
                <div className="team-section-head">
                  <h3>Team memory</h3>
                  <button type="button" className="ghost-button" onClick={() => setSection('memory')}>Edit</button>
                </div>
                <pre className="team-memory-preview">{detail?.memory.manualText.trim() || 'Nothing written yet. Team memory is injected into every agent that works on this team’s projects.'}</pre>
              </section>
            </>
          )}

          {section === 'members' && (
            <section className="card panel team-section">
              <div className="team-section-head">
                <h3>Members</h3>
                <span className="panel-subtitle">{canManage ? 'Change roles inline; owners can promote to owner.' : 'Ask an owner or admin to change roles.'}</span>
              </div>
              <ul className="member-list">
                {members.map((m) => {
                  const isMe = m.userId === me?.user?.userId
                  return (
                    <li key={m.userId} className="member-row">
                      <span className="avatar avatar-initial member-avatar" aria-hidden="true">{m.name.slice(0, 1).toUpperCase()}</span>
                      <div className="member-id">
                        <strong>{m.name}{isMe ? <span className="text-subtle"> · you</span> : null}</strong>
                        <span className="text-subtle">{m.email} · joined {new Date(m.joinedAt).toLocaleDateString()}</span>
                      </div>
                      {canManage && !isMe ? (
                        <select className="member-role" value={m.role} disabled={busy} title={ROLE_HINT[m.role]} onChange={(e) => void act(() => json(`/api/teams/${team.teamId}/members/${m.userId}`, { method: 'PATCH', body: JSON.stringify({ role: e.target.value }) }), `${m.name} is now ${e.target.value}.`)}>
                          {(['owner', 'admin', 'member', 'viewer'] as TeamRole[]).map((r) => <option key={r} value={r} disabled={r === 'owner' && role !== 'owner'}>{r}</option>)}
                        </select>
                      ) : <span className={`mini-badge ${m.role === 'owner' ? 'completed' : 'idle'} member-role-badge`} title={ROLE_HINT[m.role]}>{m.role}</span>}
                      {(canManage || isMe) && (
                        <button type="button" className="ghost-button" disabled={busy} onClick={() => { if (window.confirm(isMe ? `Leave ${team.name}?` : `Remove ${m.name} from ${team.name}?`)) void act(() => json(`/api/teams/${team.teamId}/members/${m.userId}`, { method: 'DELETE' }).then(async () => { if (isMe) { await refresh(); navigate('/') } }), isMe ? undefined : `${m.name} removed.`) }}>
                          {isMe ? 'Leave team' : 'Remove'}
                        </button>
                      )}
                    </li>
                  )
                })}
              </ul>
              <div className="role-legend">
                {(['owner', 'admin', 'member', 'viewer'] as TeamRole[]).map((r) => <span key={r}><strong>{r}</strong> — {ROLE_HINT[r]}</span>)}
              </div>
            </section>
          )}

          {section === 'invites' && canManage && (
            <InvitesSection teamId={team.teamId} teamName={team.name} invites={detail?.invites ?? []} busy={busy} act={act} />
          )}

          {section === 'memory' && (
            <MemorySection teamId={team.teamId} initial={detail?.memory.manualText ?? ''} updatedAt={detail?.memory.updatedAt} readOnly={role === 'viewer'} busy={busy} act={act} />
          )}

          {section === 'knowledge' && canManage && (
            <KnowledgeSection teamId={team.teamId} busy={busy} act={act} />
          )}

        </div>
    </section>
  )
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

function TeamName({ name, canEdit, busy, onRename }: { name: string; canEdit: boolean; busy: boolean; onRename: (name: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)
  useEffect(() => { setDraft(name) }, [name])
  if (!editing) {
    return (
      <h1 className="team-title">
        {name}
        {canEdit && <button type="button" className="ghost-button team-rename" onClick={() => setEditing(true)} title="Rename team">Rename</button>}
      </h1>
    )
  }
  return (
    <form className="team-title-edit" onSubmit={(e) => { e.preventDefault(); if (draft.trim() && draft.trim() !== name) void onRename(draft.trim()); setEditing(false) }}>
      <input value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus aria-label="Team name" />
      <button type="submit" className="primary-button" disabled={busy || !draft.trim()}>Save</button>
      <button type="button" className="ghost-button" onClick={() => { setDraft(name); setEditing(false) }}>Cancel</button>
    </form>
  )
}

function InvitesSection({ teamId, teamName, invites, busy, act }: { teamId: string; teamName: string; invites: TeamDetail['invites']; busy: boolean; act: (fn: () => Promise<unknown>, done?: string) => Promise<void> }) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'admin' | 'member' | 'viewer'>('member')
  const [link, setLink] = useState('')
  const [copied, setCopied] = useState(false)
  const copy = async (value: string) => { await navigator.clipboard?.writeText(value); setCopied(true); window.setTimeout(() => setCopied(false), 1500) }
  return (
    <>
      <section className="card panel team-section">
        <div className="team-section-head">
          <h3>Invite someone to {teamName}</h3>
          <span className="panel-subtitle">No mail is sent: you get a link to share. It works for 14 days and only for that address.</span>
        </div>
        <form className="invite-form" onSubmit={(e) => { e.preventDefault(); if (!email.trim()) return; void act(async () => { const r = await json<{ link: string }>(`/api/teams/${teamId}/invites`, { method: 'POST', body: JSON.stringify({ email, role }) }); setLink(r.link); setEmail('') }, 'Invite created — copy the link below.') }}>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@company.com" required />
          <select value={role} onChange={(e) => setRole(e.target.value as 'admin' | 'member' | 'viewer')} title={ROLE_HINT[role]}>
            <option value="admin">admin</option><option value="member">member</option><option value="viewer">viewer</option>
          </select>
          <button type="submit" className="primary-button" disabled={busy || !email.trim()}>Create invite link</button>
        </form>
        {link && (
          <div className="invite-link">
            <code>{link}</code>
            <button type="button" className="secondary-button" onClick={() => void copy(link)}>{copied ? 'Copied' : 'Copy link'}</button>
          </div>
        )}
      </section>
      <section className="card panel team-section">
        <div className="team-section-head">
          <h3>Pending invites</h3>
          <span className="panel-subtitle">{invites.length === 0 ? 'None outstanding.' : `${invites.length} waiting to be accepted.`}</span>
        </div>
        <ul className="member-list">
          {invites.map((i) => (
            <li key={i.inviteId} className="member-row">
              <span className="avatar avatar-initial member-avatar pending" aria-hidden="true">@</span>
              <div className="member-id">
                <strong>{i.email}</strong>
                <span className="text-subtle">expires {new Date(i.expiresAt).toLocaleDateString()}{i.invitedByName ? ` · invited by ${i.invitedByName}` : ''}</span>
              </div>
              <span className="mini-badge idle member-role-badge">{i.role}</span>
              <button type="button" className="ghost-button" disabled={busy} onClick={() => void act(() => json(`/api/teams/${teamId}/invites/${i.inviteId}`, { method: 'DELETE' }), 'Invite revoked.')}>Revoke</button>
            </li>
          ))}
        </ul>
      </section>
    </>
  )
}

function MemorySection({ teamId, initial, updatedAt, readOnly, busy, act }: { teamId: string; initial: string; updatedAt?: string; readOnly: boolean; busy: boolean; act: (fn: () => Promise<unknown>, done?: string) => Promise<void> }) {
  const [text, setText] = useState(initial)
  useEffect(() => { setText(initial) }, [initial])
  const dirty = text !== initial
  return (
    <section className="card panel team-section">
      <div className="team-section-head">
        <h3>Team memory</h3>
        <span className="panel-subtitle">Injected into every agent working on this team’s projects, after organization memory and before project memory.</span>
      </div>
      <div className="memory-hints">
        <span>Conventions and coding standards</span><span>Review preferences</span><span>Architecture decisions</span><span>Rollout and release rules</span><span>Glossary</span>
      </div>
      <textarea className="memory-editor team-memory-editor" value={text} onChange={(e) => setText(e.target.value)} readOnly={readOnly} placeholder={readOnly ? 'Nothing written yet.' : 'Write in plain language. Short, concrete rules work best: “All services expose /healthz”, “Reviews need one approval from @platform”…'} />
      <div className="button-row memory-footer">
        {!readOnly && <button type="button" className="primary-button" disabled={busy || !dirty} onClick={() => void act(() => json(`/api/teams/${teamId}/memory`, { method: 'PUT', body: JSON.stringify({ text }) }), 'Team memory saved.')}>{dirty ? 'Save changes' : 'Saved'}</button>}
        {!readOnly && dirty && <button type="button" className="ghost-button" onClick={() => setText(initial)}>Discard</button>}
        <span className="text-subtle" style={{ marginLeft: 'auto' }}>{text.length.toLocaleString()} characters{updatedAt ? ` · last saved ${new Date(updatedAt).toLocaleString()}` : ''}</span>
      </div>
    </section>
  )
}

function KnowledgeSection({ teamId, busy, act }: { teamId: string; busy: boolean; act: (fn: () => Promise<unknown>, done?: string) => Promise<void> }) {
  const [config, setConfig] = useState<KnowledgeConfig | null>(null)
  const [connected, setConnected] = useState<string[]>([])
  useEffect(() => {
    void json<{ config: KnowledgeConfig }>(`/api/teams/${teamId}/knowledge`).then((r) => setConfig(r.config ?? {})).catch(() => setConfig({}))
    void json<{ sources: string[] }>('/api/knowledge/sources').then((r) => setConnected(r.sources)).catch(() => setConnected([]))
  }, [teamId])
  const all: Array<{ id: 'jira' | 'linear' | 'confluence' | 'github'; label: string }> = [
    { id: 'jira', label: 'Jira' }, { id: 'linear', label: 'Linear' }, { id: 'confluence', label: 'Confluence' }, { id: 'github', label: 'GitHub issues & PRs' },
  ]
  const listValue = (v?: string[]) => (v ?? []).join(', ')
  const parseList = (v: string) => v.split(/[,\n]/).map((s) => s.trim()).filter(Boolean)
  const sources = config?.sources ?? []
  const enabled = (id: string) => sources.length === 0 || sources.includes(id as never)
  const toggle = (id: 'jira' | 'linear' | 'confluence' | 'github') => setConfig((c) => {
    const current = c?.sources?.length ? c.sources : all.map((a) => a.id)
    const next = current.includes(id) ? current.filter((s) => s !== id) : [...current, id]
    return { ...(c ?? {}), sources: next }
  })
  if (!config) return <section className="card panel team-section"><p className="panel-subtitle">Loading…</p></section>
  return (
    <section className="card panel team-section">
      <div className="team-section-head">
        <h3>Knowledge defaults</h3>
        <span className="panel-subtitle">New projects in this team inherit these integration scopes; each project can still narrow them in its Context tab.</span>
      </div>
      <div className="knowledge-grid">
        {all.map((s) => (
          <label key={s.id} className={`knowledge-source ${enabled(s.id) ? 'on' : ''} ${connected.includes(s.id) ? '' : 'disconnected'}`}>
            <input type="checkbox" checked={enabled(s.id)} onChange={() => toggle(s.id)} />
            <span className="knowledge-source-name">{s.label}</span>
            <span className="text-subtle">{connected.includes(s.id) ? 'connected' : 'not connected'}</span>
          </label>
        ))}
      </div>
      <div className="knowledge-fields">
        <label>Jira project keys<input value={listValue(config.jira?.projects)} onChange={(e) => setConfig({ ...config, jira: { projects: parseList(e.target.value) } })} placeholder="PAY, PLAT" /></label>
        <label>Linear team keys<input value={listValue(config.linear?.teams)} onChange={(e) => setConfig({ ...config, linear: { ...config.linear, teams: parseList(e.target.value) } })} placeholder="ENG, DATA" /></label>
        <label>Linear projects<input value={listValue(config.linear?.projects)} onChange={(e) => setConfig({ ...config, linear: { ...config.linear, projects: parseList(e.target.value) } })} placeholder="Checkout v2" /></label>
        <label>Confluence spaces<input value={listValue(config.confluence?.spaces)} onChange={(e) => setConfig({ ...config, confluence: { spaces: parseList(e.target.value) } })} placeholder="ENG, RUNBOOKS" /></label>
        <label>GitHub repositories<input value={listValue(config.github?.repos)} onChange={(e) => setConfig({ ...config, github: { repos: parseList(e.target.value) } })} placeholder="acme/api, acme/web" /></label>
      </div>
      <div className="button-row">
        <button type="button" className="primary-button" disabled={busy} onClick={() => void act(() => json(`/api/teams/${teamId}/knowledge`, { method: 'PUT', body: JSON.stringify(config) }), 'Knowledge defaults saved.')}>Save defaults</button>
      </div>
    </section>
  )
}

export function useTeamBySlug(teams: MeTeam[], slug: string | null): MeTeam | undefined {
  return useMemo(() => (slug ? teams.find((t) => t.slug === slug) : undefined), [teams, slug])
}
