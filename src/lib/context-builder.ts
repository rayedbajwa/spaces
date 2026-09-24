import { activeFeatureId } from './active-feature'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDb } from './db'
import { resolveKnowledgeScope, SOURCE_LABEL, type KnowledgeSource } from './integration-sources'
import { log } from './logger'
import { getProject } from './project-registry'

const contextLog = log.child({ mod: 'context-builder' })

/**
 * Organization and team memory: the two shared layers above a project (AIDLC
 * "spaces"). The organization layer is visible to every team; the team layer
 * only to that team's projects.
 */
async function loadSharedMemoryLayers(projectId?: string): Promise<{ orgName: string; orgMemory: string; teamName?: string; teamMemory: string }> {
  const sql = getDb()
  // Organization memory is per tenant. This used to read the single row the
  // table had before tenancy, which has not existed since — and the failure was
  // swallowed, so every agent ran with no organization memory at all.
  const { getDefaultOrgId, orgIdForProject } = await import('./orgs')
  const orgId = projectId ? await orgIdForProject(projectId) : await getDefaultOrgId()
  const [org] = await sql<Array<{ name: string; manualText: string }>>`
    SELECT name, manual_text AS "manualText" FROM org_memory WHERE org_id = ${orgId}
  `.catch((error) => {
    contextLog.warn('organization memory could not be read', { orgId, error: error instanceof Error ? error.message : String(error) })
    return []
  })
  let teamName: string | undefined
  let teamMemory = ''
  if (projectId) {
    const project = await getProject(projectId).catch(() => undefined)
    if (project?.teamId) {
      const [team] = await sql<Array<{ name: string; manualText: string | null }>>`
        SELECT t.name, m.manual_text AS "manualText" FROM teams t LEFT JOIN team_memory m ON m.team_id = t.team_id WHERE t.team_id = ${project.teamId}
      `.catch((error) => {
        contextLog.warn('team memory could not be read', { teamId: project.teamId, error: error instanceof Error ? error.message : String(error) })
        return []
      })
      teamName = team?.name
      teamMemory = team?.manualText ?? ''
    }
  }
  return { orgName: org?.name ?? 'Organization', orgMemory: org?.manualText ?? '', teamName, teamMemory }
}

const srcDir = dirname(fileURLToPath(import.meta.url))
const rootDir = join(srcDir, '..', '..')
const orgDir = join(rootDir, 'data', 'org')

export interface ContextArtifact {
  label: string
  path: string
  content: string
}

export interface SourceSnapshot {
  source: string
  scope?: string
  entityType: string
  entityId: string
  title: string
  content: string
  url?: string
  fetchedAt: string
  metadata?: Record<string, unknown>
}

export interface ContextBundle {
  projectId?: string
  projectSlug?: string
  projectPath: string
  org: Record<string, string>
  project: {
    memory: string
    manualMemory: string
    autoSummary: string
    sources: SourceSnapshot[]
  }
  featureArtifacts: ContextArtifact[]
  sourceSnapshots: SourceSnapshot[]
  promptBundle: string
  /**
   * The bundle a pipeline run starts with: the same, less the feature's files.
   * A run keeps its bundle for all of its stages, so inlined files would be the
   * copies from before it started — spec, plan and tasks are then rewritten by
   * the run itself. Each stage is told which current files to read instead
   * (lib/stage-context.ts), and pays only for the ones it needs.
   */
  runPromptBundle: string
}

