import { useCallback, useEffect, useState } from 'react'
import { json } from './auth'

/**
 * "No repository matched — create one" card, shown by discovery when neither
 * the registered repositories nor the GitHub catalog fit the project.
 *
 * Spaces does not create repositories (that needs the GitHub App's
 * Administration permission, which it does not ask for). The card opens
 * GitHub's new-repository page prefilled with the proposal; when the person
 * comes back to this tab it looks the repository up among the ones the
 * connected account can see and offers it — or the most recently updated
 * ones — to attach.
 */

export interface NewRepositoryProposal {
  name: string
  owner?: string
  description: string
  reason: string
  visibility: 'private' | 'public'
  language?: string
}

interface GitHubRepoSummary { fullName: string; name: string; owner: string; updatedAt?: string; private: boolean }

export function newRepoUrl(p: Pick<NewRepositoryProposal, 'name' | 'owner' | 'description' | 'visibility'>): string {
  const params = new URLSearchParams({ name: p.name, description: p.description.slice(0, 350), visibility: p.visibility })
  if (p.owner) params.set('owner', p.owner)
  return `https://github.com/new?${params.toString()}`
}

export function NewRepoCard({ projectId, proposal, compact = false, onAttached }: {
  projectId: string
  proposal: NewRepositoryProposal
  compact?: boolean
  onAttached: (fullName: string) => void | Promise<void>
}) {
  const [owner, setOwner] = useState(proposal.owner ?? '')
  const [name, setName] = useState(proposal.name)
  const [visibility, setVisibility] = useState<'private' | 'public'>(proposal.visibility)
  const [waiting, setWaiting] = useState(false)
  const [looking, setLooking] = useState(false)
  const [candidates, setCandidates] = useState<GitHubRepoSummary[] | null>(null)
  const [selected, setSelected] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const wanted = `${owner ? `${owner}/` : ''}${name}`.toLowerCase()
  const createUrl = newRepoUrl({ name, owner: owner || undefined, description: proposal.description, visibility })

  /** The repositories the connected account can see, the one just created first. */
  const lookUp = useCallback(async () => {
    setLooking(true); setNote('')
    try {
      const { repos } = await json<{ repos: GitHubRepoSummary[] }>('/api/github/repos')
      // Without an owner, a name alone is only a match when exactly one visible repository has it.
      const byName = owner ? [] : repos.filter((r) => r.name.toLowerCase() === name.toLowerCase())
      const match = repos.find((r) => r.fullName.toLowerCase() === wanted) ?? (byName.length === 1 ? byName[0] : undefined)
      const recent = repos.filter((r) => r !== match).slice(0, 20)
      setCandidates(match ? [match, ...recent] : recent)
      setSelected((current) => current || match?.fullName || '')
      if (!match) setNote(`${wanted} is not visible yet. GitHub can take a moment; if the Spaces GitHub App is installed on selected repositories only, add the new one to the installation on GitHub. Or pick another repository below.`)
    } catch (error) {
      setNote(`Could not list GitHub repositories: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setLooking(false)
    }
  }, [wanted, owner, name])

  // Results belong to the owner and name they were looked up for: editing either starts over.
  useEffect(() => {
    setCandidates(null)
    setSelected('')
  }, [owner, name])

  // Back from GitHub: look the new repository up as soon as this tab has focus again.
  useEffect(() => {
    if (!waiting) return
    const onFocus = () => { if (document.visibilityState === 'visible') void lookUp() }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => { window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onFocus) }
  }, [waiting, lookUp])

  const attach = async () => {
    if (!selected) return
    setBusy(true); setNote('')
    try {
      await json(`/api/projects/${projectId}/repos`, {
        method: 'POST',
        body: JSON.stringify({ label: selected.split('/').pop() ?? selected, kind: 'github', githubRepo: selected, primaryIfFirst: true }),
      })
      await onAttached(selected)
    } catch (error) {
      setNote(`Could not attach ${selected}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`new-repo-card ${compact ? 'compact' : ''}`}>
      <div className="new-repo-head">
        <span className="new-repo-badge">No repository matched</span>
        <strong>Create a repository for this project on GitHub, then select it here</strong>
        <span className="text-subtle">{proposal.reason}</span>
      </div>
      <div className="new-repo-fields">
        <label>Owner<input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="account or organization" autoComplete="off" /></label>
        <label>Name<input value={name} onChange={(e) => setName(e.target.value.trim())} autoComplete="off" /></label>
        <label>Visibility
          <select value={visibility} onChange={(e) => setVisibility(e.target.value as 'private' | 'public')}>
            <option value="private">private</option>
            <option value="public">public</option>
          </select>
        </label>
      </div>
      <p className="new-repo-desc"><code>{owner || '…'}/{name}</code> — {proposal.description}{proposal.language ? <span className="text-subtle"> · {proposal.language}</span> : null}</p>
      <div className="button-row">
        <a className="primary-button" href={createUrl} target="_blank" rel="noreferrer" onClick={() => setWaiting(true)}>Create on GitHub ↗</a>
        <button type="button" className="secondary-button" disabled={looking} onClick={() => { setWaiting(true); void lookUp() }}>{looking ? 'Looking…' : candidates ? 'Look again' : 'I created it — select it'}</button>
      </div>
      {waiting && !candidates && !looking && (
        <p className="new-repo-note">Create <code>{owner || '…'}/{name}</code> on GitHub (the form is prefilled), then come back to this tab: Spaces looks it up and offers it to attach.</p>
      )}
      {candidates && (
        <div className="button-row new-repo-pick">
          <select value={selected} onChange={(e) => setSelected(e.target.value)} aria-label="Repository to attach">
            <option value="">Select a repository…</option>
            {candidates.map((r) => <option key={r.fullName} value={r.fullName}>{r.fullName}{r.fullName.toLowerCase() === wanted ? ' (new)' : ''}</option>)}
          </select>
          <button type="button" className="primary-button" disabled={busy || !selected} onClick={() => void attach()}>{busy ? 'Attaching…' : 'Attach'}</button>
        </div>
      )}
      {note && <p className="new-repo-note">{note}</p>}
    </div>
  )
}
