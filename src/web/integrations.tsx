import { useCallback, useEffect, useState } from 'react'
import { json, navigate, useAuth } from './auth'

/**
 * Integrations, self-serve and organization-wide.
 *
 * One card per OAuth provider (GitHub, Atlassian for Jira + Confluence, Linear,
 * Slack). Each shows whether app credentials are set, the callback URL and
 * scopes to register with the provider, and the
 * connection state of the integrations it powers. Owners and admins set the
 * provider app up here — created for them where the provider allows it
 * (GitHub App manifest, Slack app manifest), guided through the console
 * otherwise — and connecting is enabled only once credentials exist.
 */

interface OAuthApp {
  provider: 'github' | 'atlassian' | 'slack' | 'linear'
  label: string
  kinds: string[]
  configured: boolean
  source: 'database' | 'none'
  clientIdMasked: string | null
  scopes: string[]
  consoleUrl: string
  callbackPath: string
  notes?: string
  updatedAt: string | null
  updatedByName: string | null
  setup: {
    method: 'github-manifest' | 'slack-manifest' | 'console'
    createUrl?: string
    installUrl?: string
    installed: boolean
    appName?: string
    appUrl?: string
    appSlug?: string
    ownerLogin?: string
    source?: 'manifest' | 'manual'
  }
}

interface Connection { kind: string; status: string; displayName?: string; updatedAt: string; credentialsOk?: boolean }

const KIND_LABEL: Record<string, string> = { github: 'GitHub', jira: 'Jira', confluence: 'Confluence', slack: 'Slack', linear: 'Linear' }
const PROVIDER_BLURB: Record<OAuthApp['provider'], string> = {
  github: 'Repository catalog, cloning, pull requests, issue search and GitHub sign-in.',
  atlassian: 'Jira issues and Confluence pages for agents and the knowledge base. One app covers both.',
  linear: 'Linear issues, projects and initiatives for agents and the knowledge base.',
  slack: 'Reserved for notifications.',
}

