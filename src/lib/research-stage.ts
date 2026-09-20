/**
 * The `research` stage: load everything an agent needs before specifying.
 *
 * Deterministic preparation (this module) runs before the stage prompt:
 *   1. Suggest repositories for the feature from the GitHub catalog, register
 *      and clone the confident ones, and learn them (inventory + brief).
 *   2. Gather what is already known: repository briefs from project memory
 *      and the most relevant organization knowledge excerpts.
 *   3. Write `.aidlc/research/inputs.md` in the governing workspace and hand
 *      the same text to the agent as its preamble.
 *
 * The agent stage then explores the repositories and knowledge base with its
 * tools and writes `.aidlc/research/brief.md`, which the specify stage reads
 * first and which every later run gets in its shared context.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { getDb } from './db'
import { scheduleRepoClone } from './github'
import { renderKnowledgeHits, searchOrgKnowledge } from './knowledge-store'
import { getDefaultOrgId, orgIdForProject } from './orgs'
import { log } from './logger'
import { refreshRepositoryKnowledge } from './project-onboarding'
import { addRepo, getProject, listRepos, type ProjectSuggestions, type RepoRow } from './project-registry'
import { suggestRepositoriesAndWorkAreas } from './suggestions'

const researchLog = log.child({ mod: 'research-stage' })

export const RESEARCH_DIR = '.aidlc/research'
export const RESEARCH_INPUTS_FILE = `${RESEARCH_DIR}/inputs.md`
export const RESEARCH_BRIEF_FILE = `${RESEARCH_DIR}/brief.md`

/** Repositories auto-added per research run; more than this is a plan, not research. */
const MAX_AUTO_REPOS = 3
/** Clone + learn budget per repository before we move on and let the agent continue. */
const REPO_LEARN_TIMEOUT_MS = 6 * 60_000

export interface ResearchPreparation {
  /** Markdown handed to the agent (and written to inputs.md). */
  markdown: string
  addedRepos: string[]
  suggestions?: ProjectSuggestions
  knowledgeHits: number
}

export async function prepareResearchInputs(options: {
  projectId?: string
  cwd: string
  feature?: string
  model?: string
  /** Progress lines for the run log. */
  print?: (line: string) => void
}): Promise<ResearchPreparation> {
  const print = options.print ?? (() => undefined)
  const feature = options.feature?.trim() ?? ''
  const project = options.projectId ? await getProject(options.projectId).catch(() => undefined) : undefined
  const sections: string[] = []
  sections.push(`# Research inputs\n\nProject: ${project?.name ?? path.basename(options.cwd)}${project?.code ? ` (${project.code})` : ''}\nFeature: ${feature || '(none given)'}\n\nGathered automatically before the research stage. Verify, do not assume.`)

  let suggestions: ProjectSuggestions | undefined
  const added: string[] = []
  let repos: RepoRow[] = project ? await listRepos(project.projectId) : []

  if (project) {
    // 1. Which repositories does this feature touch? Ask, then bring them in.
    print(`[research] Suggesting repositories for “${feature || project.name}”…\n`)
    suggestions = await suggestRepositoriesAndWorkAreas(project.projectId, { basis: 'project', feature, model: options.model }).catch((error) => {
      print(`[research] Repository suggestions unavailable: ${error instanceof Error ? error.message : String(error)}\n`)
      return undefined
    })
    const registeredNames = new Set(repos.map((r) => r.githubRepo?.toLowerCase()).filter(Boolean) as string[])
    const candidates = (suggestions?.repositories ?? [])
      .filter((r) => !r.registered && !registeredNames.has(r.fullName.toLowerCase()) && (r.confidence === 'high' || r.confidence === 'medium'))
      .slice(0, MAX_AUTO_REPOS)
    for (const candidate of candidates) {
      try {
        print(`[research] Adding and cloning ${candidate.fullName} (${candidate.confidence}: ${candidate.reason})…\n`)
        const repo = await addRepo({ projectId: project.projectId, label: candidate.fullName.split('/')[1] ?? candidate.fullName, kind: 'github', githubRepo: candidate.fullName, isPrimary: false })
        await withTimeout(scheduleRepoClone(repo).then(() => refreshRepositoryKnowledge(project.projectId, repo.repoId, { model: options.model })), REPO_LEARN_TIMEOUT_MS, `clone and learn ${candidate.fullName}`)
        added.push(candidate.fullName)
        print(`[research] Learned ${candidate.fullName}.\n`)
      } catch (error) {
        print(`[research] Could not bring in ${candidate.fullName}: ${error instanceof Error ? error.message : String(error)} (continuing)\n`)
        researchLog.warn('research repo add failed', { repo: candidate.fullName, error: error instanceof Error ? error.message : String(error) })
      }
    }
    repos = await listRepos(project.projectId)
  }

  // 2. Repositories and what we know about them.
  const briefs = project ? await loadRepoBriefs(project.projectId) : new Map<string, string>()
  const repoLines = repos.map((r) => {
    const brief = briefs.get(r.repoId)
    const where = r.localPath ? `\`${r.localPath}\`` : r.githubRepo ? `${r.githubRepo} (not cloned yet)` : '(no checkout)'
    const tag = r.githubRepo && added.includes(r.githubRepo) ? ' — **added for this feature**' : r.isPrimary ? ' — primary' : ''
    return `### ${r.label}${tag}\n${r.githubRepo ? `GitHub: ${r.githubRepo}\n` : ''}Path: ${where}\n${brief ? `\n${clip(brief, 1_800)}` : '\n_No brief yet — inventory it yourself (README, top-level layout, tests)._'}`
  })
  sections.push(`## Repositories\n\n${repoLines.length ? repoLines.join('\n\n') : '_No repositories registered. Work in the governing workspace and recommend which repositories the feature needs._'}`)

  if (suggestions) {
    const rest = suggestions.repositories.filter((r) => !added.includes(r.fullName))
    const lines = rest.map((r) => `- ${r.fullName} — ${r.role} · ${r.confidence} confidence${r.registered ? ' · registered' : ''}: ${r.reason}`)
    const areas = suggestions.workAreas.map((w) => `- **${w.name}** — ${w.description}${w.repositories.length ? ` (repos: ${w.repositories.join(', ')})` : ''}${w.paths.length ? ` (paths: ${w.paths.join(', ')})` : ''}${w.risks ? ` · risk: ${w.risks}` : ''}`)
    sections.push(`## Suggested repositories and work areas\n\n${lines.length ? lines.join('\n') : '_No further repositories suggested._'}\n\n${areas.length ? `Work areas:\n${areas.join('\n')}` : ''}${suggestions.notes ? `\n\nNotes: ${suggestions.notes}` : ''}`.trim())
  }

  // 3. Organization knowledge relevant to the feature.
  let knowledgeHits = 0
  const query = [project?.name, project?.description, feature].filter(Boolean).join('. ')
  if (query.trim()) {
    try {
      const { hits, mode } = await searchOrgKnowledge({ query, scope: { orgId: project ? await orgIdForProject(project.projectId) : await getDefaultOrgId(), teamIds: project?.teamId ? [project.teamId] : [] }, limit: 8 })
      knowledgeHits = hits.length
      if (hits.length) {
        sections.push(`## Organization knowledge (${mode} search, ${hits.length} excerpts)\n\nUse \`org_knowledge_search(query)\` for more.\n\n${renderKnowledgeHits(hits, { maxCharsPerHit: 1_000 })}`)
        print(`[research] ${hits.length} knowledge excerpts loaded.\n`)
      } else {
        sections.push(`## Organization knowledge\n\n_Nothing matched yet. Try \`org_knowledge_search\` with narrower terms; the base may be empty._`)
      }
    } catch (error) {
      sections.push(`## Organization knowledge\n\n_Search unavailable: ${error instanceof Error ? error.message : String(error)}_`)
    }
  }

  const markdown = sections.join('\n\n')
  try {
    await mkdir(path.join(options.cwd, RESEARCH_DIR), { recursive: true })
    await writeFile(path.join(options.cwd, RESEARCH_INPUTS_FILE), `${markdown}\n`, 'utf8')
  } catch (error) {
    researchLog.warn('could not write research inputs', { cwd: options.cwd, error: error instanceof Error ? error.message : String(error) })
  }
  return { markdown, addedRepos: added, suggestions, knowledgeHits }
}

