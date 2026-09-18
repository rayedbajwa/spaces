/**
 * Repo-local changes: what gets committed to implementation repositories.
 *
 * The pattern (after OpenSpec's workspace architecture, design decisions of
 * April 2026): the governing workspace is the coordination workspace and each
 * feature is an **initiative** there — shared planning (spec, plan, tasks,
 * test plan, workstreams) plus `initiative.yaml` and `links.yaml` pointing at
 * the repo-local changes that implement it. Each implementation repository
 * carries its own **change**, committed with the code on the same branch and
 * pull request, under the same `specs/` directory Spec Kit uses:
 *
 *   specs/<initiative-id>/
 *     change.yaml   metadata: schema, created, initiative, repository, links to sibling changes
 *     tasks.md      the tasks this repository owns (its workstreams), as a checklist
 *     spec.md       the delta spec as seen from this repository
 *
 * Cross-repo links use stable project identifiers (`github.com/org/repo`),
 * never filesystem paths, and are informational: nothing fails when a sibling
 * is missing.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { stringify as toYaml } from 'yaml'
import { isGovernanceRepo } from './governance'

export interface ChangeRepo {
  label: string
  githubRepo?: string
  localPath: string
  isPrimary?: boolean
}

export interface ChangeWorkstream {
  title: string
  tasks: string
  inputs?: string
  outputs?: string
  dependencies?: string
  qaFocus?: string
  scopedFiles?: string
}

export interface RepoChangePlan {
  initiativeId: string
  /** One entry per implementation repository (governance workspace excluded). */
  changes: Array<{ repo: ChangeRepo; changeId: string; project: string; workstreams: ChangeWorkstream[] }>
}

export interface ChangeLink { project: string; change: string }

/** `github.com/org/repo` for GitHub-hosted checkouts, `local/<dir>` otherwise. */
export function projectIdentifier(repo: Pick<ChangeRepo, 'githubRepo' | 'localPath'>): string {
  const gh = repo.githubRepo?.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '')
  if (gh && /^[\w.-]+\/[\w.-]+$/.test(gh)) return `github.com/${gh}`
  return `local/${path.basename(path.resolve(repo.localPath))}`
}

/** `specs/003-add-cache` → `add-cache`; `Add 3DS!` → `add-3ds`. */
export function initiativeIdFor(featureDirName: string): string {
  return slug(featureDirName.replace(/^\d+[-_]/, '')) || 'feature'
}

/** The change id is the initiative id: the same `specs/<id>/` directory name in every repository. */
export function changeIdFor(initiativeId: string, _repo: Pick<ChangeRepo, 'label' | 'githubRepo'>): string {
  return initiativeId
}

/** Where a repository keeps its change for an initiative. */
export function changeDirFor(initiativeId: string): string {
  return path.join('specs', initiativeId)
}

/** A code repository (not the governing workspace) that a workstream runs in. */
export function isImplementationRepo(repo: ChangeRepo): boolean {
  return !isGovernanceRepo({ label: repo.label, localPath: repo.localPath })
}

/**
 * Decide the change per implementation repository from the workstreams that
 * target it, and record the initiative + links in the feature directory.
 */
export async function planRepoChanges(options: {
  featureDir: string
  workstreams: ChangeWorkstream[]
  repoFor: (workstream: ChangeWorkstream) => ChangeRepo | undefined
  project?: { name: string; code?: string | null }
}): Promise<RepoChangePlan> {
  const initiativeId = initiativeIdFor(path.basename(options.featureDir))
  const byRepo = new Map<string, { repo: ChangeRepo; workstreams: ChangeWorkstream[] }>()
  for (const ws of options.workstreams) {
    const repo = options.repoFor(ws)
    if (!repo || !isImplementationRepo(repo)) continue
    const key = path.resolve(repo.localPath)
    const entry = byRepo.get(key) ?? { repo, workstreams: [] }
    entry.workstreams.push(ws)
    byRepo.set(key, entry)
  }
  const changes = [...byRepo.values()].map(({ repo, workstreams }) => ({
    repo,
    changeId: changeIdFor(initiativeId, repo),
    project: projectIdentifier(repo),
    workstreams,
  }))
  const plan: RepoChangePlan = { initiativeId, changes }
  await writeInitiative(options.featureDir, plan, options.project).catch(() => undefined)
  return plan
}

/** `initiative.yaml` + `links.yaml` beside the spec in the governing workspace. */
export async function writeInitiative(featureDir: string, plan: RepoChangePlan, project?: { name: string; code?: string | null }): Promise<void> {
  const today = new Date().toISOString().slice(0, 10)
  const existing = await readFile(path.join(featureDir, 'initiative.yaml'), 'utf8').catch(() => '')
  const created = /^created:\s*(\S+)/m.exec(existing)?.[1] ?? today
  const artifacts = ['spec.md', 'plan.md', 'tasks.md', 'test-plan.md', 'parallel-workstreams.md']
  await writeFile(path.join(featureDir, 'initiative.yaml'), toYaml({
    schema: 'spec-driven',
    id: plan.initiativeId,
    created,
    updated: today,
    ...(project ? { project: project.code ? `${project.code} · ${project.name}` : project.name } : {}),
    artifacts,
    repositories: plan.changes.map((c) => c.project),
  }), 'utf8')
  await writeFile(path.join(featureDir, 'links.yaml'), toYaml({
    initiative: plan.initiativeId,
    links: plan.changes.map((c) => ({ project: c.project, change: c.changeId, path: changeDirFor(c.changeId) })),
  }), 'utf8')
}

