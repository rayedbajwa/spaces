import { useState } from 'react'
import { json } from './auth'

const TEAM_SIZES = ['1', '2-10', '11-50', '51-200', '200+']

/**
 * The landing page's waitlist form, while registration is by invitation.
 * The answer is the same for a new email and one already on the list.
 */
export function WaitlistForm() {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [company, setCompany] = useState('')
  const [teamSize, setTeamSize] = useState('')
  const [website, setWebsite] = useState('') // never shown; bots fill it in
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [joined, setJoined] = useState(false)

  async function submit() {
    setBusy(true)
    setError('')
    try {
      await json('/api/waitlist', { method: 'POST', body: JSON.stringify({ email, name, company, teamSize: teamSize || undefined, website }) })
      setJoined(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (joined) {
    return (
      <div className="waitlist-done" role="status">
        <strong>You're on the list.</strong>
        <span>We're letting teams in in small batches; your join link will come to <strong>{email}</strong>.</span>
      </div>
    )
  }

  return (
    <form className="waitlist-form" onSubmit={(e) => { e.preventDefault(); void submit() }}>
      <div className="waitlist-row">
        <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" autoComplete="email" aria-label="Work email" />
        <button type="submit" className="primary-button" disabled={busy}>{busy ? 'Joining…' : 'Join the waitlist'}</button>
      </div>
      <div className="waitlist-row waitlist-optional">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" autoComplete="name" aria-label="Name" maxLength={120} />
        <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Company (optional)" autoComplete="organization" aria-label="Company" maxLength={120} />
        <select value={teamSize} onChange={(e) => setTeamSize(e.target.value)} aria-label="Team size">
          <option value="">Team size</option>
          {TEAM_SIZES.map((size) => <option key={size} value={size}>{size === '1' ? 'Just me' : `${size} people`}</option>)}
        </select>
      </div>
      <input className="waitlist-trap" tabIndex={-1} autoComplete="off" aria-hidden="true" value={website} onChange={(e) => setWebsite(e.target.value)} name="website" />
      {error && <p className="error-text">{error}</p>}
    </form>
  )
}
