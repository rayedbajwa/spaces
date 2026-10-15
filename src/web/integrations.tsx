import { useCallback, useEffect, useState } from 'react'
import { SkeletonRows } from './loading'
import { json, navigate, useAuth } from './auth'
import { INTEGRATION_CATEGORIES, calculateCategoryStatus } from '../lib/integration-categories'

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
  provider: 'github' | 'atlassian' | 'slack' | 'linear' | 'figma' | 'railway'
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
  /** False when the provider no longer knows this app (deleted on their side). */
  availableAtProvider?: boolean
  /** Permissions the app is missing that agents need. */
  missingPermissions?: string[]
  permissionsUrl?: string
  /** Slack only: whether the signing secret that verifies inbound requests is stored. */
  signingSecretSet?: boolean
}

interface Connection { kind: string; status: string; displayName?: string; updatedAt: string; credentialsOk?: boolean }

const KIND_LABEL: Record<string, string> = { github: 'GitHub', jira: 'Jira', confluence: 'Confluence', slack: 'Slack', linear: 'Linear', figma: 'Figma', railway: 'Railway', datadog: 'Datadog', email: 'Email' }
const PROVIDER_BLURB: Record<OAuthApp['provider'], string> = {
  github: 'Repository catalog, cloning, pull requests, issue search and GitHub sign-in.',
  atlassian: 'Jira issues and Confluence pages for agents and the knowledge base. One app covers both.',
  linear: 'Linear issues, projects and initiatives for agents and the knowledge base.',
  slack: 'A channel per project (#spaces-<code>) with run updates, stage summaries and approval requests.',
  figma: 'Figma files, design tokens, style definitions, and component libraries for agent visual inspection and knowledge base ingestion.',
  railway: 'Railway deployment targets, release approval and live deployment state. OAuth connections are observation-only; releases require a workspace or project token. Connect once per organization; a project links one service and environment.',
}

/**
 * The two two-way workflow surfaces. They are reachable from here rather than
 * the main menu, so the connections they depend on stay in one place with the
 * guidance a person needs to set them up.
 */
const WORK_SURFACES = [
  {
    id: 'intake',
    label: 'Work inbox',
    icon: '📥',
    path: '/integrations/intake',
    blurb: 'Every request from outside Spaces lands here first — Jira and Linear issues, Slack requests and Datadog alerts — in one prioritized queue.',
    how: [
      'Connect a source under Project Management, Communication or Monitoring below.',
      'New items appear in the inbox automatically as the source syncs.',
      'Open an item to set its priority and turn it into a feature or bugfix in a project.',
    ],
  },
  {
    id: 'outbound',
    label: 'Outbound updates',
    icon: '📤',
    path: '/integrations/outbound',
    blurb: 'Tell the tools you already use when something happens in Spaces — a run fails, a gate opens, a feature is delivered.',
    how: [
      'Connect the target tool below (Jira, Linear, GitHub or Slack).',
      'Add a subscription that maps an event to a target and action.',
      'Spaces sends it, retries on failure and records every attempt — never blocking a run.',
    ],
  },
] as const

