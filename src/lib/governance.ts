import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { findLatestFeatureDirAbsolute, parsePlanRepositories } from './aidlc'
import { getDb } from './db'
import { getGitHubToken, scheduleRepoClone, workspaceRoot } from './github'
import { log } from './logger'
import { initializeSpecKit, refreshRepositoryKnowledge } from './project-onboarding'
import { addRepo, getProject, listRepos, pickRunnableRepo, type ProjectRow, type RepoRow } from './project-registry'

const execFileAsync = promisify(execFile)
const govLog = log.child({ mod: 'governance' })

/**
 * Governing workspace: one local git repository per project that owns the
 * Spec Kit workspace (`.specify/`, `specs/<feature>/…`), exported project
 * memory, imported knowledge and reports. It is the project's primary repo, so
 * runs target it; application code lives in the (secondary) repositories the
 * plan names, which are added and cloned on demand. The workspace on local disk
 * (a git repository with full history) is the long-term store.
 */

export const GOVERNANCE_LABEL = 'governance'

export function governanceEnabled(): boolean {
  return (process.env.AIDLC_GOVERNANCE_WORKSPACE ?? '1') !== '0'
}

export function governanceRoot(): string {
  const configured = process.env.AIDLC_GOVERNANCE_ROOT?.trim()
  return configured ? path.resolve(configured) : path.join(workspaceRoot(), '_governance')
}

export function governancePathFor(slug: string): string {
  return path.join(governanceRoot(), slug)
}

export function isGovernanceRepo(repo: Pick<RepoRow, 'label' | 'localPath'>): boolean {
  return repo.label === GOVERNANCE_LABEL || (repo.localPath ? path.resolve(repo.localPath).startsWith(governanceRoot()) : false)
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 120_000 })
  return stdout.trim()
}

/**
 * Create the governing workspace for a project if it does not exist and
 * register it as the primary repository. Idempotent.
 */
export async function ensureGovernanceWorkspace(project: ProjectRow): Promise<RepoRow> {
  const repos = await listRepos(project.projectId)
  const existing = repos.find((r) => isGovernanceRepo(r))
  const dir = existing?.localPath ?? governancePathFor(project.slug)
  await mkdir(dir, { recursive: true })

  let isRepo = true
  try { await git(dir, ['rev-parse', '--is-inside-work-tree']) } catch { isRepo = false }
  if (!isRepo) {
    await git(dir, ['init', '-q'])
    await writeFile(path.join(dir, 'README.md'), [
      `# ${project.name} — governing workspace`,
      '',
      `This repository is managed by Spaces for the project **${project.name}** (slug \`${project.slug}\`).`,
      'It holds the Spec Kit workspace (`.specify/`), every feature\'s specs, plans, tasks, test plans and reports (`specs/<feature>/`),',
      'exported project memory (`memory/`), imported tickets and docs (`knowledge/`) and the project manifest (`project.json`).',
      '',
      'Application code lives in the repositories listed in `project.json` / each plan\'s "## Repositories" section;',
      'implementation and QA run inside those checkouts. Do not put application code here.',
      '',
    ].join('\n'))
    await writeFile(path.join(dir, '.gitignore'), '.aidlc/\n.aidlc-worktrees/\nnode_modules/\n')
    await git(dir, ['add', '-A'])
    await git(dir, ['-c', 'user.name=AIDLC Governance', '-c', 'user.email=aidlc-governance@users.noreply.github.com', 'commit', '-q', '-m', 'Initialize governing workspace'])
  }
  await initializeSpecKit(dir).catch((error) => govLog.warn('spec kit init in governance workspace failed', { error: String(error) }))

  if (existing) return existing
  const row = await addRepo({ projectId: project.projectId, label: GOVERNANCE_LABEL, kind: 'local', localPath: dir, isPrimary: true })
  govLog.info('governing workspace created', { slug: project.slug, dir })
  return row
}

/**
 * Write the project's durable state into the governing workspace and commit:
 * memory (auto + manual), imported knowledge, the repository manifest and the
 * latest delivery/verification pointers. Git history in the workspace is the archive.
 */
