import { createHash, randomUUID } from 'node:crypto'
import { getDb } from './db'

export type IntegrationKind = 'github' | 'jira' | 'confluence'
export type IntegrationStatus = 'not_connected' | 'pending' | 'connected' | 'error'
export type RepoKind = 'local' | 'github'

/**
 * Which connected integrations a project's agents may query, and how queries
 * are narrowed. Empty/undefined fields mean "all connected" / "unscoped".
 */
export interface ProjectKnowledgeConfig {
  /** Subset of connected sources to expose. Omit for all connected. */
  sources?: Array<'jira' | 'linear' | 'confluence' | 'github'>
  jira?: { projects?: string[] }
  linear?: { teams?: string[]; projects?: string[] }
  confluence?: { spaces?: string[] }
  /** GitHub repos (owner/name) in scope; defaults to the project's registered repos. */
  github?: { repos?: string[] }
}

/** Repositories and work areas suggested for a project (after onboarding and after the plan stage). */
export interface ProjectSuggestions {
  generatedAt: string
  basis: 'project' | 'plan'
  repositories: Array<{ fullName: string; reason: string; confidence: 'high' | 'medium' | 'low' | string; role: string; registered: boolean }>
  workAreas: Array<{ name: string; description: string; repositories: string[]; paths: string[]; risks?: string }>
  notes?: string
}

export interface ProjectRow {
  projectId: string
  name: string
  slug: string
  /** Readable code, e.g. PLAT-12: team prefix + per-prefix counter. */
  code?: string | null
  description?: string
  knowledgeJson?: ProjectKnowledgeConfig
  suggestionsJson?: ProjectSuggestions | null
  /** Owning team ("space"); null only for legacy rows before the first user bootstrapped. */
  teamId?: string | null
  /** Set when the project is archived: hidden from the board, no new work; everything kept. */
  archivedAt?: string | null
  /** Set while paused: queued jobs wait, runs stop at the next stage boundary; reversible. */
  pausedAt?: string | null
  createdAt: string
  updatedAt: string
}

export type RepoCloneStatus = 'pending' | 'cloning' | 'ready' | 'error'

export interface RepoRow {
  repoId: string
  projectId: string
  label: string
  kind: RepoKind
  localPath?: string
  githubRepo?: string
  isPrimary: boolean
  addedAt: string
  /** Only set for kind='github': progress of the local clone that runs target. */
  cloneStatus?: RepoCloneStatus
  cloneError?: string
}

export interface IntegrationRow {
  integrationId: string
  projectId: string
  kind: IntegrationKind
  status: IntegrationStatus
  displayName?: string
  configJson: Record<string, unknown>
  credentialsJson?: Record<string, unknown>
  lastSyncedAt?: string
  lastSyncError?: string
  createdAt: string
  updatedAt: string
}

export interface ProjectDetail extends ProjectRow {
  repos: RepoRow[]
  integrations: IntegrationRow[]
}

const PROJECT_COLS = `
  project_id  AS "projectId",
  name        AS "name",
  slug        AS "slug",
  code        AS "code",
  description AS "description",
  knowledge_json AS "knowledgeJson",
  suggestions_json AS "suggestionsJson",
  team_id AS "teamId",
  archived_at AS "archivedAt",
  paused_at AS "pausedAt",
  created_at  AS "createdAt",
  updated_at  AS "updatedAt"
`

const REPO_COLS = `
  repo_id     AS "repoId",
  project_id  AS "projectId",
  label       AS "label",
  kind        AS "kind",
  local_path  AS "localPath",
  github_repo AS "githubRepo",
  is_primary  AS "isPrimary",
  added_at    AS "addedAt",
  clone_status AS "cloneStatus",
  clone_error  AS "cloneError"
`