export async function buildContextBundle(options: {
  projectId?: string
  projectSlug?: string
  projectPath: string
}): Promise<ContextBundle> {
  const { projectId, projectPath, projectSlug } = options
  const org = await loadOrgContext()
  const projectConstitution = await loadProjectConstitution(projectPath)
  const memory = projectId ? await loadProjectMemory(projectId) : { manualText: '', autoSummary: '', text: '' }
  const featureArtifacts = await loadFeatureArtifacts(projectPath)
  const sourceSnapshots = projectId ? await loadSourceSnapshots(projectId) : []
  // Only the sources this project has selected (and that are connected).
  const { getDefaultOrgId, orgIdForProject } = await import('./orgs')
  const bundleOrgId = projectId ? await orgIdForProject(projectId) : await getDefaultOrgId()
  const knowledgeSources = await resolveKnowledgeScope(bundleOrgId, projectId).then((scope) => scope.sources).catch(() => [] as KnowledgeSource[])
  // Every GitHub repo the organization's account can see, with its use case — so plans can name repos without upfront selection.
  const repoCatalog = await loadRepoCatalog(bundleOrgId).catch(() => '')
  // Shared layers above the project: organization (everyone) and team (this space).
  const shared = await loadSharedMemoryLayers(projectId).catch(() => ({ orgName: 'Organization', orgMemory: '', teamName: undefined, teamMemory: '' }))
  // Organization knowledge base: excerpts relevant to this project and its current feature.
  const orgKnowledge = await loadRetrievedKnowledge(projectId, projectSlug, featureArtifacts).catch(() => ({ available: false, retrieved: '' }))

  const bundleInput = {
    projectSlug,
    projectPath,
    org,
    projectConstitution,
    projectMemory: memory.text,
    featureArtifacts,
    sourceSnapshots,
    knowledgeSources,
    repoCatalog,
    orgName: shared.orgName,
    orgMemory: shared.orgMemory,
    teamName: shared.teamName,
    teamMemory: shared.teamMemory,
    orgKnowledge,
  }
  return {
    projectId,
    projectSlug,
    projectPath,
    org,
    project: {
      memory: memory.text,
      manualMemory: memory.manualText,
      autoSummary: memory.autoSummary,
      sources: sourceSnapshots,
    },
    featureArtifacts,
    sourceSnapshots,
    promptBundle: buildPromptBundle(bundleInput),
    runPromptBundle: buildPromptBundle({ ...bundleInput, inlineArtifacts: false }),
  }
}

/**
 * Pull the handful of knowledge-base excerpts most relevant to the project and
 * the feature being worked on, so every stage starts with the organization's
 * standards and prior decisions in view. Scope: organization sources plus the
 * project's team. Empty when nothing has been imported.
 */
async function loadRetrievedKnowledge(projectId: string | undefined, projectSlug: string | undefined, artifacts: ContextArtifact[]): Promise<{ available: boolean; retrieved: string }> {
  const { hasOrgKnowledge, renderKnowledgeHits, searchOrgKnowledge } = await import('./knowledge-store')
  const project = projectId ? await getProject(projectId).catch(() => undefined) : undefined
  const { getDefaultOrgId, orgIdForProject } = await import('./orgs')
  const scope = { orgId: projectId ? await orgIdForProject(projectId) : await getDefaultOrgId(), teamIds: project?.teamId ? [project.teamId] : [] }
  if (!(await hasOrgKnowledge(scope))) return { available: false, retrieved: '' }
  // The spec (or the newest artifact) says what this work is about; the project name anchors it.
  const focus = artifacts[0]?.content.replace(/\s+/g, ' ').slice(0, 800) ?? ''
  const query = [project?.name ?? projectSlug ?? '', project?.description ?? '', focus].filter(Boolean).join('. ').trim()
  if (!query) return { available: true, retrieved: '' }
  const { hits } = await searchOrgKnowledge({ query, scope, limit: 5 })
  return { available: true, retrieved: hits.length ? renderKnowledgeHits(hits, { maxCharsPerHit: 900 }) : '' }
}

/**
 * The project's own constitution (Spec Kit: `.specify/memory/constitution.md`).
 * Only plan and analyze were told to read it, so every other stage worked
 * without the project's principles. Empty until the constitution stage has
 * filled the template in.
 */
export async function loadProjectConstitution(projectPath: string): Promise<string> {
  const text = await readTextIfExists(join(projectPath, '.specify', 'memory', 'constitution.md'))
  return /\[[A-Z][A-Z0-9_]*\]/.test(text) ? '' : text.trim()
}

