import { useEffect, useRef, useState, type ReactNode } from 'react'
import { navigate, useAuth, useInviteAcceptance } from './auth'

/**
 * Application shell: a thin top strip (brand, integrations, attention) and a
 * left sidebar (team switcher, navigation, account), in the style of hosting
 * dashboards. Pages render inside the rounded main panel to the right.
 */

export interface ArchivedCardSummary { projectNamespace: string; projectLabel: string; code?: string | null; archivedAt?: string | null }

export const DOCS_URL = 'https://rayedbajwa.github.io/spaces/'
export const REPO_URL = 'https://github.com/rayedbajwa/spaces'

/** Current URL, updated on every SPA navigation (navigate() dispatches popstate). */
export function useLocation(): { pathname: string; search: string } {
  const [loc, setLoc] = useState(() => ({ pathname: window.location.pathname, search: window.location.search }))
  useEffect(() => {
    const on = () => setLoc({ pathname: window.location.pathname, search: window.location.search })
    window.addEventListener('popstate', on)
    return () => window.removeEventListener('popstate', on)
  }, [])
  return loc
}

/** Close a popover on outside click or Escape. */
function useDismiss(open: boolean, close: () => void, ref: React.RefObject<HTMLElement>) {
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open, close, ref])
}

// ---------------------------------------------------------------------------
// Icons (16px, stroked)
// ---------------------------------------------------------------------------

const I = {
  grid: <svg viewBox="0 0 16 16"><rect x="2" y="2" width="5" height="5" rx="1" /><rect x="9" y="2" width="5" height="5" rx="1" /><rect x="2" y="9" width="5" height="5" rx="1" /><rect x="9" y="9" width="5" height="5" rx="1" /></svg>,
  archive: <svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="3" rx="1" /><path d="M3 6v6.5A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6M6.5 9h3" /></svg>,
  book: <svg viewBox="0 0 16 16"><path d="M2.5 3.5A1.5 1.5 0 0 1 4 2h9v11H4a1.5 1.5 0 0 0-1.5 1.5z" /><path d="M2.5 12.5A1.5 1.5 0 0 1 4 11h9" /></svg>,
  brain: <svg viewBox="0 0 16 16"><path d="M6 2.5a2 2 0 0 0-2 2v.5A2.5 2.5 0 0 0 3 9.5a2.5 2.5 0 0 0 2.5 4H8V2.5zM10 2.5a2 2 0 0 1 2 2v.5a2.5 2.5 0 0 1 1 4.5 2.5 2.5 0 0 1-2.5 4H8" /></svg>,
  plug: <svg viewBox="0 0 16 16"><path d="M5.5 2v3M10.5 2v3M3.5 5h9v2a4.5 4.5 0 0 1-9 0zM8 11.5V14" /></svg>,
  cpu: <svg viewBox="0 0 16 16"><rect x="4" y="4" width="8" height="8" rx="1.5" /><rect x="6.5" y="6.5" width="3" height="3" /><path d="M6 1.5v2.5M10 1.5v2.5M6 12v2.5M10 12v2.5M1.5 6h2.5M1.5 10h2.5M12 6h2.5M12 10h2.5" /></svg>,
  users: <svg viewBox="0 0 16 16"><circle cx="6" cy="5.5" r="2.5" /><path d="M1.5 13.5a4.5 4.5 0 0 1 9 0M10.5 3.2a2.5 2.5 0 0 1 0 4.6M12 9.3a4.5 4.5 0 0 1 2.5 4.2" /></svg>,
  building: <svg viewBox="0 0 16 16"><path d="M2.5 14V3a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v11M10.5 6h2a1 1 0 0 1 1 1v7M1.5 14h13M5 5h1.5M5 8h1.5M5 11h1.5" /></svg>,
  megaphone: <svg viewBox="0 0 16 16"><path d="M2.5 6.5v3l7 3v-9zM9.5 5.5a2.5 2.5 0 0 1 0 5M4.5 9.5l1 4h2" /></svg>,
  external: <svg viewBox="0 0 16 16"><path d="M6.5 3.5h-3v9h9v-3M9 3h4v4M13 3l-6 6" /></svg>,
  chevron: <svg viewBox="0 0 16 16"><path d="M4.5 6.5 8 10l3.5-3.5" /></svg>,
  dots: <svg viewBox="0 0 16 16"><circle cx="8" cy="3.5" r="1.1" fill="currentColor" stroke="none" /><circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" /><circle cx="8" cy="12.5" r="1.1" fill="currentColor" stroke="none" /></svg>,
  menu: <svg viewBox="0 0 16 16"><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" /></svg>,
  bell: <svg viewBox="0 0 16 16"><path d="M4 11V7a4 4 0 0 1 8 0v4l1 1.5H3zM6.5 13.5a1.5 1.5 0 0 0 3 0" /></svg>,
  search: <svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></svg>,
}