export async function exportProjectState(projectId: string, reason = 'state export'): Promise<{ dir: string; committed: boolean } | undefined> {
  const project = await getProject(projectId)
  if (!project) return undefined
  const repos = await listRepos(projectId)
  const gov = repos.find((r) => isGovernanceRepo(r))
  if (!gov?.localPath) return undefined
  const dir = gov.localPath
  const sql = getDb()

  const [memory] = await sql<Array<{ manualText: string; autoSummary: string; updatedAt: string }>>`
    SELECT manual_text AS "manualText", auto_summary AS "autoSummary", updated_at AS "updatedAt" FROM project_memory WHERE project_id = ${projectId}
  `
  const snapshots = await sql<Array<{ source: string; entityType: string; entityId: string; title: string; content: string; url: string | null; fetchedAt: string }>>`
    SELECT source, entity_type AS "entityType", entity_id AS "entityId", title, content, url, fetched_at AS "fetchedAt"
      FROM project_source_snapshots WHERE project_id = ${projectId} ORDER BY fetched_at DESC LIMIT 200
  `

  await mkdir(path.join(dir, 'memory'), { recursive: true })
  await mkdir(path.join(dir, 'knowledge'), { recursive: true })
  await writeFile(path.join(dir, 'memory', 'auto-summary.md'), `${(memory?.autoSummary ?? '').trim()}\n`)
  await writeFile(path.join(dir, 'memory', 'manual.md'), `${(memory?.manualText ?? '').trim()}\n`)
  for (const snap of snapshots) {
    const safe = `${snap.source}-${snap.entityId}`.replace(/[^\w.-]+/g, '_').slice(0, 120)
    await writeFile(path.join(dir, 'knowledge', `${safe}.md`), `---\nsource: ${snap.source}\ntype: ${snap.entityType}\nid: ${snap.entityId}\ntitle: ${snap.title.replace(/\n/g, ' ')}\nurl: ${snap.url ?? ''}\nfetched: ${snap.fetchedAt}\n---\n\n${snap.content.trim()}\n`)
  }
  await writeFile(path.join(dir, 'project.json'), `${JSON.stringify({
    projectId,
    slug: project.slug,
    name: project.name,
    description: project.description ?? null,
    knowledge: project.knowledgeJson ?? {},
    repositories: repos.map((r) => ({ label: r.label, kind: r.kind, githubRepo: r.githubRepo ?? null, localPath: r.localPath ?? null, isPrimary: r.isPrimary, cloneStatus: r.cloneStatus ?? null, governance: isGovernanceRepo(r) })),
    exportedAt: new Date().toISOString(),
  }, null, 2)}\n`)

  let committed = false
  try {
    await git(dir, ['add', '-A'])
    const status = await git(dir, ['status', '--porcelain'])
    if (status) {
      await git(dir, ['-c', 'user.name=AIDLC Governance', '-c', 'user.email=aidlc-governance@users.noreply.github.com', 'commit', '-q', '-m', `chore: ${reason}`])
      committed = true
    }
  } catch (error) {
    govLog.warn('governance commit failed', { slug: project.slug, error: error instanceof Error ? error.message : String(error) })
  }
  return { dir, committed }
}

/**
 * After the plan stage: register every repository the plan names that is not
 * on the project yet. GitHub-hosted ones (owner/name, or a name found in the
 * synced GitHub catalog) are cloned, learned and set up automatically.
 */
export async function reconcilePlanRepositories(projectId: string, primaryPath: string): Promise<{ added: string[]; unknown: string[] }> {
  const featureDir = await findLatestFeatureDirAbsolute(primaryPath)
  if (!featureDir) return { added: [], unknown: [] }
  let plan = ''
  try { plan = await readFile(path.join(featureDir, 'plan.md'), 'utf8') } catch { return { added: [], unknown: [] } }
  const refs = parsePlanRepositories(plan)
  if (refs.length === 0) return { added: [], unknown: [] }
  const repos = await listRepos(projectId)
  const norm = (v: string) => v.trim().toLowerCase().replace(/\.git$/, '')
  const registered = (name: string) => /^primary$/i.test(name) || repos.some((r) =>
    norm(name) === norm(r.label)
    || (r.githubRepo ? norm(name) === norm(r.githubRepo) || norm(name) === norm(r.githubRepo.split('/')[1] ?? '') : false)
    || (r.localPath ? norm(name) === norm(path.basename(r.localPath)) : false))
  const added: string[] = []
  const unknown: string[] = []
  const sql = getDb()
  const { orgIdForProject } = await import('./orgs')
  const catalogOrgId = await orgIdForProject(projectId)
  for (const ref of refs) {
    if (registered(ref.name)) continue
    let githubRepo = ref.githubRepo
    if (!githubRepo) {
      // Bare name → look it up in the synced GitHub catalog.
      // The catalog belongs to an organization: a plan must never resolve a bare
      // repository name against another tenant's repositories.
      const [hit] = await sql<Array<{ fullName: string }>>`
        SELECT full_name AS "fullName" FROM github_repo_index
         WHERE org_id = ${catalogOrgId}
           AND (lower(full_name) = ${norm(ref.name)} OR lower(split_part(full_name, '/', 2)) = ${norm(ref.name)})
         ORDER BY updated_at DESC LIMIT 1
      `
      githubRepo = hit?.fullName
    }
    if (!githubRepo) { unknown.push(ref.name); continue }
    const repo = await addRepo({ projectId, label: githubRepo.split('/')[1] ?? ref.name, kind: 'github', githubRepo, isPrimary: false })
    added.push(githubRepo)
    void scheduleRepoClone(repo).then(() => refreshRepositoryKnowledge(projectId, repo.repoId)).catch((error) => govLog.warn('auto-added repo clone/learn failed', { githubRepo, error: String(error) }))
  }
  if (added.length || unknown.length) govLog.info('plan repositories reconciled', { projectId, added, unknown })
  return { added, unknown }
}

