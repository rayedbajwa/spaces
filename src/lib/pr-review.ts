import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { collectPullRequestLinks, discoverPullRequestsByBranch, inspectPullRequest, type DeliveryRepoHint, type TrackedPullRequest } from './delivery'
import type { DiffSide } from './diff-parse'
import { getGitHubActorToken } from './github-app-auth'

/**
 * Reviewing a feature's pull requests inside Spaces.
 *
 * While a feature is being implemented the pipeline keeps a pull request open
 * per repository (and per workstream). This module lists them, loads each
 * one's changed files, patches and review comments from GitHub, and posts a
 * person's review back — inline comments included.
 *
 * The person's decision is also what the pipeline acts on: it is kept in
 * `<feature>/human-review.json` and, once it settles the feature (changes
 * requested on any open PR, or every open PR approved), written into
 * `code-review.md` with the usual `Code Review Status:` line. Requesting
 * changes therefore sends the feature back to implement with the comments as
 * findings, and approving moves it on to deliver. A decision counts only for
 * the commit it was made on; a new push to the PR voids it.
 *
 * Pull requests opened by the pipeline are authored by the GitHub App (or the
 * connected user), and GitHub does not let an author approve their own pull
 * request. Such a review is posted as a comment that names the person and
 * their decision, so the record on GitHub stays honest.
 */

export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'
export type HumanDecision = 'approved' | 'changes_requested'

export interface ReviewFile {
  filename: string
  previousFilename?: string
  status: string
  additions: number
  deletions: number
  /** Missing when GitHub leaves the diff out (binary or too large). */
  patch?: string
  blobUrl?: string
}

export interface ReviewComment {
  id: number
  path: string
  /** Null when the line no longer exists in the latest diff (outdated). */
  line: number | null
  side: DiffSide
  originalLine: number | null
  body: string
  author: string
  createdAt: string
  inReplyTo?: number
  url: string
}

export interface ReviewSummary {
  author: string
  state: string
  body: string
  submittedAt: string
  url?: string
}

export interface PullRequestReviewData {
  githubRepo: string
  number: number
  title: string
  body: string
  url: string
  author: string
  head: string
  base: string
  headSha: string
  state: 'open' | 'closed'
  merged: boolean
  draft: boolean
  additions: number
  deletions: number
  changedFiles: number
  files: ReviewFile[]
  /** Only the first files of a very large PR are loaded. */
  filesTruncated: boolean
  comments: ReviewComment[]
  reviews: ReviewSummary[]
}

export interface DraftComment {
  path: string
  line: number
  side: DiffSide
  body: string
}

export interface RecordedDecision {
  githubRepo: string
  number: number
  decision: HumanDecision
  reviewer: string
  at: string
  headSha: string
  summary: string
  comments: DraftComment[]
  url?: string
}

export interface HumanReviewState {
  decisions: RecordedDecision[]
}

const HUMAN_REVIEW_FILE = 'human-review.json'
const SPACES_MARKER = '<!-- spaces-human-review -->'
const MAX_FILE_PAGES = 30

async function github<T>(orgId: string, method: 'GET' | 'POST', url: string, body?: unknown): Promise<{ data: T; next?: string }> {
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
    throw new GitHubReviewError(response.status, `GitHub API ${response.status} ${method} ${url}: ${text.slice(0, 400)}`)
  }
  const next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get('link') ?? '')?.[1]
  return { data: (await response.json()) as T, next }
}

export class GitHubReviewError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

async function githubPages<T>(orgId: string, url: string, maxPages: number): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = []
  let next: string | undefined = url
  let pages = 0
  while (next && pages < maxPages) {
    const page: { data: T[]; next?: string } = await github<T[]>(orgId, 'GET', next)
    items.push(...page.data)
    next = page.next
    pages += 1
  }
  return { items, truncated: Boolean(next) }
}

/** Every pull request the feature opened, open ones first. */
export async function listFeaturePullRequests(orgId: string, featureDirAbs: string, repos: DeliveryRepoHint[]): Promise<TrackedPullRequest[]> {
  const links = await collectPullRequestLinks(featureDirAbs)
  const seen = new Set(links.map((l) => `${l.githubRepo}#${l.number}`))
  for (const link of await discoverPullRequestsByBranch(orgId, featureDirAbs, repos).catch(() => [])) {
    const key = `${link.githubRepo}#${link.number}`
    if (!seen.has(key)) { seen.add(key); links.push(link) }
  }
  // Only the project's own repositories: a report may link to unrelated PRs.
  const allowed = new Set(repos.map((r) => r.githubRepo?.toLowerCase()).filter(Boolean))
  const inspected = await Promise.all(links
    .filter((l) => allowed.has(l.githubRepo.toLowerCase()))
    .map((l) => inspectPullRequest(orgId, l.githubRepo, l.number, l.source).catch(() => undefined)))
  return inspected
    .filter((p): p is TrackedPullRequest => Boolean(p))
    .sort((a, b) => Number(b.state === 'open') - Number(a.state === 'open') || a.githubRepo.localeCompare(b.githubRepo) || a.number - b.number)
}

