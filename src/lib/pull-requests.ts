import { execFile } from 'node:child_process'
import { mkdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { getGitHubActorToken } from './github-app-auth'

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

async function authHeader(orgId: string): Promise<string> {
  const token = await getGitHubActorToken(orgId)
  return `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
}

async function githubApi<T>(orgId: string, method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown): Promise<T> {
  const token = await getGitHubActorToken(orgId)
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

export async function defaultBranch(orgId: string, cwd: string, githubRepo: string): Promise<string> {
  try {
    const ref = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
    if (ref) return ref.replace(/^origin\//, '')
  } catch {
    // fall through to the API
  }
  const repo = await githubApi<{ default_branch: string }>(orgId, 'GET', `https://api.github.com/repos/${githubRepo}`)
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

// ---------------------------------------------------------------------------
// Conventional Commits (https://www.conventionalcommits.org) for every PR title
// and commit the pipeline writes.
// ---------------------------------------------------------------------------

export type ConventionalType = 'feat' | 'fix' | 'chore' | 'docs' | 'refactor' | 'test' | 'perf' | 'build' | 'ci' | 'style' | 'revert'

const CONVENTIONAL_RE = /^(feat|fix|chore|docs|refactor|test|perf|build|ci|style|revert)(\([\w./-]+\))?!?: \S/

/** Scope token: lowercase, no spaces, safe for `type(scope):`. */
export function conventionalScope(value: string | undefined): string | undefined {
  const scope = (value ?? '').toLowerCase().replace(/[^a-z0-9./-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return scope || undefined
}

/** Build `type(scope): subject` with a ≤72-char header, lowercase first letter, no trailing period. */
export function conventional(type: ConventionalType, scope: string | undefined, subject: string): string {
  const cleanSubject = subject.replace(/\s+/g, ' ').trim().replace(/\.+$/, '')
  const lowered = cleanSubject ? cleanSubject[0]!.toLowerCase() + cleanSubject.slice(1) : 'update'
  const prefix = `${type}${conventionalScope(scope) ? `(${conventionalScope(scope)})` : ''}: `
  const room = Math.max(20, 72 - prefix.length)
  return `${prefix}${lowered.length > room ? `${lowered.slice(0, room - 1)}…` : lowered}`
}

/** Keep a header that already follows the convention; otherwise wrap it. */
export function ensureConventional(header: string, fallbackType: ConventionalType, scope?: string): string {
  const first = header.split('\n')[0]!.trim()
  return CONVENTIONAL_RE.test(first) ? first : conventional(fallbackType, scope, first)
}

/** Conventional Commits type for a pipeline stage's commits/PR updates. */
export function conventionalTypeForStage(stage: string): ConventionalType {
  switch (stage) {
    case 'verify': return 'test'
    case 'orchestrate': return 'chore'
    case 'docs': return 'docs'
    default: return 'feat'
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

/** GitHub refuses a push touching .github/workflows unless the app has the Workflows permission. */
export function explainPushFailure(message: string): string {
  if (/refusing to allow (a|an) (GitHub App|OAuth App|integration) to (create or update|update) workflow/i.test(message)) {
    return 'GitHub refused the push because it changes files under .github/workflows and the GitHub App does not have the Workflows permission. Add it to the app on GitHub (Settings → Developer settings → GitHub Apps → Permissions → Workflows: Read and write), then accept the permission request on the installation. Until then, keep workflow changes out of the branch.'
  }
  return message
}

export async function pushBranch(orgId: string, cwd: string, branch: string): Promise<void> {
  const header = await authHeader(orgId)
  try {
    await git(cwd, ['-c', `http.extraheader=${header}`, 'push', '-u', 'origin', `${branch}:${branch}`], { timeoutMs: 10 * 60_000 })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const explained = explainPushFailure(message)
    throw explained === message ? error : new Error(explained)
  }
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

export async function findOpenPullRequest(orgId: string, githubRepo: string, head: string): Promise<GitHubPull | undefined> {
  const owner = githubRepo.split('/')[0]
  const pulls = await githubApi<GitHubPull[]>(orgId, 'GET', `https://api.github.com/repos/${githubRepo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}&per_page=5`)
  return pulls[0]
}

/**
 * Open a PR from `head` into `base`, or update the existing open one for `head`
 * (title/body/base). Idempotent across stage completions.
 */
export async function openOrUpdatePullRequest(options: {
  orgId: string
  githubRepo: string
  head: string
  base: string
  title: string
  body: string
  draft?: boolean
}): Promise<PullRequestRef> {
  const existing = await findOpenPullRequest(options.orgId, options.githubRepo, options.head)
  if (existing) {
    const updated = await githubApi<GitHubPull>(options.orgId, 'PATCH', `https://api.github.com/repos/${options.githubRepo}/pulls/${existing.number}`, {
      title: options.title,
      body: options.body,
      ...(existing.base.ref !== options.base ? { base: options.base } : {}),
    })
    return { number: updated.number, url: updated.html_url, head: updated.head.ref, base: updated.base.ref, created: false }
  }
  const created = await githubApi<GitHubPull>(options.orgId, 'POST', `https://api.github.com/repos/${options.githubRepo}/pulls`, {
    title: options.title,
    head: options.head,
    base: options.base,
    body: options.body,
    draft: options.draft ?? false,
  })
  return { number: created.number, url: created.html_url, head: created.head.ref, base: created.base.ref, created: true }
}

export async function commentOnPullRequest(orgId: string, githubRepo: string, number: number, body: string): Promise<void> {
  await githubApi(orgId, 'POST', `https://api.github.com/repos/${githubRepo}/issues/${number}/comments`, { body })
}

/**
 * One-shot: commit whatever the agent left in `cwd`, push the branch, and
 * open/update its PR. Returns undefined when there is nothing to publish.
 */
export async function publishBranchAsPullRequest(options: {
  orgId: string
  cwd: string
  githubRepo: string
  branch: string
  base: string
  commitMessage: string
  title: string
  body: string
  draft?: boolean
  /** Conventional Commits type used when title/commit are not already conventional (default feat). */
  type?: ConventionalType
  /** Conventional Commits scope (e.g. feature branch or workstream). */
  scope?: string
}): Promise<PullRequestRef | undefined> {
  // Every commit and PR title the pipeline writes follows Conventional Commits.
  const [commitHeader, ...commitRest] = options.commitMessage.split('\n')
  const commitMessage = [ensureConventional(commitHeader ?? '', options.type ?? 'feat', options.scope), ...commitRest].join('\n')
  const title = ensureConventional(options.title, options.type ?? 'feat', options.scope)
  await commitAll(options.cwd, commitMessage)
  if (!(await hasCommitsAhead(options.cwd, `origin/${options.base}`, options.branch)) && !(await hasCommitsAhead(options.cwd, options.base, options.branch))) {
    return undefined
  }
  await pushBranch(options.orgId, options.cwd, options.branch)
  return openOrUpdatePullRequest({
    orgId: options.orgId,
    githubRepo: options.githubRepo,
    head: options.branch,
    base: options.base,
    title,
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
