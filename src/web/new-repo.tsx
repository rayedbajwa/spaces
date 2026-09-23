import { useState } from 'react'

/**
 * "No repository matched — create one" card, shown by discovery when neither
 * the registered repositories nor the GitHub catalog fit the project. Creates
 * the repository through the connected GitHub account and attaches it, or
 * hands the user a prefilled GitHub page when the token may not create repos.
 */

export interface NewRepositoryProposal {
  name: string
  owner?: string
  description: string
  reason: string
  visibility: 'private' | 'public'
  language?: string
}

export function newRepoUrl(p: Pick<NewRepositoryProposal, 'name' | 'owner' | 'description' | 'visibility'>): string {
  const params = new URLSearchParams({ name: p.name, description: p.description.slice(0, 350), visibility: p.visibility })
  if (p.owner) params.set('owner', p.owner)
  return `https://github.com/new?${params.toString()}`
}

export function NewRepoCard({ projectId, proposal, compact = false, onCreated, onAttachExisting }: {
  projectId: string
  proposal: NewRepositoryProposal
  compact?: boolean
  onCreated: (fullName: string) => void | Promise<void>
  /** Opens the "add existing repository" form, prefilled with the proposed name. */
  onAttachExisting?: (fullName: string) => void
}) {
  const [name, setName] = useState(proposal.name)
  const [owner, setOwner] = useState(proposal.owner ?? '')
  const [visibility, setVisibility] = useState<'private' | 'public'>(proposal.visibility)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ text: string; manualUrl?: string; permissionsUrl?: string; installationUrl?: string } | null>(null)
  const fullName = `${owner || '…'}/${name}`

  const create = async () => {
    setBusy(true); setNote(null)
    try {
      const response = await fetch(`/api/projects/${projectId}/repos/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, owner: owner || undefined, description: proposal.description, visibility }),
      })
      const data = (await response.json().catch(() => ({}))) as { fullName?: string; error?: string; permissionsUrl?: string; installationUrl?: string }
      if (!response.ok) {
        // A missing GitHub App permission comes with the pages to fix it on.
        setNote({ text: data.error ?? `${response.status}`, manualUrl: newRepoUrl({ name, owner: owner || undefined, description: proposal.description, visibility }), permissionsUrl: data.permissionsUrl, installationUrl: data.installationUrl })
        return
      }
      await onCreated(data.fullName!)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setNote({ text: message, manualUrl: newRepoUrl({ name, owner: owner || undefined, description: proposal.description, visibility }) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`new-repo-card ${compact ? 'compact' : ''}`}>
      <div className="new-repo-head">
        <span className="new-repo-badge">No repository matched</span>
        <strong>Create a repository for this project</strong>
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
      <p className="new-repo-desc"><code>{fullName}</code> — {proposal.description}{proposal.language ? <span className="text-subtle"> · {proposal.language}</span> : null}</p>
      <div className="button-row">
        <button type="button" className="primary-button" disabled={busy || !name} onClick={() => void create()}>{busy ? 'Creating…' : 'Create on GitHub & attach'}</button>
        <a className="secondary-button" href={newRepoUrl({ name, owner: owner || undefined, description: proposal.description, visibility })} target="_blank" rel="noreferrer">Create manually ↗</a>
        {onAttachExisting && <button type="button" className="ghost-button" onClick={() => onAttachExisting(owner ? `${owner}/${name}` : name)}>I already created it — attach</button>}
      </div>
      {note && (
        <p className="new-repo-note">
          {note.text}
          {note.permissionsUrl && <> <a href={note.permissionsUrl} target="_blank" rel="noreferrer">Open the app's permissions ↗</a>{note.installationUrl && <>, then <a href={note.installationUrl} target="_blank" rel="noreferrer">accept it on the installation ↗</a></>}. Or</>}
          {note.manualUrl && <> <a href={note.manualUrl} target="_blank" rel="noreferrer">{note.permissionsUrl ? 'create it on GitHub' : 'Create it on GitHub'}</a>, then attach it here.</>}
        </p>
      )}
    </div>
  )
}