export function WorkSurfaces() {
  return (
    <section className="integration-category work-surfaces" aria-label="Workflow surfaces">
      <div className="integration-category-header">
        <div className="integration-category-title-row">
          <h3>Workflow surfaces</h3>
        </div>
        <p className="panel-subtitle">The two-way surfaces that use the connections below. Set up the connection first, then open the surface to configure it.</p>
      </div>
      <div className="work-surface-grid">
        {WORK_SURFACES.map((surface) => (
          <section key={surface.id} className="card work-surface">
            <div className="work-surface-head">
              <span className="work-surface-icon" aria-hidden="true">{surface.icon}</span>
              <div>
                <h4>{surface.label}</h4>
                <p className="panel-subtitle">{surface.blurb}</p>
              </div>
            </div>
            <ol className="work-surface-steps">
              {surface.how.map((step) => <li key={step}>{step}</li>)}
            </ol>
            <button type="button" className="secondary-button" onClick={() => navigate(surface.path)}>Open {surface.label.toLowerCase()}</button>
          </section>
        ))}
      </div>
    </section>
  )
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
  const [showFigmaPatModal, setShowFigmaPatModal] = useState(false)
  const [showRailwayTokenModal, setShowRailwayTokenModal] = useState(false)
  const [showEmailModal, setShowEmailModal] = useState(false)
  const [showDatadogModal, setShowDatadogModal] = useState(false)

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
      <WorkSurfaces />
      {apps === null && <SkeletonRows count={4} label="Loading integrations…" />}
      {apps !== null && (
        <div className="integration-categories">
          {INTEGRATION_CATEGORIES.map((category) => {
            const categoryApps = apps.filter((app) => (category.providers as readonly string[]).includes(app.provider))
            const statusSummary = calculateCategoryStatus(category, apps, connections)
            const isEmpty = statusSummary.state === 'empty'

            return (
              <section key={category.id} className="integration-category">
                <div className="integration-category-header">
                  <div className="integration-category-title-row">
                    <h3>{category.label}</h3>
                    <span className={`category-badge category-badge-${statusSummary.badgeVariant} mini-badge ${statusSummary.badgeVariant}`}>
                      {statusSummary.summaryBadge}
                    </span>
                  </div>
                  <p className="panel-subtitle">{category.description}</p>
                </div>

                {isEmpty && (
                  <div className="integration-category-empty card">
                    <p>{category.emptyGuidance}</p>
                    {canManage && categoryApps.length > 0 && (
                      <div className="integration-category-empty-actions">
                        {categoryApps.map((app) => (
                          <button
                            key={app.provider}
                            type="button"
                            className={editing === app.provider ? 'ghost-button' : 'primary-button'}
                            onClick={() => setEditing(editing === app.provider ? null : app.provider)}
                          >
                            {editing === app.provider ? `Close ${app.label} setup` : `Set up ${app.label}`}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {category.id === 'notifications' && !readOnly && (
                  <div className="integration-list">
                    {(() => {
                      const row = connections.find((c) => c.kind === 'email')
                      const connected = row?.status === 'connected' && row.credentialsOk !== false
                      return (
                        <section className={`card integration ${connected ? 'configured connected' : ''}`}>
                          <div className="integration-head">
                            <div className="integration-logo email" aria-hidden="true">E</div>
                            <div className="integration-title">
                              <h3>Resend email</h3>
                              <p className="panel-subtitle" style={{ margin: 0 }}>Direct approval requests and confirmations sent straight to the accountable owner by email.</p>
                            </div>
                            <div className="integration-state">
                              <span className={`mini-badge ${connected ? 'completed' : 'idle'}`}>{connected ? '✓ connected' : 'not connected'}</span>
                              {canManage && <button type="button" className="primary-button" onClick={() => setShowEmailModal(true)}>{connected ? 'Update' : 'Connect'}</button>}
                            </div>
                          </div>
                          {row?.displayName && <p className="text-subtle" style={{ margin: '0 0 8px' }}>{row.displayName}</p>}
                          {connected && canManage && (
                            <div className="integration-foot">
                              <span className="text-subtle">Connected for the whole organization.</span>
                              <button type="button" className="ghost-button" style={{ marginLeft: 'auto' }} onClick={() => void disconnect('email')}>Disconnect</button>
                            </div>
                          )}
                        </section>
                      )
                    })()}
                  </div>
                )}

                {category.id === 'monitoring' && !readOnly && (
                  <div className="integration-list">
                    {(() => {
                      const row = connections.find((c) => c.kind === 'datadog')
                      const connected = row?.status === 'connected' && row.credentialsOk !== false
                      return (
                        <section className={`card integration ${connected ? 'configured connected' : ''}`}>
                          <div className="integration-head">
                            <div className="integration-logo datadog" aria-hidden="true">D</div>
                            <div className="integration-title">
                              <h3>Datadog</h3>
                              <p className="panel-subtitle" style={{ margin: 0 }}>Datadog monitors and alerts land in the organization-scoped Intake queue, ordered by severity and triaged into project work.</p>
                            </div>
                            <div className="integration-state">
                              <span className={`mini-badge ${connected ? 'completed' : row?.credentialsOk === false ? 'error' : 'idle'}`}>{connected ? '✓ connected' : row?.credentialsOk === false ? '⚠ reconnect needed' : 'not connected'}</span>
                              {canManage && <button type="button" className="primary-button" onClick={() => setShowDatadogModal(true)}>{connected ? 'Update' : 'Connect'}</button>}
                            </div>
                          </div>
                          {row?.displayName && <p className="text-subtle" style={{ margin: '0 0 8px' }}>{row.displayName}</p>}
                          {connected && canManage && (
                            <div className="integration-foot">
                              <span className="text-subtle">Connected for the whole organization.</span>
                              <button type="button" className="ghost-button" style={{ marginLeft: 'auto' }} onClick={() => void disconnect('datadog')}>Disconnect</button>
                            </div>
                          )}
                        </section>
                      )
                    })()}
                  </div>
                )}

                {categoryApps.length > 0 && (
                  <div className="integration-list">
                    {categoryApps.map((app) => {
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

                          {app.availableAtProvider === false && (
                            <p className="error-text" style={{ margin: '0 0 8px' }}>
                              This app no longer exists on {app.label.split(' ')[0]}, so connecting and signing in with it fail. Create it again below.
                            </p>
                          )}
                          {app.availableAtProvider !== false && app.missingPermissions && app.missingPermissions.length > 0 && (
                            <p className="error-text" style={{ margin: '0 0 8px' }}>
                              This app cannot {app.missingPermissions.includes('workflows') ? 'change workflow files, so a run that wires its tests into CI is refused' : 'do everything agents need'}.
                              {' '}Add {app.missingPermissions.map((name) => name.replace('_', ' ')).join(', ')} (read and write)
                              {app.permissionsUrl ? <> on <a href={app.permissionsUrl} target="_blank" rel="noreferrer">the app's permissions page</a></> : ' on GitHub'}
                              , then accept the request on the installation.
                            </p>
                          )}

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
                                ? (
                                  <>
                                    <span className="text-subtle">Connected as one account for the whole organization.</span>
                                    {app.provider === 'figma' && canManage && (
                                      <button type="button" className="ghost-button" style={{ marginLeft: 'auto' }} onClick={() => setShowFigmaPatModal(true)}>
                                        Update Token
                                      </button>
                                    )}
                                    {app.provider === 'railway' && canManage && (
                                      <button type="button" className="ghost-button" style={{ marginLeft: 'auto' }} onClick={() => setShowRailwayTokenModal(true)}>
                                        Update credential
                                      </button>
                                    )}
                                  </>
                                )
                                : (
                                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                                    {app.configured && (
                                      canManage ? (
                                        <button type="button" className="primary-button" onClick={() => connect(app.provider)}>
                                          {needsReconnect ? `Reconnect ${app.label}` : `Connect ${app.label}`}
                                        </button>
                                      ) : (
                                        <span className="text-subtle">An owner or admin can connect this.</span>
                                      )
                                    )}
                                    {app.provider === 'figma' && canManage && (
                                      <button
                                        type="button"
                                        className={app.configured ? 'ghost-button' : 'primary-button'}
                                        onClick={() => setShowFigmaPatModal(true)}
                                      >
                                        {needsReconnect ? 'Reconnect with Token (PAT)' : 'Connect with Token (PAT)'}
                                      </button>
                                    )}
                                    {app.provider === 'railway' && canManage && (
                                      <button
                                        type="button"
                                        className={app.configured ? 'ghost-button' : 'primary-button'}
                                        onClick={() => setShowRailwayTokenModal(true)}
                                      >
                                        {needsReconnect ? 'Reconnect with Token' : 'Connect with Token'}
                                      </button>
                                    )}
                                    {!app.configured && app.provider !== 'figma' && (
                                      <span className="text-subtle">Set up the {app.label.split(' ')[0]} app to enable connecting.</span>
                                    )}
                                  </div>
                                )}
                            </div>
                          )}
                          {readOnly && (
                            <div className="integration-foot">
                              <span className="text-subtle">
                                {anyConnected && !needsReconnect
                                  ? 'Connected for the organization.'
                                  : app.configured
                                    ? (needsReconnect ? 'Needs reconnecting.' : 'App set up, not connected yet.')
                                    : 'App not set up yet.'}
                              </span>
                            </div>
                          )}
                        </section>
                      )
                    })}
                  </div>
                )}
              </section>
            )
          })}
        </div>
      )}
      {showFigmaPatModal && (
        <FigmaTokenModal
          onClose={() => setShowFigmaPatModal(false)}
          onSaved={async (m) => {
            await load()
            flash(m)
          }}
          onError={setError}
        />
      )}
      {showRailwayTokenModal && (
        <RailwayTokenModal
          onClose={() => setShowRailwayTokenModal(false)}
          onSaved={async (m) => {
            await load()
            flash(m)
          }}
          onError={setError}
        />
      )}
      {showEmailModal && (
        <EmailTokenModal
          onClose={() => setShowEmailModal(false)}
          onSaved={async (m) => {
            await load()
            flash(m)
          }}
          onError={setError}
        />
      )}
      {showDatadogModal && (
        <DatadogTokenModal
          onClose={() => setShowDatadogModal(false)}
          onSaved={async (m) => {
            await load()
            flash(m)
          }}
          onError={setError}
        />
      )}
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
            <span className="text-subtle">{app.provider === 'atlassian' ? 'Atlassian has no install-from-manifest flow: create an OAuth 2.0 (3LO) app, add the callback URL and enable the scopes below, then paste the client id and secret here.' : 'Linear has no install-from-manifest flow: in your workspace\'s Settings → API → OAuth applications → New (linear.app/<workspace>/settings/api/applications/new, e.g. linear.app/rayed/settings/api/applications/new), create the application, add the callback URL, then paste the client id and secret here.'}</span>
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

      {app.provider === 'slack' && app.configured && (
        <SlackInbound app={app} copyChip={copyChip} onSaved={onSaved} onError={onError} busy={busy} setBusy={setBusy} />
      )}

      <div className="button-row">
        {app.configured && <button type="button" className="ghost-button" disabled={busy} onClick={remove}>Remove app from Spaces</button>}
        <span className="text-subtle" style={{ marginLeft: 'auto' }}>Secrets are stored encrypted for this organization and never shown again.</span>
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
                : 'Spaces sends GitHub a manifest with the app name, callback URL and repository permissions (contents, pull requests and issues; read metadata, checks and actions). You confirm on GitHub and come straight back — no copying of ids or secrets.'}
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

/**
 * What Slack needs to reach Spaces: the request URLs for buttons, events and
 * the /spaces command, and the signing secret that verifies those requests.
 * Without the secret every request from Slack is refused.
 */
function SlackInbound({ app, copyChip, onSaved, onError, busy, setBusy }: {
  app: OAuthApp; copyChip: (label: string, value: string) => JSX.Element
  onSaved: (message: string) => Promise<void>; onError: (message: string) => void; busy: boolean; setBusy: (b: boolean) => void
}) {
  const [secret, setSecret] = useState('')
  const origin = window.location.origin
  return (
    <form className="manual-credentials" onSubmit={(e) => {
      e.preventDefault()
      setBusy(true)
      json('/api/oauth-apps/slack/signing-secret', { method: 'PUT', body: JSON.stringify({ signingSecret: secret }) })
        .then(() => { setSecret(''); return onSaved('Slack signing secret saved. Buttons, replies and /spaces now reach Spaces.') })
        .catch((err) => onError(err instanceof Error ? err.message : String(err)))
        .finally(() => setBusy(false))
    }}>
      <strong>Let Slack reach Spaces {app.signingSecretSet ? '· signing secret stored' : '· not set up'}</strong>
      <span className="text-subtle">Approval buttons, replies to questions and the /spaces command need these in the Slack app's settings. An app created from the manifest has the URLs already.</span>
      <ol className="credentials-steps">
        <li>
          <span><em>Interactivity &amp; Shortcuts</em>: turn on, Request URL</span>
          {copyChip('interactions', `${origin}/api/slack/interactions`)}
        </li>
        <li>
          <span><em>Event Subscriptions</em>: turn on, Request URL (bot events message.im, app_mention)</span>
          {copyChip('events', `${origin}/api/slack/events`)}
        </li>
        <li>
          <span><em>Slash Commands</em>: /spaces, Request URL</span>
          {copyChip('commands', `${origin}/api/slack/commands`)}
        </li>
        <li><span>Paste the <em>Signing Secret</em> from <em>Basic Information → App Credentials</em>.</span></li>
      </ol>
      <div className="credentials-fields">
        <label>Signing secret<input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={app.signingSecretSet ? 'Stored; paste a new one to replace it' : 'Paste the signing secret'} autoComplete="new-password" /></label>
      </div>
      <div className="button-row">
        <button type="submit" className="primary-button" disabled={busy || !secret.trim()}>{busy ? 'Saving…' : 'Save signing secret'}</button>
      </div>
    </form>
  )
}

function FigmaTokenModal({
  onClose,
  onSaved,
  onError,
}: {
  onClose: () => void
  onSaved: (message: string) => Promise<void>
  onError: (message: string) => void
}) {
  const [token, setToken] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)

  const handleVerify = async () => {
    if (!token.trim()) return
    setTesting(true)
    setTestResult(null)
    try {
      const res = await json<{ ok: boolean; user?: { handle: string; email: string }; error?: string }>(
        '/api/integrations/figma/verify',
        { method: 'POST', body: JSON.stringify({ token: token.trim() }) }
      )
      if (res.ok && res.user) {
        setTestResult(`✓ Valid token for ${res.user.handle || res.user.email}`)
      } else {
        setTestResult(`✗ ${res.error || 'Verification failed'}`)
      }
    } catch (err) {
      setTestResult(`✗ ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setTesting(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!token.trim()) return
    setBusy(true)
    try {
      await json('/api/integrations/figma/token', {
        method: 'POST',
        body: JSON.stringify({ token: token.trim(), displayName: displayName.trim() || undefined }),
      })
      await onSaved('Figma Personal Access Token connected successfully.')
      onClose()
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-shell" style={{ maxWidth: 520, width: '90vw' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">
            <h2>Connect Figma Personal Access Token</h2>
            <p className="panel-subtitle">Generate a Personal Access Token in Figma under Settings → Security → Personal access tokens.</p>
          </div>
          <button type="button" className="ghost-button" onClick={onClose}>✕</button>
        </div>
        <form onSubmit={handleSubmit} className="modal-body figma-token-form" style={{ padding: '16px 20px', display: 'grid', gap: 14 }}>
          <label>
            <span>Personal Access Token</span>
            <input
              type="password"
              value={token}
              onChange={(e) => { setToken(e.target.value); setTestResult(null) }}
              placeholder="figd_..."
              required
              autoFocus
            />
          </label>
          <label>
            <span>Display Name (optional)</span>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. Acme Design Team"
            />
          </label>
          {testResult && (
            <div style={{ fontSize: 13, color: testResult.startsWith('✓') ? 'var(--green)' : 'var(--red)' }}>
              {testResult}
            </div>
          )}
          <div className="button-row" style={{ marginTop: 8, display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button type="button" className="ghost-button" disabled={busy || testing || !token.trim()} onClick={handleVerify}>
              {testing ? 'Verifying…' : 'Test Token'}
            </button>
            <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary-button" disabled={busy || !token.trim()}>
              {busy ? 'Connecting…' : 'Connect Figma'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function RailwayTokenModal({
  onClose,
  onSaved,
  onError,
}: {
  onClose: () => void
  onSaved: (message: string) => Promise<void>
  onError: (message: string) => void
}) {
  const [token, setToken] = useState('')
  const [tokenType, setTokenType] = useState<'workspace' | 'account' | 'project'>('workspace')
  const [displayName, setDisplayName] = useState('')
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)

  const describeIdentity = (result: { identity?: { workspaceName?: string; accountName?: string; projectId?: string; environmentId?: string } }) =>
    result.identity?.workspaceName ?? result.identity?.accountName ?? result.identity?.projectId ?? 'the credential'

  const handleVerify = async () => {
    if (!token.trim()) return
    setTesting(true)
    setTestResult(null)
    try {
      const res = await json<{ ok: boolean; identity?: { workspaceName?: string; accountName?: string; projectId?: string; environmentId?: string }; error?: string }>(
        '/api/integrations/railway/verify',
        { method: 'POST', body: JSON.stringify({ token: token.trim(), tokenType }) }
      )
      setTestResult(res.ok ? `✓ Valid Railway credential for ${describeIdentity(res)}` : `✗ ${res.error || 'Verification failed'}`)
    } catch (err) {
      setTestResult(`✗ ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setTesting(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!token.trim()) return
    setBusy(true)
    try {
      await json('/api/integrations/railway/token', {
        method: 'POST',
        body: JSON.stringify({ token: token.trim(), tokenType, displayName: displayName.trim() || undefined }),
      })
      await onSaved('Railway connected successfully.')
      onClose()
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-shell" style={{ maxWidth: 560, width: '90vw' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">
            <h2>Connect Railway</h2>
            <p className="panel-subtitle">Create a token under Railway → Account → Tokens. A <strong>workspace token</strong> scoped to the workspace holding your deployable projects is preferred; a project token is narrowest (one environment), an account token is broadest.</p>
          </div>
          <button type="button" className="ghost-button" onClick={onClose}>✕</button>
        </div>
        <form onSubmit={handleSubmit} className="modal-body" style={{ padding: '16px 20px', display: 'grid', gap: 14 }}>
          <label>
            <span>Credential type</span>
            <select value={tokenType} onChange={(e) => { setTokenType(e.target.value as 'workspace' | 'account' | 'project'); setTestResult(null) }}>
              <option value="workspace">Workspace token (recommended)</option>
              <option value="project">Project token (one environment)</option>
              <option value="account">Account token (broadest — discouraged)</option>
            </select>
          </label>
          <label>
            <span>Token</span>
            <input
              type="password"
              value={token}
              onChange={(e) => { setToken(e.target.value); setTestResult(null) }}
              placeholder="Railway token"
              required
              autoFocus
            />
          </label>
          <label>
            <span>Display Name (optional)</span>
            <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="e.g. Acme Workspace" />
          </label>
          {testResult && (
            <div style={{ fontSize: 13, color: testResult.startsWith('✓') ? 'var(--green)' : 'var(--red)' }}>{testResult}</div>
          )}
          <div className="button-row" style={{ marginTop: 8, display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button type="button" className="ghost-button" disabled={busy || testing || !token.trim()} onClick={handleVerify}>
              {testing ? 'Verifying…' : 'Test credential'}
            </button>
            <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary-button" disabled={busy || !token.trim()}>
              {busy ? 'Connecting…' : 'Connect Railway'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function EmailTokenModal({
  onClose,
  onSaved,
  onError,
}: {
  onClose: () => void
  onSaved: (message: string) => Promise<void>
  onError: (message: string) => void
}) {
  const [apiKey, setApiKey] = useState('')
  const [fromAddress, setFromAddress] = useState('')
  const [fromName, setFromName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)

  const handleVerify = async () => {
    if (!apiKey.trim()) return
    setTesting(true)
    setTestResult(null)
    try {
      const res = await json<{ ok: boolean; domains?: string[]; error?: string }>(
        '/api/integrations/email/verify',
        { method: 'POST', body: JSON.stringify({ apiKey: apiKey.trim() }) }
      )
      const domains = res.domains?.length ? ` (${res.domains.join(', ')})` : ''
      setTestResult(res.ok ? `✓ Valid Resend key${domains}` : `✗ ${res.error || 'Verification failed'}`)
    } catch (err) {
      setTestResult(`✗ ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setTesting(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!apiKey.trim() || !fromAddress.trim()) return
    setBusy(true)
    try {
      await json('/api/integrations/email/token', {
        method: 'POST',
        body: JSON.stringify({ apiKey: apiKey.trim(), fromAddress: fromAddress.trim(), fromName: fromName.trim() || undefined, displayName: displayName.trim() || undefined }),
      })
      await onSaved('Email connected successfully.')
      onClose()
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-shell" style={{ maxWidth: 560, width: '90vw' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">
            <h2>Connect email (Resend)</h2>
            <p className="panel-subtitle">Create an API key under Resend → API Keys, and send from an address on a domain verified in that account. The key is stored encrypted and never shown again.</p>
          </div>
          <button type="button" className="ghost-button" onClick={onClose}>✕</button>
        </div>
        <form onSubmit={handleSubmit} className="modal-body" style={{ padding: '16px 20px', display: 'grid', gap: 14 }}>
          <label>
            <span>Resend API key</span>
            <input type="password" value={apiKey} onChange={(e) => { setApiKey(e.target.value); setTestResult(null) }} placeholder="re_..." required autoFocus />
          </label>
          <label>
            <span>From address</span>
            <input type="email" value={fromAddress} onChange={(e) => setFromAddress(e.target.value)} placeholder="approvals@yourdomain.com" required />
          </label>
          <label>
            <span>From name (optional)</span>
            <input type="text" value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder="Acme Approvals" />
          </label>
          <label>
            <span>Display name (optional)</span>
            <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="e.g. Acme Email" />
          </label>
          {testResult && <div style={{ fontSize: 13, color: testResult.startsWith('✓') ? 'var(--green)' : 'var(--red)' }}>{testResult}</div>}
          <div className="button-row" style={{ marginTop: 8, display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button type="button" className="ghost-button" disabled={busy || testing || !apiKey.trim()} onClick={handleVerify}>
              {testing ? 'Verifying…' : 'Test key'}
            </button>
            <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary-button" disabled={busy || !apiKey.trim() || !fromAddress.trim()}>
              {busy ? 'Connecting…' : 'Connect email'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function DatadogTokenModal({
  onClose,
  onSaved,
  onError,
}: {
  onClose: () => void
  onSaved: (message: string) => Promise<void>
  onError: (message: string) => void
}) {
  const [apiKey, setApiKey] = useState('')
  const [appKey, setAppKey] = useState('')
  const [site, setSite] = useState('datadoghq.com')
  const [displayName, setDisplayName] = useState('')
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)

  const handleVerify = async () => {
    if (!apiKey.trim() || !appKey.trim()) return
    setTesting(true)
    setTestResult(null)
    try {
      const res = await json<{ ok: boolean; account?: string; error?: string }>('/api/integrations/datadog/verify', {
        method: 'POST',
        body: JSON.stringify({ apiKey: apiKey.trim(), appKey: appKey.trim(), site: site.trim() }),
      })
      setTestResult(res.ok ? `✓ Valid Datadog credentials (${res.account ?? site})` : `✗ ${res.error || 'Verification failed'}`)
    } catch (err) {
      setTestResult(`✗ ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setTesting(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!apiKey.trim() || !appKey.trim()) return
    setBusy(true)
    try {
      await json('/api/integrations/datadog/token', {
        method: 'POST',
        body: JSON.stringify({ apiKey: apiKey.trim(), appKey: appKey.trim(), site: site.trim(), displayName: displayName.trim() || undefined }),
      })
      await onSaved('Datadog connected successfully.')
      onClose()
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-shell" style={{ maxWidth: 540, width: '90vw' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">
            <h2>Connect Datadog</h2>
            <p className="panel-subtitle">Create an API key and an application key in Datadog under Organization Settings → API keys / Application keys. Both are stored encrypted and never returned.</p>
          </div>
          <button type="button" className="ghost-button" onClick={onClose}>✕</button>
        </div>
        <form onSubmit={handleSubmit} className="modal-body" style={{ padding: '16px 20px', display: 'grid', gap: 14 }}>
          <label>
            <span>API key</span>
            <input type="password" value={apiKey} onChange={(e) => { setApiKey(e.target.value); setTestResult(null) }} placeholder="Datadog API key" required autoFocus />
          </label>
          <label>
            <span>Application key</span>
            <input type="password" value={appKey} onChange={(e) => { setAppKey(e.target.value); setTestResult(null) }} placeholder="Datadog application key" required />
          </label>
          <label>
            <span>Site</span>
            <input type="text" value={site} onChange={(e) => { setSite(e.target.value); setTestResult(null) }} placeholder="datadoghq.com" />
          </label>
          <label>
            <span>Display name (optional)</span>
            <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="e.g. Acme monitoring" />
          </label>
          {testResult && <div style={{ fontSize: 13, color: testResult.startsWith('✓') ? 'var(--green)' : 'var(--red)' }}>{testResult}</div>}
          <div className="button-row" style={{ marginTop: 8, display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button type="button" className="ghost-button" disabled={busy || testing || !apiKey.trim() || !appKey.trim()} onClick={handleVerify}>
              {testing ? 'Verifying…' : 'Test credentials'}
            </button>
            <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary-button" disabled={busy || !apiKey.trim() || !appKey.trim()}>
              {busy ? 'Connecting…' : 'Connect Datadog'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