async function loadOrgContext(): Promise<Record<string, string>> {
  const entries = {
    constitution: await readTextIfExists(join(orgDir, 'constitution.md')),
    principles: await readTextIfExists(join(orgDir, 'principles.md')),
    security: await readTextIfExists(join(orgDir, 'security.md')),
    architecture: await readTextIfExists(join(orgDir, 'architecture.md')),
    guidelines: await readTextIfExists(join(orgDir, 'guidelines.md')),
    reviewPolicies: await readTextIfExists(join(orgDir, 'review-policies.yml')),
    mcpServers: await readTextIfExists(join(orgDir, 'mcp', 'servers.yml')),
  }

  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value.trim()))
}

async function loadProjectMemory(projectId: string): Promise<{ manualText: string; autoSummary: string; text: string }> {
  const sql = getDb()
  const [row] = await sql<Array<{ manualText: string; autoSummary: string }>>`
    SELECT manual_text AS "manualText", auto_summary AS "autoSummary"
      FROM project_memory WHERE project_id = ${projectId}
  `
  const manualText = row?.manualText ?? ''
  const autoSummary = row?.autoSummary ?? ''
  return {
    manualText,
    autoSummary,
    text: [manualText.trim(), autoSummary.trim() ? `## Auto summary\n${autoSummary.trim()}` : ''].filter(Boolean).join('\n\n'),
  }
}

async function loadFeatureArtifacts(projectPath: string): Promise<ContextArtifact[]> {
  const artifacts: ContextArtifact[] = []
  // Written by the research stage before any feature directory exists.
  await pushArtifact(artifacts, 'Research brief', join(projectPath, '.aidlc', 'research', 'brief.md'))
  const featureDir = await getLatestFeatureDir(projectPath)
  if (!featureDir) return artifacts

  await pushArtifact(artifacts, 'Feature spec', join(projectPath, featureDir, 'spec.md'))
  await pushArtifact(artifacts, 'Implementation plan', join(projectPath, featureDir, 'plan.md'))
  await pushArtifact(artifacts, 'Tasks', join(projectPath, featureDir, 'tasks.md'))
  await pushArtifact(artifacts, 'Test plan', join(projectPath, featureDir, 'test-plan.md'))
  await pushArtifact(artifacts, 'Parallel workstreams', join(projectPath, featureDir, 'parallel-workstreams.md'))
  await pushArtifact(artifacts, 'Verification report', join(projectPath, featureDir, 'verification-report.md'))
  await pushArtifact(artifacts, 'Research', join(projectPath, featureDir, 'research.md'))
  await pushArtifact(artifacts, 'Data model', join(projectPath, featureDir, 'data-model.md'))
  await pushArtifact(artifacts, 'Quickstart', join(projectPath, featureDir, 'quickstart.md'))
  await pushArtifact(artifacts, 'Delivery status', join(projectPath, featureDir, 'delivery-status.md'))
  await pushArtifact(artifacts, 'Delivery report', join(projectPath, featureDir, 'delivery-report.md'))

  // Dev-environment notes written by the setup step (repo root, local-only).
  const devSetup = await readTextIfExists(join(projectPath, '.aidlc', 'dev-setup.md'))
  if (devSetup.trim()) artifacts.push({ label: 'Dev environment (install/build/test commands)', path: '.aidlc/dev-setup.md', content: devSetup })

  const contractsDir = join(projectPath, featureDir, 'contracts')
  for (const file of await safeReadDir(contractsDir)) {
    const fullPath = join(contractsDir, file)
    const content = await readTextIfExists(fullPath)
    if (!content.trim()) continue
    artifacts.push({ label: `Contract: ${file}`, path: relativeToProject(projectPath, fullPath), content })
  }

  return artifacts
}

