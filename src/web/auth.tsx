import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'

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
export interface Me { authEnabled: boolean; user: MeUser | null; teams: MeTeam[]; activeTeam: MeTeam | null; org?: { name: string; manualText: string }; defaultModel?: string; /** A model provider key is stored; projects cannot be created without one. */ modelsReady?: boolean }

interface AuthState { me: Me | null; refresh: () => Promise<void>; signOut: () => Promise<void>; switchTeam: (teamId: string) => Promise<void> }

const AuthContext = createContext<AuthState>({ me: null, refresh: async () => undefined, signOut: async () => undefined, switchTeam: async () => undefined })
export const useAuth = () => useContext(AuthContext)

/** Navigate inside the SPA: push the URL and let the app's router effect react. */
export function navigate(path: string): void {
  if (window.location.pathname !== path) window.history.pushState({}, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

export async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...(init?.headers ?? {}) } })
  const data = (await response.json().catch(() => ({}))) as T & { error?: string }
  if (!response.ok) throw new Error(data.error ?? `${response.status}`)
  return data
}

export function AuthRoot({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<{ authEnabled: boolean; needsBootstrap: boolean; githubLogin: boolean; defaultModel?: string; modelsReady?: boolean } | null>(null)
  const [me, setMe] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)
  const [signedOut, setSignedOut] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const s = await json<{ authEnabled: boolean; needsBootstrap: boolean; githubLogin: boolean; defaultModel?: string; modelsReady?: boolean }>('/api/auth/status')
      setStatus(s)
      if (!s.authEnabled) { setMe({ authEnabled: false, user: null, teams: [], activeTeam: null, defaultModel: s.defaultModel, modelsReady: s.modelsReady }); setSignedOut(false); return }
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
  const [organizationName, setOrganizationName] = useState('')
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
        await json('/api/auth/register', { method: 'POST', body: JSON.stringify({ email, name, password, inviteToken, organizationName: organizationName.trim() || undefined }) })
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
          <p className="panel-subtitle">New accounts usually need an invitation. If this site is open to sign-ups, your account starts its own organization: model keys, integrations, knowledge and projects are never shared with another one.</p>
        )}

        <form onSubmit={(e) => { e.preventDefault(); void submit() }}>
          {mode === 'register' && (
            <label>Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada Lovelace" autoComplete="name" /></label>
          )}
          {mode === 'register' && !inviteToken && (
            <label>Organization<input value={organizationName} onChange={(e) => setOrganizationName(e.target.value)} placeholder="Your company" autoComplete="organization" /></label>
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

/** Signed in and landed on an invite link: accept it now. Returns a status message to show. */
export function useInviteAcceptance(): string {
  const { me, refresh } = useAuth()
  const inviteToken = inviteTokenFromPath()
  const [inviteMsg, setInviteMsg] = useState('')
  useEffect(() => {
    if (!inviteToken || !me?.user) return
    json<{ team: { name: string } }>(`/api/invites/${encodeURIComponent(inviteToken)}/accept`, { method: 'POST', body: '{}' })
      .then(async (r) => { setInviteMsg(`Joined ${r.team.name}.`); window.history.replaceState({}, '', '/'); await refresh(); window.location.reload() })
      .catch((e) => setInviteMsg(e instanceof Error ? e.message : String(e)))
  }, [inviteToken, me?.user?.userId, refresh])
  return inviteMsg
}

export function UserMenu() {
  const { me, signOut, switchTeam } = useAuth()
  const [open, setOpen] = useState(false)
  const [switching, setSwitching] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const inviteMsg = useInviteAcceptance()

  // Close on outside click and Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  if (!me?.authEnabled || !me.user) return null
  const active = me.activeTeam
  const canManage = active && (active.role === 'owner' || active.role === 'admin')
  const isAdminAnywhere = me.teams.some((t) => t.role === 'owner' || t.role === 'admin')
  const go = (path: string) => { setOpen(false); navigate(path) }

  return (
    <div className="user-menu" ref={rootRef}>
      {inviteMsg && <span className="mini-badge idle">{inviteMsg}</span>}
      <button type="button" className={`account-button ${open ? 'open' : ''}`} onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} title={`${me.user.name} · ${me.user.email}`}>
        {me.user.avatarUrl ? <img className="avatar" src={me.user.avatarUrl} alt="" /> : <span className="avatar avatar-initial">{me.user.name.slice(0, 1).toUpperCase()}</span>}
        <span className="account-team">{active?.name ?? 'No team'}</span>
        <span className="account-chevron" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="menu-popover card account-menu" role="menu">
          <div className="account-head">
            {me.user.avatarUrl ? <img className="avatar account-avatar" src={me.user.avatarUrl} alt="" /> : <span className="avatar avatar-initial account-avatar">{me.user.name.slice(0, 1).toUpperCase()}</span>}
            <div className="account-id">
              <strong>{me.user.name}</strong>
              <span>{me.user.email}</span>
            </div>
          </div>

          <div className="menu-group">
            <div className="menu-group-title">Teams <span className="text-subtle">· switch</span></div>
            {me.teams.map((t) => {
              const isActive = t.teamId === active?.teamId
              return (
                <button key={t.teamId} type="button" className={`menu-row ${isActive ? 'active' : ''}`} role="menuitemradio" aria-checked={isActive} disabled={switching !== null} onClick={() => { if (isActive) { go(`/teams/${encodeURIComponent(t.slug)}`); return } setSwitching(t.teamId); void switchTeam(t.teamId) }}>
                  <span className="menu-row-icon team-dot" aria-hidden="true">{t.name.slice(0, 1).toUpperCase()}</span>
                  <span className="menu-row-main">
                    <span className="menu-row-title">{t.name}</span>
                    <span className="menu-row-sub">{t.role} · {t.projectCount} project{t.projectCount === 1 ? '' : 's'} · {t.memberCount} member{t.memberCount === 1 ? '' : 's'}</span>
                  </span>
                  <span className="menu-row-end">{switching === t.teamId ? '…' : isActive ? '✓' : ''}</span>
                </button>
              )
            })}
            {me.teams.length === 0 && <div className="menu-row-sub" style={{ padding: '6px 10px' }}>You are not in a team yet.</div>}
            {active && (
              <button type="button" className="menu-row" role="menuitem" onClick={() => go(`/teams/${encodeURIComponent(active.slug)}`)}>
                <span className="menu-row-icon" aria-hidden="true">⚙</span>
                <span className="menu-row-main"><span className="menu-row-title">{canManage ? 'Team settings' : 'Team members'}</span><span className="menu-row-sub">{canManage ? 'Members, invites, memory, knowledge defaults' : `Who is in ${active.name}`}</span></span>
              </button>
            )}
          </div>

          <div className="menu-group">
            <div className="menu-group-title">Organization</div>
            <button type="button" className="menu-row" role="menuitem" onClick={() => go('/organization')}>
              <span className="menu-row-icon" aria-hidden="true">◈</span>
              <span className="menu-row-main"><span className="menu-row-title">Overview &amp; memory</span><span className="menu-row-sub">Shared by every team</span></span>
            </button>
            <button type="button" className="menu-row" role="menuitem" onClick={() => go('/organization?section=knowledge')}>
              <span className="menu-row-icon" aria-hidden="true">▤</span>
              <span className="menu-row-main"><span className="menu-row-title">Knowledge base</span><span className="menu-row-sub">Imports and search</span></span>
            </button>
            <button type="button" className="menu-row" role="menuitem" onClick={() => go('/organization?section=integrations')}>
              <span className="menu-row-icon" aria-hidden="true">⇄</span>
              <span className="menu-row-main"><span className="menu-row-title">Integrations</span><span className="menu-row-sub">{isAdminAnywhere ? 'Credentials and connections' : 'Connection status'}</span></span>
            </button>
            <button type="button" className="menu-row" role="menuitem" onClick={() => go('/organization?section=models')}>
              <span className="menu-row-icon" aria-hidden="true">◎</span>
              <span className="menu-row-main"><span className="menu-row-title">Models</span><span className="menu-row-sub">Automatic routing by cost and speed</span></span>
            </button>
          </div>

          <div className="menu-group">
            <button type="button" className="menu-row" role="menuitem" onClick={() => { setOpen(false); void signOut() }}>
              <span className="menu-row-icon" aria-hidden="true">⎋</span>
              <span className="menu-row-main"><span className="menu-row-title">Sign out</span></span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Team dialog: members, roles, invites, memory, rename
// ---------------------------------------------------------------------------
