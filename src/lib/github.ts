import { execFile } from 'node:child_process'
import { access, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { getAppIntegration } from './app-integrations'
import { getIntegrationAccessToken } from './integration-token'
import { updateRepoClone, type RepoRow } from './project-registry'

const execFileAsync = promisify(execFile)

export interface GitHubRepoSummary {
  fullName: string
  name: string
  owner: string
  description?: string
  private: boolean
  defaultBranch?: string
  updatedAt?: string
  htmlUrl: string
}

export class GitHubNotConnectedError extends Error {
  constructor() {
    super('GitHub is not connected. Connect it under Integrations first.')
    this.name = 'GitHubNotConnectedError'
  }
}

/**
 * Root directory where GitHub repos are cloned. Override with
 * AIDLC_WORKSPACE_ROOT; defaults to ~/.aidlc/workspaces/<owner>/<name>.
 */
export function workspaceRoot(): string {
  const configured = process.env.AIDLC_WORKSPACE_ROOT?.trim()
  return configured ? path.resolve(configured) : path.join(homedir(), '.aidlc', 'workspaces')
}

export function clonePathFor(fullName: string): string {
  const [owner, name] = splitFullName(fullName)
  return path.join(workspaceRoot(), owner, name)
}

function splitFullName(fullName: string): [string, string] {
  const trimmed = fullName.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '')
  const parts = trimmed.split('/')
  if (parts.length !== 2 || !parts[0] || !parts[1] || parts.some((p) => p === '.' || p === '..')) {
    throw new Error(`Invalid GitHub repo "${fullName}"; expected owner/name.`)
  }
  return [parts[0], parts[1]]
}

export async function getGitHubToken(): Promise<string> {
  const integration = await getAppIntegration('github')
  if (!integration || integration.status !== 'connected') throw new GitHubNotConnectedError()
  // Refreshes GitHub App user tokens (8h lifetime) before they expire; throws
  // IntegrationCredentialsError when the stored token cannot be read, so a
  // changed ENCRYPTION_KEY is named instead of a vague "not connected".
  return getIntegrationAccessToken('github')
}

async function githubGet<T>(token: string, url: string): Promise<{ data: T; next?: string }> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'pi-speckit-pdlc',
    },
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`GitHub API ${response.status} for ${url}: ${body.slice(0, 300)}`)
  }
  const link = response.headers.get('link') ?? ''
  const next = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1]
  return { data: (await response.json()) as T, next }
}

interface GitHubApiRepo {
  full_name: string
  name: string
  owner: { login: string }
  description: string | null
  private: boolean
  default_branch?: string
  updated_at?: string
  html_url: string
}

/**
 * Repos the connected account can push to (owned, collaborator, org member),
 * most recently updated first. Paginates up to `maxPages` × 100.
 */
export async function listGitHubRepos(options: { maxPages?: number } = {}): Promise<GitHubRepoSummary[]> {
  const token = await getGitHubToken()
  const maxPages = options.maxPages ?? 5
  const repos: GitHubRepoSummary[] = []
  let url: string | undefined = 'https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member'
  for (let page = 0; url && page < maxPages; page += 1) {
    const { data, next }: { data: GitHubApiRepo[]; next?: string } = await githubGet<GitHubApiRepo[]>(token, url)
    for (const repo of data) {
      repos.push({
        fullName: repo.full_name,
        name: repo.name,
        owner: repo.owner.login,
        description: repo.description ?? undefined,
        private: repo.private,
        defaultBranch: repo.default_branch,
        updatedAt: repo.updated_at,
        htmlUrl: repo.html_url,
      })
    }
    url = next
  }
  return repos
}

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await access(path.join(dir, '.git'))
    return true
  } catch {
    return false
  }
}

/**
 * Clone (or refresh) a GitHub repo into the workspace and return its local path.
 * The token is passed as an HTTP header for the single git invocation only, so it
 * is never written into the clone's .git/config.
 */
export async function cloneGitHubRepo(fullName: string): Promise<string> {
  const [owner, name] = splitFullName(fullName)
  const token = await getGitHubToken()
  const target = path.join(workspaceRoot(), owner, name)
  await mkdir(path.dirname(target), { recursive: true })

  const authHeader = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  const remote = `https://github.com/${owner}/${name}.git`

  if (await isGitRepo(target)) {
    // Already cloned: bring it up to date but never clobber local work.
    await execFileAsync('git', ['-c', `http.extraheader=${authHeader}`, 'fetch', '--all', '--prune'], { cwd: target, env, timeout: 10 * 60_000 })
    return target
  }

  await execFileAsync('git', ['-c', `http.extraheader=${authHeader}`, 'clone', remote, target], { env, timeout: 30 * 60_000, maxBuffer: 16 * 1024 * 1024 })
  return target
}

const inFlight = new Map<string, Promise<void>>()

/**
 * Fire-and-forget clone for a registered GitHub repo, recording progress on the
 * repo row so the UI and run routes can see it. Concurrent calls for the same
 * repo share one clone.
 */
export function scheduleRepoClone(repo: RepoRow): Promise<void> {
  if (repo.kind !== 'github' || !repo.githubRepo) return Promise.resolve()
  const existing = inFlight.get(repo.repoId)
  if (existing) return existing

  const job = (async () => {
    await updateRepoClone(repo.repoId, { cloneStatus: 'cloning', cloneError: null })
    try {
      const localPath = await cloneGitHubRepo(repo.githubRepo!)
      await updateRepoClone(repo.repoId, { cloneStatus: 'ready', cloneError: null, localPath })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await updateRepoClone(repo.repoId, { cloneStatus: 'error', cloneError: message.slice(0, 1000) })
    } finally {
      inFlight.delete(repo.repoId)
    }
  })()
  inFlight.set(repo.repoId, job)
  return job
}