/** Compact list of synced GitHub repos with their README-derived use case (capped). */
async function loadRepoCatalog(orgId: string, limit = 60): Promise<string> {
  const sql = getDb()
  const rows = await sql<Array<{ fullName: string; description: string | null; language: string | null; topics: string[] | null; usecase: string | null }>>`
    SELECT full_name AS "fullName", description, language, topics, usecase
      FROM github_repo_index WHERE org_id = ${orgId} ORDER BY updated_at DESC NULLS LAST LIMIT ${limit}
  `
  return rows
    .map((r) => `- **${r.fullName}**${r.language ? ` (${r.language})` : ''}${r.topics?.length ? ` [${r.topics.slice(0, 4).join(', ')}]` : ''} — ${(r.usecase ?? r.description ?? 'no description').replace(/\s+/g, ' ').slice(0, 160)}`)
    .join('\n')
}

async function loadSourceSnapshots(projectId: string): Promise<SourceSnapshot[]> {
  const sql = getDb()
  return await sql<SourceSnapshot[]>`
    SELECT
      source      AS "source",
      scope       AS "scope",
      entity_type AS "entityType",
      entity_id   AS "entityId",
      title       AS "title",
      content     AS "content",
      url         AS "url",
      metadata    AS "metadata",
      fetched_at  AS "fetchedAt"
    FROM project_source_snapshots
    WHERE project_id = ${projectId}
      AND source <> 'codebase'  -- repository briefs feed project memory, not this section
    ORDER BY fetched_at DESC
    LIMIT 20
  `
}

/**
 * Cap the total shared-context bundle at ~8k tokens (~32k chars). Beyond
 * that, we drop lower-priority sections rather than truncate mid-artifact.
 * Priority order (highest first):
 *   1. Header + AIDLC directives   — always keep (tiny)
 *   2. Memory (org, team, project) and the constitutions — always keep
 *   3. Feature Artifacts           — the actual work-in-progress
 *   4. Knowledge Sources note      — small, high-signal
 *   5. Org context (principles, security, architecture, guidelines,
 *      review policies, mcp registry) — evergreen, easy to drop
 *   6. Source Snapshots            — largest, most redundant with artifacts
 */
const BUNDLE_MAX_CHARS = 32_000

