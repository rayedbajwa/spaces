import { useCallback, useEffect, useState } from 'react'
import { LoadingBlock, SkeletonRows } from './loading'
import { json } from './auth'

/**
 * Organization → Models: automatic routing per provider, tuned by policy.
 *
 * Shows which provider is routing, what each tier resolved to and why, the
 * scored candidates with their prices, and the knobs: preference (cost /
 * balanced / quality), provider order, premium models, and optional pins.
 */

type Tier = 'small' | 'medium' | 'large'
type Provider = 'anthropic' | 'openrouter' | 'openai'

interface Candidate {
  provider: string
  id: string
  spec: string
  name: string
  reasoning: boolean
  inputCost: number
  outputCost: number
  blendedCost: number
  contextWindow: number
  generation: number
  sizeHint?: 'small' | 'large'
  costScore: number
  qualityScore: number
  speedScore: number
  premium: boolean
  role?: Tier
}

interface Routing {
  provider: Provider | null
  tiers: Record<Tier, string>
  reasons: Record<Tier, string>
  candidates: Candidate[]
  policy: { preference: 'cost' | 'balanced' | 'quality'; providerOrder: Provider[]; allowPremium: boolean; overrides: Partial<Record<Tier, string>> }
  configuredProviders: Provider[]
}

const PROVIDER_LABEL: Record<Provider, string> = { anthropic: 'Anthropic', openrouter: 'OpenRouter', openai: 'OpenAI' }
const TIER_HINT: Record<Tier, string> = {
  small: 'Review, chat and fast mode. Cheap and quick.',
  medium: 'Planning and implementation. The everyday model.',
  large: 'Quality mode and retry escalation. The most capable.',
}

interface ProviderKey {
  provider: Provider
  label: string
  consoleUrl: string
  configured: boolean
  keyMasked: string | null
  updatedAt: string | null
  updatedByName: string | null
  lastVerifiedAt: string | null
  lastVerifyStatus: 'ok' | 'rejected' | 'forbidden' | 'unreachable' | 'unknown' | null
  lastVerifyError: string | null
  envLeftover: boolean
}

