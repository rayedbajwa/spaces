import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { getGitHubToken } from './github'

/**
 * Delivery tracking for a feature: every pull request the implementation
 * opened (feature branch PR, per-workstream stacked PRs), its review/CI/merge
 * state, and the deployments GitHub recorded for the merged commits. Written
 * deterministically to `<feature>/delivery-status.md` before the `deliver`
 * stage so the agent reasons over facts, not guesses.
 */

export interface TrackedPullRequest {
  githubRepo: string
  number: number
  url: string
  title: string
  head: string
  base: string
  state: 'open' | 'closed'
  merged: boolean
  mergedAt?: string
  draft: boolean
  /** Approved / changes_requested / review_required / none */
  review: string
  /** success / failure / pending / none — combined check-runs for the head SHA. */
  checks: string
  mergeable?: boolean | null
  /** Deployments recorded for the merge commit (or head), newest first. */
  deployments: Array<{ environment: string; state: string; url?: string; createdAt: string }>
  /** Base branch is another workstream's branch → stacked; must merge after it. */
  stackedOn?: string
  /** Where we found it (report file), for traceability. */
  source: string
}

export type DeliveryStatus = 'MERGED' | 'PARTIAL' | 'BLOCKED' | 'NONE'

export interface DeliverySnapshot {
  status: DeliveryStatus
  pullRequests: TrackedPullRequest[]
  pendingCount: number
  markdown: string
  generatedAt: string
}

const PR_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g

async function githubApi<T>(url: string): Promise<T> {
  const token = await getGitHubToken()
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'pi-speckit-pdlc' },
  })
  if (!response.ok) throw new Error(`GitHub API ${response.status} ${url}: ${(await response.text().catch(() => '')).slice(0, 200)}`)
  return (await response.json()) as T
}

/** PR links mentioned anywhere in the feature directory's reports. */
export async function collectPullRequestLinks(featureDirAbs: string): Promise<Array<{ githubRepo: string; number: number; source: string }>> {
  const found = new Map<string, { githubRepo: string; number: number; source: string }>()
  const files: string[] = []
  for (const name of ['merge-orchestrator.md', 'verification-report.md', 'delivery-report.md', 'delivery-status.md', 'tasks.md']) files.push(path.join(featureDirAbs, name))
  try {
    for (const entry of await readdir(path.join(featureDirAbs, 'subagents'))) if (entry.endsWith('.md')) files.push(path.join(featureDirAbs, 'subagents', entry))
  } catch { /* no subagent reports */ }
  for (const file of files) {
    let text = ''
    try { text = await readFile(file, 'utf8') } catch { continue }
    for (const match of text.matchAll(PR_URL)) {
      const key = `${match[1]}#${match[2]}`
      if (!found.has(key)) found.set(key, { githubRepo: match[1]!, number: Number(match[2]), source: path.relative(featureDirAbs, file) })
    }
  }
  return [...found.values()]
}

interface GitHubPull {
  number: number
  html_url: string
  title: string
  state: 'open' | 'closed'
  merged: boolean
  merged_at: string | null
  merge_commit_sha: string | null
  draft: boolean
  mergeable: boolean | null
  head: { ref: string; sha: string }
  base: { ref: string }
}

export async function inspectPullRequest(githubRepo: string, number: number, source: string, workstreamBranchPrefix?: string): Promise<TrackedPullRequest> {
  const pr = await githubApi<GitHubPull>(`https://api.github.com/repos/${githubRepo}/pulls/${number}`)
  const [reviews, checks, deployments] = await Promise.all([
    githubApi<Array<{ state: string; submitted_at: string; user?: { login: string } }>>(`https://api.github.com/repos/${githubRepo}/pulls/${number}/reviews?per_page=50`).catch(() => []),
    githubApi<{ check_runs: Array<{ conclusion: string | null; status: string }> }>(`https://api.github.com/repos/${githubRepo}/commits/${pr.head.sha}/check-runs?per_page=50`).catch(() => ({ check_runs: [] })),
    githubApi<Array<{ id: number; environment: string; created_at: string }>>(`https://api.github.com/repos/${githubRepo}/deployments?sha=${pr.merge_commit_sha ?? pr.head.sha}&per_page=5`).catch(() => []),
  ])
  // Latest review per reviewer decides.
  const latestByUser = new Map<string, string>()
  for (const r of [...reviews].sort((a, b) => a.submitted_at.localeCompare(b.submitted_at))) if (r.user?.login && r.state !== 'COMMENTED') latestByUser.set(r.user.login, r.state)
  const states = [...latestByUser.values()]
  const review = states.includes('CHANGES_REQUESTED') ? 'changes_requested' : states.includes('APPROVED') ? 'approved' : states.length ? states[0]!.toLowerCase() : 'none'
  const runs = checks.check_runs
  const checkState = runs.length === 0 ? 'none' : runs.some((r) => r.status !== 'completed') ? 'pending' : runs.every((r) => ['success', 'neutral', 'skipped'].includes(r.conclusion ?? '')) ? 'success' : 'failure'
  const deployStates = await Promise.all(deployments.slice(0, 3).map(async (d) => {
    const statuses = await githubApi<Array<{ state: string; environment_url?: string; created_at: string }>>(`https://api.github.com/repos/${githubRepo}/deployments/${d.id}/statuses?per_page=1`).catch(() => [])
    return { environment: d.environment, state: statuses[0]?.state ?? 'unknown', url: statuses[0]?.environment_url, createdAt: d.created_at }
  }))
  const stackedOn = workstreamBranchPrefix && pr.base.ref.startsWith(workstreamBranchPrefix) ? pr.base.ref : (/\/ws-\d+-/.test(pr.base.ref) ? pr.base.ref : undefined)
  return {
    githubRepo,
    number: pr.number,
    url: pr.html_url,
    title: pr.title,
    head: pr.head.ref,
    base: pr.base.ref,
    state: pr.state,
    merged: pr.merged,
    mergedAt: pr.merged_at ?? undefined,
    draft: pr.draft,
    review,
    checks: checkState,
    mergeable: pr.mergeable,
    deployments: deployStates,
    stackedOn,
    source,
  }
}