const INTEGRATION_COLS = `
  integration_id    AS "integrationId",
  project_id        AS "projectId",
  kind              AS "kind",
  status            AS "status",
  display_name      AS "displayName",
  config_json       AS "configJson",
  credentials_json  AS "credentialsJson",
  last_synced_at    AS "lastSyncedAt",
  last_sync_error   AS "lastSyncError",
  created_at        AS "createdAt",
  updated_at        AS "updatedAt"
`

export function generateSlug(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project'
  const hash = createHash('sha256').update(`${name}:${Date.now()}`).digest('hex').slice(0, 8)
  return `${base}-${hash}`
}

export async function createProject(input: {
  name: string
  description?: string
  slug?: string
  /** Owning team ("space"). */
  teamId?: string | null
}): Promise<ProjectRow> {
  const sql = getDb()
  const projectId = randomUUID()
  const slug = input.slug ?? generateSlug(input.name)
  await sql`
    INSERT INTO projects (project_id, name, slug, description, team_id)
    VALUES (${projectId}, ${input.name}, ${slug}, ${input.description ?? null}, ${input.teamId ?? null})
  `
  return (await assignProjectCode(projectId)) ?? (await getProject(projectId))!
}

// ---------------------------------------------------------------------------
// Readable project codes (PLAT-12): prefix from the team name, counter per prefix
// ---------------------------------------------------------------------------

const FALLBACK_PREFIX = 'PRJ'

/** "Platform Engineering" → PE, "payments" → PAYM, "Data & ML team" → DMT (letters only, 2–4 chars). */
export function prefixForTeamName(name: string): string {
  const words = name.toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').split(/\s+/).filter((w) => w && !['TEAM', 'THE', 'AND', 'OF', 'SPACE'].includes(w))
  let prefix = words.length >= 2 ? words.map((w) => w[0]!).join('').slice(0, 4) : (words[0] ?? '').replace(/[^A-Z]/g, '').slice(0, 4)
  if (prefix.length < 2) prefix = (words.join('').replace(/[^A-Z]/g, '') + FALLBACK_PREFIX).slice(0, 4)
  return prefix || FALLBACK_PREFIX
}