function ProviderKeysCard({ canEdit, onChanged }: { canEdit: boolean; onChanged: () => Promise<void> }) {
  const [keys, setKeys] = useState<ProviderKey[] | null>(null)
  const [editing, setEditing] = useState<Provider | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const load = useCallback(async () => { try { setKeys((await json<{ keys: ProviderKey[] }>('/api/org/provider-keys')).keys) } catch (e) { setError(e instanceof Error ? e.message : String(e)) } }, [])
  useEffect(() => { void load() }, [load])
  const flash = (m: string) => { setNotice(m); setError(''); window.setTimeout(() => setNotice(''), 3000) }
  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true); setError('')
    try { await fn(); await load(); await onChanged(); flash(done) } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  return (
    <section className="card panel team-section">
      <div className="team-section-head">
        <h3>Provider keys</h3>
        <span className="panel-subtitle">Stored encrypted in the database and verified against the provider when saved. Nothing lives in .env.</span>
      </div>
      {error && <p className="error-text">{error}</p>}
      {notice && <p className="team-flash team-flash-ok">{notice}</p>}
      {keys === null && <SkeletonRows count={3} label="Loading provider keys…" />}
      <ul className="member-list">
        {keys?.map((k) => (
          <li key={k.provider} className="member-row provider-key-row">
            <span className={`dock-dot ${k.configured ? (k.lastVerifyStatus === 'ok' ? 'completed' : k.lastVerifyStatus === 'rejected' ? 'error' : 'paused') : ''}`} aria-hidden="true" />
            <div className="member-id">
              <strong>{k.label}{k.configured ? <span className="text-subtle"> · {k.keyMasked}</span> : null}</strong>
              <span className="text-subtle">
                {k.configured
                  ? `${k.lastVerifyStatus === 'ok' ? 'verified' : `verification: ${k.lastVerifyStatus ?? 'unknown'}${k.lastVerifyError ? ` — ${k.lastVerifyError}` : ''}`}${k.lastVerifiedAt ? ` ${new Date(k.lastVerifiedAt).toLocaleString()}` : ''}${k.updatedByName ? ` · set by ${k.updatedByName}` : ''}`
                  : 'no key'}
                {k.envLeftover ? ' · a key left in the server configuration is ignored; keys are managed here' : ''}
              </span>
            </div>
            {canEdit && editing !== k.provider && (
              <span className="provider-key-actions">
                {k.configured && <button type="button" className="ghost-button" disabled={busy} onClick={() => void act(() => json(`/api/org/provider-keys/${k.provider}/verify`, { method: 'POST', body: '{}' }), `${k.label} key re-verified.`)}>Verify</button>}
                <button type="button" className={k.configured ? 'ghost-button' : 'primary-button'} disabled={busy} onClick={() => { setEditing(k.provider); setDraft('') }}>{k.configured ? 'Replace' : 'Add key'}</button>
                {k.configured && <button type="button" className="ghost-button" disabled={busy} onClick={() => { if (window.confirm(`Remove the ${k.label} key? Runs routed through ${k.label} will fail until a key is added again.`)) void act(() => json(`/api/org/provider-keys/${k.provider}`, { method: 'DELETE' }), `${k.label} key removed.`) }}>Remove</button>}
              </span>
            )}
            {canEdit && editing === k.provider && (
              <form className="provider-key-form" onSubmit={(e) => { e.preventDefault(); if (!draft.trim()) return; void act(() => json(`/api/org/provider-keys/${k.provider}`, { method: 'PUT', body: JSON.stringify({ key: draft }) }), `${k.label} key saved and verified.`).then(() => { setEditing(null); setDraft('') }) }}>
                <input type="password" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={`Paste the ${k.label} API key`} autoFocus autoComplete="off" />
                <button type="submit" className="primary-button" disabled={busy || !draft.trim()}>{busy ? 'Verifying…' : 'Save'}</button>
                <button type="button" className="ghost-button" disabled={busy} onClick={() => { setEditing(null); setDraft('') }}>Cancel</button>
                <a className="text-subtle" href={k.consoleUrl} target="_blank" rel="noreferrer">Get a key ↗</a>
              </form>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * OpenRouter routes every request itself, so three tier cards would all read
 * "openrouter/auto". The choice that actually exists is automatic or naming
 * models yourself, so that is all this shows.
 */
function OpenRouterRouting({ routing, canEdit, busy, onSave }: {
  routing: Routing
  canEdit: boolean
  busy: boolean
  onSave: (patch: Partial<Routing['policy']>) => Promise<void>
}) {
  const overrides = routing.policy.overrides
  const pinned = (['small', 'medium', 'large'] as Tier[]).filter((t) => overrides[t]?.trim())
  const [manual, setManual] = useState(pinned.length > 0)
  const [draft, setDraft] = useState<Record<Tier, string>>({
    small: overrides.small ?? '',
    medium: overrides.medium ?? '',
    large: overrides.large ?? '',
  })

  const choose = async (next: boolean) => {
    setManual(next)
    if (!next && pinned.length > 0) {
      setDraft({ small: '', medium: '', large: '' })
      await onSave({ overrides: {} })
    }
  }

  return (
    <div className="routing-openrouter">
      <div className="segmented" role="tablist">
        <button type="button" role="tab" aria-selected={!manual} className={!manual ? 'active' : ''} disabled={busy || !canEdit} onClick={() => void choose(false)}>Automatic</button>
        <button type="button" role="tab" aria-selected={manual} className={manual ? 'active' : ''} disabled={busy || !canEdit} onClick={() => void choose(true)}>Chosen by me</button>
      </div>
      {!manual ? (
        <p className="panel-subtitle" style={{ marginTop: 10 }}>OpenRouter picks the model for every request from its own catalog, balancing price and availability. Nothing to tune.</p>
      ) : (
        <>
          <p className="panel-subtitle" style={{ marginTop: 10 }}>Name the model for each size. Leave one empty to let OpenRouter pick it.</p>
          <form
            className="openrouter-pins"
            onSubmit={(e) => {
              e.preventDefault()
              const next: Partial<Record<Tier, string>> = {}
              for (const tier of ['small', 'medium', 'large'] as Tier[]) {
                const value = draft[tier].trim()
                if (value) next[tier] = value
              }
              void onSave({ overrides: next })
            }}
          >
            {(['small', 'medium', 'large'] as Tier[]).map((tier) => (
              <label key={tier}>
                <span className="stat-label">{tier}</span>
                <input
                  value={draft[tier]}
                  disabled={busy || !canEdit}
                  onChange={(e) => setDraft({ ...draft, [tier]: e.target.value })}
                  placeholder="openrouter/anthropic/claude-sonnet-5"
                  autoComplete="off"
                  spellCheck={false}
                />
                <span className="text-subtle">{TIER_HINT[tier]}</span>
              </label>
            ))}
            {canEdit && <button type="submit" className="primary-button" disabled={busy}>{busy ? 'Saving…' : 'Save models'}</button>}
          </form>
        </>
      )}
    </div>
  )
}

export function ModelsSection({ canEdit }: { canEdit: boolean }) {
  const [routing, setRouting] = useState<Routing | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')

  const load = useCallback(async (refresh = false) => {
    try { setRouting(await json<Routing>(`/api/org/models${refresh ? '?refresh=1' : ''}`)) } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [])
  useEffect(() => { void load() }, [load])

  const save = async (patch: Partial<Routing['policy']>) => {
    setBusy(true); setError('')
    try {
      setRouting(await json<Routing>('/api/org/models', { method: 'PUT', body: JSON.stringify(patch) }))
      setNotice('Routing updated.'); window.setTimeout(() => setNotice(''), 2500)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  if (!routing) return <section className="card panel team-section">{error ? <p className="panel-subtitle">{error}</p> : <LoadingBlock label="Loading model routing…" />}</section>
  const { policy } = routing
  const keysCard = <ProviderKeysCard canEdit={canEdit} onChanged={() => load(true)} />
  const isOpenRouter = routing.provider === 'openrouter'
  const money = (n: number) => `$${n < 1 ? n.toFixed(2) : n.toFixed(n < 10 ? 1 : 0)}`

  return (
    <>
      {keysCard}
      <section className="card panel team-section">
        <div className="team-section-head">
          <h3>Model routing</h3>
          <span className="panel-subtitle">{isOpenRouter ? 'OpenRouter routes every request itself. Let it choose, or name the models you want.' : 'No model is hard-coded. For the provider in use, Spaces scores the catalog by price, generation and size, and fills three tiers.'}</span>
        </div>
        {error && <p className="error-text">{error}</p>}
        {notice && <p className="team-flash team-flash-ok">{notice}</p>}

        <div className="routing-provider">
          <span className="text-subtle">Routing through</span>
          <strong>{routing.provider ? PROVIDER_LABEL[routing.provider] : 'no provider — add a key above'}</strong>
          {routing.configuredProviders.length > 1 && <span className="text-subtle">· keys present for {routing.configuredProviders.map((p) => PROVIDER_LABEL[p]).join(', ')}</span>}
          <button type="button" className="ghost-button" style={{ marginLeft: 'auto' }} disabled={busy} onClick={() => void load(true)}>Recompute</button>
        </div>

        {isOpenRouter ? (
          <OpenRouterRouting routing={routing} canEdit={canEdit} busy={busy} onSave={save} />
        ) : (
        <div className="tier-grid">
          {(['small', 'medium', 'large'] as Tier[]).map((tier) => (
            <div key={tier} className={`tier-card ${tier}`}>
              <div className="tier-name">{tier}</div>
              <code className="tier-model">{routing.tiers[tier] || '—'}</code>
              <div className="tier-reason">{routing.reasons[tier]}</div>
              <div className="tier-hint">{TIER_HINT[tier]}</div>
              {canEdit && !isOpenRouter && (
                <select className="tier-pin" value={policy.overrides[tier] ?? ''} disabled={busy} onChange={(e) => void save({ overrides: { ...policy.overrides, [tier]: e.target.value || undefined } })} title="Pin a specific model for this tier, or leave automatic">
                  <option value="">automatic</option>
                  {routing.candidates.map((c) => <option key={c.spec} value={c.spec}>{c.name} · {money(c.inputCost)}/{money(c.outputCost)} per M</option>)}
                </select>
              )}
            </div>
          ))}
        </div>
        )}
      </section>

      {canEdit && (
        <section className="card panel team-section">
          <div className="team-section-head">
            <h3>Policy</h3>
            <span className="panel-subtitle">Applies to every team and project. Templates and projects never need to name a model.</span>
          </div>
          <div className="policy-grid">
            <div className="policy-field">
              <span className="stat-label">Preference</span>
              <div className="segmented" role="tablist">
                {(['cost', 'balanced', 'quality'] as const).map((p) => (
                  <button key={p} type="button" role="tab" aria-selected={policy.preference === p} className={policy.preference === p ? 'active' : ''} disabled={busy} onClick={() => void save({ preference: p })}>{p}</button>
                ))}
              </div>
              <span className="text-subtle">cost: cheapest viable everywhere · balanced: cheap small, mid medium, best large · quality: pushes every tier up</span>
            </div>
            <div className="policy-field">
              <span className="stat-label">Provider order</span>
              <ol className="provider-order">
                {policy.providerOrder.map((p, i) => (
                  <li key={p} className={routing.configuredProviders.includes(p) ? '' : 'missing'}>
                    <span>{PROVIDER_LABEL[p]}{routing.configuredProviders.includes(p) ? '' : ' · no key'}</span>
                    <span className="provider-order-actions">
                      <button type="button" className="ghost-button" disabled={busy || i === 0} onClick={() => { const next = [...policy.providerOrder]; [next[i - 1], next[i]] = [next[i]!, next[i - 1]!]; void save({ providerOrder: next }) }} aria-label={`Move ${p} up`}>▲</button>
                      <button type="button" className="ghost-button" disabled={busy || i === policy.providerOrder.length - 1} onClick={() => { const next = [...policy.providerOrder]; [next[i + 1], next[i]] = [next[i]!, next[i + 1]!]; void save({ providerOrder: next }) }} aria-label={`Move ${p} down`}>▼</button>
                    </span>
                  </li>
                ))}
              </ol>
              <span className="text-subtle">The first provider with a key routes. OpenRouter, when first, routes every request itself.</span>
            </div>
            <div className="policy-field">
              <span className="stat-label">Premium models</span>
              <label className="policy-toggle">
                <input type="checkbox" checked={policy.allowPremium} disabled={busy} onChange={(e) => void save({ allowPremium: e.target.checked })} />
                Let the large tier use premium models (“pro” variants: slower and several times the price)
              </label>
            </div>
          </div>
        </section>
      )}

      {!isOpenRouter && routing.candidates.length > 0 && (
        <section className="card panel team-section">
          <div className="team-section-head">
            <h3>Candidates</h3>
            <span className="panel-subtitle">Current-generation chat models of the routing provider, cheapest first. Prices per million tokens.</span>
          </div>
          <div className="ks-list" role="table">
            <div className="cand-row cand-head" role="row"><span>Model</span><span>Input</span><span>Output</span><span>Context</span><span>Speed</span><span>Capability</span><span>Role</span></div>
            {[...routing.candidates].sort((a, b) => a.blendedCost - b.blendedCost).map((c) => (
              <div key={c.spec} className={`cand-row ${c.role ? 'chosen' : ''}`} role="row">
                <span className="cand-name"><strong>{c.name}</strong><span className="text-subtle">{c.spec}{c.premium ? ' · premium' : ''}{c.reasoning ? ' · reasoning' : ''}</span></span>
                <span>{money(c.inputCost)}</span>
                <span>{money(c.outputCost)}</span>
                <span>{Math.round(c.contextWindow / 1000)}k</span>
                <span><Meter value={c.speedScore} /></span>
                <span><Meter value={c.qualityScore} /></span>
                <span>{c.role ? <span className={`mini-badge ${c.role === 'large' ? 'completed' : c.role === 'medium' ? 'running' : 'idle'}`}>{c.role}</span> : ''}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  )
}

function Meter({ value }: { value: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100)
  return <span className="meter" title={`${pct}%`}><span style={{ width: `${pct}%` }} /></span>
}
