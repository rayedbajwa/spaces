import { execFile } from 'node:child_process'
import { appendFile, chmod, cp, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { resolveSpeckitRoot, summarizeCodebaseForMemory } from './aidlc'
import { getDb } from './db'
import { getProject, getRepo } from './project-registry'

const execFileAsync = promisify(execFile)
import { buildContextBundle, upsertProjectMemory } from './context-builder'
import { scheduleRepoClone } from './github'
import { listRepos, pickRunnableRepo, type ProjectRow, type RepoRow } from './project-registry'

/**
 * Project onboarding: the work that happens right after a project is created and
 * before its first run. Phases run in order and every phase does something real:
 *
 *   clone  — clone remote (GitHub) repos into the local workspace
 *   sync   — inventory the codebase (stack, layout, size, docs)
 *   learn  — a read-only agent explores the repo and writes a project brief
 *   memory — store the brief as the project's auto-summary memory and warm the
 *            context bundle that every later stage is prompted with
 *
 * Progress is kept in memory per project so the UI can poll it.
 */

export type OnboardingStepId = 'clone' | 'init' | 'sync' | 'learn' | 'memory'
export type OnboardingStepStatus = 'pending' | 'active' | 'done' | 'skipped' | 'error'

export interface OnboardingStep {
  id: OnboardingStepId
  label: string
  /** Rotating "delightful" sub-messages the UI cycles while the step is active. */
  hints: string[]
  status: OnboardingStepStatus
  detail?: string
  startedAt?: string
  finishedAt?: string
}

export interface OnboardingSnapshot {
  projectId: string
  status: 'idle' | 'running' | 'ready' | 'error'
  steps: OnboardingStep[]
  /** True once a run can target the project (repos are usable), even if learn/memory failed. */
  runnable: boolean
  error?: string
  startedAt?: string
  finishedAt?: string
  updatedAt: string
}

const STEP_TEMPLATE: Array<Omit<OnboardingStep, 'status'>> = [
  {
    id: 'clone',
    label: 'Cloning remote repositories',
    hints: ['Talking to GitHub…', 'Fetching history…', 'Checking out the default branch…'],
  },
  {
    id: 'init',
    label: 'Initializing Spec Kit workspace',
    hints: ['Copying spec, plan and task templates…', 'Wiring up .specify/ scripts…', 'Updating AGENTS.md…'],
  },
  {
    id: 'sync',
    label: 'Syncing project',
    hints: ['Walking the file tree…', 'Detecting the tech stack…', 'Reading the README…'],
  },
  {
    id: 'learn',
    label: 'Learning more about the project',
    hints: ['Opening entry points…', 'Tracing the architecture…', 'Finding build and test commands…', 'Noting conventions…'],
  },
  {
    id: 'memory',
    label: 'Building context & memory from the codebase',
    hints: ['Writing the project brief…', 'Warming the context bundle…'],
  },
]

const jobs = new Map<string, OnboardingSnapshot>()
const inFlight = new Map<string, Promise<OnboardingSnapshot>>()

export function getOnboardingSnapshot(projectId: string): OnboardingSnapshot {
  return jobs.get(projectId) ?? {
    projectId,
    status: 'idle',
    steps: STEP_TEMPLATE.map((step) => ({ ...step, status: 'pending' })),
    runnable: false,
    updatedAt: new Date().toISOString(),
  }
}

function touch(snapshot: OnboardingSnapshot): void {
  snapshot.updatedAt = new Date().toISOString()
}

function setStep(snapshot: OnboardingSnapshot, id: OnboardingStepId, status: OnboardingStepStatus, detail?: string): void {
  const step = snapshot.steps.find((s) => s.id === id)
  if (!step) return
  step.status = status
  if (detail !== undefined) step.detail = detail
  if (status === 'active') step.startedAt = new Date().toISOString()
  if (status === 'done' || status === 'error' || status === 'skipped') step.finishedAt = new Date().toISOString()
  touch(snapshot)
}

/**
 * Start (or join) onboarding for a project. Safe to call repeatedly: a running
 * job is shared, a finished one is restarted.
 */
export function startProjectOnboarding(project: ProjectRow, options: { model?: string } = {}): Promise<OnboardingSnapshot> {
  const existing = inFlight.get(project.projectId)
  if (existing) return existing

  const snapshot: OnboardingSnapshot = {
    projectId: project.projectId,
    status: 'running',
    steps: STEP_TEMPLATE.map((step) => ({ ...step, status: 'pending' })),
    runnable: false,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  jobs.set(project.projectId, snapshot)

  const job = runOnboarding(project, snapshot, options)
    .catch((error) => {
      snapshot.status = 'error'
      snapshot.error = error instanceof Error ? error.message : String(error)
      touch(snapshot)
      return snapshot
    })
    .finally(() => {
      snapshot.finishedAt = new Date().toISOString()
      touch(snapshot)
      inFlight.delete(project.projectId)
    })
  inFlight.set(project.projectId, job)
  return job
}

async function runOnboarding(project: ProjectRow, snapshot: OnboardingSnapshot, options: { model?: string }): Promise<OnboardingSnapshot> {
  // ---- clone -------------------------------------------------------------
  let repos = await listRepos(project.projectId)
  const remote = repos.filter((r) => r.kind === 'github' && r.githubRepo)
  if (remote.length === 0) {
    setStep(snapshot, 'clone', 'skipped', 'No remote repositories; using local paths.')
  } else {
    setStep(snapshot, 'clone', 'active', `Cloning ${remote.map((r) => r.githubRepo).join(', ')}`)
    // Clone first, and wait for it: nothing else is meaningful until the code is local.
    await Promise.all(remote.map((repo) => scheduleRepoClone(repo)))
    repos = await listRepos(project.projectId)
    const failed = repos.filter((r) => r.kind === 'github' && r.cloneStatus === 'error')
    if (failed.length > 0) {
      const detail = failed.map((r) => `${r.githubRepo}: ${r.cloneError ?? 'unknown error'}`).join('; ')
      setStep(snapshot, 'clone', 'error', detail)
      for (const id of ['init', 'sync', 'learn', 'memory'] as OnboardingStepId[]) setStep(snapshot, id, 'skipped')
      snapshot.runnable = Boolean(pickRunnableRepo(repos))
      throw new Error(`Clone failed — ${detail}`)
    }
    setStep(snapshot, 'clone', 'done', `Cloned ${remote.length} repo${remote.length === 1 ? '' : 's'} into the local workspace.`)
  }

  const primary = pickRunnableRepo(repos)
  if (!primary?.localPath) {
    for (const id of ['init', 'sync', 'learn', 'memory'] as OnboardingStepId[]) setStep(snapshot, id, 'skipped')
    throw new Error('No repository with a local path to onboard.')
  }
  snapshot.runnable = true
  touch(snapshot)

  // ---- init --------------------------------------------------------------
  // Spec Kit artifacts live in the primary repo. Set up .specify/ there (same
  // steps as the speckit-init skill, done deterministically) so the first run
  // can go straight to specify.
  setStep(snapshot, 'init', 'active', `Initializing Spec Kit in ${primary.githubRepo ?? primary.localPath}`)
  try {
    const init = await initializeSpecKit(primary.localPath)
    setStep(snapshot, 'init', 'done', init.alreadyInitialized
      ? `.specify/ already present at ${init.repoRoot}; left as is.`
      : `Created .specify/ (${init.installedFiles} files) and ${init.agentsMdUpdated ? 'updated' : 'left'} AGENTS.md at ${init.repoRoot}.`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    setStep(snapshot, 'init', 'error', message)
  }

  // Multi-repo projects: every repo with a local checkout is inventoried and
  // learned, so later stages know where each module lives and how to build/test it.
  const localRepos = repos.filter((r): r is RepoRow & { localPath: string } => Boolean(r.localPath))
  const repoName = (r: RepoRow) => r.githubRepo ?? r.label

  // ---- sync --------------------------------------------------------------
  setStep(snapshot, 'sync', 'active', localRepos.length > 1 ? `Inventorying ${localRepos.length} repositories…` : undefined)
  const inventories = await Promise.all(localRepos.map(async (repo) => ({ repo, inventory: await inventoryCodebase(repo.localPath, [repo]) })))
  setStep(
    snapshot,
    'sync',
    'done',
    inventories.length === 1
      ? inventories[0]!.inventory.headline
      : inventories.map(({ repo, inventory }) => `${repoName(repo)}: ${inventory.headline}`).join(' · '),
  )

  // ---- learn -------------------------------------------------------------
  setStep(snapshot, 'learn', 'active', localRepos.length > 1 ? `Reading ${localRepos.length} repositories in parallel…` : undefined)
  const briefs = await Promise.all(inventories.map(async ({ repo, inventory }) => {
    try {
      const brief = await summarizeCodebaseForMemory({
        cwd: repo.localPath,
        model: options.model,
        inventory: inventory.markdown,
        projectName: localRepos.length > 1 ? `${project.name} / ${repoName(repo)}` : project.name,
      })
      return { repo, brief, error: undefined as string | undefined }
    } catch (error) {
      // The repo is usable even if the agent couldn't run; keep the inventory as memory.
      const message = error instanceof Error ? error.message : String(error)
      return { repo, brief: `_Codebase brief unavailable: ${message}_`, error: message }
    }
  }))
  const learnErrors = briefs.filter((b) => b.error)
  if (learnErrors.length === briefs.length) {
    setStep(snapshot, 'learn', 'error', learnErrors.map((b) => `${repoName(b.repo)}: ${b.error}`).join('; '))
  } else {
    const words = briefs.reduce((n, b) => n + b.brief.split(/\s+/).length, 0)
    const note = learnErrors.length > 0 ? ` (${learnErrors.map((b) => repoName(b.repo)).join(', ')} failed)` : ''
    setStep(snapshot, 'learn', 'done', `${words} words of project brief across ${briefs.length} repo${briefs.length === 1 ? '' : 's'}${note}.`)
  }

  // ---- memory ------------------------------------------------------------
  // Each repository's brief + inventory is stored as its own record, and the
  // project memory is composed from all of them. Adding a repository later
  // (e.g. one the plan depends on) learns just that repo and recomposes.
  setStep(snapshot, 'memory', 'active')
  for (const { repo, inventory } of inventories) {
    const brief = briefs.find((b) => b.repo.repoId === repo.repoId)
    await saveRepoBrief(project.projectId, repo, inventory.markdown, brief?.brief ?? '_Codebase brief unavailable._', brief?.error)
  }
  await composeProjectMemory(project.projectId)
  // Warm the context bundle so the first run's prompt is ready.
  await buildContextBundle({ projectId: project.projectId, projectSlug: project.slug, projectPath: primary.localPath })
  setStep(snapshot, 'memory', 'done', 'Project memory saved; context bundle warmed.')

  snapshot.status = snapshot.steps.some((s) => s.status === 'error') ? 'error' : 'ready'
  if (snapshot.status === 'error') {
    snapshot.error = snapshot.steps.filter((s) => s.status === 'error').map((s) => `${s.label}: ${s.detail}`).join('; ')
  }
  touch(snapshot)
  return snapshot
}

// ---------------------------------------------------------------------------
// Codebase inventory (no model involved)
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'target', 'vendor', '.next', '.turbo', 'coverage', '__pycache__', '.venv', 'venv'])
const MAX_FILES = 20_000

const STACK_MARKERS: Array<[string, string]> = [
  ['package.json', 'Node.js / JavaScript'],
  ['bun.lock', 'Bun'],
  ['bun.lockb', 'Bun'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'Yarn'],
  ['tsconfig.json', 'TypeScript'],
  ['go.mod', 'Go'],
  ['Cargo.toml', 'Rust'],
  ['pyproject.toml', 'Python (pyproject)'],
  ['requirements.txt', 'Python (pip)'],
  ['Pipfile', 'Python (pipenv)'],
  ['pom.xml', 'Java (Maven)'],
  ['build.gradle', 'JVM (Gradle)'],
  ['build.gradle.kts', 'JVM (Gradle Kotlin)'],
  ['Gemfile', 'Ruby'],
  ['composer.json', 'PHP'],
  ['mix.exs', 'Elixir'],
  ['Package.swift', 'Swift'],
  ['Dockerfile', 'Docker'],
  ['docker-compose.yml', 'Docker Compose'],
  ['.github/workflows', 'GitHub Actions'],
  ['.specify', 'Spec Kit'],
  ['Makefile', 'Make'],
]

interface Inventory {
  headline: string
  markdown: string
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

export async function inventoryCodebase(root: string, repos: RepoRow[]): Promise<Inventory> {
  const stack: string[] = []
  for (const [marker, label] of STACK_MARKERS) {
    if (await exists(path.join(root, marker)) && !stack.includes(label)) stack.push(label)
  }

  const topLevel = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => !entry.name.startsWith('.') || entry.name === '.specify' || entry.name === '.github')
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .sort()

  const extCounts = new Map<string, number>()
  let fileCount = 0
  let truncated = false
  const walk = async (dir: string): Promise<void> => {
    if (fileCount >= MAX_FILES) { truncated = true; return }
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (fileCount >= MAX_FILES) { truncated = true; return }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        await walk(path.join(dir, entry.name))
      } else if (entry.isFile()) {
        fileCount += 1
        const ext = path.extname(entry.name).toLowerCase() || '(none)'
        extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1)
      }
    }
  }
  await walk(root)

  const topExts = [...extCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)

  let readmeHead = ''
  for (const candidate of ['README.md', 'readme.md', 'README', 'README.rst']) {
    const p = path.join(root, candidate)
    if (await exists(p)) {
      const text = await readFile(p, 'utf8').catch(() => '')
      readmeHead = text.split('\n').slice(0, 40).join('\n').trim()
      break
    }
  }

  const scripts = await readPackageScripts(path.join(root, 'package.json'))

  const headline = `${stack.length ? stack.slice(0, 4).join(', ') : 'Unknown stack'} · ${fileCount}${truncated ? '+' : ''} files`

  const markdown = [
    `- Root: \`${root}\``,
    `- Repositories: ${repos.map((r) => `${r.label} (${r.githubRepo ?? r.localPath}${r.isPrimary ? ', primary' : ''})`).join('; ')}`,
    `- Detected stack: ${stack.length ? stack.join(', ') : 'none detected'}`,
    `- Files: ${fileCount}${truncated ? '+ (walk truncated)' : ''}`,
    `- Top file types: ${topExts.map(([ext, n]) => `${ext} ×${n}`).join(', ') || 'n/a'}`,
    `- Top-level entries: ${topLevel.join(', ') || '(empty)'}`,
    scripts ? `- package.json scripts: ${scripts}` : undefined,
    readmeHead ? `\n### README (first lines)\n\n${readmeHead}` : '- README: not found',
  ].filter(Boolean).join('\n')

  return { headline, markdown }
}

