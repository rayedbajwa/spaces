/**
 * Proposing a new repository when discovery finds nothing to match.
 *
 * Pure helpers shared by the suggestion engine (server) and tests: a GitHub
 * safe name derived from the project, and the prefilled "new repository" link
 * for the manual path when the connected token may not create repositories.
 */

export interface NewRepositoryProposal {
  /** Repository name (GitHub rules: letters, digits, `-`, `_`, `.`; ≤ 100 chars). */
  name: string
  /** Account or organization to create it under; the connected GitHub login when known. */
  owner?: string
  description: string
  /** Why discovery proposes a new repository instead of an existing one. */
  reason: string
  visibility: 'private' | 'public'
  /** Suggested primary language / stack, for the README and templates. */
  language?: string
}

/** Lower-case, GitHub-safe repository name from any text. Returns "" when nothing usable remains. */
export function sanitizeRepoName(input: string): string {
  const name = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 100)
    .replace(/[-._]+$/g, '')
  if (!name || name === '.' || name === '..' || /^\.git$/i.test(name)) return ''
  return name
}

/** Default proposal when the model offers none: named after the project, private, described by its summary. */
export function proposeRepository(project: { name: string; slug: string; code?: string | null; description?: string | null }, owner?: string): NewRepositoryProposal {
  const fromName = sanitizeRepoName(project.name)
  const name = fromName || sanitizeRepoName(project.slug) || sanitizeRepoName(project.code ?? '') || 'new-project'
  const description = (project.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 350) || `Code for the ${project.name} project.`
  return {
    name,
    owner,
    description,
    reason: 'No registered repository and nothing in the GitHub catalog matched this project, so the work needs a home before implementation.',
    visibility: 'private',
  }
}

/** GitHub's "create a new repository" page, prefilled (owner, name, description, visibility). */
export function newRepoUrl(proposal: Pick<NewRepositoryProposal, 'name' | 'owner' | 'description' | 'visibility'>): string {
  const params = new URLSearchParams({ name: proposal.name, description: proposal.description.slice(0, 350), visibility: proposal.visibility })
  if (proposal.owner) params.set('owner', proposal.owner)
  return `https://github.com/new?${params.toString()}`
}

/** Validate and normalize a model-produced proposal; undefined when unusable. */
export function normalizeProposal(raw: unknown, fallbackOwner?: string): NewRepositoryProposal | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const name = typeof r.name === 'string' ? sanitizeRepoName(r.name) : ''
  if (!name) return undefined
  const owner = typeof r.owner === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(r.owner.trim()) ? r.owner.trim() : fallbackOwner
  return {
    name,
    owner,
    description: typeof r.description === 'string' ? r.description.trim().slice(0, 350) : '',
    reason: typeof r.reason === 'string' ? r.reason.trim() : 'Discovery found no existing repository for this work.',
    visibility: r.visibility === 'public' ? 'public' : 'private',
    language: typeof r.language === 'string' && r.language.trim() ? r.language.trim() : undefined,
  }
}
