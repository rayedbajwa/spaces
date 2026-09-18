import { createAgentSession, SessionManager } from '@earendil-works/pi-coding-agent'
import { defaultModel } from './model-policy'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createConfiguredModelRuntime, findLatestFeatureDirAbsolute, parsePlanRepositories } from './aidlc'
import { getDb } from './db'
import { log } from './logger'
import { getProject, listRepos, pickRunnableRepo, updateProjectSuggestions, type ProjectRow, type ProjectSuggestions } from './project-registry'

const sugLog = log.child({ mod: 'suggestions' })

/**
 * Suggest which repositories a project should span and which work areas
 * (services, modules, flows) the work will touch. Runs after onboarding (from
 * the description, first feature and the synced GitHub catalog) and again after
 * the plan stage (from plan.md), so nobody has to pick repos up front and the
 * team sees where the work lands before implementation starts.
 */

interface CatalogRow { fullName: string; description: string | null; language: string | null; topics: string[] | null; usecase: string | null }

async function catalogForPrompt(limit = 120): Promise<CatalogRow[]> {
  const sql = getDb()
  return await sql<CatalogRow[]>`
    SELECT full_name AS "fullName", description, language, topics, usecase
      FROM github_repo_index ORDER BY updated_at DESC NULLS LAST LIMIT ${limit}
  `
}

/**
 * Models sometimes wrap JSON in fences, add `// comments`, trailing commas or
 * literal "high|medium|low" placeholders. Clean the common cases before parsing.
 */
function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1]
  let candidate = (fenced ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)).trim()
  try {
    return JSON.parse(candidate)
  } catch {
    candidate = candidate
      .replace(/^\s*\/\/.*$/gm, '')            // line comments
      .replace(/\/\*[\s\S]*?\*\//g, '')        // block comments
      .replace(/,\s*([}\]])/g, '$1')           // trailing commas
      .replace(/"(high|medium|low)\|[^"]*"/g, '"medium"') // "high|medium|low" placeholders
      .replace(/"([^"]*?)"\s+or\s+"([^"]*?)"/g, '"$1"')   // `"a" or "b"` alternatives
    return JSON.parse(candidate)
  }
}