// ---------------------------------------------------------------------------
// GitHub repository catalog ("local sync of repositories and their use cases")
// ---------------------------------------------------------------------------

export interface CatalogEntry {
  fullName: string
  description?: string
  language?: string
  topics: string[]
  defaultBranch?: string
  usecase?: string
  private: boolean
  updatedAt?: string
  indexedAt: string
}

/**
 * Index every repository the connected GitHub account can see: metadata plus
 * the first meaningful README paragraph as its "use case". Runs on connect and
 * periodically; the plan stage reads the catalog to name repositories without
 * anyone selecting them up front.
 */
export async function syncGitHubRepoCatalog(orgId: string, options: { maxRepos?: number } = {}): Promise<{ indexed: number }> {
  const { listGitHubRepos } = await import('./github')
  const token = await getGitHubToken(orgId)
  const repos = (await listGitHubRepos(orgId, { maxPages: 5 })).slice(0, options.maxRepos ?? 300)
  const sql = getDb()
  let indexed = 0
  for (const repo of repos) {
    let usecase: string | undefined
    let topics: string[] = []
    let language: string | undefined
    try {
      const meta = await fetch(`https://api.github.com/repos/${repo.fullName}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'pi-speckit-pdlc' } })
      if (meta.ok) {
        const m = (await meta.json()) as { topics?: string[]; language?: string | null }
        topics = m.topics ?? []
        language = m.language ?? undefined
      }
      const readme = await fetch(`https://api.github.com/repos/${repo.fullName}/readme`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.raw+json', 'User-Agent': 'pi-speckit-pdlc' } })
      if (readme.ok) {
        const text = await readme.text()
        const paragraph = text.split(/\n\s*\n/).map((p) => p.replace(/^#.*$/gm, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`>]/g, '').trim()).find((p) => p.length > 40)
        usecase = paragraph?.slice(0, 400)
      }
    } catch {
      // metadata is best-effort
    }
    await sql`
      INSERT INTO github_repo_index (org_id, full_name, description, language, topics, default_branch, usecase, is_private, updated_at, indexed_at)
      VALUES (${orgId}, ${repo.fullName}, ${repo.description ?? null}, ${language ?? null}, ${sql.json(topics as never)}, ${repo.defaultBranch ?? null}, ${usecase ?? null}, ${repo.private}, ${repo.updatedAt ?? null}, now())
      ON CONFLICT (org_id, full_name) DO UPDATE SET
        description = EXCLUDED.description, language = EXCLUDED.language, topics = EXCLUDED.topics,
        default_branch = EXCLUDED.default_branch, usecase = COALESCE(EXCLUDED.usecase, github_repo_index.usecase),
        is_private = EXCLUDED.is_private, updated_at = EXCLUDED.updated_at, indexed_at = now()
    `
    indexed += 1
  }
  govLog.info('GitHub repository catalog synced', { indexed })
  return { indexed }
}

export async function listRepoCatalog(orgId: string, limit = 200): Promise<CatalogEntry[]> {
  const sql = getDb()
  const rows = await sql<Array<{ fullName: string; description: string | null; language: string | null; topics: string[] | null; defaultBranch: string | null; usecase: string | null; isPrivate: boolean; updatedAt: string | null; indexedAt: string }>>`
    SELECT full_name AS "fullName", description, language, topics, default_branch AS "defaultBranch", usecase, is_private AS "isPrivate",
           updated_at AS "updatedAt", indexed_at AS "indexedAt"
      FROM github_repo_index WHERE org_id = ${orgId} ORDER BY updated_at DESC NULLS LAST LIMIT ${limit}
  `
  return rows.map((r) => ({
    fullName: r.fullName,
    description: r.description ?? undefined,
    language: r.language ?? undefined,
    topics: r.topics ?? [],
    defaultBranch: r.defaultBranch ?? undefined,
    usecase: r.usecase ?? undefined,
    private: r.isPrivate,
    updatedAt: r.updatedAt ?? undefined,
    indexedAt: r.indexedAt,
  }))
}

/** Compact Markdown catalog for the shared context: what each repo is for. */
export async function renderRepoCatalog(orgId: string, limit = 60): Promise<string> {
  const entries = await listRepoCatalog(orgId, limit).catch(() => [] as CatalogEntry[])
  if (entries.length === 0) return ''
  return entries.map((e) => `- **${e.fullName}**${e.language ? ` (${e.language})` : ''}${e.topics.length ? ` [${e.topics.slice(0, 4).join(', ')}]` : ''} — ${(e.usecase ?? e.description ?? 'no description').replace(/\s+/g, ' ').slice(0, 160)}`).join('\n')
}

/** Primary checkout for a project (governance workspace when enabled). */
export async function primaryPathFor(projectId: string): Promise<string | undefined> {
  const repos = await listRepos(projectId)
  return pickRunnableRepo(repos)?.localPath
}