/** Repository briefs written by onboarding (project memory), keyed by repo id. */
async function loadRepoBriefs(projectId: string): Promise<Map<string, string>> {
  const rows = await getDb()<Array<{ entityId: string; content: string }>>`
    SELECT entity_id AS "entityId", content FROM project_source_snapshots
    WHERE project_id = ${projectId} AND source = 'codebase' AND entity_type = 'repository-brief'
    ORDER BY fetched_at DESC
  `.catch(() => [])
  const map = new Map<string, string>()
  for (const row of rows) if (!map.has(row.entityId)) map.set(row.entityId, row.content)
  return map
}

function clip(text: string, max: number): string {
  const t = text.trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} took longer than ${Math.round(ms / 60_000)} minutes`)), ms)
    promise.then((v) => { clearTimeout(timer); resolve(v) }, (e) => { clearTimeout(timer); reject(e) })
  })
}

/** The research stage prompt: explore, then write the brief the specify stage reads first. */
export function buildResearchPrompt(feature: string): string {
  return `Research the codebase and organization knowledge before anything is specified.

Feature under consideration: ${feature || '(see the shared context)'}

Inputs gathered for you are in the preamble above and in \`${RESEARCH_INPUTS_FILE}\` (repositories with paths and briefs, suggested repositories and work areas, organization knowledge excerpts). Treat them as leads to verify, not conclusions.

Do this:
1. For every repository with a local path, look at its layout (top-level directories, package or build files, README) and find the code, tests and docs most related to the feature. Use read, ls and grep; do not modify anything.
2. Note the conventions you see: languages and frameworks, module layout, naming, how tests are written and run, how configuration and secrets are handled, how services talk to each other.
3. Query the organization knowledge base with \`org_knowledge_search\` for standards, architecture decisions, runbooks, glossary and prior decisions that constrain this feature. If \`integration_search\` is available, look up tickets, epics and documents that mention it.
4. Decide which repositories this feature should change and which are read-only context. If a needed repository is missing, name it and say why.

Then write \`${RESEARCH_BRIEF_FILE}\` (create the directory if needed) with exactly these sections:
- \`## Summary\` — three to six sentences a specifier can rely on.
- \`## Feature intent and success signals\` — what the feature is for and how we would know it works.
- \`## Repositories\` — one bullet per repository: \`- <label or owner/name> — change | context — <why>\`; append \`(not registered)\` for repositories the project should add.
- \`## Existing code and patterns to reuse\` — concrete file paths and what they show.
- \`## Standards and decisions that apply\` — from the knowledge base, each with its title or link.
- \`## Related tickets and documents\` — ids and titles, or “none found”.
- \`## Risks and unknowns\`
- \`## Open questions for the team\` — questions to settle during specify; list them, do not stop to ask.
- \`## Inputs for the specification\` — glossary, constraints, non-goals, integration points.

Rules: do not create or edit anything except \`${RESEARCH_BRIEF_FILE}\`; do not run installs, builds or tests; cite paths and knowledge titles; never phrase anything as a question to the user (use the “Open questions” section instead). Finish with the line \`Research Status: COMPLETE\` and a one-paragraph summary.`
}
