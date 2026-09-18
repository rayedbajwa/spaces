import { useCallback, useEffect, useState } from 'react'
import { json, navigate, useAuth } from './auth'

/**
 * Integrations, self-serve and organization-wide.
 *
 * One card per OAuth provider (GitHub, Atlassian for Jira + Confluence, Linear,
 * Slack). Each shows whether app credentials are set, the callback URL and
 * scopes to register with the provider, and the
 * connection state of the integrations it powers. Owners and admins paste the
 * client id and secret here; connecting is enabled only once they exist.
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
          Integrations are shared by every team. App credentials are set once here by an owner or admin, stored encrypted in the database, and are required before a provider can be connected.
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
                  <span className={`mini-badge ${app.configured ? 'idle' : 'error'}`} title={app.configured ? `Set in the app${app.updatedByName ? ` by ${app.updatedByName}` : ''}${app.updatedAt ? ` on ${new Date(app.updatedAt).toLocaleDateString()}` : ''}` : 'No client id and secret yet'}>
                    {app.configured ? 'credentials set' : 'credentials missing'}
                  </span>
                  {canManage && <button type="button" className="ghost-button" onClick={() => setEditing(isEditing ? null : app.provider)}>{isEditing ? 'Close' : app.configured ? 'Edit credentials' : 'Add credentials'}</button>}
                </div>
              </div>

              {isEditing && canManage && (
                <CredentialsForm app={app} onSaved={async (m) => { setEditing(null); await load(); flash(m) }} onError={setError} />
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
                      : <span className="text-subtle">Add the app credentials to enable connecting.</span>}
                </div>
              )}
              {readOnly && !anyConnected && (
                <div className="integration-foot">
                  <span className="text-subtle">{app.configured ? (needsReconnect ? 'Needs reconnecting.' : 'Credentials set, not connected yet.') : 'No credentials yet.'}</span>
                </div>
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}

function CredentialsForm({ app, onSaved, onError }: { app: OAuthApp; onSaved: (message: string) => Promise<void>; onError: (message: string) => void }) {
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState('')
  const callbackUrl = `${window.location.origin}${app.callbackPath}`
  const copy = async (label: string, value: string) => { await navigator.clipboard?.writeText(value); setCopied(label); window.setTimeout(() => setCopied(''), 1500) }
  return (
    <form className="credentials-form" onSubmit={(e) => {
      e.preventDefault()
      setBusy(true)
      json(`/api/oauth-apps/${app.provider}`, { method: 'PUT', body: JSON.stringify({ clientId, clientSecret: clientSecret || undefined }) })
        .then(() => onSaved(`${app.label} credentials saved. You can connect now.`))
        .catch((err) => onError(err instanceof Error ? err.message : String(err)))
        .finally(() => setBusy(false))
    }}>
      <ol className="credentials-steps">
        <li>
          <span>Create an OAuth app in the <a href={app.consoleUrl} target="_blank" rel="noreferrer">{app.label} developer console</a>.</span>
        </li>
        <li>
          <span>Set its callback / redirect URL to</span>
          <button type="button" className="copy-chip" onClick={() => void copy('callback', callbackUrl)} title="Copy"><code>{callbackUrl}</code>{copied === 'callback' ? ' ✓' : ''}</button>
        </li>
        <li>
          <span>Grant these scopes (permissions):</span>
          <button type="button" className="copy-chip" onClick={() => void copy('scopes', app.scopes.join(' '))} title="Copy"><code>{app.scopes.join(' ')}</code>{copied === 'scopes' ? ' ✓' : ''}</button>
          {app.notes && <span className="text-subtle">{app.notes}</span>}
        </li>
        <li><span>Paste the client id and secret here.</span></li>
      </ol>
      <div className="credentials-fields">
        <label>Client id<input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder={app.clientIdMasked ?? 'Iv1.… / 3f9c…'} required autoComplete="off" /></label>
        <label>Client secret<input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder={app.configured ? 'Leave empty to keep the stored secret' : 'Paste the secret'} autoComplete="new-password" required={!app.configured} /></label>
      </div>
      <div className="button-row">
        <button type="submit" className="primary-button" disabled={busy || !clientId.trim()}>{busy ? 'Saving…' : 'Save credentials'}</button>
        {app.configured && (
          <button type="button" className="ghost-button" disabled={busy} onClick={() => { if (window.confirm(`Remove the stored ${app.label} credentials? Connected tokens keep working until they expire, but reconnecting will need credentials again.`)) { setBusy(true); json(`/api/oauth-apps/${app.provider}`, { method: 'DELETE' }).then(() => onSaved(`${app.label} credentials removed.`)).catch((err) => onError(err instanceof Error ? err.message : String(err))).finally(() => setBusy(false)) } }}>Remove stored credentials</button>
        )}
        <span className="text-subtle" style={{ marginLeft: 'auto' }}>Secrets are encrypted with the server's ENCRYPTION_KEY and never shown again.</span>
      </div>
    </form>
  )
}
