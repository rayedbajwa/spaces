import { useCallback, useEffect, useState } from 'react'
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

  if (!routing) return <section className="card panel team-section"><p className="panel-subtitle">{error || 'Loading…'}</p></section>
  const { policy } = routing
  const isOpenRouter = routing.provider === 'openrouter'
  const money = (n: number) => `$${n < 1 ? n.toFixed(2) : n.toFixed(n < 10 ? 1 : 0)}`

  return (
    <>
      <section className="card panel team-section">
        <div className="team-section-head">
          <h3>Model routing</h3>
          <span className="panel-subtitle">No model is hard-coded. For the provider in use, Spaces scores the catalog by price, generation and size, and fills three tiers.</span>
        </div>
        {error && <p className="error-text">{error}</p>}
        {notice && <p className="team-flash team-flash-ok">{notice}</p>}

        <div className="routing-provider">
          <span className="text-subtle">Routing through</span>
          <strong>{routing.provider ? PROVIDER_LABEL[routing.provider] : 'no provider'}</strong>
          {routing.configuredProviders.length > 1 && <span className="text-subtle">· keys present for {routing.configuredProviders.map((p) => PROVIDER_LABEL[p]).join(', ')}</span>}
          <button type="button" className="ghost-button" style={{ marginLeft: 'auto' }} disabled={busy} onClick={() => void load(true)}>Recompute</button>
        </div>

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

        {isOpenRouter && <p className="panel-subtitle" style={{ marginTop: 10 }}>OpenRouter chooses the model for every request from its own catalog. Nothing else to tune here; switch the provider order below to route yourself.</p>}
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