export function buildPromptBundle(options: {
  projectSlug?: string
  projectPath: string
  org: Record<string, string>
  /** The project's own constitution (.specify/memory/constitution.md), when filled in. */
  projectConstitution?: string
  projectMemory: string
  featureArtifacts: ContextArtifact[]
  sourceSnapshots: SourceSnapshot[]
  knowledgeSources?: KnowledgeSource[]
  /** Markdown list of the GitHub repositories the account can see, with use cases. */
  repoCatalog?: string
  /** Shared layers above the project (AIDLC spaces): organization for everyone, team for this space. */
  orgName?: string
  orgMemory?: string
  teamName?: string
  teamMemory?: string
  /** Organization knowledge base: whether it exists, and excerpts retrieved for this work. */
  orgKnowledge?: { available: boolean; retrieved: string }
  /** Inline the feature's files (spec, plan, tasks…). Off for pipeline runs: see ContextBundle.runPromptBundle. */
  inlineArtifacts?: boolean
}): string {
  // Build each section as a labeled block so we can drop the lowest-priority
  // ones if the total exceeds the token budget.
  const blocks: Array<{ label: string; priority: number; text: string }> = []

  blocks.push({
    label: 'header',
    priority: 100,
    text: `# Shared Context\nProject: ${options.projectSlug ?? '(unknown)'}\nProject path: ${options.projectPath}`,
  })

  blocks.push({
    label: 'directives',
    priority: 95,
    text: `## AIDLC Directives\n- Specifications should include explicit test cases or acceptance scenarios.\n- Implementation planning should account for test-plan generation.\n- Parallel work should be organized into machine-readable workstreams before sub-agent execution.\n- Act, don't advise: when a problem is within reach — a lint or type error, a failing test you touched, a missing dependency, a red CI job, a conflict to rebase, a missing pull request — fix it, run the commands, and re-check. Never hand a to-do list to "the team" for work you can do here.\n- Ask for approval (a "## Question N: …" heading, then stop) only before irreversible or costly actions: merging a PR, deploying, deleting or migrating data, or touching repositories outside the project's scope.`,
  })

  // Shared layers (AIDLC spaces): organization memory applies to every team;
  // team memory to every project of this team; project memory to this project.
  if (options.orgMemory?.trim()) {
    blocks.push({
      label: 'org-memory',
      priority: 93,
      text: `## ${options.orgName ?? 'Organization'} Memory (shared by all teams)\n${options.orgMemory.trim()}`,
    })
  }
  if (options.teamMemory?.trim()) {
    blocks.push({
      label: 'team-memory',
      priority: 92,
      text: `## Team Memory${options.teamName ? ` — ${options.teamName}` : ''} (this team's space)\n${options.teamMemory.trim()}`,
    })
  }

  // Constitutions govern every stage, so they are never dropped for the budget.
  if (options.projectConstitution?.trim()) {
    blocks.push({
      label: 'project-constitution',
      priority: 91,
      text: `## Project Constitution (.specify/memory/constitution.md)\nNon-negotiable for this project; where it and the organization constitution differ, this one is more specific.\n${options.projectConstitution.trim()}`,
    })
  }

  if (options.projectMemory.trim()) {
    blocks.push({
      label: 'project-memory',
      priority: 90,
      text: `## Project Memory\n${options.projectMemory.trim()}`,
    })
  }

  if (options.inlineArtifacts !== false && options.featureArtifacts.length > 0) {
    blocks.push({
      label: 'feature-artifacts',
      priority: 80,
      text: `## Feature Artifacts\n${options.featureArtifacts.map((artifact) => `### ${artifact.label} (${artifact.path})\n${artifact.content.trim()}`).join('\n\n')}`,
    })
  }

  if (options.repoCatalog?.trim()) {
    blocks.push({
      label: 'repo-catalog',
      priority: 55,
      text: `## Repository catalog (GitHub)\nEvery repository the connected account can see, with what it is for. Plans should name the repositories a feature touches from this list (owner/name); unregistered ones are cloned into the project automatically after the plan stage.\n${options.repoCatalog.trim()}`,
    })
  }

  if (options.orgKnowledge?.available) {
    const intro = `## Organization knowledge base\nThe organization's imported knowledge (Confluence spaces, Jira/Linear projects and initiatives, repository docs, web pages, notes) is searchable with \`org_knowledge_search(query)\`. Check it for standards, architecture decisions, runbooks and prior decisions before designing or implementing, and cite what you rely on.`
    blocks.push({
      label: 'org-knowledge',
      priority: 75,
      text: options.orgKnowledge.retrieved
        ? `${intro}\n\nExcerpts retrieved for this project and feature (search for more or for the full documents):\n\n${options.orgKnowledge.retrieved}`
        : intro,
    })
  }

  if (options.knowledgeSources && options.knowledgeSources.length > 0) {
    const names = options.knowledgeSources.map((s) => SOURCE_LABEL[s]).join(', ')
    blocks.push({
      label: 'knowledge-sources',
      priority: 70,
      text: `## Knowledge Sources\nConnected: ${names}. You have the tools \`integration_search(source, query)\` and \`integration_get(source, id)\`.\n- Use them when a ticket key, epic, customer request, design doc or PR is referenced, or when requirements/acceptance criteria are missing from the repo — fetch, don't guess.\n- Be efficient: one targeted search, then read the 1–3 most relevant items in full. Do not crawl.\n- Cite ids (PROJ-123, ENG-45, page id, owner/repo#12) in the artifacts you write so decisions are traceable.`,
    })
  }

  for (const [name, content] of Object.entries(options.org)) {
    blocks.push({
      label: `org-${name}`,
      priority: name === 'constitution' ? 91 : 50,
      text: `## Org ${humanizeKey(name)}\n${content.trim()}`,
    })
  }

  if (options.sourceSnapshots.length > 0) {
    blocks.push({
      label: 'source-snapshots',
      priority: 30,
      text: `## Source Snapshots\nImported tickets/docs this work is based on. Treat them as requirements input; re-fetch with integration_get if you need the latest state.\n${options.sourceSnapshots.map((snapshot) => `### ${snapshot.source}: ${snapshot.title}${snapshot.url ? ` (${snapshot.url})` : ''}\nType: ${snapshot.entityType} · Id: ${snapshot.entityId}\nFetched: ${snapshot.fetchedAt}\n${snapshot.content.trim()}`).join('\n\n')}`,
    })
  }

  // Assemble in priority order, dropping (with a footnote) whichever
  // low-priority blocks push us past the budget.
  blocks.sort((a, b) => b.priority - a.priority)
  const kept: typeof blocks = []
  const dropped: string[] = []
  let running = 0
  for (const block of blocks) {
    const projected = running + block.text.length + 8
    if (projected <= BUNDLE_MAX_CHARS || block.priority >= 90) {
      kept.push(block)
      running = projected
    } else {
      dropped.push(block.label)
    }
  }
  if (dropped.length > 0) {
    kept.push({
      label: 'truncation-note',
      priority: 0,
      text: `## Context truncation\nThe following sections were omitted to stay under the ${BUNDLE_MAX_CHARS}-char shared-context budget: ${dropped.join(', ')}. Fetch them explicitly with the read tool if you need them.`,
    })
  }
  return kept.map((b) => b.text).join('\n\n---\n\n')
}