// ---------------------------------------------------------------------------
// Spec Kit initialization (deterministic port of the speckit-init skill)
// ---------------------------------------------------------------------------

const AGENTS_MD_SPECKIT_SECTION = `
## Spec-Kit

This repository uses the [spec-kit](https://github.com/github/spec-kit) workflow for AI-assisted feature development.
Spec-kit is a convention for structuring feature specs, plans, and tasks in a \`.specify/\` directory so that AI agents can read and act on them.
This project uses an opinionated local tooling layer to generate the artifacts that live there — the source of truth for the workflow itself is the spec-kit repo linked above.

### \`.specify/\` directory

| Path | Purpose |
|------|---------|
| \`.specify/templates/\` | Markdown templates for specs, plans, tasks, and checklists |
| \`.specify/memory/\` | Long-lived context files (e.g. \`constitution.md\`) read by agents |
| \`.specify/scripts/\` | Helper shell scripts for common workflow steps |
| \`.specify/hooks.yml\` | CI/automation hook definitions |

### How to use it

- Start a new feature: \`/speckit-specify\` — creates a spec from a template and opens a clarification loop.
- Generate a plan: \`/speckit-plan\` — converts an approved spec into a structured plan.
- Break into tasks: \`/speckit-tasks\` — decomposes a plan into trackable tasks.
- Implement: \`/speckit-implement\` — works through tasks and updates checklists.
`