function orderByStack(prs: TrackedPullRequest[]): TrackedPullRequest[] {
  // Base-first: a PR whose base is another PR's head comes after that PR.
  const byHead = new Map(prs.map((p) => [`${p.githubRepo}:${p.head}`, p]))
  const depth = (p: TrackedPullRequest, seen = new Set<string>()): number => {
    const parent = byHead.get(`${p.githubRepo}:${p.base}`)
    if (!parent || seen.has(parent.url)) return 0
    seen.add(parent.url)
    return 1 + depth(parent, seen)
  }
  return [...prs].sort((a, b) => depth(a) - depth(b) || a.githubRepo.localeCompare(b.githubRepo) || a.number - b.number)
}

/**
 * Gather every PR for the feature, inspect it on GitHub, order by stack, write
 * `<feature>/delivery-status.md`, and return the snapshot.
 */
export async function refreshDeliveryStatus(featureDirAbs: string): Promise<DeliverySnapshot> {
  const links = await collectPullRequestLinks(featureDirAbs)
  const inspected: TrackedPullRequest[] = []
  const errors: string[] = []
  for (const link of links) {
    try {
      inspected.push(await inspectPullRequest(link.githubRepo, link.number, link.source))
    } catch (error) {
      errors.push(`${link.githubRepo}#${link.number}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const prs = orderByStack(inspected)
  const open = prs.filter((p) => p.state === 'open')
  const closedUnmerged = prs.filter((p) => p.state === 'closed' && !p.merged)
  const status: DeliveryStatus = prs.length === 0
    ? 'NONE'
    : open.length === 0 && closedUnmerged.length === 0
      ? 'MERGED'
      : open.some((p) => p.checks === 'failure' || p.review === 'changes_requested' || p.mergeable === false) || closedUnmerged.length > 0
        ? 'BLOCKED'
        : 'PARTIAL'
  const generatedAt = new Date().toISOString()
  const nextAction = (p: TrackedPullRequest): string => {
    if (p.merged) return p.deployments.length ? `deployed: ${p.deployments.map((d) => `${d.environment} ${d.state}`).join(', ')}` : 'merged — no deployment recorded yet'
    if (p.state === 'closed') return 'closed without merge — reopen or supersede'
    const parent = p.stackedOn ? prs.find((q) => q.githubRepo === p.githubRepo && q.head === p.stackedOn) : undefined
    if (parent && !parent.merged) return `wait: stacked on #${parent.number} (${parent.head}) which is not merged`
    if (p.draft) return 'mark ready for review'
    if (p.checks === 'failure') return 'CI failing — fix and push'
    if (p.checks === 'pending') return 'CI running'
    if (p.review === 'changes_requested') return 'address review comments'
    if (p.review !== 'approved') return 'needs review/approval'
    if (p.mergeable === false) return 'merge conflict — rebase'
    return 'ready to merge'
  }
  const markdown = [
    `# Delivery status`,
    `Delivery Status: ${status}`,
    `_Generated ${generatedAt} · ${prs.length} pull request${prs.length === 1 ? '' : 's'}, ${open.length} open_`,
    '',
    prs.length ? '| Order | Repository | PR | Branch → Base | State | Review | Checks | Deploy | Next action |' : '_No pull requests found in the feature reports yet._',
    prs.length ? '|---|---|---|---|---|---|---|---|---|' : '',
    ...prs.map((p, i) => `| ${i + 1} | ${p.githubRepo} | [#${p.number}](${p.url}) ${p.title.replace(/\|/g, '/').slice(0, 60)} | \`${p.head}\` → \`${p.base}\`${p.stackedOn ? ' (stacked)' : ''} | ${p.merged ? `merged ${p.mergedAt?.slice(0, 16) ?? ''}` : p.state}${p.draft ? ' (draft)' : ''} | ${p.review} | ${p.checks} | ${p.deployments.length ? p.deployments.map((d) => `${d.environment}: ${d.state}`).join('<br>') : '—'} | ${nextAction(p)} |`),
    '',
    errors.length ? `## Lookup errors\n${errors.map((e) => `- ${e}`).join('\n')}` : '',
    `## Rules`,
    `- Merge order follows the stack: a PR whose base is another workstream branch merges after that branch's PR.`,
    `- "Deploy" lists GitHub Deployments recorded for the merge commit; if the project deploys another way, check the pipeline named in .aidlc/dev-setup.md or the README.`,
    `- Re-run the deliver stage (or approve the pending gate) to refresh this file.`,
  ].filter((line) => line !== '').join('\n')
  await writeFile(path.join(featureDirAbs, 'delivery-status.md'), `${markdown}\n`)
  return { status, pullRequests: prs, pendingCount: open.length + closedUnmerged.length, markdown, generatedAt }
}