function Icon({ children }: { children: ReactNode }) { return <span className="nav-icon" aria-hidden="true">{children}</span> }

// ---------------------------------------------------------------------------
// Top strip
// ---------------------------------------------------------------------------

export function TopStrip({ integrationsConnected, integrationsTotal, onIntegrations, attentionCount, onToggleSidebar, sidebarOpen }: {
  integrationsConnected: number; integrationsTotal: number; onIntegrations: () => void
  attentionCount: number; onToggleSidebar: () => void; sidebarOpen: boolean
}) {
  const all = integrationsConnected === integrationsTotal && integrationsTotal > 0
  return (
    <header className="topstrip">
      <div className="topstrip-left">
        <button type="button" className="icon-button sidebar-toggle" onClick={onToggleSidebar} aria-label={sidebarOpen ? 'Hide navigation' : 'Show navigation'} aria-expanded={sidebarOpen}>{I.menu}</button>
        <a className="brand" href="/" onClick={(e) => { e.preventDefault(); navigate('/') }} title="Projects">
          <span className="brand-logo" aria-hidden="true">S</span>
          <span className="brand-name">Spaces</span>
        </a>
      </div>
      <div className="topstrip-right">
        {attentionCount > 0 && (
          <button type="button" className="strip-chip attention" onClick={() => navigate('/')} title="Projects that need a decision or hit an error">
            <span className="nav-icon" aria-hidden="true">{I.bell}</span>
            {attentionCount} need{attentionCount === 1 ? 's' : ''} attention
          </button>
        )}
        <button type="button" className={`strip-chip ${all ? 'ok' : integrationsConnected > 0 ? 'partial' : ''}`} onClick={onIntegrations} title="Integration status">
          <span className={`status-dot ${all ? 'ok' : integrationsConnected > 0 ? 'partial' : 'off'}`} aria-hidden="true" />
          {all ? 'Integrations connected' : `Integrations ${integrationsConnected}/${integrationsTotal}`}
        </button>
      </div>
    </header>
  )
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

type NavItem = { id: string; label: string; icon: ReactNode; path: string; match: (loc: { pathname: string; search: string }) => boolean; count?: number; hint?: string }

export function AppSidebar({ open, onNavigate, archivedCount, loadArchived, onOpenArchived, promotionsPending }: {
  open: boolean
  onNavigate: () => void
  archivedCount: number
  loadArchived: () => Promise<ArchivedCardSummary[]>
  onOpenArchived: (card: ArchivedCardSummary) => void
  promotionsPending?: number
}) {
  const { me, switchTeam, signOut } = useAuth()
  const loc = useLocation()
  const inviteMsg = useInviteAcceptance()
  const active = me?.activeTeam ?? null
  const teams = me?.teams ?? []
  const signedIn = Boolean(me?.authEnabled && me.user)

  const section = new URLSearchParams(loc.search).get('section') ?? 'overview'
  const onOrg = (s: string) => loc.pathname === '/organization' && section === s
  const orgPath = (s: string) => (s === 'overview' ? '/organization' : `/organization?section=${s}`)

  const groups: NavItem[][] = [
    [
      { id: 'projects', label: 'Projects', icon: I.grid, path: '/', match: (l) => l.pathname === '/' || l.pathname.startsWith('/spaces/') },
    ],
    [
      { id: 'knowledge', label: 'Knowledge base', icon: I.book, path: orgPath('knowledge'), match: () => onOrg('knowledge') },
      { id: 'memory', label: 'Memory', icon: I.brain, path: orgPath('memory'), match: () => onOrg('memory') },
      { id: 'integrations', label: 'Integrations', icon: I.plug, path: orgPath('integrations'), match: () => onOrg('integrations') },
      { id: 'models', label: 'Models', icon: I.cpu, path: orgPath('models'), match: () => onOrg('models') },
    ],
    [
      ...(active ? [{ id: 'people', label: 'People', icon: I.users, path: `/teams/${encodeURIComponent(active.slug)}`, match: (l: { pathname: string }) => l.pathname.startsWith('/teams/'), hint: active.name } as NavItem] : []),
      { id: 'organization', label: 'Organization', icon: I.building, path: '/organization', match: () => onOrg('overview') || onOrg('teams') },
      { id: 'promotions', label: 'Promotions', icon: I.megaphone, path: orgPath('promotions'), match: () => onOrg('promotions'), count: promotionsPending },
    ],
  ]

  const go = (path: string) => { navigate(path); onNavigate() }

  return (
    <aside className={`sidebar ${open ? 'open' : ''}`} aria-label="Main navigation">
      {signedIn && <TeamSwitcher teams={teams} active={active} onSwitch={switchTeam} onManage={() => go('/organization?section=teams')} />}
      {inviteMsg && <div className="sidebar-note">{inviteMsg}</div>}

      <nav className="sidebar-nav">
        {groups.map((items, gi) => (
          <div key={gi} className="nav-group">
            {items.map((item) => {
              const isActive = item.match(loc)
              return (
                <a key={item.id} href={item.path} className={`nav-item ${isActive ? 'active' : ''}`} aria-current={isActive ? 'page' : undefined} onClick={(e) => { e.preventDefault(); go(item.path) }}>
                  <Icon>{item.icon}</Icon>
                  <span className="nav-label">{item.label}</span>
                  {item.hint && <span className="nav-hint">{item.hint}</span>}
                  {item.count ? <span className="nav-count">{item.count}</span> : null}
                </a>
              )
            })}
            {gi === 0 && archivedCount > 0 && <ArchivedNav count={archivedCount} load={loadArchived} onOpen={(c) => { onOpenArchived(c); onNavigate() }} />}
          </div>
        ))}
        <div className="nav-group nav-group-external">
          <a className="nav-item external" href={DOCS_URL} target="_blank" rel="noreferrer"><Icon>{I.book}</Icon><span className="nav-label">Docs</span><span className="nav-ext" aria-hidden="true">{I.external}</span></a>
          <a className="nav-item external" href={REPO_URL} target="_blank" rel="noreferrer"><Icon>{I.grid}</Icon><span className="nav-label">GitHub</span><span className="nav-ext" aria-hidden="true">{I.external}</span></a>
        </div>
      </nav>

      {signedIn && me?.user && <AccountBlock user={me.user} onSignOut={signOut} onTeam={active ? () => go(`/teams/${encodeURIComponent(active.slug)}`) : undefined} />}
    </aside>
  )
}

function TeamSwitcher({ teams, active, onSwitch, onManage }: { teams: Array<{ teamId: string; name: string; slug: string; role: string; projectCount: number; memberCount: number }>; active: { teamId: string; name: string; role: string } | null; onSwitch: (teamId: string) => Promise<void>; onManage: () => void }) {
  const [open, setOpen] = useState(false)
  const [switching, setSwitching] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(open, () => setOpen(false), ref)
  const initials = (active?.name ?? '?').slice(0, 1).toUpperCase()
  return (
    <div className="team-switcher-wrap" ref={ref}>
      <button type="button" className={`team-switch ${open ? 'open' : ''}`} onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} title="Switch team">
        <span className="team-mark" aria-hidden="true">{initials}</span>
        <span className="team-switch-text">
          <span className="team-switch-name">{active?.name ?? 'No team'}</span>
          <span className="team-switch-role">{active?.role ?? 'not a member'}</span>
        </span>
        <span className="nav-icon chev" aria-hidden="true">{I.chevron}</span>
      </button>
      {open && (
        <div className="menu-popover card team-switch-menu" role="menu">
          <div className="menu-group-title">Teams</div>
          {teams.map((t) => {
            const isActive = t.teamId === active?.teamId
            return (
              <button key={t.teamId} type="button" className={`menu-row ${isActive ? 'active' : ''}`} role="menuitemradio" aria-checked={isActive} disabled={switching !== null} onClick={() => { if (isActive) { setOpen(false); return } setSwitching(t.teamId); void onSwitch(t.teamId).finally(() => { setSwitching(null); setOpen(false) }) }}>
                <span className="menu-row-icon team-dot" aria-hidden="true">{t.name.slice(0, 1).toUpperCase()}</span>
                <span className="menu-row-main">
                  <span className="menu-row-title">{t.name}</span>
                  <span className="menu-row-sub">{t.role} · {t.projectCount} project{t.projectCount === 1 ? '' : 's'} · {t.memberCount} member{t.memberCount === 1 ? '' : 's'}</span>
                </span>
                <span className="menu-row-end">{switching === t.teamId ? '…' : isActive ? '✓' : ''}</span>
              </button>
            )
          })}
          {teams.length === 0 && <div className="menu-row-sub" style={{ padding: '6px 10px' }}>You are not in a team yet.</div>}
          <button type="button" className="menu-row" role="menuitem" onClick={() => { setOpen(false); onManage() }}>
            <span className="menu-row-icon" aria-hidden="true">＋</span>
            <span className="menu-row-main"><span className="menu-row-title">Manage teams</span><span className="menu-row-sub">Organization → Teams</span></span>
          </button>
        </div>
      )}
    </div>
  )
}

