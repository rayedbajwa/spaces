import { execFile } from 'node:child_process'
import { mkdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { getGitHubToken } from './github'

const execFileAsync = promisify(execFile)

/**
 * Pull requests for GitHub-hosted project repos.
 *
 * Two flows use this:
 *  - the single-agent `implement` → `orchestrate` → `verify` stages publish one PR
 *    from the feature branch to the repo's default branch, updating it as stages
 *    complete;
 *  - parallel workstreams each get their own branch + worktree and PR. A
 *    workstream that depends on another is branched from — and its PR targets —
 *    that workstream's branch (a stacked PR), so reviewers see only its own diff.
 *
 * The GitHub token is passed as a per-invocation HTTP header for git and never
 * written to the checkout's config.
 */

export interface PullRequestRef {
  number: number
  url: string
  head: string
  base: string
  created: boolean
}

async function git(cwd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...opts.env },
    timeout: opts.timeoutMs ?? 5 * 60_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  return stdout.trim()
}

async function authHeader(): Promise<string> {
  const token = await getGitHubToken()
  return `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
}

async function githubApi<T>(method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown): Promise<T> {
  const token = await getGitHubToken()
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'pi-speckit-pdlc',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`GitHub API ${response.status} ${method} ${url}: ${text.slice(0, 400)}`)
  }
  return (await response.json()) as T
}

// ---------------------------------------------------------------------------
// Repository facts
// ---------------------------------------------------------------------------

export async function currentBranch(cwd: string): Promise<string> {
  return git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
}

export async function defaultBranch(cwd: string, githubRepo: string): Promise<string> {
  try {
    const ref = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
    if (ref) return ref.replace(/^origin\//, '')
  } catch {
    // fall through to the API
  }
  const repo = await githubApi<{ default_branch: string }>('GET', `https://api.github.com/repos/${githubRepo}`)
  return repo.default_branch
}

export async function branchExistsLocally(cwd: string, branch: string): Promise<boolean> {
  try {
    await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
    return true
  } catch {
    return false
  }
}

export function slugForBranch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'work'
}

// ---------------------------------------------------------------------------
// Worktrees (one isolated checkout per parallel workstream)
// ---------------------------------------------------------------------------

export function worktreeRoot(repoPath: string): string {
  const configured = process.env.AIDLC_WORKTREE_ROOT?.trim()
  return configured ? path.join(path.resolve(configured), path.basename(repoPath)) : path.join(repoPath, '.aidlc-worktrees')
}

/**
 * Create (or reuse) a worktree for `branch`, creating the branch from `base`
 * when it does not exist yet. Returns the worktree path.
 */
export async function ensureWorktree(options: { repoPath: string; branch: string; base: string }): Promise<string> {
  const root = worktreeRoot(options.repoPath)
  await mkdir(root, { recursive: true })
  const dir = path.join(root, slugForBranch(options.branch))
  try {
    await stat(path.join(dir, '.git'))
    // Existing worktree: make sure it is on the right branch.
    const branch = await currentBranch(dir)
    if (branch !== options.branch) await git(dir, ['checkout', options.branch])
    return dir
  } catch {
    // not there yet
  }
  // Ignore the worktree root inside the main checkout so agents/commits never pick it up.
  await ensureIgnored(options.repoPath, '.aidlc-worktrees/')
  if (await branchExistsLocally(options.repoPath, options.branch)) {
    await git(options.repoPath, ['worktree', 'add', dir, options.branch])
  } else {
    await git(options.repoPath, ['worktree', 'add', '-b', options.branch, dir, options.base])
  }
  return dir
}

export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  try {
    await git(repoPath, ['worktree', 'remove', '--force', worktreePath])
  } catch {
    await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined)
    await git(repoPath, ['worktree', 'prune']).catch(() => undefined)
  }
}

/** Add a pattern to the repo's local exclude file (.git/info/exclude), never to the tracked .gitignore. */
export async function ensureIgnored(repoPath: string, pattern: string): Promise<void> {
  const excludePath = path.join(repoPath, '.git', 'info', 'exclude')
  try {
    const { readFile, appendFile } = await import('node:fs/promises')
    const current = await readFile(excludePath, 'utf8').catch(() => '')
    if (!current.split('\n').includes(pattern)) await appendFile(excludePath, `${current.endsWith('\n') || current === '' ? '' : '\n'}${pattern}\n`)
  } catch {
    // best effort
  }
}

// ---------------------------------------------------------------------------
// Commit, push, PR
// ---------------------------------------------------------------------------