interface GitHubPullDetail {
  number: number
  title: string
  body: string | null
  html_url: string
  user?: { login: string }
  head: { ref: string; sha: string }
  base: { ref: string }
  state: 'open' | 'closed'
  merged: boolean
  draft: boolean
  additions: number
  deletions: number
  changed_files: number
}

export async function loadPullRequestReview(orgId: string, githubRepo: string, number: number): Promise<PullRequestReviewData> {
  const base = `https://api.github.com/repos/${githubRepo}/pulls/${number}`
  const [{ data: pr }, files, comments, reviews] = await Promise.all([
    github<GitHubPullDetail>(orgId, 'GET', base),
    githubPages<{ filename: string; previous_filename?: string; status: string; additions: number; deletions: number; patch?: string; blob_url?: string }>(orgId, `${base}/files?per_page=100`, MAX_FILE_PAGES),
    githubPages<{ id: number; path: string; line: number | null; side?: DiffSide; original_line: number | null; body: string; user?: { login: string }; created_at: string; in_reply_to_id?: number; html_url: string }>(orgId, `${base}/comments?per_page=100`, 10),
    githubPages<{ user?: { login: string }; state: string; body: string | null; submitted_at?: string; html_url?: string }>(orgId, `${base}/reviews?per_page=100`, 5),
  ])
  return {
    githubRepo,
    number: pr.number,
    title: pr.title,
    body: pr.body ?? '',
    url: pr.html_url,
    author: pr.user?.login ?? 'unknown',
    head: pr.head.ref,
    base: pr.base.ref,
    headSha: pr.head.sha,
    state: pr.state,
    merged: pr.merged,
    draft: pr.draft,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changed_files,
    files: files.items.map((f) => ({ filename: f.filename, previousFilename: f.previous_filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch, blobUrl: f.blob_url })),
    filesTruncated: files.truncated,
    comments: comments.items.map((c) => ({ id: c.id, path: c.path, line: c.line, side: c.side ?? 'RIGHT', originalLine: c.original_line, body: c.body, author: c.user?.login ?? 'unknown', createdAt: c.created_at, inReplyTo: c.in_reply_to_id, url: c.html_url })),
    reviews: reviews.items
      .filter((r) => r.state !== 'PENDING')
      .map((r) => ({ author: r.user?.login ?? 'unknown', state: r.state, body: r.body ?? '', submittedAt: r.submitted_at ?? '', url: r.html_url })),
  }
}

export function reviewHeading(event: ReviewEvent, reviewer: string): string {
  const verdict = event === 'APPROVE' ? 'Approved' : event === 'REQUEST_CHANGES' ? 'Changes requested' : 'Comments'
  return `**${verdict}** by ${reviewer} in Spaces`
}

/**
 * Post a review with its inline comments. GitHub refuses APPROVE and
 * REQUEST_CHANGES from the pull request's author (422); those are posted again
 * as a COMMENT carrying the decision in its heading.
 */
export async function postPullRequestReview(orgId: string, input: {
  githubRepo: string
  number: number
  headSha: string
  event: ReviewEvent
  reviewer: string
  summary: string
  comments: DraftComment[]
}): Promise<{ postedAs: ReviewEvent; url?: string }> {
  const body = [reviewHeading(input.event, input.reviewer), input.summary.trim()].filter(Boolean).join('\n\n')
  const payload = (event: ReviewEvent) => ({
    commit_id: input.headSha,
    event,
    body,
    comments: input.comments.map((c) => ({ path: c.path, line: c.line, side: c.side, body: c.body })),
  })
  const url = `https://api.github.com/repos/${input.githubRepo}/pulls/${input.number}/reviews`
  try {
    const { data } = await github<{ html_url?: string }>(orgId, 'POST', url, payload(input.event))
    return { postedAs: input.event, url: data.html_url }
  } catch (error) {
    if (!(error instanceof GitHubReviewError) || error.status !== 422 || input.event === 'COMMENT') throw error
    const { data } = await github<{ html_url?: string }>(orgId, 'POST', url, payload('COMMENT'))
    return { postedAs: 'COMMENT', url: data.html_url }
  }
}

