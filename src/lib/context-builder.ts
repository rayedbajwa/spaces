import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDb } from './db'

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
    ORDER BY fetched_at DESC
    LIMIT 20
  `
}

function buildPromptBundle(options: {
  projectSlug?: string
  projectPath: string
  org: Record<string, string>
  projectMemory: string
  featureArtifacts: ContextArtifact[]
  sourceSnapshots: SourceSnapshot[]
}): string {
  const sections: string[] = []

  sections.push(`# Shared Context\nProject: ${options.projectSlug ?? '(unknown)'}\nProject path: ${options.projectPath}`)

  for (const [name, content] of Object.entries(options.org)) {
    sections.push(`## Org ${humanizeKey(name)}\n${content.trim()}`)
  }

  sections.push(`## AIDLC Directives\n- Specifications should include explicit test cases or acceptance scenarios.\n- Implementation planning should account for test-plan generation.\n- Parallel work should be organized into machine-readable workstreams before sub-agent execution.`)

  if (options.projectMemory.trim()) {
    sections.push(`## Project Memory\n${options.projectMemory.trim()}`)
  }

  if (options.featureArtifacts.length > 0) {
    sections.push(`## Feature Artifacts\n${options.featureArtifacts.map((artifact) => `### ${artifact.label} (${artifact.path})\n${artifact.content.trim()}`).join('\n\n')}`)
  }

  if (options.sourceSnapshots.length > 0) {
    sections.push(`## Source Snapshots\n${options.sourceSnapshots.map((snapshot) => `### ${snapshot.source}: ${snapshot.title}\nType: ${snapshot.entityType}\nFetched: ${snapshot.fetchedAt}\n${snapshot.content.trim()}`).join('\n\n')}`)
  }

  return sections.join('\n\n---\n\n')
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
