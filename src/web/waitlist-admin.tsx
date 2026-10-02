import { useCallback, useEffect, useState } from 'react'
import { json } from './auth'
import { SkeletonRows } from './loading'

/**
 * The deployment's waitlist, for owners and admins of the default
 * organization: who asked for access, and a join link for each person let in.
 * A join link registers that email into its own new organization.
 */

interface WaitlistEntry {
  entryId: string
  email: string
  name: string | null
  company: string | null
  teamSize: string | null
  status: 'waiting' | 'invited' | 'joined'
  invitedAt: string | null
  expiresAt: string | null
  joinedAt: string | null
  createdAt: string
}

const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '')

export function WaitlistSection() {
  const [entries, setEntries] = useState<WaitlistEntry[] | null>(null)
  const [links, setLinks] = useState<Record<string, string>>({})
  const [copied, setCopied] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try { setEntries((await json<{ entries: WaitlistEntry[] }>('/api/admin/waitlist')).entries) } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [])
  useEffect(() => { void load() }, [load])

  async function invite(entry: WaitlistEntry) {
    setBusy(entry.entryId); setError('')
    try {
      const { link } = await json<{ link: string }>(`/api/admin/waitlist/${entry.entryId}/invite`, { method: 'POST', body: '{}' })
      setLinks((current) => ({ ...current, [entry.entryId]: link }))
      await copy(entry.entryId, link)
      await load()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy('') }
  }

  async function remove(entry: WaitlistEntry) {
    if (!window.confirm(`Remove ${entry.email} from the waitlist?`)) return
    setBusy(entry.entryId); setError('')
    try { await json(`/api/admin/waitlist/${entry.entryId}`, { method: 'DELETE' }); await load() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy('') }
  }

  async function copy(entryId: string, link: string) {
    try { await navigator.clipboard.writeText(link); setCopied(entryId); window.setTimeout(() => setCopied(''), 2500) } catch { /* the link stays visible to copy by hand */ }
  }

  if (entries === null) return error ? <p className="error-text">{error}</p> : <SkeletonRows count={3} label="Loading the waitlist…" />
  const waiting = entries.filter((e) => e.status === 'waiting').length
  const invited = entries.filter((e) => e.status === 'invited').length
  const joined = entries.filter((e) => e.status === 'joined').length

  return (
    <section className="card panel team-section">
      <div className="team-section-head">
        <h3>Waitlist</h3>
        <span className="panel-subtitle">{waiting} waiting · {invited} invited · {joined} joined</span>
      </div>
      <p className="panel-subtitle">
        People who asked for access on the landing page. <strong>Invite</strong> makes a join link for that email (valid 14 days) and copies it;
        send it to them yourself. Registering through it starts their own organization.
      </p>
      {error && <p className="error-text">{error}</p>}
      {entries.length === 0 && <p className="empty-state">Nobody on the waitlist yet.</p>}
      {entries.length > 0 && (
        <div className="table-wrap">
          <table className="project-table waitlist-table">
            <thead><tr><th>Who</th><th>Team size</th><th>Signed up</th><th>Status</th><th /></tr></thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.entryId}>
                  <td>
                    <strong>{entry.name || entry.email}</strong>
                    <div className="text-subtle">{[entry.name ? entry.email : null, entry.company].filter(Boolean).join(' · ')}</div>
                    {links[entry.entryId] && (
                      <div className="waitlist-link">
                        <code>{links[entry.entryId]}</code>
                        <button type="button" className="ghost-button small-button" onClick={() => void copy(entry.entryId, links[entry.entryId]!)}>{copied === entry.entryId ? 'Copied' : 'Copy'}</button>
                      </div>
                    )}
                  </td>
                  <td>{entry.teamSize ?? <span className="text-subtle">—</span>}</td>
                  <td>{date(entry.createdAt)}</td>
                  <td>
                    <span className={`mini-badge ${entry.status === 'joined' ? 'completed' : entry.status === 'invited' ? 'running' : 'idle'}`}>{entry.status}</span>
                    {entry.status === 'invited' && entry.expiresAt && <div className="text-subtle">link until {date(entry.expiresAt)}</div>}
                    {entry.status === 'joined' && <div className="text-subtle">{date(entry.joinedAt)}</div>}
                  </td>
                  <td>
                    <div className="button-row waitlist-actions">
                      {entry.status !== 'joined' && (
                        <button type="button" className={entry.status === 'waiting' ? 'primary-button small-button' : 'secondary-button small-button'} disabled={busy === entry.entryId} onClick={() => void invite(entry)}>
                          {entry.status === 'waiting' ? 'Invite' : 'New link'}
                        </button>
                      )}
                      <button type="button" className="ghost-button small-button" disabled={busy === entry.entryId} onClick={() => void remove(entry)}>Remove</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