// ---------------------------------------------------------------------------
// The person's decision, as the pipeline sees it
// ---------------------------------------------------------------------------

export async function readHumanReview(featureDirAbs: string): Promise<HumanReviewState> {
  try {
    const parsed = JSON.parse(await readFile(path.join(featureDirAbs, HUMAN_REVIEW_FILE), 'utf8')) as HumanReviewState
    return { decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [] }
  } catch {
    return { decisions: [] }
  }
}

/** Keep the latest decision per pull request. */
export function withDecision(state: HumanReviewState, decision: RecordedDecision): HumanReviewState {
  return { decisions: [...state.decisions.filter((d) => !(d.githubRepo === decision.githubRepo && d.number === decision.number)), decision] }
}

/**
 * What the decisions say about the feature, judged against its open pull
 * requests at their current head commits. Undefined while some open PR has no
 * current decision and none asks for changes.
 */
export function overallDecision(state: HumanReviewState, openPullRequests: Array<{ githubRepo: string; number: number; headSha: string }>): HumanDecision | undefined {
  if (openPullRequests.length === 0) return undefined
  const current = openPullRequests.map((pr) => state.decisions.find((d) => d.githubRepo === pr.githubRepo && d.number === pr.number && d.headSha === pr.headSha))
  if (current.some((d) => d?.decision === 'changes_requested')) return 'changes_requested'
  if (current.every((d) => d?.decision === 'approved')) return 'approved'
  return undefined
}

/** code-review.md for a settled human review, keeping an automated review that preceded it. */
export function renderHumanReview(decision: HumanDecision, state: HumanReviewState, openPullRequests: Array<{ githubRepo: string; number: number; headSha: string }>, previous: string): string {
  const current = openPullRequests
    .map((pr) => state.decisions.find((d) => d.githubRepo === pr.githubRepo && d.number === pr.number && d.headSha === pr.headSha))
    .filter((d): d is RecordedDecision => Boolean(d))
  const requested = current.filter((d) => d.decision === 'changes_requested')
  // An earlier Spaces review is replaced; an automated one is kept below, with
  // its status line renamed so only this review's status is read.
  const earlier = previous.includes(SPACES_MARKER)
    ? previous.split('## Earlier automated review')[1]?.trim() ?? ''
    : previous.trim().replace(/Code Review Status:/gi, 'Automated review status:')
  const lines = [
    `Code Review Status: ${decision === 'approved' ? 'APPROVED' : 'CHANGES_REQUESTED'}`,
    SPACES_MARKER,
    '',
    '# Code review (Spaces)',
    '',
    '| Pull request | Commit | Decision | Reviewer | When |',
    '|---|---|---|---|---|',
    ...current.map((d) => `| ${d.githubRepo}#${d.number} | \`${d.headSha.slice(0, 7)}\` | ${d.decision === 'approved' ? 'Approved' : 'Changes requested'} | ${d.reviewer} | ${d.at.slice(0, 16).replace('T', ' ')} |`),
    '',
  ]
  if (requested.length) {
    lines.push('## Requested changes', '', 'Address every item below, push, and the pull request comes back for review.', '')
    for (const d of requested) {
      lines.push(`### ${d.githubRepo}#${d.number} — ${d.reviewer}`, '')
      if (d.summary.trim()) lines.push(d.summary.trim(), '')
      for (const c of d.comments) lines.push(`- \`${c.path}:${c.line}\`${c.side === 'LEFT' ? ' (removed line)' : ''} — ${c.body.replace(/\n+/g, ' ')}`)
      if (d.comments.length) lines.push('')
    }
  }
  if (earlier) lines.push('## Earlier automated review', '', earlier, '')
  return `${lines.join('\n').trimEnd()}\n`
}

/**
 * Record a decision and, when it settles the feature, rewrite code-review.md.
 * Returns the feature-level decision (if any) the pipeline will now act on.
 */
export async function recordHumanDecision(featureDirAbs: string, decision: RecordedDecision, openPullRequests: Array<{ githubRepo: string; number: number; headSha: string }>): Promise<HumanDecision | undefined> {
  const state = withDecision(await readHumanReview(featureDirAbs), decision)
  await writeFile(path.join(featureDirAbs, HUMAN_REVIEW_FILE), `${JSON.stringify(state, null, 2)}\n`)
  const overall = overallDecision(state, openPullRequests)
  if (overall) {
    const reviewPath = path.join(featureDirAbs, 'code-review.md')
    const previous = await readFile(reviewPath, 'utf8').catch(() => '')
    await writeFile(reviewPath, renderHumanReview(overall, state, openPullRequests, previous))
  }
  return overall
}