export async function suggestRepositoriesAndWorkAreas(
  projectId: string,
  options: { basis: 'project' | 'plan'; feature?: string; model?: string } = { basis: 'project' },
): Promise<ProjectSuggestions | undefined> {
  const project = await getProject(projectId)
  if (!project) return undefined
  const repos = await listRepos(projectId)
  const registered = repos.filter((r) => r.label !== 'governance')
  const catalog = await catalogForPrompt().catch(() => [] as CatalogRow[])

  let planContext = ''
  if (options.basis === 'plan') {
    const primary = pickRunnableRepo(repos)
    const featureDir = primary?.localPath ? await findLatestFeatureDirAbsolute(primary.localPath) : null
    if (featureDir) {
      const plan = await readFile(path.join(featureDir, 'plan.md'), 'utf8').catch(() => '')
      const spec = await readFile(path.join(featureDir, 'spec.md'), 'utf8').catch(() => '')
      const planRepos = parsePlanRepositories(plan)
      planContext = [
        spec ? `## Spec (excerpt)\n${spec.slice(0, 3000)}` : '',
        plan ? `## Plan (excerpt)\n${plan.slice(0, 6000)}` : '',
        planRepos.length ? `## Repositories named by the plan\n${planRepos.map((r) => `- ${r.name}${r.flaggedUnregistered ? ' (not registered)' : ''} — ${r.note}`).join('\n')}` : '',
      ].filter(Boolean).join('\n\n')
    }
  }

  if (catalog.length === 0 && registered.length === 0 && !planContext) {
    sugLog.info('nothing to base suggestions on (no catalog, repos or plan)', { projectId })
    return undefined
  }

  const prompt = `You help set up a software project in a delivery workspace. Suggest which repositories it should span and which work areas the work will touch. Answer with JSON only.

## Project
Name: ${project.name}
Description: ${project.description ?? '(none)'}
${options.feature ? `First feature: ${options.feature}` : ''}

## Already registered repositories
${registered.length ? registered.map((r) => `- ${r.label} — ${r.githubRepo ?? r.localPath ?? ''}`).join('\n') : '- none yet'}

${planContext ? `${planContext}\n` : ''}## Repository catalog (what the connected GitHub account can see)
${catalog.length ? catalog.map((c) => `- ${c.fullName}${c.language ? ` (${c.language})` : ''}${c.topics?.length ? ` [${c.topics.slice(0, 4).join(', ')}]` : ''} — ${(c.usecase ?? c.description ?? 'no description').replace(/\s+/g, ' ').slice(0, 160)}`).join('\n') : '- (catalog empty — GitHub not connected or not synced yet)'}

Return exactly this JSON shape (no prose):
{
  "repositories": [
    { "fullName": "owner/name", "reason": "why this repo is involved (1 sentence)", "confidence": "high|medium|low", "role": "primary code|dependency|infra|shared library|docs" }
  ],
  "workAreas": [
    { "name": "short name", "description": "what changes here and why (1–2 sentences)", "repositories": ["owner/name"], "paths": ["likely/dir or module"], "risks": "main risk or unknown (optional)" }
  ],
  "notes": "anything the team should decide before implementation (optional)"
}
Rules: only list repositories that exist in the catalog or are already registered (use their exact owner/name); prefer 1–5 repositories and 2–6 work areas; if the project clearly needs a repository that does not exist yet, describe it in notes instead of inventing a name.`

  const modelRuntime = await createConfiguredModelRuntime()
  const { resolveCliModel } = await import('@earendil-works/pi-coding-agent')
  const modelSpec = options.model ?? await defaultModel()
  const resolved = resolveCliModel({ cliModel: modelSpec, modelRuntime })
  if (resolved.error) throw new Error(resolved.error)
  const cwd = pickRunnableRepo(repos)?.localPath ?? process.cwd()
  const { session } = await createAgentSession({ cwd, modelRuntime, model: resolved.model, tools: [], sessionManager: SessionManager.inMemory(cwd) })
  let output = ''
  let providerError: string | undefined
  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') output += event.assistantMessageEvent.delta
    if (event.type === 'agent_end') {
      const last = (event as { messages?: Array<{ stopReason?: string; errorMessage?: string }> }).messages?.slice(-1)[0]
      if (last?.stopReason === 'error' && last.errorMessage) providerError = last.errorMessage
    }
  })
  let parsed: Partial<ProjectSuggestions>
  try {
    await session.prompt(prompt, { expandPromptTemplates: false })
    if (providerError) throw new Error(`LLM provider error: ${providerError}`)
    try {
      parsed = extractJson(output) as Partial<ProjectSuggestions>
    } catch (parseError) {
      // One repair round: ask the same session to re-emit strict JSON.
      output = ''
      await session.prompt(`Your previous reply was not valid JSON (${parseError instanceof Error ? parseError.message : String(parseError)}). Reply again with ONLY the JSON object in the required shape — no comments, no prose, no alternatives like "a|b", double-quoted keys and strings, no trailing commas.`, { expandPromptTemplates: false })
      if (providerError) throw new Error(`LLM provider error: ${providerError}`)
      parsed = extractJson(output) as Partial<ProjectSuggestions>
    }
  } finally {
    unsubscribe()
    session.dispose()
  }
  const known = new Set([...catalog.map((c) => c.fullName.toLowerCase()), ...registered.map((r) => (r.githubRepo ?? r.label).toLowerCase())])
  const registeredNames = new Set(registered.map((r) => (r.githubRepo ?? r.label).toLowerCase()))
  const suggestions: ProjectSuggestions = {
    generatedAt: new Date().toISOString(),
    basis: options.basis,
    repositories: (parsed.repositories ?? [])
      .filter((r) => r && typeof r.fullName === 'string' && known.has(r.fullName.toLowerCase()))
      .map((r) => ({ fullName: r.fullName, reason: r.reason ?? '', confidence: r.confidence ?? 'medium', role: r.role ?? '', registered: registeredNames.has(r.fullName.toLowerCase()) })),
    workAreas: (parsed.workAreas ?? []).filter((w) => w && typeof w.name === 'string').map((w) => ({
      name: w.name,
      description: w.description ?? '',
      repositories: (w.repositories ?? []).filter((n) => typeof n === 'string'),
      paths: (w.paths ?? []).filter((p) => typeof p === 'string'),
      risks: w.risks,
    })),
    notes: typeof parsed.notes === 'string' ? parsed.notes : undefined,
  }
  await updateProjectSuggestions(projectId, suggestions)
  sugLog.info('suggestions generated', { projectId, basis: options.basis, repositories: suggestions.repositories.length, workAreas: suggestions.workAreas.length })
  return suggestions
}

export async function getProjectSuggestions(project: ProjectRow): Promise<ProjectSuggestions | undefined> {
  return project.suggestionsJson ?? undefined
}
