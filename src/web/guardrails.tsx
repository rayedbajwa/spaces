import { useEffect, useState } from 'react'
import { json } from './auth'
import { LoadingBlock } from './loading'

/**
 * Organization → Data guardrails: how secrets and personal data are kept from
 * AI models (lib/guardrails.ts). Owners and admins choose the mode and the
 * values that are never masked; everyone can see the setting.
 */

type Mode = 'off' | 'warn' | 'mask' | 'strict'
interface Policy { mode: Mode; allow: string[] }

const MODES: Array<{ id: Mode; label: string; description: string }> = [
  { id: 'mask', label: 'Mask (recommended)', description: 'Secrets (keys, tokens, passwords, connection strings) and personal data (emails, phone numbers, SSNs, card numbers, IBANs) are replaced with tokens like <EMAIL_1> before anything reaches the model. Agents still work: real values are put back when they run a command or write a file. Logs, Slack posts and pull requests show the tokens or [redacted].' },
  { id: 'strict', label: 'Strict', description: 'Everything Mask does, and agents may not read secret files (.env, private keys, credentials) or print the environment; they refer to variables by name instead.' },
  { id: 'warn', label: 'Warn only', description: 'Nothing is changed; each stage\'s log says how many secrets and pieces of personal data were sent to the model. Secrets are still masked in logs.' },
  { id: 'off', label: 'Off', description: 'No guardrails. Secrets are still masked in run logs.' },
]

export function GuardrailsSection({ canEdit }: { canEdit: boolean }) {
  const [policy, setPolicy] = useState<Policy | null>(null)
  const [mode, setMode] = useState<Mode>('mask')
  const [allow, setAllow] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null)

  useEffect(() => {
    json<{ policy: Policy }>('/api/org/guardrails')
      .then(({ policy }) => { setPolicy(policy); setMode(policy.mode); setAllow(policy.allow.join('\n')) })
      .catch((e) => setMessage({ text: e instanceof Error ? e.message : String(e), error: true }))
  }, [])

  if (!policy) return message ? <p className="error-text">{message.text}</p> : <LoadingBlock label="Loading the guardrails…" />

  const allowList = allow.split('\n').map((a) => a.trim()).filter(Boolean)
  const dirty = mode !== policy.mode || allowList.join('\n') !== policy.allow.join('\n')

  const save = async () => {
    setBusy(true); setMessage(null)
    try {
      const { policy: saved } = await json<{ policy: Policy }>('/api/org/guardrails', { method: 'PUT', body: JSON.stringify({ mode, allow: allowList }) })
      setPolicy(saved); setMode(saved.mode); setAllow(saved.allow.join('\n'))
      setMessage({ text: 'Guardrails saved. New agent sessions use them right away.' })
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : String(e), error: true })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card panel team-section guardrails-section">
      <div className="team-section-head"><h3>What AI models may see</h3></div>
      <div className="guardrail-modes" role="radiogroup" aria-label="Guardrail mode">
        {MODES.map((m) => (
          <label key={m.id} className={`guardrail-mode${mode === m.id ? ' selected' : ''}${!canEdit ? ' readonly' : ''}`}>
            <input type="radio" name="guardrail-mode" value={m.id} checked={mode === m.id} disabled={!canEdit || busy} onChange={() => setMode(m.id)} />
            <span>
              <strong>{m.label}</strong>
              <span className="panel-subtitle">{m.description}</span>
            </span>
          </label>
        ))}
      </div>
      <label className="field-hint guardrail-allow">
        Never mask (one per line): exact values, or /patterns/ — for example a public support address
        <textarea value={allow} onChange={(e) => setAllow(e.target.value)} rows={4} disabled={!canEdit || busy} placeholder={'support@acme.io\n/@acme-test\\.com$/'} />
      </label>
      {canEdit
        ? <div className="button-row"><button type="button" className="primary-button" disabled={busy || !dirty} onClick={() => void save()}>{busy ? 'Saving…' : dirty ? 'Save guardrails' : 'Saved'}</button></div>
        : <p className="panel-subtitle">Only team owners or admins can change the guardrails.</p>}
      {message && <p className={message.error ? 'error-text' : 'team-flash team-flash-ok'}>{message.text}</p>}
    </section>
  )
}