/**
 * Write (or refresh) the repo-local change inside a checkout or worktree. Safe
 * to call once per worktree: files are deterministic for a repository, so
 * sibling worktrees of the same repo produce identical content.
 */
export async function writeRepoChange(options: {
  /** Checkout or worktree the change is committed from. */
  cwd: string
  featureDir: string
  plan: RepoChangePlan
  change: RepoChangePlan['changes'][number]
  project?: { name: string; code?: string | null }
}): Promise<{ dir: string; relativeDir: string; tasksFile: string }> {
  const { plan, change } = options
  const relativeDir = changeDirFor(change.changeId)
  const dir = path.join(options.cwd, relativeDir)
  await mkdir(dir, { recursive: true })

  const existingMeta = await readFile(path.join(dir, 'change.yaml'), 'utf8').catch(() => '')
  const created = /^created:\s*(\S+)/m.exec(existingMeta)?.[1] ?? new Date().toISOString().slice(0, 10)
  const links: ChangeLink[] = plan.changes.filter((c) => c.project !== change.project).map((c) => ({ project: c.project, change: c.changeId }))
  await writeFile(path.join(dir, 'change.yaml'), toYaml({
    schema: 'spec-driven',
    created,
    initiative: plan.initiativeId,
    ...(options.project ? { project: options.project.code ? `${options.project.code} · ${options.project.name}` : options.project.name } : {}),
    repository: change.project,
    links,
  }), 'utf8')

  // tasks.md: only what this repository owns, one section per workstream.
  const taskSections = change.workstreams.map((ws) => [
    `## ${ws.title}`,
    '',
    checklist(ws.tasks),
    ws.scopedFiles?.trim() ? `\n**Scoped files**\n${ws.scopedFiles.trim()}` : '',
    ws.outputs?.trim() ? `\n**Outputs**\n${ws.outputs.trim()}` : '',
    ws.dependencies?.trim() && !/^\s*(none|n\/a|independent|-)?\s*$/i.test(ws.dependencies) ? `\n**Depends on**\n${ws.dependencies.trim()}` : '',
    ws.qaFocus?.trim() ? `\n**QA focus**\n${ws.qaFocus.trim()}` : '',
  ].filter((l) => l !== '').join('\n'))
  const spec = await readFile(path.join(options.featureDir, 'spec.md'), 'utf8').catch(() => '')
  const specTitle = /^#\s+(.+)$/m.exec(spec)?.[1]?.trim() ?? plan.initiativeId
  await writeFile(path.join(dir, 'tasks.md'), [
    `# Tasks — ${change.changeId}`,
    '',
    `Repository-local tasks for initiative **${plan.initiativeId}** (${specTitle}). Planning lives in the governing workspace; this file is what this repository owns. Tick items as they land; the pipeline commits it with the code.`,
    '',
    ...taskSections,
    '',
    links.length ? `## Linked changes\n\n${links.map((l) => `- ${l.project} — \`${l.change}\``).join('\n')}` : '',
  ].join('\n').trim() + '\n', 'utf8')

  // specs/<initiative>.md: the delta spec as seen from this repository.
  const scope = change.workstreams.map((ws) => `- **${ws.title}**${ws.outputs?.trim() ? ` — ${firstLine(ws.outputs)}` : ''}`).join('\n')
  await writeFile(path.join(dir, 'spec.md'), [
    `# ${specTitle} — delta for ${change.repo.githubRepo ?? change.repo.label}`,
    '',
    `Initiative: \`${plan.initiativeId}\` · Change: \`${change.changeId}\` · Repository: \`${change.project}\``,
    '',
    '## Scope in this repository',
    '',
    scope || '_See tasks.md._',
    '',
    '## Specification (from the initiative)',
    '',
    spec.trim() ? clip(spec.trim(), 40_000) : '_spec.md not found in the governing workspace at the time of writing._',
  ].join('\n') + '\n', 'utf8')

  return { dir, relativeDir, tasksFile: path.join(relativeDir, 'tasks.md') }
}

/** Instructions appended to an implementation agent's prompt. */
export function repoChangeInstructions(relativeDir: string): string {
  return `Repo-local change: \`${relativeDir}/\` was written into this checkout and is committed with your code.\n- Tick the boxes in \`${relativeDir}/tasks.md\` as tasks land; add a short note under a task if you deviated.\n- Do not edit \`${relativeDir}/change.yaml\` or \`${relativeDir}/spec.md\`; planning changes go through the governing workspace.\n- Do not create other files under \`specs/\`.`
}

function checklist(tasks: string): string {
  const lines = tasks.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim())
  if (lines.length === 0) return '- [ ] (tasks not specified — see the initiative)'
  return lines.map((l) => {
    const t = l.trim()
    if (/^- \[[ xX]\]/.test(t)) return `- ${t.slice(2)}`
    if (/^[-*]\s+/.test(t)) return `- [ ] ${t.replace(/^[-*]\s+/, '')}`
    if (/^\d+[.)]\s+/.test(t)) return `- [ ] ${t.replace(/^\d+[.)]\s+/, '')}`
    return `- [ ] ${t}`
  }).join('\n')
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]!.replace(/^[-*]\s+/, '').trim()
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