export function IntegrationsPanel({ embedded = false, readOnly = false }: { embedded?: boolean; readOnly?: boolean }) {
  const { me } = useAuth()
  const isAdmin = !me?.authEnabled || (me?.teams ?? []).some((t) => t.role === 'owner' || t.role === 'admin')
  // The top-bar modal is a status view; changes happen on the Organization page.
  const canManage = isAdmin && !readOnly
  const [apps, setApps] = useState<OAuthApp[] | null>(null)
  const [connections, setConnections] = useState<Connection[]>([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [editing, setEditing] = useState<OAuthApp['provider'] | null>(null)

  const load = useCallback(async () => {
    try {
      const [a, c] = await Promise.all([json<OAuthApp[]>('/api/oauth-apps'), json<Connection[]>('/api/integrations')])
      setApps(a); setConnections(c)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [])
  useEffect(() => { void load() }, [load])

  const flash = (m: string) => { setNotice(m); setError(''); window.setTimeout(() => setNotice(''), 3500) }

  // Same-tab flows (GitHub App create / install) come back with a query flag; show it once and clean the URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const setup = params.get('setup'); const connected = params.get('connected'); const err = params.get('error')
    if (!setup && !connected && !err) return
    if (err) setError(err)
    else if (setup === 'github') { setNotice('GitHub App created and its credentials stored. Install it on your account or organization to grant repository access.'); setEditing('github') }
    else if (connected) flash(`${KIND_LABEL[connected] ?? connected} connected.`)
    for (const key of ['setup', 'connected', 'error']) params.delete(key)
    const search = params.toString()
    window.history.replaceState(null, '', `${window.location.pathname}${search ? `?${search}` : ''}`)
  }, [])

  function connect(provider: string) {
    const w = window.open(`/api/oauth/${provider}/authorize`, `oauth-${provider}`, 'width=720,height=820')
    const timer = window.setInterval(() => { if (!w || w.closed) { window.clearInterval(timer); void load() } }, 800)
  }

  async function disconnect(kind: string) {
    if (!window.confirm(`Disconnect ${KIND_LABEL[kind] ?? kind}? The stored token is deleted; reconnect to use it again.`)) return
    try { await json(`/api/integrations/${kind}`, { method: 'DELETE' }); await load(); flash(`${KIND_LABEL[kind] ?? kind} disconnected.`) } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  return (
    <div className={`integrations ${embedded ? 'embedded' : ''}`}>
      {!embedded && !readOnly && (
        <p className="panel-subtitle" style={{ marginTop: 0 }}>
          Integrations are shared by every team. An owner or admin sets each provider app up once here — created for you where the provider allows it — and its credentials are stored encrypted in the database. An app must be set up before it can be connected.
        </p>
      )}
      {readOnly && (
        <div className="integrations-manage-hint">
          <span>Status only. Credentials and connections are managed on the Organization page{isAdmin ? '' : ' by an owner or admin'}.</span>
          {isAdmin && <button type="button" className="primary-button" onClick={() => navigate('/organization?section=integrations')}>Manage integrations</button>}
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
      {notice && <p className="team-flash team-flash-ok">{notice}</p>}
      {apps === null && <p className="panel-subtitle">Loading…</p>}
      <div className="integration-list">
        {apps?.map((app) => {
          const conns = app.kinds.map((kind) => ({ kind, row: connections.find((c) => c.kind === kind) }))
          const anyConnected = conns.some((c) => c.row?.status === 'connected' && c.row.credentialsOk !== false)
          const needsReconnect = conns.some((c) => c.row?.credentialsOk === false)
          const isEditing = editing === app.provider
          return (
            <section key={app.provider} className={`card integration ${app.configured ? 'configured' : ''} ${anyConnected ? 'connected' : ''}`}>
              <div className="integration-head">
                <div className={`integration-logo ${app.provider}`} aria-hidden="true">{app.label.slice(0, 1)}</div>
                <div className="integration-title">
                  <h3>{app.label}</h3>
                  <p className="panel-subtitle" style={{ margin: 0 }}>{PROVIDER_BLURB[app.provider]}</p>
                </div>
                <div className="integration-state">
                  <span className={`mini-badge ${app.configured ? 'idle' : 'error'}`} title={app.configured ? `${app.setup.source === 'manifest' ? 'App created by Spaces' : 'Credentials set in the app'}${app.updatedByName ? ` by ${app.updatedByName}` : ''}${app.updatedAt ? ` on ${new Date(app.updatedAt).toLocaleDateString()}` : ''}` : 'No app set up yet'}>
                    {app.configured ? (app.setup.installed ? 'app installed' : 'app set up') : 'app not set up'}
                  </span>
                  {canManage && <button type="button" className={isEditing || app.configured ? 'ghost-button' : 'primary-button'} onClick={() => setEditing(isEditing ? null : app.provider)}>{isEditing ? 'Close' : app.configured ? 'Manage app' : 'Set up app'}</button>}
                </div>
              </div>

              {isEditing && canManage && (
                <SetupForm app={app} onSaved={async (m) => { setEditing(null); await load(); flash(m) }} onError={setError} />
              )}

              <ul className="integration-kinds">
                {conns.map(({ kind, row }) => {
                  const connected = row?.status === 'connected' && row.credentialsOk !== false
                  return (
                    <li key={kind}>
                      <span className={`mini-badge ${connected ? 'completed' : row?.credentialsOk === false ? 'error' : 'idle'}`}>{connected ? '✓ connected' : row?.credentialsOk === false ? '⚠ reconnect needed' : 'not connected'}</span>
                      <strong>{KIND_LABEL[kind] ?? kind}</strong>
                      {row?.displayName && <span className="text-subtle">{row.displayName}</span>}
                      {row?.updatedAt && connected && <span className="text-subtle">since {new Date(row.updatedAt).toLocaleDateString()}</span>}
                      <span className="integration-kind-actions">
                        {connected && canManage && <button type="button" className="ghost-button" onClick={() => void disconnect(kind)}>Disconnect</button>}
                      </span>
                    </li>
                  )
                })}
              </ul>

              {!readOnly && (
                <div className="integration-foot">
                  {anyConnected && !needsReconnect
                    ? <span className="text-subtle">Connected as one account for the whole organization.</span>
                    : app.configured
                      ? (canManage ? <button type="button" className="primary-button" onClick={() => connect(app.provider)}>{needsReconnect ? `Reconnect ${app.label}` : `Connect ${app.label}`}</button> : <span className="text-subtle">An owner or admin can connect this.</span>)
                      : <span className="text-subtle">Set up the {app.label.split(' ')[0]} app to enable connecting.</span>}
                </div>
              )}
              {readOnly && !anyConnected && (
                <div className="integration-foot">
                  <span className="text-subtle">{app.configured ? (needsReconnect ? 'Needs reconnecting.' : 'App set up, not connected yet.') : 'App not set up yet.'}</span>
                </div>
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}

function SetupForm({ app, onSaved, onError }: { app: OAuthApp; onSaved: (message: string) => Promise<void>; onError: (message: string) => void }) {
  const [showManual, setShowManual] = useState(app.setup.method === 'console' || (app.configured && app.setup.source === 'manual'))
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState('')
  const callbackUrl = `${window.location.origin}${app.callbackPath}`
  const copy = async (label: string, value: string) => { await navigator.clipboard?.writeText(value); setCopied(label); window.setTimeout(() => setCopied(''), 1500) }
  const remove = () => {
    if (!window.confirm(`Remove the stored ${app.label} app credentials? Connected tokens keep working until they expire, but reconnecting will need the app again.`)) return
    setBusy(true)
    json(`/api/oauth-apps/${app.provider}`, { method: 'DELETE' }).then(() => onSaved(`${app.label} app removed from Spaces.`)).catch((err) => onError(err instanceof Error ? err.message : String(err))).finally(() => setBusy(false))
  }
  const copyChip = (label: string, value: string) => (
    <button type="button" className="copy-chip" onClick={() => void copy(label, value)} title="Copy"><code>{value}</code>{copied === label ? ' ✓' : ''}</button>
  )

  return (
    <div className="credentials-form">
      {app.setup.method === 'github-manifest' && <GitHubAppSetup app={app} />}
      {app.setup.method === 'slack-manifest' && (
        <div className="setup-flow">
          <div className="setup-flow-text">
            <strong>Create the Slack app from a manifest</strong>
            <span className="text-subtle">Opens Slack with the app name, redirect URL and bot scopes already filled in. Pick the workspace, press <em>Create</em>, then copy the client id and secret from <em>Basic Information</em> into the fields below.</span>
          </div>
          <div className="setup-flow-actions">
            <a className="primary-button" href={app.setup.createUrl} target="_blank" rel="noreferrer">Create Slack app ↗</a>
          </div>
        </div>
      )}
      {app.setup.method === 'console' && (
        <div className="setup-flow">
          <div className="setup-flow-text">
            <strong>Create the app in the {app.label.split(' (')[0]} developer console</strong>
            <span className="text-subtle">{app.provider === 'atlassian' ? 'Atlassian has no install-from-manifest flow: create an OAuth 2.0 (3LO) app, add the callback URL and enable the scopes below, then paste the client id and secret here.' : 'Linear has no install-from-manifest flow: create an OAuth application, add the callback URL, then paste the client id and secret here.'}</span>
          </div>
          <div className="setup-flow-actions">
            <a className="primary-button" href={app.consoleUrl} target="_blank" rel="noreferrer">Open {app.label.split(' (')[0]} console ↗</a>
          </div>
        </div>
      )}

      {app.setup.method !== 'console' && (
        <button type="button" className="link-button setup-toggle" onClick={() => setShowManual((v) => !v)}>
          {showManual ? 'Hide manual setup' : app.provider === 'github' ? 'Use an existing GitHub OAuth App or GitHub App instead (paste credentials)' : 'Paste the client id and secret'}
        </button>
      )}

      {showManual && (
        <ManualCredentials app={app} callbackUrl={callbackUrl} copyChip={copyChip} onSaved={onSaved} onError={onError} busy={busy} setBusy={setBusy} />
      )}

      <div className="button-row">
        {app.configured && <button type="button" className="ghost-button" disabled={busy} onClick={remove}>Remove app from Spaces</button>}
        <span className="text-subtle" style={{ marginLeft: 'auto' }}>Secrets are encrypted with the server's ENCRYPTION_KEY and never shown again.</span>
      </div>
    </div>
  )
}

/** One-click GitHub App: create through the manifest flow, then install it. */
function GitHubAppSetup({ app }: { app: OAuthApp }) {
  const [org, setOrg] = useState('')
  const created = app.configured && app.setup.source === 'manifest'
  const createHref = `${app.setup.createUrl}${org.trim() ? `?org=${encodeURIComponent(org.trim())}` : ''}`
  return (
    <div className="setup-flow github">
      <ol className="setup-steps">
        <li className={created ? 'done' : 'current'}>
          <div className="setup-flow-text">
            <strong>{created ? `GitHub App created: ${app.setup.appName ?? app.setup.appSlug}` : 'Create the GitHub App'}</strong>
            <span className="text-subtle">
              {created
                ? <>Owned by <b>{app.setup.ownerLogin ?? 'your account'}</b>. Credentials, private key and webhook secret are stored encrypted. <a href={app.setup.appUrl} target="_blank" rel="noreferrer">Open app settings ↗</a></>
                : 'Spaces sends GitHub a manifest with the app name, callback URL and repository permissions (contents, pull requests, issues; read metadata, checks and actions). You confirm on GitHub and come straight back — no copying of ids or secrets.'}
            </span>
          </div>
          {!created && (
            <div className="setup-flow-actions">
              <label className="setup-inline-field">
                <span>Create under organization <span className="text-subtle">(optional)</span></span>
                <input value={org} onChange={(e) => setOrg(e.target.value)} placeholder="Leave empty for your account" autoComplete="off" />
              </label>
              <a className="primary-button" href={createHref}>Create GitHub App</a>
            </div>
          )}
        </li>
        <li className={created ? (app.setup.installed ? 'done' : 'current') : ''}>
          <div className="setup-flow-text">
            <strong>{app.setup.installed ? 'Installed on GitHub' : 'Install it on your account or organization'}</strong>
            <span className="text-subtle">{app.setup.installed ? 'Repository access is granted. Reinstall to change which repositories the app can see.' : 'Choose the repositories Spaces may access. After installing, GitHub returns here and you approve the connection in one go.'}</span>
          </div>
          {created && (
            <div className="setup-flow-actions">
              <a className={app.setup.installed ? 'ghost-button' : 'primary-button'} href={app.setup.installUrl}>{app.setup.installed ? 'Manage installation ↗' : 'Install on GitHub'}</a>
            </div>
          )}
        </li>
      </ol>
    </div>
  )
}

function ManualCredentials({ app, callbackUrl, copyChip, onSaved, onError, busy, setBusy }: {
  app: OAuthApp; callbackUrl: string; copyChip: (label: string, value: string) => JSX.Element
  onSaved: (message: string) => Promise<void>; onError: (message: string) => void; busy: boolean; setBusy: (b: boolean) => void
}) {
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  return (
    <form className="manual-credentials" onSubmit={(e) => {
      e.preventDefault()
      setBusy(true)
      json(`/api/oauth-apps/${app.provider}`, { method: 'PUT', body: JSON.stringify({ clientId, clientSecret: clientSecret || undefined }) })
        .then(() => onSaved(`${app.label} app saved. You can connect now.`))
        .catch((err) => onError(err instanceof Error ? err.message : String(err)))
        .finally(() => setBusy(false))
    }}>
      <ol className="credentials-steps">
        <li>
          <span>Set the app's callback / redirect URL to</span>
          {copyChip('callback', callbackUrl)}
        </li>
        <li>
          <span>Grant these scopes (permissions):</span>
          {copyChip('scopes', app.scopes.join(' '))}
          {app.notes && <span className="text-subtle">{app.notes}</span>}
        </li>
        <li><span>Paste the client id and secret.</span></li>
      </ol>
      <div className="credentials-fields">
        <label>Client id<input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder={app.clientIdMasked ?? 'Iv1.… / 3f9c…'} required autoComplete="off" /></label>
        <label>Client secret<input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder={app.configured ? 'Leave empty to keep the stored secret' : 'Paste the secret'} autoComplete="new-password" required={!app.configured} /></label>
      </div>
      <div className="button-row">
        <button type="submit" className="primary-button" disabled={busy || !clientId.trim()}>{busy ? 'Saving…' : 'Save credentials'}</button>
      </div>
    </form>
  )
}
