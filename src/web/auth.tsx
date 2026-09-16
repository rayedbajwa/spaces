import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'

/**
 * Authentication + teams for the web UI.
 *
 *  <AuthRoot>   loads /api/auth/status and /api/me; renders the sign-in screen
 *               (register / login / GitHub / invite acceptance) until a session
 *               exists, then the app. Listens for `spaces:unauthenticated`
 *               (dispatched by the fetch helpers on 401) to fall back to it.
 *  <UserMenu>   hero widget: active team switcher, team settings, organization
 *               memory, sign out.
 */

export type TeamRole = 'owner' | 'admin' | 'member' | 'viewer'
export interface MeUser { userId: string; email: string; name: string; avatarUrl?: string | null; githubLogin?: string | null }
export interface MeTeam { teamId: string; name: string; slug: string; role: TeamRole; memberCount: number; projectCount: number }
export interface Me { authEnabled: boolean; user: MeUser | null; teams: MeTeam[]; activeTeam: MeTeam | null; org?: { name: string; manualText: string } }

interface AuthState { me: Me | null; refresh: () => Promise<void>; signOut: () => Promise<void>; switchTeam: (teamId: string) => Promise<void> }

const AuthContext = createContext<AuthState>({ me: null, refresh: async () => undefined, signOut: async () => undefined, switchTeam: async () => undefined })
export const useAuth = () => useContext(AuthContext)

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...(init?.headers ?? {}) } })
  const data = (await response.json().catch(() => ({}))) as T & { error?: string }
  if (!response.ok) throw new Error(data.error ?? `${response.status}`)
  return data
}

export function AuthRoot({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<{ authEnabled: boolean; needsBootstrap: boolean; githubLogin: boolean } | null>(null)
  const [me, setMe] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)
  const [signedOut, setSignedOut] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const s = await json<{ authEnabled: boolean; needsBootstrap: boolean; githubLogin: boolean }>('/api/auth/status')
      setStatus(s)
      if (!s.authEnabled) { setMe({ authEnabled: false, user: null, teams: [], activeTeam: null }); setSignedOut(false); return }
      const m = await json<Me>('/api/me')
      setMe(m)
      setSignedOut(false)
    } catch {
      setMe(null)
      setSignedOut(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const onUnauth = () => { setMe(null); setSignedOut(true) }
    window.addEventListener('spaces:unauthenticated', onUnauth)
    return () => window.removeEventListener('spaces:unauthenticated', onUnauth)
  }, [refresh])

  const signOut = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined)
    setMe(null)
    setSignedOut(true)
  }, [])

  const switchTeam = useCallback(async (teamId: string) => {
    await json('/api/me/team', { method: 'POST', body: JSON.stringify({ teamId }) })
    await refresh()
    window.location.reload()
  }, [refresh])

  if (loading) return <div className="auth-screen"><div className="auth-card"><p className="panel-subtitle">Loading…</p></div></div>
  if (status?.authEnabled && (signedOut || !me?.user)) {
    return <SignInScreen needsBootstrap={status.needsBootstrap} githubLogin={status.githubLogin} onSignedIn={refresh} />
  }
  return <AuthContext.Provider value={{ me, refresh, signOut, switchTeam }}>{children}</AuthContext.Provider>
}

// ---------------------------------------------------------------------------
// Sign in / register / invite
// ---------------------------------------------------------------------------

function inviteTokenFromPath(): string | undefined {
  const match = /^\/invite\/([^/]+)/.exec(window.location.pathname)
  return match ? decodeURIComponent(match[1]!) : undefined
}