export interface SpecKitInitResult {
  repoRoot: string
  alreadyInitialized: boolean
  installedFiles: number
  agentsMdUpdated: boolean
}

/**
 * Set up `.specify/` in a repository exactly as the speckit-init skill does:
 * copy the bundled templates, make scripts executable, and add the Spec-Kit
 * section to AGENTS.md. Idempotent. Initializes git first if the path is not a
 * repository yet, because every later stage works on feature branches.
 */
export async function initializeSpecKit(repoPath: string): Promise<SpecKitInitResult> {
  let repoRoot: string
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: repoPath })
    repoRoot = stdout.trim()
  } catch {
    await execFileAsync('git', ['init', '-q'], { cwd: repoPath })
    repoRoot = repoPath
  }

  const specifyDir = path.join(repoRoot, '.specify')
  if (await exists(specifyDir)) {
    return { repoRoot, alreadyInitialized: true, installedFiles: 0, agentsMdUpdated: false }
  }

  const templatesDir = path.join(resolveSpeckitRoot(), 'specify-templates')
  if (!(await exists(templatesDir))) {
    throw new Error(`Spec Kit templates not found at ${templatesDir}.`)
  }
  await cp(templatesDir, specifyDir, { recursive: true })

  const scriptsDir = path.join(specifyDir, 'scripts', 'bash')
  if (await exists(scriptsDir)) {
    for (const entry of await readdir(scriptsDir)) {
      if (entry.endsWith('.sh')) await chmod(path.join(scriptsDir, entry), 0o755)
    }
  }

  let installedFiles = 0
  const count = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) await count(path.join(dir, entry.name))
      else installedFiles += 1
    }
  }
  await count(specifyDir)

  const agentsMd = path.join(repoRoot, 'AGENTS.md')
  let agentsMdUpdated = false
  if (await exists(agentsMd)) {
    const current = await readFile(agentsMd, 'utf8')
    if (!/^## Spec-Kit\b/m.test(current)) {
      await appendFile(agentsMd, `${current.endsWith('\n') ? '' : '\n'}${AGENTS_MD_SPECKIT_SECTION}`)
      agentsMdUpdated = true
    }
  } else {
    await writeFile(agentsMd, AGENTS_MD_SPECKIT_SECTION.trimStart())
    agentsMdUpdated = true
  }

  return { repoRoot, alreadyInitialized: false, installedFiles, agentsMdUpdated }
}

