import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDb } from './db'
import { resolveKnowledgeScope, SOURCE_LABEL, type KnowledgeSource } from './integration-sources'

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
}

export async function buildContextBundle(options: {
  projectId?: string
  projectSlug?: string
  projectPath: string
}): Promise<ContextBundle> {
  const { projectId, projectPath, projectSlug } = options
  const org = await loadOrgContext()
  const memory = projectId ? await loadProjectMemory(projectId) : { manualText: '', autoSummary: '', text: '' }
  const featureArtifacts = await loadFeatureArtifacts(projectPath)
  const sourceSnapshots = projectId ? await loadSourceSnapshots(projectId) : []
  // Only the sources this project has selected (and that are connected).
  const knowledgeSources = await resolveKnowledgeScope(projectId).then((scope) => scope.sources).catch(() => [] as KnowledgeSource[])

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
    promptBundle: buildPromptBundle({
      projectSlug,
      projectPath,
      org,
      projectMemory: memory.text,
      featureArtifacts,
      sourceSnapshots,
      knowledgeSources,
    }),
  }
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
  const featureDir = await getLatestFeatureDir(projectPath)
  if (!featureDir) return []

  const artifacts: ContextArtifact[] = []
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
 *   2. Project Memory              — user's own tuning
 *   3. Feature Artifacts           — the actual work-in-progress
 *   4. Knowledge Sources note      — small, high-signal
 *   5. Org context (constitution, principles, security, architecture,
 *      guidelines, review policies, mcp registry) — evergreen, easy to drop
 *   6. Source Snapshots            — largest, most redundant with artifacts
 */
const BUNDLE_MAX_CHARS = 32_000

function buildPromptBundle(options: {
  projectSlug?: string
  projectPath: string
  org: Record<string, string>
  projectMemory: string
  featureArtifacts: ContextArtifact[]
  sourceSnapshots: SourceSnapshot[]
  knowledgeSources?: KnowledgeSource[]
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

  if (options.projectMemory.trim()) {
    blocks.push({
      label: 'project-memory',
      priority: 90,
      text: `## Project Memory\n${options.projectMemory.trim()}`,
    })
  }

  if (options.featureArtifacts.length > 0) {
    blocks.push({
      label: 'feature-artifacts',
      priority: 80,
      text: `## Feature Artifacts\n${options.featureArtifacts.map((artifact) => `### ${artifact.label} (${artifact.path})\n${artifact.content.trim()}`).join('\n\n')}`,
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
      priority: 50,
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
  const specsDir = join(projectPath, 'specs')
  const dirs = await safeReadDir(specsDir)
  const featureDirs = dirs.sort((a, b) => b.localeCompare(a))
  return featureDirs[0] ? join('specs', featureDirs[0]) : null
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