function SignInScreen({ needsBootstrap, githubLogin, onSignedIn }: { needsBootstrap: boolean; githubLogin: boolean; onSignedIn: () => Promise<void> }) {
  const inviteToken = inviteTokenFromPath()
  const [invite, setInvite] = useState<{ email: string; role: string; teamName: string } | null>(null)
  const [inviteError, setInviteError] = useState('')
  const [mode, setMode] = useState<'login' | 'register'>(needsBootstrap || inviteToken ? 'register' : 'login')
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!inviteToken) return
    json<{ email: string; role: string; teamName: string }>(`/api/invites/${encodeURIComponent(inviteToken)}`)
      .then((i) => { setInvite(i); setEmail(i.email) })
      .catch((e) => setInviteError(e instanceof Error ? e.message : String(e)))
  }, [inviteToken])

  async function submit() {
    setBusy(true)
    setError('')
    try {
      if (mode === 'register') {
        await json('/api/auth/register', { method: 'POST', body: JSON.stringify({ email, name, password, inviteToken }) })
      } else {
        await json('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password, inviteToken }) })
      }
      if (inviteToken) window.history.replaceState({}, '', '/')
      await onSignedIn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const githubHref = `/api/oauth/github/authorize?mode=login${inviteToken ? `&invite=${encodeURIComponent(inviteToken)}` : ''}`

  return (
    <div className="auth-screen">
      <div className="auth-card card">
        <p className="eyebrow">Agent-driven SDLC</p>
        <h1>Spaces</h1>
        {needsBootstrap && (
          <p className="panel-subtitle">No accounts yet. Create the first one — it becomes the owner of the default team and adopts existing projects.</p>
        )}
        {inviteToken && invite && (
          <p className="auth-invite">You are invited to join <strong>{invite.teamName}</strong> as <strong>{invite.role}</strong>. Sign in or create your account with <strong>{invite.email}</strong>.</p>
        )}
        {inviteToken && inviteError && <p className="error-text">{inviteError}</p>}
        {!needsBootstrap && !inviteToken && mode === 'register' && (
          <p className="panel-subtitle">Registration is by invitation unless the server sets OPEN_REGISTRATION=1.</p>
        )}

        <form onSubmit={(e) => { e.preventDefault(); void submit() }}>
          {mode === 'register' && (
            <label>Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada Lovelace" autoComplete="name" /></label>
          )}
          <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" autoComplete="email" required readOnly={Boolean(invite)} /></label>
          <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={mode === 'register' ? 'At least 10 characters' : '••••••••••'} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} required minLength={mode === 'register' ? 10 : undefined} /></label>
          {error && <p className="error-text">{error}</p>}
          <div className="button-row">
            <button className="primary-button" type="submit" disabled={busy}>
              {busy ? 'Please wait…' : mode === 'register' ? (needsBootstrap ? 'Create the first account' : inviteToken ? 'Create account & join' : 'Create account') : inviteToken ? 'Sign in & join' : 'Sign in'}
            </button>
            {githubLogin && <a className="secondary-button auth-github" href={githubHref}>Continue with GitHub</a>}
          </div>
        </form>
        <p className="panel-subtitle auth-switch">
          {mode === 'login'
            ? <>New here? <button type="button" className="link-button" onClick={() => setMode('register')}>Create an account</button></>
            : <>Already have an account? <button type="button" className="link-button" onClick={() => setMode('login')}>Sign in</button></>}
        </p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// User menu: team switcher, team settings, organization, sign out
// ---------------------------------------------------------------------------

export function UserMenu() {
  const { me, signOut, switchTeam, refresh } = useAuth()
  const [open, setOpen] = useState(false)
  const [teamOpen, setTeamOpen] = useState(false)
  const [orgOpen, setOrgOpen] = useState(false)
  const [newTeam, setNewTeam] = useState('')
  const [busy, setBusy] = useState(false)
  const inviteToken = inviteTokenFromPath()
  const [inviteMsg, setInviteMsg] = useState('')

  // Signed in and landed on an invite link: accept it now.
  useEffect(() => {
    if (!inviteToken || !me?.user) return
    json<{ team: { name: string } }>(`/api/invites/${encodeURIComponent(inviteToken)}/accept`, { method: 'POST', body: '{}' })
      .then(async (r) => { setInviteMsg(`Joined ${r.team.name}.`); window.history.replaceState({}, '', '/'); await refresh(); window.location.reload() })
      .catch((e) => setInviteMsg(e instanceof Error ? e.message : String(e)))
  }, [inviteToken, me?.user?.userId, refresh])

  if (!me?.authEnabled || !me.user) return null
  const active = me.activeTeam
  const canManage = active && (active.role === 'owner' || active.role === 'admin')

  async function createTeam() {
    if (!newTeam.trim()) return
    setBusy(true)
    try {
      await json('/api/teams', { method: 'POST', body: JSON.stringify({ name: newTeam.trim() }) })
      setNewTeam('')
      await refresh()
      window.location.reload()
    } finally { setBusy(false) }
  }

  return (
    <div className="user-menu">
      {inviteMsg && <span className="mini-badge idle">{inviteMsg}</span>}
      <select className="team-switcher" value={active?.teamId ?? ''} onChange={(e) => void switchTeam(e.target.value)} title="Active team (space)">
        {me.teams.map((t) => <option key={t.teamId} value={t.teamId}>{t.name} · {t.role}</option>)}
        {me.teams.length === 0 && <option value="">No team yet</option>}
      </select>
      <button type="button" className="integrations-chip" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}>
        {me.user.avatarUrl ? <img className="avatar" src={me.user.avatarUrl} alt="" /> : <span className="avatar avatar-initial">{me.user.name.slice(0, 1).toUpperCase()}</span>}
        <span className="integrations-chip-label">{me.user.name}</span>
      </button>
      {open && (
        <div className="menu-popover card" role="menu">
          <div className="menu-section">
            <span className="menu-label">{me.user.email}</span>
            {active && <span className="menu-label">Team: {active.name} ({active.role})</span>}
          </div>
          {active && <button type="button" className="menu-item" onClick={() => { setOpen(false); setTeamOpen(true) }}>{canManage ? 'Team settings, members & invites' : 'Team members'}</button>}
          <button type="button" className="menu-item" onClick={() => { setOpen(false); setOrgOpen(true) }}>Organization memory</button>
          <div className="menu-section">
            <span className="menu-label">New team (space)</span>
            <div className="button-row">
              <input value={newTeam} onChange={(e) => setNewTeam(e.target.value)} placeholder="Platform team" />
              <button type="button" className="secondary-button" disabled={busy || !newTeam.trim()} onClick={() => void createTeam()}>Create</button>
            </div>
          </div>
          <button type="button" className="menu-item" onClick={() => void signOut()}>Sign out</button>
        </div>
      )}
      {teamOpen && active && <TeamDialog team={active} onClose={() => { setTeamOpen(false); void refresh() }} />}
      {orgOpen && <OrgDialog onClose={() => { setOrgOpen(false); void refresh() }} canEdit={me.teams.some((t) => t.role === 'owner' || t.role === 'admin')} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Team dialog: members, roles, invites, memory, rename
// ---------------------------------------------------------------------------

interface TeamDetail {
  team: { teamId: string; name: string; slug: string }
  role: TeamRole
  members: Array<{ userId: string; email: string; name: string; role: TeamRole; joinedAt: string }>
  invites: Array<{ inviteId: string; email: string; role: string; expiresAt: string; invitedByName?: string | null }>
  memory: { manualText: string; updatedAt: string }
}

function TeamDialog({ team, onClose }: { team: MeTeam; onClose: () => void }) {
  const { me } = useAuth()
  const [detail, setDetail] = useState<TeamDetail | null>(null)
  const [error, setError] = useState('')
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<'admin' | 'member' | 'viewer'>('member')
  const [inviteLink, setInviteLink] = useState('')
  const [memory, setMemory] = useState('')
  const [name, setName] = useState(team.name)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const d = await json<TeamDetail>(`/api/teams/${team.teamId}`)
      setDetail(d)
      setMemory(d.memory.manualText)
      setName(d.team.name)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [team.teamId])
  useEffect(() => { void load() }, [load])

  const canManage = detail?.role === 'owner' || detail?.role === 'admin'
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError('')
    try { await fn(); await load() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-shell" style={{ maxWidth: 780 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2>{detail?.team.name ?? team.name}</h2>
            <p className="panel-subtitle">Team (space) · your role: {detail?.role ?? team.role} · {detail?.members.length ?? team.memberCount} member(s)</p>
          </div>
          <button type="button" className="ghost-button" onClick={onClose}>Close</button>
        </div>
        {error && <p className="error-text">{error}</p>}

        {canManage && (
          <section className="card panel slim-panel">
            <h3>Name</h3>
            <div className="button-row">
              <input value={name} onChange={(e) => setName(e.target.value)} />
              <button type="button" className="secondary-button" disabled={busy || !name.trim() || name === detail?.team.name} onClick={() => void act(() => json(`/api/teams/${team.teamId}`, { method: 'PATCH', body: JSON.stringify({ name }) }))}>Rename</button>
            </div>
          </section>
        )}

        <section className="card panel slim-panel">
          <h3>Members</h3>
          <div className="repo-list">
            {(detail?.members ?? []).map((m) => (
              <div key={m.userId} className="repo-row">
                <div className="repo-row-main">
                  <strong>{m.name}</strong>
                  <span className="repo-row-source">{m.email}</span>
                  {canManage && m.userId !== me?.user?.userId ? (
                    <select value={m.role} disabled={busy} onChange={(e) => void act(() => json(`/api/teams/${team.teamId}/members/${m.userId}`, { method: 'PATCH', body: JSON.stringify({ role: e.target.value }) }))} style={{ width: 'auto', marginLeft: 'auto' }}>
                      {(['owner', 'admin', 'member', 'viewer'] as TeamRole[]).map((r) => <option key={r} value={r} disabled={r === 'owner' && detail?.role !== 'owner'}>{r}</option>)}
                    </select>
                  ) : <span className="mini-badge idle" style={{ marginLeft: 'auto' }}>{m.role}</span>}
                  {(canManage || m.userId === me?.user?.userId) && (
                    <button type="button" className="ghost-button" disabled={busy} onClick={() => { if (window.confirm(`Remove ${m.name} from ${team.name}?`)) void act(() => json(`/api/teams/${team.teamId}/members/${m.userId}`, { method: 'DELETE' })) }}>
                      {m.userId === me?.user?.userId ? 'Leave' : 'Remove'}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>

        {canManage && (
          <section className="card panel slim-panel">
            <h3>Invite people</h3>
            <p className="panel-subtitle">Creates a link bound to the email. Share it; it works for 14 days and only for that address.</p>
            <div className="button-row">
              <input type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="teammate@company.com" style={{ flex: 1 }} />
              <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as 'admin' | 'member' | 'viewer')} style={{ width: 'auto' }}>
                <option value="admin">admin</option><option value="member">member</option><option value="viewer">viewer</option>
              </select>
              <button type="button" className="primary-button" disabled={busy || !inviteEmail.trim()} onClick={() => void act(async () => {
                const r = await json<{ link: string }>(`/api/teams/${team.teamId}/invites`, { method: 'POST', body: JSON.stringify({ email: inviteEmail, role: inviteRole }) })
                setInviteLink(r.link); setInviteEmail('')
              })}>Create invite</button>
            </div>
            {inviteLink && (
              <div className="repo-row" style={{ marginTop: 8 }}>
                <span className="repo-row-source">Invite link (copy and send):</span>
                <div className="button-row"><code style={{ wordBreak: 'break-all', flex: 1 }}>{inviteLink}</code><button type="button" className="secondary-button" onClick={() => void navigator.clipboard?.writeText(inviteLink)}>Copy</button></div>
              </div>
            )}
            {(detail?.invites ?? []).length > 0 && (
              <div className="repo-list" style={{ marginTop: 8 }}>
                {detail!.invites.map((i) => (
                  <div key={i.inviteId} className="repo-row-main">
                    <span>{i.email}</span><span className="mini-badge idle">{i.role}</span>
                    <span className="repo-row-source">expires {new Date(i.expiresAt).toLocaleDateString()}{i.invitedByName ? ` · by ${i.invitedByName}` : ''}</span>
                    <button type="button" className="ghost-button" style={{ marginLeft: 'auto' }} disabled={busy} onClick={() => void act(() => json(`/api/teams/${team.teamId}/invites/${i.inviteId}`, { method: 'DELETE' }))}>Revoke</button>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        <section className="card panel slim-panel">
          <h3>Team memory</h3>
          <p className="panel-subtitle">Shared by every project of this team and injected into every agent's context (below the organization memory, above project memory): conventions, review preferences, architecture decisions, rollout rules.</p>
          <textarea className="memory-editor" value={memory} onChange={(e) => setMemory(e.target.value)} readOnly={detail?.role === 'viewer'} />
          {detail?.role !== 'viewer' && (
            <div className="button-row">
              <button type="button" className="primary-button" disabled={busy} onClick={() => void act(() => json(`/api/teams/${team.teamId}/memory`, { method: 'PUT', body: JSON.stringify({ text: memory }) }))}>Save team memory</button>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Organization dialog: memory shared by every team
// ---------------------------------------------------------------------------

function OrgDialog({ onClose, canEdit }: { onClose: () => void; canEdit: boolean }) {
  const [org, setOrg] = useState<{ name: string; manualText: string; updatedAt: string } | null>(null)
  const [name, setName] = useState('')
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    json<{ name: string; manualText: string; updatedAt: string }>('/api/org/memory').then((o) => { setOrg(o); setName(o.name); setText(o.manualText) }).catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [])
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-shell" style={{ maxWidth: 720 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2>{org?.name ?? 'Organization'}</h2>
            <p className="panel-subtitle">Shared by every team and project. Agents receive it first, then team memory, then project memory (AIDLC spaces).</p>
          </div>
          <button type="button" className="ghost-button" onClick={onClose}>Close</button>
        </div>
        {error && <p className="error-text">{error}</p>}
        <section className="card panel slim-panel">
          {canEdit && <label>Organization name<input value={name} onChange={(e) => setName(e.target.value)} /></label>}
          <textarea className="memory-editor" value={text} onChange={(e) => setText(e.target.value)} readOnly={!canEdit} placeholder="Company-wide engineering principles, security policies, architecture standards, definitions of done…" />
          {canEdit && (
            <div className="button-row">
              <button type="button" className="primary-button" disabled={busy} onClick={async () => {
                setBusy(true); setError('')
                try { const o = await json<{ name: string; manualText: string; updatedAt: string }>('/api/org/memory', { method: 'PUT', body: JSON.stringify({ name, text }) }); setOrg(o) } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
              }}>Save organization memory</button>
              {org?.updatedAt && <span className="panel-subtitle">Updated {new Date(org.updatedAt).toLocaleString()}</span>}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