// ---------------------------------------------------------------------------
// Per-repository knowledge → project memory
// ---------------------------------------------------------------------------

/** Snapshot source used for codebase briefs (kept out of the "Source Snapshots" prompt section). */
export const CODEBASE_SNAPSHOT_SOURCE = 'codebase'

interface RepoBriefRow {
  entityId: string
  title: string
  content: string
  metadata: { label?: string; githubRepo?: string; localPath?: string; isPrimary?: boolean; error?: string; learnedAt?: string } | null
}

/** Store (replace) one repository's brief + inventory as a codebase snapshot. */
export async function saveRepoBrief(projectId: string, repo: RepoRow, inventoryMarkdown: string, brief: string, error?: string): Promise<void> {
  const sql = getDb()
  const name = repo.githubRepo ?? repo.label
  const content = `${brief.trim()}\n\n### Inventory\n${inventoryMarkdown.trim()}`
  await sql.begin(async (tx) => {
    await tx`DELETE FROM project_source_snapshots WHERE project_id = ${projectId} AND source = ${CODEBASE_SNAPSHOT_SOURCE} AND entity_id = ${repo.repoId}`
    await tx`
      INSERT INTO project_source_snapshots (project_id, source, scope, entity_type, entity_id, title, content, url, metadata)
      VALUES (${projectId}, ${CODEBASE_SNAPSHOT_SOURCE}, ${repo.label}, 'repository-brief', ${repo.repoId}, ${name}, ${content},
              ${repo.githubRepo ? `https://github.com/${repo.githubRepo}` : null},
              ${tx.json({ label: repo.label, githubRepo: repo.githubRepo, localPath: repo.localPath, isPrimary: repo.isPrimary, error, learnedAt: new Date().toISOString() } as never)})
    `
  })
}

/**
 * Rebuild the project's auto-summary memory from the registered repositories
 * and their stored briefs, then warm the context bundle. Repositories that have
 * a checkout but no brief yet are listed as "not learned yet" so agents know
 * the code exists and where, even before the learn step finishes.
 */
export async function composeProjectMemory(projectId: string): Promise<string> {
  const sql = getDb()
  const project = await getProject(projectId)
  if (!project) throw new Error('Project not found.')
  const repos = await listRepos(projectId)
  const briefs = await sql<RepoBriefRow[]>`
    SELECT entity_id AS "entityId", title, content, metadata
      FROM project_source_snapshots
     WHERE project_id = ${projectId} AND source = ${CODEBASE_SNAPSHOT_SOURCE}
     ORDER BY fetched_at ASC
  `
  const briefByRepo = new Map(briefs.map((b) => [b.entityId, b]))
  const localRepos = repos.filter((r) => Boolean(r.localPath))
  const repoName = (r: RepoRow) => r.githubRepo ?? r.label

  const repoMap = repos.map((r) => {
    const status = !r.localPath
      ? (r.cloneStatus === 'error' ? `clone failed: ${r.cloneError ?? 'unknown error'}` : r.cloneStatus ? `clone ${r.cloneStatus}` : 'no local checkout')
      : briefByRepo.has(r.repoId) ? 'learned' : 'available, not learned yet'
    return `- **${r.label}** — ${r.githubRepo ?? 'local'} → \`${r.localPath ?? '(not cloned)'}\`${r.isPrimary ? ' (primary: Spec Kit artifacts live here)' : ''} · ${status}`
  }).join('\n')

  const sections: string[] = [
    `# ${project.name} — project memory`,
    `_Updated ${new Date().toISOString()} · ${repos.length} repositor${repos.length === 1 ? 'y' : 'ies'}, ${briefs.length} learned_`,
    '',
    '## Repository map',
    repoMap,
    repos.length > 1
      ? '\nThis project spans multiple repositories. Plans, tasks and workstreams must name the repository they touch; implementation and QA run inside that repository\'s checkout. Tasks that were blocked on a repository listed above as available can now be implemented in that checkout.'
      : '',
  ]
  for (const repo of localRepos) {
    const brief = briefByRepo.get(repo.repoId)
    if (!brief) continue
    sections.push('', repos.length > 1 ? `# Repository: ${repoName(repo)}` : '', brief.content.trim())
  }
  const autoSummary = sections.filter((line) => line !== undefined).join('\n')
  await upsertProjectMemory(projectId, { autoSummary })
  const primary = pickRunnableRepo(repos)
  if (primary?.localPath) {
    await buildContextBundle({ projectId, projectSlug: project.slug, projectPath: primary.localPath }).catch(() => undefined)
  }
  return autoSummary
}