/** Stage everything and commit. Returns false when the tree was clean. */
export async function commitAll(cwd: string, message: string): Promise<boolean> {
  await git(cwd, ['add', '-A'])
  const status = await git(cwd, ['status', '--porcelain'])
  if (!status) return false
  await git(cwd, [
    '-c', 'user.name=AIDLC Agent',
    '-c', 'user.email=aidlc-agent@users.noreply.github.com',
    'commit', '-q', '-m', message,
  ])
  return true
}

export async function pushBranch(cwd: string, branch: string): Promise<void> {
  const header = await authHeader()
  await git(cwd, ['-c', `http.extraheader=${header}`, 'push', '-u', 'origin', `${branch}:${branch}`], { timeoutMs: 10 * 60_000 })
}

export async function hasCommitsAhead(cwd: string, base: string, head: string): Promise<boolean> {
  try {
    const count = await git(cwd, ['rev-list', '--count', `${base}..${head}`])
    return Number(count) > 0
  } catch {
    return true
  }
}

interface GitHubPull {
  number: number
  html_url: string
  head: { ref: string }
  base: { ref: string }
  body?: string | null
}

export async function findOpenPullRequest(githubRepo: string, head: string): Promise<GitHubPull | undefined> {
  const owner = githubRepo.split('/')[0]
  const pulls = await githubApi<GitHubPull[]>('GET', `https://api.github.com/repos/${githubRepo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}&per_page=5`)
  return pulls[0]
}

/**
 * Open a PR from `head` into `base`, or update the existing open one for `head`
 * (title/body/base). Idempotent across stage completions.
 */
export async function openOrUpdatePullRequest(options: {
  githubRepo: string
  head: string
  base: string
  title: string
  body: string
  draft?: boolean
}): Promise<PullRequestRef> {
  const existing = await findOpenPullRequest(options.githubRepo, options.head)
  if (existing) {
    const updated = await githubApi<GitHubPull>('PATCH', `https://api.github.com/repos/${options.githubRepo}/pulls/${existing.number}`, {
      title: options.title,
      body: options.body,
      ...(existing.base.ref !== options.base ? { base: options.base } : {}),
    })
    return { number: updated.number, url: updated.html_url, head: updated.head.ref, base: updated.base.ref, created: false }
  }
  const created = await githubApi<GitHubPull>('POST', `https://api.github.com/repos/${options.githubRepo}/pulls`, {
    title: options.title,
    head: options.head,
    base: options.base,
    body: options.body,
    draft: options.draft ?? false,
  })
  return { number: created.number, url: created.html_url, head: created.head.ref, base: created.base.ref, created: true }
}

export async function commentOnPullRequest(githubRepo: string, number: number, body: string): Promise<void> {
  await githubApi('POST', `https://api.github.com/repos/${githubRepo}/issues/${number}/comments`, { body })
}

/**
 * One-shot: commit whatever the agent left in `cwd`, push the branch, and
 * open/update its PR. Returns undefined when there is nothing to publish.
 */
export async function publishBranchAsPullRequest(options: {
  cwd: string
  githubRepo: string
  branch: string
  base: string
  commitMessage: string
  title: string
  body: string
  draft?: boolean
}): Promise<PullRequestRef | undefined> {
  await commitAll(options.cwd, options.commitMessage)
  if (!(await hasCommitsAhead(options.cwd, `origin/${options.base}`, options.branch)) && !(await hasCommitsAhead(options.cwd, options.base, options.branch))) {
    return undefined
  }
  await pushBranch(options.cwd, options.branch)
  return openOrUpdatePullRequest({
    githubRepo: options.githubRepo,
    head: options.branch,
    base: options.base,
    title: options.title,
    body: options.body,
    draft: options.draft,
  })
}

/** Standard PR body footer so every PR links back to its Spec Kit artifacts. */
export function pullRequestBody(options: {
  summary: string
  featureDir?: string
  artifacts?: string[]
  stackedOn?: string
  workstream?: string
  extra?: string
}): string {
  const lines = [
    options.summary.trim(),
    '',
    options.workstream ? `**Workstream:** ${options.workstream}` : '',
    options.stackedOn ? `**Stacked on:** \`${options.stackedOn}\` — merge that PR first; this one only contains its own changes.` : '',
    options.featureDir ? `**Spec Kit feature:** \`${options.featureDir}\`` : '',
    options.artifacts?.length ? `**Artifacts:** ${options.artifacts.map((a) => `\`${a}\``).join(', ')}` : '',
    options.extra ?? '',
    '',
    '---',
    '_Opened by the AIDLC pipeline. Review the linked spec/plan/tasks for intent; the verification report records test results._',
  ]
  return lines.filter((line, i, arr) => !(line === '' && arr[i - 1] === '')).join('\n')
}