/** The team's code prefix, generated (and made unique) on first use. */
export async function ensureTeamPrefix(teamId: string): Promise<string> {
  const sql = getDb()
  const [team] = await sql<Array<{ name: string; codePrefix: string | null }>>`SELECT name, code_prefix AS "codePrefix" FROM teams WHERE team_id = ${teamId}`
  if (!team) return FALLBACK_PREFIX
  if (team.codePrefix) return team.codePrefix
  const base = prefixForTeamName(team.name)
  for (let i = 0; i < 100; i += 1) {
    const candidate = i === 0 ? base : `${base}${i + 1}`
    const [taken] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM teams WHERE code_prefix = ${candidate}`
    if (taken?.n) continue
    const rows = await sql`UPDATE teams SET code_prefix = ${candidate} WHERE team_id = ${teamId} AND code_prefix IS NULL RETURNING team_id`
    if (rows.length) return candidate
    const [now] = await sql<Array<{ codePrefix: string | null }>>`SELECT code_prefix AS "codePrefix" FROM teams WHERE team_id = ${teamId}`
    if (now?.codePrefix) return now.codePrefix
  }
  return FALLBACK_PREFIX
}

/** Give a project the next code for its team's prefix (idempotent). */
export async function assignProjectCode(projectId: string): Promise<ProjectRow | undefined> {
  const sql = getDb()
  const project = await getProject(projectId)
  if (!project) return undefined
  if (project.code) return project
  const prefix = project.teamId ? await ensureTeamPrefix(project.teamId) : FALLBACK_PREFIX
  return sql.begin(async (tx) => {
    // One counter per prefix; the lock serialises concurrent creations.
    await tx`SELECT pg_advisory_xact_lock(8142, hashtext(${prefix}))`
    const [max] = await tx<Array<{ n: number | null }>>`SELECT max(code_number)::int AS n FROM projects WHERE code LIKE ${`${prefix}-%`} AND code_number IS NOT NULL`
    const number = (max?.n ?? 0) + 1
    const [row] = await tx<ProjectRow[]>`
      UPDATE projects SET code = ${`${prefix}-${number}`}, code_number = ${number} WHERE project_id = ${projectId} AND code IS NULL
      RETURNING ${sql.unsafe(PROJECT_COLS)}
    `
    return row ?? (await getProject(projectId))
  })
}

/** Backfill codes for projects created before codes existed, oldest first. */
export async function ensureProjectCodes(): Promise<number> {
  const sql = getDb()
  const rows = await sql<Array<{ projectId: string }>>`SELECT project_id AS "projectId" FROM projects WHERE code IS NULL ORDER BY created_at ASC`
  for (const { projectId } of rows) await assignProjectCode(projectId)
  return rows.length
}

export async function getProjectByCode(code: string): Promise<ProjectRow | undefined> {
  const sql = getDb()
  const [row] = await sql<ProjectRow[]>`SELECT ${sql.unsafe(PROJECT_COLS)} FROM projects WHERE upper(code) = ${code.trim().toUpperCase()}`
  return row
}

export async function getProject(projectId: string): Promise<ProjectRow | undefined> {
  const sql = getDb()
  const [row] = await sql<ProjectRow[]>`
    SELECT ${sql.unsafe(PROJECT_COLS)} FROM projects WHERE project_id = ${projectId}
  `
  return row
}

export async function getProjectBySlug(slug: string): Promise<ProjectRow | undefined> {
  const sql = getDb()
  const [row] = await sql<ProjectRow[]>`
    SELECT ${sql.unsafe(PROJECT_COLS)} FROM projects WHERE slug = ${slug}
  `
  return row
}

/** All projects, or only the given team's ("space") when a team id is supplied. */
export async function listProjects(teamId?: string | null): Promise<ProjectRow[]> {
  const sql = getDb()
  if (teamId) {
    return await sql<ProjectRow[]>`
      SELECT ${sql.unsafe(PROJECT_COLS)} FROM projects WHERE team_id = ${teamId} ORDER BY updated_at DESC
    `
  }
  return await sql<ProjectRow[]>`
    SELECT ${sql.unsafe(PROJECT_COLS)} FROM projects ORDER BY updated_at DESC
  `
}

export async function setProjectPaused(projectId: string, paused: boolean): Promise<ProjectRow | undefined> {
  const sql = getDb()
  const [row] = await sql<ProjectRow[]>`
    UPDATE projects SET paused_at = ${paused ? sql`now()` : null}, updated_at = now() WHERE project_id = ${projectId}
    RETURNING ${sql.unsafe(PROJECT_COLS)}
  `
  return row
}

export async function setProjectArchived(projectId: string, archived: boolean): Promise<ProjectRow | undefined> {
  const sql = getDb()
  const [row] = await sql<ProjectRow[]>`
    UPDATE projects SET archived_at = ${archived ? sql`now()` : null}, updated_at = now() WHERE project_id = ${projectId}
    RETURNING ${sql.unsafe(PROJECT_COLS)}
  `
  return row
}

export async function updateProject(projectId: string, patch: { name?: string; description?: string }): Promise<ProjectRow | undefined> {
  const sql = getDb()
  const [row] = await sql<ProjectRow[]>`
    UPDATE projects
       SET name        = COALESCE(${patch.name ?? null}, name),
           description = COALESCE(${patch.description ?? null}, description)
     WHERE project_id = ${projectId}
     RETURNING ${sql.unsafe(PROJECT_COLS)}
  `
  return row
}

/** Replace a project's knowledge scope (which integrations/repos its agents may query). */
export async function updateProjectKnowledge(projectId: string, config: ProjectKnowledgeConfig): Promise<ProjectRow | undefined> {
  const sql = getDb()
  const [row] = await sql<ProjectRow[]>`
    UPDATE projects
       SET knowledge_json = ${sql.json(config as never)}
     WHERE project_id = ${projectId}
     RETURNING ${sql.unsafe(PROJECT_COLS)}
  `
  return row
}

/** Store the latest repository/work-area suggestions for a project. */
export async function updateProjectSuggestions(projectId: string, suggestions: ProjectSuggestions): Promise<void> {
  const sql = getDb()
  await sql`UPDATE projects SET suggestions_json = ${sql.json(suggestions as never)} WHERE project_id = ${projectId}`
}

export async function deleteProject(projectId: string): Promise<void> {
  const sql = getDb()
  await sql`DELETE FROM projects WHERE project_id = ${projectId}`
}

export async function listRepos(projectId: string): Promise<RepoRow[]> {
  const sql = getDb()
  return await sql<RepoRow[]>`
    SELECT ${sql.unsafe(REPO_COLS)} FROM project_repos
     WHERE project_id = ${projectId}
     ORDER BY is_primary DESC, added_at ASC
  `
}

export async function getRepo(repoId: string): Promise<RepoRow | undefined> {
  const sql = getDb()
  const [row] = await sql<RepoRow[]>`
    SELECT ${sql.unsafe(REPO_COLS)} FROM project_repos WHERE repo_id = ${repoId}
  `
  return row
}

export async function addRepo(input: {
  projectId: string
  label: string
  kind: RepoKind
  localPath?: string
  githubRepo?: string
  isPrimary?: boolean
  cloneStatus?: RepoCloneStatus
}): Promise<RepoRow> {
  const sql = getDb()
  const repoId = randomUUID()
  const isPrimary = input.isPrimary ?? false
  // GitHub repos start life un-cloned; the server kicks off the clone right after insert.
  const cloneStatus = input.cloneStatus ?? (input.kind === 'github' && !input.localPath ? 'pending' : null)

  await sql.begin(async (tx) => {
    if (isPrimary) {
      // Clear any existing primary on this project (unique index enforces one-at-most).
      await tx`UPDATE project_repos SET is_primary = false WHERE project_id = ${input.projectId} AND is_primary`
    }
    await tx`
      INSERT INTO project_repos (repo_id, project_id, label, kind, local_path, github_repo, is_primary, clone_status)
      VALUES (
        ${repoId},
        ${input.projectId},
        ${input.label},
        ${input.kind},
        ${input.localPath ?? null},
        ${input.githubRepo ?? null},
        ${isPrimary},
        ${cloneStatus}
      )
    `
  })
  const row = await getRepo(repoId)
  if (!row) throw new Error('Repo not found after insert')
  return row
}

/** Edit a registered repo: label, local path, GitHub owner/name, or make it primary. */
export async function updateRepo(repoId: string, patch: {
  label?: string
  localPath?: string
  githubRepo?: string
  isPrimary?: boolean
}): Promise<RepoRow | undefined> {
  const sql = getDb()
  const current = await getRepo(repoId)
  if (!current) return undefined
  await sql.begin(async (tx) => {
    if (patch.isPrimary) {
      await tx`UPDATE project_repos SET is_primary = false WHERE project_id = ${current.projectId} AND is_primary`
    }
    await tx`
      UPDATE project_repos
         SET label       = COALESCE(${patch.label ?? null}, label),
             local_path  = COALESCE(${patch.localPath ?? null}, local_path),
             github_repo = COALESCE(${patch.githubRepo ?? null}, github_repo),
             is_primary  = COALESCE(${patch.isPrimary ?? null}, is_primary),
             clone_status = CASE WHEN ${patch.githubRepo ?? null}::text IS NOT NULL AND ${patch.githubRepo ?? null} <> github_repo THEN 'pending' ELSE clone_status END
       WHERE repo_id = ${repoId}
    `
  })
  return getRepo(repoId)
}

export async function removeRepo(repoId: string): Promise<void> {
  const sql = getDb()
  await sql`DELETE FROM project_repos WHERE repo_id = ${repoId}`
}

/** Record clone progress for a GitHub repo; sets local_path once the clone is usable. */
export async function updateRepoClone(repoId: string, patch: {
  cloneStatus: RepoCloneStatus
  cloneError?: string | null
  localPath?: string
}): Promise<RepoRow | undefined> {
  const sql = getDb()
  await sql`
    UPDATE project_repos
       SET clone_status = ${patch.cloneStatus},
           clone_error  = ${patch.cloneError ?? null},
           local_path   = COALESCE(${patch.localPath ?? null}, local_path)
     WHERE repo_id = ${repoId}
  `
  return getRepo(repoId)
}

/** Pick the repo a run should target: primary with a usable local path, else any with one. */
export function pickRunnableRepo(repos: RepoRow[]): RepoRow | undefined {
  return repos.find((r) => r.isPrimary && r.localPath) ?? repos.find((r) => r.localPath)
}

/** Explain why a project can't be run against yet — used for user-facing 400s. */
export function describeUnrunnableRepos(repos: RepoRow[]): string {
  if (repos.length === 0) return 'Project has no repos; add one before running.'
  const github = repos.filter((r) => r.kind === 'github')
  const cloning = github.filter((r) => r.cloneStatus === 'pending' || r.cloneStatus === 'cloning')
  const failed = github.filter((r) => r.cloneStatus === 'error')
  if (cloning.length > 0) {
    return `GitHub repo ${cloning.map((r) => r.githubRepo).join(', ')} is still being cloned locally. Try again in a moment.`
  }
  if (failed.length > 0) {
    return `Clone failed for ${failed.map((r) => `${r.githubRepo} (${r.cloneError ?? 'unknown error'})`).join('; ')}. Fix the GitHub connection and retry the clone.`
  }
  if (github.length > 0) {
    return `GitHub repo ${github.map((r) => r.githubRepo).join(', ')} has not been cloned yet. Trigger a clone from the project page.`
  }
  return 'Project has no local primary repo to run against.'
}

export async function listIntegrations(projectId: string): Promise<IntegrationRow[]> {
  const sql = getDb()
  return await sql<IntegrationRow[]>`
    SELECT ${sql.unsafe(INTEGRATION_COLS)} FROM project_integrations
     WHERE project_id = ${projectId}
     ORDER BY kind ASC
  `
}

export async function upsertIntegration(input: {
  projectId: string
  kind: IntegrationKind
  status?: IntegrationStatus
  displayName?: string
  config?: Record<string, unknown>
  credentials?: Record<string, unknown>
}): Promise<IntegrationRow> {
  const sql = getDb()
  const integrationId = randomUUID()
  const config = input.config ?? {}
  const status = input.status ?? 'not_connected'
  const [row] = await sql<IntegrationRow[]>`
    INSERT INTO project_integrations (
      integration_id, project_id, kind, status, display_name, config_json, credentials_json
    ) VALUES (
      ${integrationId}, ${input.projectId}, ${input.kind}, ${status},
      ${input.displayName ?? null},
      ${sql.json(config as never)},
      ${input.credentials ? sql.json(input.credentials as never) : null}
    )
    ON CONFLICT (project_id, kind) DO UPDATE SET
      status           = EXCLUDED.status,
      display_name     = COALESCE(EXCLUDED.display_name, project_integrations.display_name),
      config_json      = project_integrations.config_json || EXCLUDED.config_json,
      credentials_json = COALESCE(EXCLUDED.credentials_json, project_integrations.credentials_json)
    RETURNING ${sql.unsafe(INTEGRATION_COLS)}
  `
  return row
}

export async function removeIntegration(integrationId: string): Promise<void> {
  const sql = getDb()
  await sql`DELETE FROM project_integrations WHERE integration_id = ${integrationId}`
}

export async function getProjectDetail(projectId: string): Promise<ProjectDetail | undefined> {
  const project = await getProject(projectId)
  if (!project) return undefined
  const [repos, integrations] = await Promise.all([
    listRepos(projectId),
    listIntegrations(projectId),
  ])
  return { ...project, repos, integrations }
}