const refreshing = new Map<string, Promise<void>>()

/**
 * Learn one repository (inventory + agent brief) and recompose the project
 * memory. Called after a repo is added, re-cloned or edited, so context and
 * memory reflect the new checkout and previously blocked tasks can proceed.
 * Concurrent calls for the same repo share one refresh.
 */
export function refreshRepositoryKnowledge(projectId: string, repoId: string, options: { model?: string } = {}): Promise<void> {
  const key = `${projectId}:${repoId}`
  const existing = refreshing.get(key)
  if (existing) return existing
  const job = (async () => {
    const project = await getProject(projectId)
    const repo = await getRepo(repoId)
    if (!project || !repo) return
    if (!repo.localPath) {
      // Not cloned (yet, or failed): still record it in the repository map.
      await composeProjectMemory(projectId)
      return
    }
    const inventory = await inventoryCodebase(repo.localPath, [repo])
    let brief = ''
    let error: string | undefined
    try {
      brief = await summarizeCodebaseForMemory({
        cwd: repo.localPath,
        model: options.model ?? 'anthropic/claude-sonnet-4-5',
        inventory: inventory.markdown,
        projectName: `${project.name} / ${repo.githubRepo ?? repo.label}`,
      })
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
      brief = `_Codebase brief unavailable: ${error}_`
    }
    await saveRepoBrief(projectId, repo, inventory.markdown, brief, error)
    await composeProjectMemory(projectId)
  })().finally(() => refreshing.delete(key))
  refreshing.set(key, job)
  return job
}

async function readPackageScripts(pkgPath: string): Promise<string | undefined> {
  if (!(await exists(pkgPath))) return undefined
  try {
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as { scripts?: Record<string, string> }
    const entries = Object.entries(pkg.scripts ?? {})
    if (entries.length === 0) return undefined
    return entries.slice(0, 12).map(([name, cmd]) => `\`${name}\` → \`${cmd}\``).join(', ')
  } catch {
    return undefined
  }
}