function ArchivedNav({ count, load, onOpen }: { count: number; load: () => Promise<ArchivedCardSummary[]>; onOpen: (card: ArchivedCardSummary) => void }) {
  const [open, setOpen] = useState(false)
  const [cards, setCards] = useState<ArchivedCardSummary[] | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(open, () => setOpen(false), ref)
  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next && cards === null) load().then(setCards).catch(() => setCards([]))
  }
  return (
    <div className="archived-nav" ref={ref}>
      <button type="button" className={`nav-item ${open ? 'active' : ''}`} onClick={toggle} aria-haspopup="menu" aria-expanded={open}>
        <Icon>{I.archive}</Icon>
        <span className="nav-label">Archived</span>
        <span className="nav-count muted">{count}</span>
      </button>
      {open && (
        <div className="menu-popover card archived-popover side" role="menu">
          <div className="menu-group-title">Archived projects</div>
          {cards === null && <span className="menu-label">Loading…</span>}
          {cards?.length === 0 && <span className="menu-label">No archived projects.</span>}
          {cards?.map((card) => (
            <button key={card.projectNamespace} type="button" className="menu-row" role="menuitem" onClick={() => { setOpen(false); onOpen(card) }}>
              <span className="menu-row-main">
                <span className="menu-row-title">{card.projectLabel}</span>
                <span className="menu-row-sub">{card.code ?? card.projectNamespace}{card.archivedAt ? ` · archived ${new Date(card.archivedAt).toLocaleDateString()}` : ''}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function AccountBlock({ user, onSignOut, onTeam }: { user: { name: string; email: string; avatarUrl?: string | null }; onSignOut: () => Promise<void>; onTeam?: () => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(open, () => setOpen(false), ref)
  return (
    <div className="sidebar-account" ref={ref}>
      <button type="button" className={`account-row ${open ? 'open' : ''}`} onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} title={user.email}>
        {user.avatarUrl ? <img className="avatar" src={user.avatarUrl} alt="" /> : <span className="avatar avatar-initial">{user.name.slice(0, 1).toUpperCase()}</span>}
        <span className="account-name">{user.name}</span>
        <span className="nav-icon" aria-hidden="true">{I.dots}</span>
      </button>
      {open && (
        <div className="menu-popover card account-popover" role="menu">
          <div className="account-head">
            {user.avatarUrl ? <img className="avatar account-avatar" src={user.avatarUrl} alt="" /> : <span className="avatar avatar-initial account-avatar">{user.name.slice(0, 1).toUpperCase()}</span>}
            <div className="account-id"><strong>{user.name}</strong><span>{user.email}</span></div>
          </div>
          {onTeam && (
            <button type="button" className="menu-row" role="menuitem" onClick={() => { setOpen(false); onTeam() }}>
              <span className="menu-row-icon" aria-hidden="true">{I.users}</span>
              <span className="menu-row-main"><span className="menu-row-title">Team settings</span><span className="menu-row-sub">Members, invites, defaults</span></span>
            </button>
          )}
          <button type="button" className="menu-row" role="menuitem" onClick={() => { setOpen(false); void onSignOut() }}>
            <span className="menu-row-icon" aria-hidden="true">⎋</span>
            <span className="menu-row-main"><span className="menu-row-title">Sign out</span></span>
          </button>
        </div>
      )}
    </div>
  )
}

/** Page header inside the main panel: title, optional count, right-hand tools. */
export function PageHead({ title, count, children }: { title: string; count?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      <h1 className="page-title">{title}{count !== undefined && <span className="page-count">{count}</span>}</h1>
      <div className="page-tools">{children}</div>
    </div>
  )
}

export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); ref.current?.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  return (
    <label className="search-box">
      <span className="nav-icon" aria-hidden="true">{I.search}</span>
      <input ref={ref} type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
      <kbd aria-hidden="true">⌘K</kbd>
    </label>
  )
}