async function pushArtifact(target: ContextArtifact[], label: string, filePath: string): Promise<void> {
  const content = await readTextIfExists(filePath)
  if (!content.trim()) return
  const projectPath = filePath.split('/specs/')[0] || dirname(filePath)
  target.push({ label, path: relativeToProject(projectPath, filePath), content })
}

async function getLatestFeatureDir(projectPath: string): Promise<string | null> {
  const id = activeFeatureId(projectPath)
  return id ? join('specs', id) : null
}

async function readTextIfExists(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8')
  } catch {
    return ''
  }
}

async function safeReadDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

function relativeToProject(projectPath: string, filePath: string): string {
  return filePath.startsWith(projectPath) ? filePath.slice(projectPath.length + 1) : filePath
}

function humanizeKey(value: string): string {
  return value.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())
}

// -------- DB-backed memory + source helpers (usable from server.ts) --------

export interface ProjectMemoryRow {
  manualText: string
  autoSummary: string
  updatedAt: string
}

export async function getProjectMemory(projectId: string): Promise<ProjectMemoryRow> {
  const sql = getDb()
  const [row] = await sql<ProjectMemoryRow[]>`
    SELECT manual_text AS "manualText", auto_summary AS "autoSummary", updated_at AS "updatedAt"
      FROM project_memory WHERE project_id = ${projectId}
  `
  return row ?? { manualText: '', autoSummary: '', updatedAt: new Date().toISOString() }
}

export async function upsertProjectMemory(projectId: string, patch: { manualText?: string; autoSummary?: string }): Promise<ProjectMemoryRow> {
  const sql = getDb()
  const [row] = await sql<ProjectMemoryRow[]>`
    INSERT INTO project_memory (project_id, manual_text, auto_summary)
    VALUES (${projectId}, ${patch.manualText ?? ''}, ${patch.autoSummary ?? ''})
    ON CONFLICT (project_id) DO UPDATE SET
      manual_text  = COALESCE(${patch.manualText ?? null}, project_memory.manual_text),
      auto_summary = COALESCE(${patch.autoSummary ?? null}, project_memory.auto_summary),
      updated_at   = now()
    RETURNING manual_text AS "manualText", auto_summary AS "autoSummary", updated_at AS "updatedAt"
  `
  return row
}
