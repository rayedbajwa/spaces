/**
 * Delete a project and everything it owns.
 *
 * Refused while the project is busy (queued/running/paused runs, queued or
 * running jobs, busy agents, onboarding in progress) — finish or cancel that
 * work first. Otherwise, in one transaction: pipeline runs (their steps,
 * events, gates, artifacts and handoff entries cascade), source snapshots and
 * the project row (repos, integrations, memory, orchestrator, agents and jobs
 * cascade). Then, best effort, on disk: the governing workspace, GitHub clones
 * no other project uses (with their worktrees), worktrees inside local
 * repositories, and agent session files. Local repositories themselves are
 * the user's and are never removed.
 */

import { rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { getDb } from './db'
import { clonePathFor, workspaceRoot } from './github'
import { governancePathFor, governanceRoot, isGovernanceRepo } from './governance'
import { log } from './logger'
import { forgetOnboarding, getOnboardingSnapshot } from './project-onboarding'
import { listRepos, type ProjectRow, type RepoRow } from './project-registry'
import { worktreeRoot } from './pull-requests'

const deleteLog = log.child({ mod: 'project-delete' })

export interface ProjectActivity {
  active: boolean
  reasons: string[]
  runs: Array<{ runId: string; status: string; feature: string | null; currentStage: string | null }>
  jobs: number
  busyAgents: number
  onboarding: boolean
}

export interface DeletionPreview {
  /** Deletion needs the project archived first; this is the phrase to type. */
  archived: boolean
  confirmPhrase: string
  activity: ProjectActivity
  runs: number
  jobs: number
  snapshots: number
  repos: Array<{ label: string; kind: string; localPath: string | null; githubRepo: string | null; action: 'delete-clone' | 'delete-workspace' | 'keep-shared' | 'keep-local' | 'none' }>
}

export interface DeletionReport {
  projectId: string
  slug: string
  runsDeleted: number
  jobsDeleted: number
  snapshotsDeleted: number
  removedPaths: string[]
  keptPaths: string[]
  warnings: string[]
}

export class ProjectBusyError extends Error {
  constructor(public readonly activity: ProjectActivity) {
    super(`Project is still active: ${activity.reasons.join('; ')}`)
    this.name = 'ProjectBusyError'
  }
}

export async function getProjectActivity(project: ProjectRow): Promise<ProjectActivity> {
  const sql = getDb()
  const runs = await sql<Array<{ runId: string; status: string; feature: string | null; currentStage: string | null }>>`
    SELECT run_id AS "runId", status, feature, current_stage AS "currentStage" FROM pipeline_runs
    WHERE (project_namespace = ${project.slug} OR project_id = ${project.projectId}) AND status IN ('queued', 'running', 'paused')
    ORDER BY created_at DESC
  `
  const [jobRow] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM project_jobs WHERE project_id = ${project.projectId} AND status IN ('queued', 'claimed', 'running')`
  const [agentRow] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM project_agents WHERE project_id = ${project.projectId} AND status IN ('busy', 'warming')`
  const onboarding = ['running', 'queued', 'pending'].includes(String(getOnboardingSnapshot(project.projectId).status))

  const reasons: string[] = []
  if (runs.length) {
    const byStatus = runs.reduce<Record<string, number>>((acc, r) => { acc[r.status] = (acc[r.status] ?? 0) + 1; return acc }, {})
    reasons.push(`${runs.length} run${runs.length === 1 ? '' : 's'} in progress (${Object.entries(byStatus).map(([s, n]) => `${n} ${s}`).join(', ')})`)
  }
  if (jobRow?.n) reasons.push(`${jobRow.n} queued or running job${jobRow.n === 1 ? '' : 's'}`)
  if (agentRow?.n) reasons.push(`${agentRow.n} busy agent${agentRow.n === 1 ? '' : 's'}`)
  if (onboarding) reasons.push('onboarding is still running')
  return { active: reasons.length > 0, reasons, runs, jobs: jobRow?.n ?? 0, busyAgents: agentRow?.n ?? 0, onboarding }
}

/** What deleting would remove, so the UI can show it before asking for confirmation. */
export async function previewProjectDeletion(project: ProjectRow): Promise<DeletionPreview> {
  const sql = getDb()
  const activity = await getProjectActivity(project)
  const [runs] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pipeline_runs WHERE project_namespace = ${project.slug} OR project_id = ${project.projectId}`
  const [jobs] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM project_jobs WHERE project_id = ${project.projectId}`
  const [snapshots] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM project_source_snapshots WHERE project_id = ${project.projectId}`
  const repos = await listRepos(project.projectId)
  const shared = await sharedPaths(project.projectId, repos)
  return {
    archived: Boolean(project.archivedAt),
    confirmPhrase: confirmPhraseFor(project),
    activity,
    runs: runs?.n ?? 0,
    jobs: jobs?.n ?? 0,
    snapshots: snapshots?.n ?? 0,
    repos: repos.map((r) => ({ label: r.label, kind: r.kind, localPath: r.localPath ?? null, githubRepo: r.githubRepo ?? null, action: repoAction(r, shared) })),
  }
}

/** The exact phrase a user must type: the word delete followed by the project key (its code, e.g. PLAT-12). */
export function confirmPhraseFor(project: Pick<ProjectRow, 'slug' | 'code'>): string {
  return `delete ${(project.code ?? project.slug).toLowerCase()}`
}

export class ProjectNotArchivedError extends Error {
  constructor() {
    super('Archive the project first. Deletion is permanent; archiving keeps everything and can be undone.')
    this.name = 'ProjectNotArchivedError'
  }
}

/**
 * Delete the project. It must already be archived, and `confirm` must be
 * "delete <slug>". Throws ProjectBusyError while runs, jobs, agents or
 * onboarding are active.
 */
export async function deleteProjectCompletely(project: ProjectRow, confirm: string): Promise<DeletionReport> {
  if (!project.archivedAt) throw new ProjectNotArchivedError()
  if (confirm.trim().toLowerCase().replace(/\s+/g, ' ') !== confirmPhraseFor(project)) throw new Error(`Type "${confirmPhraseFor(project)}" to confirm.`)
  const activity = await getProjectActivity(project)
  if (activity.active) throw new ProjectBusyError(activity)

  const sql = getDb()
  const repos = await listRepos(project.projectId)
  const shared = await sharedPaths(project.projectId, repos)
  const sessionFiles = (await sql<Array<{ file: string | null }>>`
    SELECT session_file AS file FROM pipeline_runs WHERE (project_namespace = ${project.slug} OR project_id = ${project.projectId}) AND session_file IS NOT NULL
    UNION SELECT session_file FROM project_agents WHERE project_id = ${project.projectId} AND session_file IS NOT NULL
  `).map((r) => r.file).filter((f): f is string => Boolean(f))

  const report: DeletionReport = { projectId: project.projectId, slug: project.slug, runsDeleted: 0, jobsDeleted: 0, snapshotsDeleted: 0, removedPaths: [], keptPaths: [], warnings: [] }

  await sql.begin(async (tx) => {
    // Re-check under the transaction so a job claimed a moment ago is not lost.
    const [busy] = await tx<Array<{ n: number }>>`
      SELECT (SELECT count(*) FROM project_jobs WHERE project_id = ${project.projectId} AND status IN ('queued', 'claimed', 'running'))
           + (SELECT count(*) FROM pipeline_runs WHERE (project_namespace = ${project.slug} OR project_id = ${project.projectId}) AND status IN ('queued', 'running', 'paused')) AS n
    `
    if (Number(busy?.n ?? 0) > 0) throw new ProjectBusyError(await getProjectActivity(project))
    report.runsDeleted = (await tx`DELETE FROM pipeline_runs WHERE project_namespace = ${project.slug} OR project_id = ${project.projectId} RETURNING run_id`).length
    report.jobsDeleted = (await tx`DELETE FROM project_jobs WHERE project_id = ${project.projectId} RETURNING job_id`).length
    report.snapshotsDeleted = (await tx`DELETE FROM project_source_snapshots WHERE project_id = ${project.projectId} RETURNING snapshot_id`).length
    await tx`UPDATE workers SET project_id = NULL WHERE project_id = ${project.projectId}`
    await tx`DELETE FROM projects WHERE project_id = ${project.projectId}`
  })
  forgetOnboarding(project.projectId)

  // On-disk cleanup after the commit: a failure here must not resurrect the project.
  for (const repo of repos) {
    const action = repoAction(repo, shared)
    const target = repo.localPath ?? (repo.githubRepo ? clonePathFor(repo.githubRepo) : undefined)
    if (!target) continue
    if (action === 'delete-clone' || action === 'delete-workspace') {
      await removePath(target, report)
      const worktrees = worktreeRoot(target)
      if (!worktrees.startsWith(target)) await removePath(worktrees, report)
    } else if (action === 'keep-local') {
      // The repository is the user's; only our worktrees go.
      await removePath(worktreeRoot(target), report, true)
      report.keptPaths.push(target)
    } else if (action === 'keep-shared') {
      report.keptPaths.push(target)
    }
  }
  const governanceDir = governancePathFor(project.slug)
  if (!report.removedPaths.includes(governanceDir)) await removePath(governanceDir, report, true)
  for (const file of sessionFiles) await removePath(file, report, true)

  deleteLog.info('project deleted', { ...report })
  return report
}

/** Paths other projects also point at; those are kept. */
async function sharedPaths(projectId: string, repos: RepoRow[]): Promise<Set<string>> {
  const sql = getDb()
  const paths = repos.map((r) => r.localPath).filter((p): p is string => Boolean(p))
  const names = repos.map((r) => r.githubRepo).filter((n): n is string => Boolean(n))
  if (paths.length === 0 && names.length === 0) return new Set()
  const rows = await sql<Array<{ localPath: string | null; githubRepo: string | null }>>`
    SELECT local_path AS "localPath", github_repo AS "githubRepo" FROM project_repos
    WHERE project_id <> ${projectId} AND (local_path = ANY(${paths}::text[]) OR github_repo = ANY(${names}::text[]))
  `
  const shared = new Set<string>()
  for (const row of rows) {
    if (row.localPath) shared.add(path.resolve(row.localPath))
    if (row.githubRepo) shared.add(`github:${row.githubRepo.toLowerCase()}`)
  }
  return shared
}

function repoAction(repo: RepoRow, shared: Set<string>): DeletionPreview['repos'][number]['action'] {
  const local = repo.localPath ? path.resolve(repo.localPath) : undefined
  if (isGovernanceRepo(repo)) return 'delete-workspace'
  if (repo.githubRepo && shared.has(`github:${repo.githubRepo.toLowerCase()}`)) return 'keep-shared'
  if (local && shared.has(local)) return 'keep-shared'
  // Clones we made live under the workspace root; anything else is the user's checkout.
  const target = local ?? (repo.githubRepo ? clonePathFor(repo.githubRepo) : undefined)
  if (!target) return 'none'
  if (target.startsWith(governanceRoot())) return 'delete-workspace'
  if (repo.githubRepo && target.startsWith(workspaceRoot())) return 'delete-clone'
  return 'keep-local'
}

async function removePath(target: string, report: DeletionReport, quiet = false): Promise<void> {
  try {
    await stat(target)
  } catch {
    return // nothing there
  }
  try {
    await rm(target, { recursive: true, force: true })
    report.removedPaths.push(target)
  } catch (error) {
    const message = `could not remove ${target}: ${error instanceof Error ? error.message : String(error)}`
    if (!quiet) report.warnings.push(message)
    deleteLog.warn(message)
  }
}
