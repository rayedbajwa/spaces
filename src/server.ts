import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, normalize, resolve as resolvePath, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { marked } from 'marked'
import { ensureFrontendBuilt } from './build-web'
import { buildContextBundle } from './lib/context-builder'
import { createPromotionProposal, decidePromotionProposal, listPromotionProposals } from './lib/org-governance'
import {
  normalizeThinkingLevel,
  QUESTION_PATTERN,
  resolveCwd,
  runAIDLCAssistantChat,
  runAIDLCMergeOrchestrator,
  runAIDLCParallelSubAgents,
  runAIDLCSpecificTask,
  runAIDLCSpecificWorkstream,
  STAGE_DEFINITIONS,
  type FlowOptions,
  type ParallelSubAgentResult,
  type PauseKind,
  type StageName,
} from './lib/aidlc'
import { PipelineEngine } from './lib/pipeline-engine'
import { getTemplate, listTemplates } from './lib/pipeline-loader'
import type { PipelineTemplate } from './lib/pipeline-template'
import { closeDb, getDb } from './lib/db'
import { enqueueJob, getOrchestrator, listJobsForProject, upsertOrchestrator } from './lib/dispatcher'
import { assertEnvOrExit } from './lib/env'
import { beginAuthorization, consumeState, exchangeCode, getProvider } from './lib/oauth'
import { disconnectAppIntegration, listAppIntegrations, upsertAppIntegration, type AppIntegrationKind } from './lib/app-integrations'
import { listLiveWorkers, sendAnswerToOwner } from './lib/worker-registry'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AssistantChatTurn } from './lib/aidlc'
import { checkAnthropicKey } from './lib/provider-check'
import { findLatestFeatureDirAbsolute, parsePlanRepositories } from './lib/aidlc'
import {
  createRun as dbCreateRun,
  getLatestRunForProject as dbGetLatestRunForProject,
  getRun as dbGetRun,
  listAllRuns as dbListAllRuns,
  listEvents as dbListEvents,
  requeueRunFromStage as dbRequeueRunFromStage,
  listRunsForProject as dbListRunsForProject,
  appendEvent as dbAppendEvent,
  resolveOpenGate as dbResolveOpenGate,
  updateRunStatus as dbUpdateRunStatus,
  type EventRow,
  type RunRow,
} from './lib/run-store'
import {
  addRepo as projAddRepo,
  createProject as projCreate,
  deleteProject as projDelete,
  getProject as projGet,
  getProjectDetail as projGetDetail,
  getRepo as projGetRepo,
  updateRepo as projUpdateRepo,
  listProjects as projList,
  removeIntegration as projRemoveIntegration,
  removeRepo as projRemoveRepo,
  updateProject as projUpdate,
  upsertIntegration as projUpsertIntegration,
  type IntegrationKind,
  type RepoKind,
  pickRunnableRepo,
  describeUnrunnableRepos,
  updateProjectKnowledge as projUpdateKnowledge,
  type ProjectKnowledgeConfig,
  type RepoRow,
} from './lib/project-registry'
import { GitHubNotConnectedError, listGitHubRepos, scheduleRepoClone, workspaceRoot } from './lib/github'
import { currentBranch as gitCurrentBranch, defaultBranch as gitDefaultBranch, publishBranchAsPullRequest, pullRequestBody } from './lib/pull-requests'
import { getOnboardingSnapshot, refreshRepositoryKnowledge, startProjectOnboarding } from './lib/project-onboarding'
import {
  getKnowledgeItem,
  KnowledgeSourceNotConnectedError,
  listConnectedKnowledgeSources,
  saveKnowledgeSnapshot,
  searchKnowledge,
  type KnowledgeSource,
} from './lib/integration-sources'
import { log } from './lib/logger'

const serverLog = log.child({ mod: 'server' })

assertEnvOrExit('web server')

const srcDir = dirname(fileURLToPath(import.meta.url))
const webDir = join(srcDir, 'web')
const publicDir = join(srcDir, '..', 'public')
const port = Number(process.env.PORT ?? '3000')
const subagentJobs = new Map<string, SubAgentJobRecord>()
// Keep the database schema in step with the code on every boot (idempotent DDL),
// so a new column never surfaces as "column ... does not exist" in the UI.
try {
  await import('./lib/db').then((m) => m.applySchema())
} catch (error) {
  serverLog.error(
    'schema apply failed (continuing; run `bun run db:migrate` manually)',
    error instanceof Error ? error : new Error(String(error)),
  )
}
await ensureFrontendBuilt()
// A shell ANTHROPIC_API_KEY overrides .env; a placeholder there makes every agent
// call 401 with nothing in the UI explaining why. Check once at boot (non-fatal).
void checkAnthropicKey(serverLog)

const server = Bun.serve({
  port,
  idleTimeout: 0,
  async fetch(req) {
    try {
      return await route(req)
    } catch (error) {
      return sendJson(500, {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  },
})

serverLog.info('spaces web UI running', { url: `http://localhost:${server.port}`, port: server.port })
serverLog.info('serving frontend assets', { publicDir })

let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  serverLog.info('shutdown signal received', { signal })
  try {
    server.stop(true)
    await closeDb()
    serverLog.info('shutdown complete')
    process.exit(0)
  } catch (err) {
    serverLog.error('shutdown error', err instanceof Error ? err : new Error(String(err)))
    process.exit(1)
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

async function route(req: Request): Promise<Response> {
  const method = req.method ?? 'GET'
  const url = new URL(req.url)

  if (method === 'GET' && url.pathname === '/') {
    const html = await readFile(join(webDir, 'index.html'), 'utf8')
    return sendHtml(200, html)
  }

  if (method === 'GET' && url.pathname === '/health') {
    return sendJson(200, { ok: true })
  }

  if (method === 'GET' && url.pathname === '/api/history') {
    return sendJson(200, await listHistory())
  }

  // ---- Project registry (Phase 4A) ----

  if (method === 'GET' && url.pathname === '/api/projects') {
    return sendJson(200, await projList())
  }

  if (method === 'POST' && url.pathname === '/api/projects') {
    const body = await readJson<{
      name?: string
      description?: string
      repos?: Array<{ label: string; kind: RepoKind; localPath?: string; githubRepo?: string; isPrimary?: boolean }>
      integrations?: Array<{ kind: IntegrationKind; displayName?: string; config?: Record<string, unknown> }>
      /** Model used by the onboarding "learn the codebase" agent. */
      model?: string
    }>(req)
    if (!body.name?.trim()) return sendJson(400, { error: 'name is required' })
    const project = await projCreate({ name: body.name.trim(), description: body.description?.trim() })
    for (const r of body.repos ?? []) {
      await projAddRepo({ projectId: project.projectId, ...r })
    }
    for (const i of body.integrations ?? []) {
      await projUpsertIntegration({ projectId: project.projectId, ...i })
    }
    // Onboarding runs in the background: clone remote repos FIRST, then inventory
    // the codebase, have an agent learn it, and store the result as project memory.
    // The wizard polls GET /api/projects/:id/onboarding and waits before the first run.
    void startProjectOnboarding(project, { model: body.model?.trim() || 'anthropic/claude-sonnet-4-5' })
    const detail = await projGetDetail(project.projectId)
    return sendJson(201, { ...detail, onboarding: getOnboardingSnapshot(project.projectId) })
  }

  if (method === 'GET' && /^\/api\/projects\/[0-9a-f-]{36}\/onboarding$/.test(url.pathname)) {
    const projectId = url.pathname.split('/')[3]!
    return sendJson(200, getOnboardingSnapshot(projectId))
  }

  // Re-run onboarding (e.g. after fixing the GitHub connection or adding a repo).
  if (method === 'POST' && /^\/api\/projects\/[0-9a-f-]{36}\/onboarding$/.test(url.pathname)) {
    const projectId = url.pathname.split('/')[3]!
    const project = await projGet(projectId)
    if (!project) return sendJson(404, { error: 'Project not found.' })
    const body = await readJson<{ model?: string }>(req)
    void startProjectOnboarding(project, { model: body.model?.trim() || 'anthropic/claude-sonnet-4-5' })
    return sendJson(202, getOnboardingSnapshot(projectId))
  }

  if (method === 'GET' && /^\/api\/projects\/[0-9a-f-]{36}$/.test(url.pathname)) {
    const projectId = url.pathname.split('/').pop()!
    const detail = await projGetDetail(projectId)
    if (!detail) return sendJson(404, { error: 'Project not found.' })
    return sendJson(200, detail)
  }

  if (method === 'PATCH' && /^\/api\/projects\/[0-9a-f-]{36}$/.test(url.pathname)) {
    const projectId = url.pathname.split('/').pop()!
    const body = await readJson<{ name?: string; description?: string }>(req)
    const updated = await projUpdate(projectId, body)
    if (!updated) return sendJson(404, { error: 'Project not found.' })
    return sendJson(200, updated)
  }

  if (method === 'DELETE' && /^\/api\/projects\/[0-9a-f-]{36}$/.test(url.pathname)) {
    const projectId = url.pathname.split('/').pop()!
    await projDelete(projectId)
    return sendJson(204, {})
  }

  if (method === 'POST' && /^\/api\/projects\/[0-9a-f-]{36}\/repos$/.test(url.pathname)) {
    const projectId = url.pathname.split('/')[3]!
    const project = await projGet(projectId)
    if (!project) return sendJson(404, { error: 'Project not found.' })
    const body = await readJson<{ label?: string; kind?: RepoKind; localPath?: string; githubRepo?: string; isPrimary?: boolean }>(req)
    if (!body.label?.trim() || !body.kind) return sendJson(400, { error: 'label and kind are required' })
    if (body.kind === 'local' && !body.localPath) return sendJson(400, { error: 'localPath required for kind=local' })
    if (body.kind === 'github' && !body.githubRepo) return sendJson(400, { error: 'githubRepo required for kind=github' })
    const repo = await projAddRepo({ projectId, label: body.label.trim(), kind: body.kind, localPath: body.localPath, githubRepo: body.githubRepo, isPrimary: body.isPrimary })
    // Once the checkout exists, learn it and recompose project memory so agents
    // (and tasks blocked on this repo) can use it.
    if (repo.kind === 'github') {
      void scheduleRepoClone(repo).then(() => refreshRepositoryKnowledge(projectId, repo.repoId)).catch(() => undefined)
    } else {
      void refreshRepositoryKnowledge(projectId, repo.repoId).catch(() => undefined)
    }
    return sendJson(201, repo)
  }

  // Re-learn one repository (inventory + brief) and recompose project memory.
  if (method === 'POST' && /^\/api\/projects\/[0-9a-f-]{36}\/repos\/[0-9a-f-]{36}\/learn$/.test(url.pathname)) {
    const projectId = url.pathname.split('/')[3]!
    const repoId = url.pathname.split('/')[5]!
    const repo = await projGetRepo(repoId)
    if (!repo) return sendJson(404, { error: 'Repo not found.' })
    if (!repo.localPath) return sendJson(409, { error: 'Repository has no local checkout yet; clone it first.' })
    void refreshRepositoryKnowledge(projectId, repoId).catch(() => undefined)
    return sendJson(202, { ok: true, repoId, status: 'learning' })
  }

  // Edit a registered repo (label, path, owner/name, primary). Changing the
  // GitHub owner/name re-queues a clone.
  if (method === 'PATCH' && /^\/api\/projects\/[0-9a-f-]{36}\/repos\/[0-9a-f-]{36}$/.test(url.pathname)) {
    const repoId = url.pathname.split('/')[5]!
    const existing = await projGetRepo(repoId)
    if (!existing) return sendJson(404, { error: 'Repo not found.' })
    const body = await readJson<{ label?: string; localPath?: string; githubRepo?: string; isPrimary?: boolean }>(req)
    const updated = await projUpdateRepo(repoId, {
      label: body.label?.trim() || undefined,
      localPath: body.localPath?.trim() || undefined,
      githubRepo: body.githubRepo?.trim() || undefined,
      isPrimary: body.isPrimary,
    })
    if (updated?.kind === 'github' && body.githubRepo?.trim() && body.githubRepo.trim() !== existing.githubRepo) {
      void scheduleRepoClone(updated).then(() => refreshRepositoryKnowledge(updated.projectId, updated.repoId)).catch(() => undefined)
    } else if (updated && body.localPath?.trim() && body.localPath.trim() !== existing.localPath) {
      void refreshRepositoryKnowledge(updated.projectId, updated.repoId).catch(() => undefined)
    } else if (updated) {
      // Label/primary changes: recompose the repository map without re-learning.
      void import('./lib/project-onboarding').then((m) => m.composeProjectMemory(updated.projectId)).catch(() => undefined)
    }
    return sendJson(200, updated ?? existing)
  }

  // Repositories the current plan says this feature touches, matched against the
  // project's registered repos, so missing ones can be added before implementation.
  if (method === 'GET' && /^\/api\/projects\/[^/]+\/plan-repos$/.test(url.pathname)) {
    const [, , , slug] = url.pathname.split('/')
    const project = await import('./lib/project-registry').then((m) => m.getProjectBySlug(slug))
    if (!project) return sendJson(404, { error: 'Project not found.' })
    const repos = await import('./lib/project-registry').then((m) => m.listRepos(project.projectId))
    const primary = pickRunnableRepo(repos)
    if (!primary?.localPath) return sendJson(200, { featureDir: null, repositories: [] })
    const featureDir = await findLatestFeatureDirAbsolute(primary.localPath)
    if (!featureDir) return sendJson(200, { featureDir: null, repositories: [] })
    let plan = ''
    try { plan = await readFile(join(featureDir, 'plan.md'), 'utf8') } catch { return sendJson(200, { featureDir, repositories: [] }) }
    const norm = (v: string) => v.trim().toLowerCase().replace(/\.git$/, '')
    const matches = (name: string, repo: RepoRow) =>
      norm(name) === norm(repo.label)
      || (repo.githubRepo ? norm(name) === norm(repo.githubRepo) || norm(name) === norm(repo.githubRepo.split('/')[1] ?? '') : false)
      || (repo.localPath ? norm(name) === norm(basename(repo.localPath)) : false)
    const repositories = parsePlanRepositories(plan).map((ref) => {
      const registered = /^primary$/i.test(ref.name)
        ? repos.find((r) => r.isPrimary) ?? primary
        : repos.find((r) => matches(ref.name, r))
      return { ...ref, registered: Boolean(registered), repoId: registered?.repoId, cloneStatus: registered?.cloneStatus }
    })
    return sendJson(200, { featureDir: featureDir.replace(`${primary.localPath}/`, ''), repositories })
  }

  // (Re)clone a GitHub repo into the local workspace. Idempotent: an in-flight
  // clone is shared, a finished clone is fetched rather than re-cloned.
  if (method === 'POST' && /^\/api\/projects\/[0-9a-f-]{36}\/repos\/[0-9a-f-]{36}\/clone$/.test(url.pathname)) {
    const repoId = url.pathname.split('/')[5]!
    const repo = await projGetRepo(repoId)
    if (!repo) return sendJson(404, { error: 'Repo not found.' })
    if (repo.kind !== 'github' || !repo.githubRepo) return sendJson(400, { error: 'Only GitHub repos can be cloned.' })
    void scheduleRepoClone(repo).then(() => refreshRepositoryKnowledge(repo.projectId, repo.repoId)).catch(() => undefined)
    const refreshed = await projGetRepo(repoId)
    return sendJson(202, refreshed ?? repo)
  }

  // ---- Workers (shared or per-project via src/supervisor.ts) ----

  if (method === 'GET' && url.pathname === '/api/workers') {
    return sendJson(200, { workers: await listLiveWorkers() })
  }

  // The worker serving one project: hot (running jobs), warm (alive, idle or
  // holding paused runs), stale (missed heartbeats) or none (spawns on demand).
  if (method === 'GET' && /^\/api\/projects\/[0-9a-f-]{36}\/worker$/.test(url.pathname)) {
    const projectId = url.pathname.split('/')[3]!
    const workers = await listLiveWorkers()
    const dedicated = workers.find((w) => w.projectId === projectId && w.state !== 'stale')
      ?? workers.find((w) => w.projectId === projectId)
    const shared = workers.filter((w) => !w.projectId && w.state !== 'stale')
    return sendJson(200, {
      worker: dedicated ?? null,
      sharedWorkers: shared.length,
      state: dedicated ? dedicated.state : shared.length > 0 ? 'shared' : 'none',
    })
  }

  // ---- Integrations as knowledge (Jira / Linear / Confluence / GitHub) ----

  if (method === 'GET' && url.pathname === '/api/knowledge/sources') {
    return sendJson(200, { sources: await listConnectedKnowledgeSources() })
  }

  // Per-project knowledge scope: which integrations/repos this project's agents may query.
  if (method === 'GET' && /^\/api\/projects\/[0-9a-f-]{36}\/knowledge$/.test(url.pathname)) {
    const projectId = url.pathname.split('/')[3]!
    const project = await projGet(projectId)
    if (!project) return sendJson(404, { error: 'Project not found.' })
    const { resolveKnowledgeScope } = await import('./lib/integration-sources')
    const scope = await resolveKnowledgeScope(projectId)
    const connected = await listConnectedKnowledgeSources()
    const repos = (await import('./lib/project-registry').then((m) => m.listRepos(projectId)))
      .map((r) => r.githubRepo).filter((r): r is string => Boolean(r))
    return sendJson(200, { config: project.knowledgeJson ?? {}, effective: scope, connected, registeredRepos: repos })
  }

  if (method === 'PUT' && /^\/api\/projects\/[0-9a-f-]{36}\/knowledge$/.test(url.pathname)) {
    const projectId = url.pathname.split('/')[3]!
    const project = await projGet(projectId)
    if (!project) return sendJson(404, { error: 'Project not found.' })
    const body = await readJson<ProjectKnowledgeConfig>(req)
    const clean = (list?: unknown): string[] | undefined => Array.isArray(list)
      ? list.map((v) => String(v).trim()).filter(Boolean)
      : undefined
    const allowedSources = ['jira', 'linear', 'confluence', 'github'] as const
    const config: ProjectKnowledgeConfig = {
      ...(body.sources ? { sources: body.sources.filter((s) => (allowedSources as readonly string[]).includes(s)) } : {}),
      ...(body.jira ? { jira: { projects: clean(body.jira.projects) } } : {}),
      ...(body.linear ? { linear: { teams: clean(body.linear.teams), projects: clean(body.linear.projects) } } : {}),
      ...(body.confluence ? { confluence: { spaces: clean(body.confluence.spaces) } } : {}),
      ...(body.github ? { github: { repos: clean(body.github.repos) } } : {}),
    }
    const updated = await projUpdateKnowledge(projectId, config)
    const { resolveKnowledgeScope } = await import('./lib/integration-sources')
    return sendJson(200, { config: updated?.knowledgeJson ?? config, effective: await resolveKnowledgeScope(projectId) })
  }

  // Search a connected source. Powers "Import from Jira/Linear" and ad-hoc lookups.
  if (method === 'GET' && url.pathname === '/api/knowledge/search') {
    const source = url.searchParams.get('source') as KnowledgeSource | null
    const query = url.searchParams.get('q')?.trim() ?? ''
    const limit = Number(url.searchParams.get('limit') ?? '10')
    const repos = (url.searchParams.get('repos') ?? '').split(',').map((r) => r.trim()).filter(Boolean)
    if (!source || !['jira', 'linear', 'confluence', 'github'].includes(source)) return sendJson(400, { error: 'source must be jira, linear, confluence or github.' })
    if (!query) return sendJson(400, { error: 'q is required.' })
    try {
      return sendJson(200, { hits: await searchKnowledge({ source, query, limit, repos }) })
    } catch (error) {
      if (error instanceof KnowledgeSourceNotConnectedError) return sendJson(409, { error: error.message, hits: [] })
      return sendJson(502, { error: error instanceof Error ? error.message : String(error), hits: [] })
    }
  }

  if (method === 'GET' && url.pathname === '/api/knowledge/item') {
    const source = url.searchParams.get('source') as KnowledgeSource | null
    const id = url.searchParams.get('id')?.trim() ?? ''
    const repos = (url.searchParams.get('repos') ?? '').split(',').map((r) => r.trim()).filter(Boolean)
    if (!source || !['jira', 'linear', 'confluence', 'github'].includes(source)) return sendJson(400, { error: 'source must be jira, linear, confluence or github.' })
    if (!id) return sendJson(400, { error: 'id is required.' })
    try {
      return sendJson(200, await getKnowledgeItem({ source, id, repos }))
    } catch (error) {
      if (error instanceof KnowledgeSourceNotConnectedError) return sendJson(409, { error: error.message })
      return sendJson(502, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  // Import a ticket/doc into a project as a source snapshot: it then appears in the
  // shared context bundle for every stage and agent working on that project.
  if (method === 'POST' && /^\/api\/projects\/[0-9a-f-]{36}\/sources\/import$/.test(url.pathname)) {
    const projectId = url.pathname.split('/')[3]!
    const project = await projGet(projectId)
    if (!project) return sendJson(404, { error: 'Project not found.' })
    const body = await readJson<{ source?: KnowledgeSource; id?: string; scope?: string }>(req)
    if (!body.source || !body.id?.trim()) return sendJson(400, { error: 'source and id are required.' })
    const repos = (await import('./lib/project-registry').then((m) => m.listRepos(projectId)))
      .map((r) => r.githubRepo).filter((r): r is string => Boolean(r))
    try {
      const doc = await getKnowledgeItem({ source: body.source, id: body.id.trim(), repos })
      await saveKnowledgeSnapshot(projectId, doc, body.scope)
      return sendJson(201, doc)
    } catch (error) {
      if (error instanceof KnowledgeSourceNotConnectedError) return sendJson(409, { error: error.message })
      return sendJson(502, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  // Repos visible to the connected GitHub account — powers the wizard autocomplete.
  if (method === 'GET' && url.pathname === '/api/github/repos') {
    try {
      const repos = await listGitHubRepos()
      return sendJson(200, { workspaceRoot: workspaceRoot(), repos })
    } catch (error) {
      if (error instanceof GitHubNotConnectedError) return sendJson(409, { error: error.message, repos: [] })
      return sendJson(502, { error: error instanceof Error ? error.message : String(error), repos: [] })
    }
  }

  if (method === 'DELETE' && /^\/api\/projects\/[0-9a-f-]{36}\/repos\/[0-9a-f-]{36}$/.test(url.pathname)) {
    const projectId = url.pathname.split('/')[3]!
    const repoId = url.pathname.split('/').pop()!
    const existing = await projGetRepo(repoId)
    await projRemoveRepo(repoId)
    // Keep agents' picture consistent: drop the repo's brief, recompose memory,
    // and prune it from the project's knowledge scope.
    void (async () => {
      const sql = getDb()
      await sql`DELETE FROM project_source_snapshots WHERE project_id = ${projectId} AND source = 'codebase' AND entity_id = ${repoId}`
      const project = await projGet(projectId)
      if (project?.knowledgeJson?.github?.repos?.length && existing?.githubRepo) {
        const repos = project.knowledgeJson.github.repos.filter((r) => r !== existing.githubRepo)
        await projUpdateKnowledge(projectId, { ...project.knowledgeJson, github: { ...project.knowledgeJson.github, repos } })
      }
      const { composeProjectMemory } = await import('./lib/project-onboarding')
      await composeProjectMemory(projectId)
    })().catch((error) => serverLog.warn('post-remove repo cleanup failed', { repoId, error: error instanceof Error ? error.message : String(error) }))
    return sendJson(204, {})
  }

  if (method === 'POST' && /^\/api\/projects\/[0-9a-f-]{36}\/integrations$/.test(url.pathname)) {
    const projectId = url.pathname.split('/')[3]!
    const project = await projGet(projectId)
    if (!project) return sendJson(404, { error: 'Project not found.' })
    const body = await readJson<{ kind?: IntegrationKind; displayName?: string; config?: Record<string, unknown> }>(req)
    if (!body.kind) return sendJson(400, { error: 'kind is required' })
    const integration = await projUpsertIntegration({ projectId, kind: body.kind, displayName: body.displayName, config: body.config })
    return sendJson(201, integration)
  }

  if (method === 'DELETE' && /^\/api\/projects\/[0-9a-f-]{36}\/integrations\/[0-9a-f-]{36}$/.test(url.pathname)) {
    const integrationId = url.pathname.split('/').pop()!
    await projRemoveIntegration(integrationId)
    return sendJson(204, {})
  }

  if (method === 'GET' && url.pathname === '/api/pipelines') {
    const projectNamespace = url.searchParams.get('project') || undefined
    return sendJson(200, await listTemplates(projectNamespace))
  }

  if (method === 'GET' && /^\/api\/pipelines\/[^/]+$/.test(url.pathname)) {
    const name = url.pathname.split('/').filter(Boolean)[2]!
    const projectNamespace = url.searchParams.get('project') || undefined
    try {
      const { template, source, path } = await getTemplate(name, projectNamespace)
      return sendJson(200, { template, source, path, plan: PipelineEngine.describePlan(template) })
    } catch (error) {
      return sendJson(404, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  if (method === 'GET' && url.pathname === '/api/board') {
    return sendJson(200, await buildBoard())
  }

  if (method === 'GET' && url.pathname === '/api/org/promotions') {
    return sendJson(200, await listPromotionProposals())
  }

  if (method === 'POST' && /^\/api\/org\/promotions\/[^/]+\/decision$/.test(url.pathname)) {
    const parts = url.pathname.split('/').filter(Boolean)
    const proposalId = parts[3]
    const body = await readJson<{ decision: 'approved' | 'rejected'; notes?: string }>(req)
    return sendJson(200, await decidePromotionProposal({ proposalId, decision: body.decision, notes: body.notes }))
  }

  if (method === 'GET' && /^\/api\/projects\/[^/]+\/context$/.test(url.pathname)) {
    const [, , , projectNamespace] = url.pathname.split('/')
    const projectMeta = await readProjectMeta(projectNamespace)
    if (!projectMeta) {
      return sendJson(404, { error: 'Project namespace not found.' })
    }
    return sendJson(200, await buildContextBundle({ projectSlug: projectNamespace, projectPath: projectMeta.path }))
  }

  if (method === 'GET' && /^\/api\/projects\/[^/]+\/latest-run$/.test(url.pathname)) {
    const [, , , projectNamespace] = url.pathname.split('/')
    const snapshot = await readLatestRunSnapshot(projectNamespace)
    return sendJson(200, snapshot ? { ...snapshot, resumable: await isRunResumable(snapshot.runId) } : null)
  }

  if (method === 'GET' && /^\/api\/projects\/[^/]+\/qa$/.test(url.pathname)) {
    const [, , , projectNamespace] = url.pathname.split('/')
    const projectMeta = await readProjectMeta(projectNamespace)
    if (!projectMeta) {
      return sendJson(404, { error: 'Project namespace not found.' })
    }
    return sendJson(200, await buildQAOverview(projectNamespace, projectMeta.path))
  }

  if (method === 'POST' && /^\/api\/projects\/[^/]+\/tasks\/[^/]+\/run$/.test(url.pathname)) {
    const parts = url.pathname.split('/').filter(Boolean)
    const projectNamespace = parts[2]
    const taskId = decodeURIComponent(parts[4])
    const projectMeta = await readProjectMeta(projectNamespace)
    if (!projectMeta) {
      return sendJson(404, { error: 'Project namespace not found.' })
    }
    // Test plan is required before individual task runs — enforces the "don't
    // work on tasks without a test plan" rule.
    const artifacts = await collectProjectArtifacts(projectNamespace, projectMeta.path)
    const hasTestPlan = artifacts.links.some((l) => l.stepLabel === 'Test Plan')
    if (!hasTestPlan) {
      return sendJson(409, { error: 'Cannot run individual tasks before a test plan exists. Run the `testplan` stage first.' })
    }
    const contextBundle = await buildContextBundle({ projectSlug: projectNamespace, projectPath: projectMeta.path })
    const result = await runAIDLCSpecificTask({ cwd: projectMeta.path, taskId, sharedContextPrompt: contextBundle.promptBundle })
    return sendJson(200, result)
  }

  if (method === 'POST' && /^\/api\/projects\/[^/]+\/workstreams\/run$/.test(url.pathname)) {
    const [, , , projectNamespace] = url.pathname.split('/')
    const projectMeta = await readProjectMeta(projectNamespace)
    if (!projectMeta) {
      return sendJson(404, { error: 'Project namespace not found.' })
    }
    const artifacts = await collectProjectArtifacts(projectNamespace, projectMeta.path)
    const hasTestPlan = artifacts.links.some((l) => l.stepLabel === 'Test Plan')
    if (!hasTestPlan) {
      return sendJson(409, { error: 'Cannot run a workstream before a test plan exists. Run the `testplan` stage first.' })
    }
    const body = await readJson<{ taskId?: string; workstreamTitle?: string }>(req)
    const contextBundle = await buildContextBundle({ projectSlug: projectNamespace, projectPath: projectMeta.path })
    const result = await runAIDLCSpecificWorkstream({
      cwd: projectMeta.path,
      taskId: body.taskId,
      workstreamTitle: body.workstreamTitle,
      sharedContextPrompt: contextBundle.promptBundle,
    })
    return sendJson(200, result)
  }

  if (method === 'GET' && /^\/api\/projects\/[^/]+\/subagents$/.test(url.pathname)) {
    const [, , , projectNamespace] = url.pathname.split('/')
    return sendJson(200, subagentJobs.get(projectNamespace)?.snapshot ?? createIdleSubagentSnapshot(projectNamespace))
  }

  if (method === 'GET' && /^\/api\/projects\/[^/]+\/subagents\/events$/.test(url.pathname)) {
    const [, , , projectNamespace] = url.pathname.split('/')
    const job = ensureSubagentJob(projectNamespace)
    return attachSubagentEventStream(req, job)
  }

  if (method === 'POST' && /^\/api\/projects\/[^/]+\/subagents\/cancel$/.test(url.pathname)) {
    const [, , , projectNamespace] = url.pathname.split('/')
    const job = ensureSubagentJob(projectNamespace)
    for (const session of job.activeSessions.values()) {
      void session.abort()
    }
    job.snapshot.status = 'error'
    job.snapshot.error = 'Cancelled by user.'
    job.snapshot.updatedAt = new Date().toISOString()
    emitSubagentJob(job)
    return sendJson(200, job.snapshot)
  }

  if (method === 'POST' && /^\/api\/projects\/[^/]+\/subagents\/retry$/.test(url.pathname)) {
    const [, , , projectNamespace] = url.pathname.split('/')
    const projectMeta = await readProjectMeta(projectNamespace)
    if (!projectMeta) {
      return sendJson(404, { error: 'Project namespace not found.' })
    }
    const body = await readJson<{ maxAgents?: number; model?: string }>(req)
    const contextBundle = await buildContextBundle({ projectSlug: projectNamespace, projectPath: projectMeta.path })
    const model = await resolveSubagentModel(projectNamespace, body.model)
    const { projectId: subagentProjectId, targets: repoTargets } = await subagentRepoTargets(projectNamespace)
    const job = ensureSubagentJob(projectNamespace)
    job.snapshot = createIdleSubagentSnapshot(projectNamespace)
    emitSubagentJob(job)
    void startSubagentJob(job, projectMeta.path, contextBundle.promptBundle, body.maxAgents, model, repoTargets, subagentProjectId)
    return sendJson(202, job.snapshot)
  }

  if (method === 'POST' && /^\/api\/projects\/[^/]+\/subagents\/run$/.test(url.pathname)) {
    const [, , , projectNamespace] = url.pathname.split('/')
    const projectMeta = await readProjectMeta(projectNamespace)
    if (!projectMeta) {
      return sendJson(404, { error: 'Project namespace not found.' })
    }
    const body = await readJson<{ maxAgents?: number; model?: string }>(req)
    const contextBundle = await buildContextBundle({ projectSlug: projectNamespace, projectPath: projectMeta.path })
    const job = ensureSubagentJob(projectNamespace)
    if (job.snapshot.status === 'running') {
      return sendJson(409, { error: 'Sub-agent job already running.' })
    }

    const model = await resolveSubagentModel(projectNamespace, body.model)
    const { projectId: subagentProjectId, targets: repoTargets } = await subagentRepoTargets(projectNamespace)
    void startSubagentJob(job, projectMeta.path, contextBundle.promptBundle, body.maxAgents, model, repoTargets, subagentProjectId)
    return sendJson(202, job.snapshot)
  }

  if (method === 'POST' && /^\/api\/projects\/[^/]+\/promotions$/.test(url.pathname)) {
    const [, , , projectNamespace] = url.pathname.split('/')
    const body = await readJson<{ title: string; content: string; targetFile?: string }>(req)
    return sendJson(200, await createPromotionProposal({
      projectNamespace,
      title: body.title,
      content: body.content,
      targetFile: body.targetFile,
    }))
  }

  if (method === 'POST' && /^\/api\/projects\/[^/]+\/chat$/.test(url.pathname)) {
    const [, , , projectNamespace] = url.pathname.split('/')
    const projectMeta = await readProjectMeta(projectNamespace)
    if (!projectMeta) {
      return sendJson(404, { error: 'Project namespace not found.' })
    }

    const body = await readJson<{ message?: string; model?: string }>(req)
    if (!body.message?.trim()) {
      return sendJson(400, { error: 'Message is required.' })
    }

    // Full context: the shared bundle WITH the project id (memory, imported
    // tickets, knowledge scope), a live operations snapshot (runs, timelines,
    // log tails, jobs, workers, repos, onboarding), the conversation so far,
    // and action tools so the assistant can act, not just advise.
    const ops = await buildAssistantOperationsContext(projectNamespace, projectMeta.path)
    const contextBundle = await buildContextBundle({ projectId: ops.projectId, projectSlug: projectNamespace, projectPath: projectMeta.path })
    const history = assistantHistory.get(projectNamespace) ?? []
    const actions: string[] = []
    const model = await resolveSubagentModel(projectNamespace, body.model)
    try {
      const answer = await runAIDLCAssistantChat({
        cwd: projectMeta.path,
        message: body.message,
        sharedContextPrompt: contextBundle.promptBundle,
        operationsContext: ops.markdown,
        history,
        projectId: ops.projectId,
        actionTools: buildAssistantActionTools(projectNamespace, ops.projectId, (line) => actions.push(line)),
        model,
      })
      if (!answer) {
        return sendJson(502, {
          error: 'The assistant returned no output. Check server logs and your LLM provider status/quota.',
        })
      }
      rememberAssistantTurn(projectNamespace, { role: 'user', content: body.message })
      rememberAssistantTurn(projectNamespace, { role: 'assistant', content: answer })
      const entries = (assistantHistory.get(projectNamespace) ?? []).map((turn) => ({ role: turn.role, content: turn.content, kind: 'chat' as const }))
      return sendJson(200, { answer, history: entries, actions, focusRunId: ops.latestRunId })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return sendJson(502, { error: message })
    }
  }

  if (method === 'GET' && /^\/api\/projects\/[^/]+\/assistant\/history$/.test(url.pathname)) {
    const [, , , projectNamespace] = url.pathname.split('/')
    const entries = (assistantHistory.get(projectNamespace) ?? []).map((turn) => ({ role: turn.role, content: turn.content, kind: 'chat' as const }))
    return sendJson(200, { history: entries })
  }

  if (method === 'DELETE' && /^\/api\/projects\/[^/]+\/assistant\/history$/.test(url.pathname)) {
    const [, , , projectNamespace] = url.pathname.split('/')
    assistantHistory.delete(projectNamespace)
    return sendJson(200, { history: [] })
  }

  // ---- Project orchestrator config + jobs queue ----

  if (method === 'GET' && /^\/api\/projects\/[^/]+\/orchestrator$/.test(url.pathname)) {
    const [, , , slug] = url.pathname.split('/')
    const project = await import('./lib/project-registry').then((m) => m.getProjectBySlug(slug))
    if (!project) return sendJson(404, { error: 'Project not found.' })
    const orch = await getOrchestrator(project.projectId)
    // Surface speedMode from configJson so the UI can render + edit it directly
    // without needing to reach into the JSON bag.
    const rawSpeed = (orch.configJson as Record<string, unknown> | undefined)?.speed_mode
    const speedMode = rawSpeed === 'fast' || rawSpeed === 'balanced' || rawSpeed === 'quality' ? rawSpeed : 'balanced'
    return sendJson(200, { ...orch, speedMode })
  }

  if (method === 'PATCH' && /^\/api\/projects\/[^/]+\/orchestrator$/.test(url.pathname)) {
    const [, , , slug] = url.pathname.split('/')
    const project = await import('./lib/project-registry').then((m) => m.getProjectBySlug(slug))
    if (!project) return sendJson(404, { error: 'Project not found.' })
    const body = await readJson<{
      autonomousMode?: boolean
      maxConcurrent?: number
      speedMode?: 'fast' | 'balanced' | 'quality'
      config?: Record<string, unknown>
    }>(req)
    // speedMode is stored inside config_json.speed_mode (shallow-merged in
    // upsertOrchestrator via `||`), so the worker can read it when building
    // engine options for a new run.
    const config = {
      ...(body.config ?? {}),
      ...(body.speedMode ? { speed_mode: body.speedMode } : {}),
    }
    const updated = await upsertOrchestrator({
      projectId: project.projectId,
      autonomousMode: body.autonomousMode,
      maxConcurrent: body.maxConcurrent,
      config: Object.keys(config).length > 0 ? config : undefined,
    })
    const rawSpeed = (updated.configJson as Record<string, unknown> | undefined)?.speed_mode
    const speedMode = rawSpeed === 'fast' || rawSpeed === 'balanced' || rawSpeed === 'quality' ? rawSpeed : 'balanced'
    return sendJson(200, { ...updated, speedMode })
  }

  if (method === 'GET' && /^\/api\/projects\/[^/]+\/jobs$/.test(url.pathname)) {
    const [, , , slug] = url.pathname.split('/')
    const project = await import('./lib/project-registry').then((m) => m.getProjectBySlug(slug))
    if (!project) return sendJson(404, { error: 'Project not found.' })
    return sendJson(200, await listJobsForProject(project.projectId))
  }

  if (method === 'GET' && /^\/api\/projects\/[^/]+\/agents$/.test(url.pathname)) {
    const [, , , slug] = url.pathname.split('/')
    const project = await import('./lib/project-registry').then((m) => m.getProjectBySlug(slug))
    if (!project) return sendJson(404, { error: 'Project not found.' })
    const sql = getDb()
    const agents = await sql<Array<{ agentId: string; role: string; status: string; sessionFile?: string; lastUsedAt?: string; warmedAt?: string }>>`
      SELECT agent_id AS "agentId", role, status, session_file AS "sessionFile", last_used_at AS "lastUsedAt", warmed_at AS "warmedAt"
        FROM project_agents WHERE project_id = ${project.projectId}
        ORDER BY warmed_at DESC
    `
    return sendJson(200, agents)
  }

  // ---- Read-only task tracker (parses tasks.md from the latest feature dir) ----

  if (method === 'GET' && /^\/api\/projects\/[^/]+\/task-tracker$/.test(url.pathname)) {
    const [, , , slug] = url.pathname.split('/')
    const project = await import('./lib/project-registry').then((m) => m.getProjectBySlug(slug))
    if (!project) return sendJson(404, { error: 'Project not found.' })
    const repos = await import('./lib/project-registry').then((m) => m.listRepos(project.projectId))
    const primary = pickRunnableRepo(repos)
    if (!primary?.localPath) return sendJson(200, { featureDir: undefined, items: [] })
    const tracker = await buildTaskTrackerRead(primary.localPath)
    return sendJson(200, tracker)
  }

  // ---- App-level integrations ----

  if (method === 'GET' && url.pathname === '/api/integrations') {
    return sendJson(200, await listAppIntegrations())
  }

  if (method === 'DELETE' && /^\/api\/integrations\/[a-z]+$/.test(url.pathname)) {
    const kind = url.pathname.split('/').pop() as AppIntegrationKind
    await disconnectAppIntegration(kind)
    return sendJson(200, { ok: true })
  }

  // ---- OAuth authorize + callback (app-level, no projectId) ----

  if (method === 'GET' && /^\/api\/oauth\/[^/]+\/authorize$/.test(url.pathname)) {
    const provider = url.pathname.split('/')[3]!
    const cfg = getProvider(provider)
    if (!cfg) return sendJson(400, { error: `Provider "${provider}" is not configured. Set ${provider.toUpperCase()}_CLIENT_ID + _CLIENT_SECRET in .env.` })
    const callbackUrl = `${url.origin}/api/oauth/${provider}/callback`
    // projectId is legacy: keep it optional in state so old links don't 500.
    const projectIdOrEmpty = url.searchParams.get('projectId') ?? ''
    const { redirectUrl } = beginAuthorization(cfg, projectIdOrEmpty, callbackUrl)
    return new Response(null, { status: 302, headers: { location: redirectUrl } })
  }

  if (method === 'GET' && /^\/api\/oauth\/[^/]+\/callback$/.test(url.pathname)) {
    const provider = url.pathname.split('/')[3]!
    const cfg = getProvider(provider)
    if (!cfg) return sendJson(400, { error: `Provider "${provider}" no longer configured.` })
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    if (!code || !state) return sendJson(400, { error: 'Missing code or state.' })
    const pending = consumeState(state)
    if (!pending || pending.provider !== provider) return sendJson(400, { error: 'Invalid or expired OAuth state.' })

    const callbackUrl = `${url.origin}/api/oauth/${provider}/callback`
    try {
      const tokens = await exchangeCode(cfg, code, callbackUrl)
      // Atlassian OAuth grants access to both Jira and Confluence — record both slots.
      const kinds: AppIntegrationKind[] = provider === 'atlassian' ? ['jira', 'confluence'] : [provider as AppIntegrationKind]
      for (const kind of kinds) {
        await upsertAppIntegration({
          kind,
          status: 'connected',
          credentials: tokens as unknown as Record<string, unknown>,
        })
      }
      return sendHtml(200, `<!doctype html><html><body style="font-family:system-ui;padding:40px;text-align:center"><h1>✅ ${provider} connected</h1><p>App-level integration stored. You can close this window and return to the app.</p><script>window.close()</script></body></html>`)
    } catch (error) {
      return sendJson(500, { error: `OAuth token exchange failed: ${error instanceof Error ? error.message : String(error)}` })
    }
  }

  // ---- Ad-hoc single-stage runs (DB-backed successor to legacy execute-step) ----

  if (method === 'POST' && /^\/api\/projects\/[^/]+\/execute-step$/.test(url.pathname)) {
    const [, , , slug] = url.pathname.split('/')
    const project = await import('./lib/project-registry').then((m) => m.getProjectBySlug(slug))
    if (!project) return sendJson(404, { error: 'Project not found.' })

    const body = await readJson<{
      step?: StageName
      role?: string
      force?: boolean
      feature?: string
      constitution?: string
      checklistDomain?: string
    }>(req)
    if (!body.step || !(body.step in STAGE_DEFINITIONS)) {
      return sendJson(400, { error: `Step is required and must be one of ${Object.keys(STAGE_DEFINITIONS).join(', ')}` })
    }

    // Validate stage-specific required inputs before we create a run/job.
    // Without this, the run gets created, the worker picks it up, the
    // PipelineEngine constructor throws, and the UI shows a confusing
    // "adhoc-specify errored" instead of "specify needs a feature".
    if (body.step === 'specify' && !body.feature?.trim()) {
      return sendJson(400, {
        error: 'The specify stage requires a feature description. Provide { "feature": "..." } in the request body.',
        field: 'feature',
      })
    }
    if (body.step === 'constitution' && !body.constitution?.trim()) {
      return sendJson(400, {
        error: 'The constitution stage requires a constitution statement. Provide { "constitution": "..." } in the request body.',
        field: 'constitution',
      })
    }
    if (body.step === 'checklist' && !body.checklistDomain?.trim()) {
      return sendJson(400, {
        error: 'The checklist stage requires a checklist domain. Provide { "checklistDomain": "..." } in the request body.',
        field: 'checklistDomain',
      })
    }

    const repos = await import('./lib/project-registry').then((m) => m.listRepos(project.projectId))
    const repo = pickRunnableRepo(repos)
    if (!repo?.localPath) return sendJson(400, { error: describeUnrunnableRepos(repos) })

    // Guard 1: don't accept a duplicate for a step whose artifact already exists,
    // unless caller explicitly passes force:true. Prevents accidental double-runs.
    if (!body.force) {
      const projectArtifacts = await collectProjectArtifacts(project.slug, resolveCwd(repo.localPath))
      const alreadyDone: Partial<Record<StageName, boolean>> = {
        init: projectArtifacts.initialized,
        specify: projectArtifacts.specified,
        plan: projectArtifacts.planned,
        tasks: projectArtifacts.tasked,
        verify: projectArtifacts.verifiedPass,
      }
      if (alreadyDone[body.step]) {
        return sendJson(409, {
          error: `${body.step} already produced its artifact for this project.`,
          hint: `Call again with {"force": true} to re-run anyway.`,
          currentState: alreadyDone,
        })
      }
    }

    // Guard 2: don't stack on top of an in-flight job for this project.
    const sql = getDb()
    const [inflight] = await sql<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n FROM project_jobs
       WHERE project_id = ${project.projectId} AND status IN ('queued','claimed','running')
    `
    if ((inflight?.n ?? 0) > 0 && !body.force) {
      return sendJson(409, {
        error: `Project already has ${inflight.n} job(s) queued or running.`,
        hint: 'Wait for the current job to finish, or pass {"force": true} to enqueue anyway.',
      })
    }

    const template: PipelineTemplate = {
      name: `adhoc-${body.step}`,
      version: 1,
      description: `Ad-hoc single-step run of ${body.step} triggered from project detail UI.`,
      steps: [{
        id: body.step,
        stage: body.step,
        review: true,
        humanGate: true,
        ...(body.role ? { role: body.role as never } : {}),
      }],
    }

    const cwd = resolveCwd(repo.localPath)
    const contextBundle = await buildContextBundle({ projectId: project.projectId, projectSlug: project.slug, projectPath: cwd })

    // Model resolution: prefer the model from the project's most recent run so
    // one-off Run <step> clicks don't fall back to whatever Pi's resolver picks
    // (which lately has been an OpenAI quota-exhausted default).
    const latest = await dbGetLatestRunForProject(project.slug)
    const inheritedModel = latest?.optionsJson?.model
    const model = inheritedModel && inheritedModel.trim() ? inheritedModel.trim() : 'anthropic/claude-sonnet-4-5'

    const row = await dbCreateRun({
      projectNamespace: project.slug,
      projectLabel: project.name,
      projectPath: cwd,
      pipelineName: template.name,
      options: {
        cwd,
        model,
        projectId: project.projectId,
        ...(repo.githubRepo ? { pullRequests: { githubRepo: repo.githubRepo } } : {}),
        projectMemory: contextBundle.project.memory,
        sharedContextPrompt: contextBundle.promptBundle,
        persistSession: true,
        nonInteractive: false,
        verbose: false,
        // Stage-specific inputs required by validateStageInputs. The endpoint
        // above rejects requests missing these when the step needs them.
        ...(body.feature ? { feature: body.feature } : {}),
        ...(body.constitution ? { constitution: body.constitution } : {}),
        ...(body.checklistDomain ? { checklistDomain: body.checklistDomain } : {}),
      },
      template,
      projectId: project.projectId,
      repoId: repo.repoId,
    })
    await enqueueJob({ projectId: project.projectId, kind: 'task_run', triggerSource: 'user', payload: { runId: row.runId }, runId: row.runId })
    return sendJson(200, { ok: true, message: `Queued ${body.step} with model ${model}.`, runId: row.runId })
  }

  // ---- Project memory (DB-backed, Phase 4A cleanup) ----

  if (method === 'GET' && /^\/api\/projects\/[^/]+\/memory$/.test(url.pathname)) {
    const [, , , slug] = url.pathname.split('/')
    const project = await import('./lib/project-registry').then((m) => m.getProjectBySlug(slug))
    if (!project) return sendJson(404, { error: 'Project not found.' })
    const memory = await import('./lib/context-builder').then((m) => m.getProjectMemory(project.projectId))
    return sendJson(200, { projectId: project.projectId, slug, ...memory })
  }

  if (method === 'POST' && /^\/api\/projects\/[^/]+\/memory$/.test(url.pathname)) {
    const [, , , slug] = url.pathname.split('/')
    const project = await import('./lib/project-registry').then((m) => m.getProjectBySlug(slug))
    if (!project) return sendJson(404, { error: 'Project not found.' })
    // The UI sends `text`; older callers sent `manualText`. Accept both — the
    // mismatch used to make "Save memory" write nothing.
    const body = await readJson<{ manualText?: string; text?: string }>(req)
    const manualText = body.manualText ?? body.text
    if (typeof manualText !== 'string') return sendJson(400, { error: 'text is required.' })
    const memory = await import('./lib/context-builder').then((m) => m.upsertProjectMemory(project.projectId, { manualText }))
    return sendJson(200, { projectId: project.projectId, slug, ...memory })
  }

  // Rebuild the auto-summary from the registered repositories: learn every
  // checkout that has no brief yet (or all, with force) and recompose memory.
  if (method === 'POST' && /^\/api\/projects\/[^/]+\/memory\/rebuild$/.test(url.pathname)) {
    const [, , , slug] = url.pathname.split('/')
    const project = await import('./lib/project-registry').then((m) => m.getProjectBySlug(slug))
    if (!project) return sendJson(404, { error: 'Project not found.' })
    const body = await readJson<{ force?: boolean }>(req).catch(() => ({ force: false }))
    const repos = (await import('./lib/project-registry').then((m) => m.listRepos(project.projectId))).filter((r) => Boolean(r.localPath))
    const sql = getDb()
    const learned = new Set((await sql<Array<{ entityId: string }>>`SELECT entity_id AS "entityId" FROM project_source_snapshots WHERE project_id = ${project.projectId} AND source = 'codebase'`).map((r) => r.entityId))
    const targets = repos.filter((r) => body.force || !learned.has(r.repoId))
    void (async () => {
      for (const repo of targets) await refreshRepositoryKnowledge(project.projectId, repo.repoId)
      if (targets.length === 0) {
        const { composeProjectMemory } = await import('./lib/project-onboarding')
        await composeProjectMemory(project.projectId)
      }
    })().catch((error) => serverLog.warn('memory rebuild failed', { slug, error: error instanceof Error ? error.message : String(error) }))
    return sendJson(202, { learning: targets.map((r) => r.label), repos: repos.length })
  }

  if (method === 'GET' && /^\/api\/projects\/[^/]+\/artifact$/.test(url.pathname)) {
    const [, , , projectNamespace] = url.pathname.split('/')
    const relativePath = url.searchParams.get('path')
    if (!relativePath) {
      return sendJson(400, { error: 'Artifact path is required.' })
    }

    const projectMeta = await readProjectMeta(projectNamespace)
    if (!projectMeta) {
      return sendJson(404, { error: 'Project namespace not found.' })
    }

    const filePath = resolveArtifactPath(projectMeta.path, relativePath)
    if (!filePath) {
      return sendJson(400, { error: 'Invalid artifact path.' })
    }

    try {
      if (extname(filePath) === '.md' && url.searchParams.get('raw') !== '1') {
        const markdown = await readFile(filePath, 'utf8')
        return sendHtml(200, renderMarkdownPreview({
          title: relativePath,
          markdown,
          rawHref: `${url.pathname}?path=${encodeURIComponent(relativePath)}&raw=1`,
        }))
      }

      const file = Bun.file(filePath)
      return new Response(file, {
        headers: { 'content-type': getContentType(filePath) },
      })
    } catch {
      return sendJson(404, { error: 'Artifact not found.' })
    }
  }

  if (method === 'GET' && url.pathname.startsWith('/api/runs/')) {
    const parts = url.pathname.split('/').filter(Boolean)
    const runId = parts[2]
    const action = parts[3]

    if (!runId) {
      return sendJson(404, { error: 'Run not found.' })
    }

    const row = await dbGetRun(runId)
    if (!row) {
      return sendJson(404, { error: 'Run not found.' })
    }

    if (action === 'events') {
      return attachDbEventStream(req, runId)
    }

    return sendJson(200, await snapshotFromRow(row))
  }

  if (method === 'POST' && url.pathname === '/api/runs') {
    const body = await readJson<CreateRunRequest>(req)

    if (!body.projectId) {
      return sendJson(400, { error: 'projectId is required.' })
    }
    const project = await projGet(body.projectId)
    if (!project) return sendJson(404, { error: 'Project not found.' })

    const repos = await import('./lib/project-registry').then((m) => m.listRepos(project.projectId))
    const repo = body.targetRepoId
      ? repos.find((r) => r.repoId === body.targetRepoId)
      : pickRunnableRepo(repos)
    if (!repo) return sendJson(400, { error: describeUnrunnableRepos(repos) })
    if (!repo.localPath) {
      return sendJson(400, { error: describeUnrunnableRepos([repo]) })
    }

    const projectId = project.projectId
    const repoId = repo.repoId
    const projectLabel = project.name
    const projectNamespace = project.slug
    const cwd = resolveCwd(repo.localPath)
    // Model resolution: prefer explicit body.model → inherit from latest run →
    // default to a known-good Anthropic model. Prevents Pi's global default from
    // routing us to a quota-exhausted OpenAI catalog when the caller didn't specify.
    const latest = await dbGetLatestRunForProject(project.slug)
    const inheritedModel = latest?.optionsJson?.model
    const resolvedModel = body.model?.trim() || (inheritedModel?.trim() ? inheritedModel.trim() : 'anthropic/claude-sonnet-4-5')
    const baseOptions = toFlowOptions(body)
    const options: FlowOptions = {
      ...baseOptions,
      cwd,
      model: resolvedModel,
      projectId: project.projectId,
      // GitHub-hosted repo → implement/orchestrate/verify publish the feature branch as a PR.
      ...(repo.githubRepo ? { pullRequests: { githubRepo: repo.githubRepo } } : {}),
    }
    const templateName = body.pipeline?.trim() || DEFAULT_PIPELINE_NAME
    const { template } = await getTemplate(templateName, projectNamespace)

    if (body.dryRun) {
      return sendJson(200, {
        status: 'dry-run',
        plan: PipelineEngine.describePlan(template),
      })
    }

    const contextBundle = await buildContextBundle({ projectId, projectSlug: projectNamespace, projectPath: cwd })
    const orchestrator = await getOrchestrator(projectId)
    const row = await dbCreateRun({
      projectNamespace,
      projectLabel,
      projectPath: cwd,
      pipelineName: template.name,
      feature: options.feature,
      options: {
        ...options,
        projectMemory: contextBundle.project.memory,
        sharedContextPrompt: contextBundle.promptBundle,
        autonomousMode: orchestrator.autonomousMode,
      },
      template,
      projectId,
      repoId,
    })
    await enqueueJob({ projectId, kind: 'pipeline_run', triggerSource: 'user', payload: { runId: row.runId }, runId: row.runId })

    return sendJson(202, await snapshotFromRow(row))
  }

  if (method === 'POST' && /^\/api\/runs\/[^/]+\/answer$/.test(url.pathname)) {
    const parts = url.pathname.split('/').filter(Boolean)
    const runId = parts[2]

    if (!runId) {
      return sendJson(404, { error: 'Run not found.' })
    }

    const row = await dbGetRun(runId)
    if (!row) {
      return sendJson(404, { error: 'Run not found.' })
    }

    if (row.status !== 'paused') {
      return sendJson(409, { error: 'Run is not waiting for input.' })
    }

    const body = await readJson<AnswerRunRequest>(req)
    const answer = body.answer?.trim()
    if (!answer) {
      return sendJson(400, { error: 'Answer is required.' })
    }

    const delivery = await sendAnswerToOwner(runId, answer)
    if (!delivery.delivered) {
      // The worker that paused this run is gone. Record the answer and restart the
      // paused stage (or the next one, for an approved review) on any worker.
      const stages = (row.templateJson?.steps ?? []).map((s) => s.stage as StageName)
      const currentIdx = row.currentStage ? stages.indexOf(row.currentStage) : -1
      const approved = row.pauseKind === 'review' && /^(approve|approved|lgtm|yes|ok|continue)\b/i.test(answer)
      const nextIdx = approved ? currentIdx + 1 : Math.max(0, currentIdx)
      const gate = await dbResolveOpenGate(runId, answer)
      await dbAppendEvent({ runId, kind: 'gate_resolved', payload: { gateId: gate?.gateId, kind: gate?.kind, response: answer, afterRestart: true } })
      if (approved && nextIdx >= stages.length) {
        await dbUpdateRunStatus(runId, { status: 'completed', currentStage: null, pauseKind: null, errorMessage: null })
        await dbAppendEvent({ runId, kind: 'run_completed', payload: { afterRestart: true } })
      } else {
        const fromStage = stages[nextIdx]
        const note = approved
          ? `Approved after a worker restart; continuing from stage ${fromStage}.`
          : `The worker that paused this run is gone; re-running stage ${fromStage} with your answer recorded in the timeline.`
        const requeued = await requeueRun(row, fromStage, note, 'user')
        if (!requeued.ok) return sendJson(409, { error: requeued.error })
      }
    }
    const refreshed = await dbGetRun(runId)
    return sendJson(202, await snapshotFromRow(refreshed ?? row))
  }

  // Rerun a failed, interrupted, or completed run — from the stage where it stopped
  // (default) or from an explicit stage. Reuses the same run row so the timeline
  // stays continuous; retry_count records the attempt.
  if (method === 'POST' && /^\/api\/runs\/[^/]+\/rerun$/.test(url.pathname)) {
    const runId = url.pathname.split('/')[3]!
    const row = await dbGetRun(runId)
    if (!row) return sendJson(404, { error: 'Run not found.' })
    if (row.status === 'running' || row.status === 'queued') {
      return sendJson(409, { error: 'Run is already in progress.' })
    }
    const body = await readJson<{
      fromStage?: StageName | 'start'
      feature?: string
      constitution?: string
      checklistDomain?: string
    }>(req)
    const stages = (row.templateJson?.steps ?? []).map((s) => s.stage as StageName)
    let fromStage: StageName | null
    if (body.fromStage === 'start') {
      fromStage = null
    } else if (body.fromStage) {
      if (!stages.includes(body.fromStage)) return sendJson(400, { error: `Stage "${body.fromStage}" is not part of this run (${stages.join(' → ')}).` })
      fromStage = body.fromStage
    } else {
      fromStage = row.currentStage && stages.includes(row.currentStage) ? row.currentStage : null
    }

    // Merge stage-input overrides from the request into the stored options.
    // The first attempt may have been missing a required input (e.g. specify
    // without --feature); this lets the client supply it on retry without
    // creating a brand-new run row.
    const mergedOptions = {
      ...row.optionsJson,
      ...(body.feature ? { feature: body.feature } : {}),
      ...(body.constitution ? { constitution: body.constitution } : {}),
      ...(body.checklistDomain ? { checklistDomain: body.checklistDomain } : {}),
    }

    // Validate stage-required inputs before we requeue. Returns a structured
    // 400 the client can react to (prompt for the missing field + retry).
    if (stages.includes('specify') && !mergedOptions.feature) {
      return sendJson(400, {
        error: 'This run includes the specify stage but no feature was provided. Rerun with { "feature": "..." } to supply one.',
        field: 'feature',
      })
    }
    if (stages.includes('constitution') && !mergedOptions.constitution) {
      return sendJson(400, {
        error: 'This run includes the constitution stage but no constitution was provided. Rerun with { "constitution": "..." }.',
        field: 'constitution',
      })
    }
    if (stages.includes('checklist') && !mergedOptions.checklistDomain) {
      return sendJson(400, {
        error: 'This run includes the checklist stage but no checklist domain was provided. Rerun with { "checklistDomain": "..." }.',
        field: 'checklistDomain',
      })
    }

    if (row.status === 'paused') {
      await dbResolveOpenGate(runId, 'rerun requested')
    }
    // If the caller supplied new stage inputs, persist them onto the run so
    // the worker sees them when it re-materializes the flow.
    if (body.feature || body.constitution || body.checklistDomain) {
      const sql = getDb()
      await sql`
        UPDATE pipeline_runs SET options_json = ${sql.json(mergedOptions as never)}
         WHERE run_id = ${runId}
      `
    }
    const note = `Rerun requested${fromStage ? ` from stage ${fromStage}` : ' from the start'} (attempt ${row.retryCount + 2}).`
    const requeued = await requeueRun({ ...row, optionsJson: mergedOptions }, fromStage ?? undefined, note, 'user')
    if (!requeued.ok) return sendJson(409, { error: requeued.error })
    const refreshed = await dbGetRun(runId)
    return sendJson(202, await snapshotFromRow(refreshed ?? row))
  }

  if (method === 'GET') {
    const served = await tryServeStaticAsset(url.pathname)
    if (served) {
      return served
    }
  }

  return sendJson(404, { error: 'Not found.' })
}

// ---------------------------------------------------------------------------
// Project assistant: conversation memory, live operations snapshot, action tools
// ---------------------------------------------------------------------------

/** Per-project chat memory (in-process; last 40 turns). */
const assistantHistory = new Map<string, AssistantChatTurn[]>()

function rememberAssistantTurn(projectNamespace: string, turn: AssistantChatTurn): void {
  const list = assistantHistory.get(projectNamespace) ?? []
  list.push(turn)
  assistantHistory.set(projectNamespace, list.slice(-40))
}

function shortId(id: string): string {
  return id.slice(0, 8)
}

/**
 * Everything the assistant should know about the project right now, as
 * Markdown: identity + repos + knowledge scope, onboarding, worker, recent runs
 * (with the in-flight/latest run's timeline, open question and log tail), the
 * job queue, sub-agent workstreams, task tracker, and artifacts on disk.
 */
async function buildAssistantOperationsContext(projectNamespace: string, projectPath: string): Promise<{ markdown: string; projectId?: string; latestRunId?: string }> {
  const registry = await import('./lib/project-registry')
  const project = await registry.getProjectBySlug(projectNamespace)
  const sections: string[] = []

  if (project) {
    const repos = await registry.listRepos(project.projectId)
    const onboarding = getOnboardingSnapshot(project.projectId)
    const { resolveKnowledgeScope } = await import('./lib/integration-sources')
    const scope = await resolveKnowledgeScope(project.projectId).catch(() => undefined)
    const workers = await listLiveWorkers().catch(() => [])
    const worker = workers.find((w) => w.projectId === project.projectId && w.state !== 'stale')
    sections.push([
      `### Project`,
      `- Name: ${project.name} (slug ${project.slug}, id ${project.projectId})`,
      project.description ? `- Description: ${project.description}` : '',
      `- Repositories:`,
      ...repos.map((r) => `  - ${r.label} — ${r.kind === 'github' ? `GitHub ${r.githubRepo} (clone: ${r.cloneStatus ?? 'n/a'}${r.cloneError ? `, error: ${r.cloneError}` : ''})` : 'local'} → ${r.localPath ?? '(no local path)'}${r.isPrimary ? ' [primary]' : ''} (repoId ${r.repoId})`),
      `- Knowledge sources in scope: ${scope?.sources.length ? scope.sources.join(', ') : 'none connected/selected'}`,
      `- Onboarding: ${onboarding.status}${onboarding.error ? ` — ${onboarding.error}` : ''}; steps: ${onboarding.steps.map((s) => `${s.id}=${s.status}`).join(', ')}`,
      `- Worker: ${worker ? `${worker.state} (${worker.workerId}, ${worker.activeJobs} active job(s))` : workers.some((w) => !w.projectId && w.state !== 'stale') ? 'shared worker online' : 'none online (a per-project worker spawns when work is queued)'}`,
    ].filter(Boolean).join('\n'))
  }

  const runs = await dbListRunsForProject(projectNamespace, 6).catch(() => [])
  const focus = runs.find((r) => r.status === 'running' || r.status === 'paused' || r.status === 'queued') ?? runs[0]
  if (runs.length) {
    sections.push([
      `### Recent runs (newest first)`,
      ...runs.map((r) => `- ${shortId(r.runId)} · ${r.pipelineName} · **${r.status}**${r.currentStage ? ` at ${r.currentStage}` : ''}${r.pauseKind ? ` (waiting for ${r.pauseKind})` : ''}${r.retryCount ? ` · attempt ${r.retryCount + 1}` : ''} · updated ${r.updatedAt}${r.errorMessage ? `\n  error: ${r.errorMessage.slice(0, 300)}` : ''}${r.feature ? `\n  feature: ${r.feature.slice(0, 160)}` : ''}`),
    ].join('\n'))
  } else {
    sections.push('### Recent runs\n- none yet')
  }

  if (focus) {
    const events = await dbListEvents(focus.runId).catch(() => [])
    const timeline = events
      .filter((e) => e.kind !== 'log')
      .slice(-14)
      .map((e) => {
        const payload = e.payload as Record<string, unknown> | null
        const detail = payload ? Object.entries(payload).filter(([k]) => !['tailBytes'].includes(k)).map(([k, v]) => `${k}=${typeof v === 'string' ? v.slice(0, 140) : JSON.stringify(v)}`).join(', ') : ''
        return `- ${e.createdAt} ${e.kind}${detail ? ` — ${detail}` : ''}`
      })
    const log = events.filter((e) => e.kind === 'log').map((e) => ((e.payload as { chunk?: string } | null)?.chunk ?? '')).join('')
    const tail = log.trim().slice(-6000)
    sections.push([
      `### Focus run ${shortId(focus.runId)} (${focus.status}${focus.currentStage ? ` at ${focus.currentStage}` : ''}) — full id ${focus.runId}`,
      `Stages: ${(focus.templateJson?.steps ?? []).map((s) => s.stage).join(' → ') || '(none)'}`,
      focus.status === 'paused' ? `This run is waiting for ${focus.pauseKind ?? 'input'}; the question/request is at the end of the log tail. The user can answer with the answer box, or you can use answer_run.` : '',
      `Timeline (last ${timeline.length} events):`,
      ...timeline,
      `Log tail (last ${tail.length} chars):`,
      '```',
      tail || '(no log yet)',
      '```',
    ].filter(Boolean).join('\n'))
  }

  if (project) {
    const jobs = await listJobsForProject(project.projectId, 8).catch(() => [])
    if (jobs.length) {
      sections.push([
        `### Job queue (newest first)`,
        ...jobs.map((j) => `- ${shortId(j.jobId)} · ${j.runPipeline ?? j.kind} · ${j.displayStatus}${j.runStage ? ` at ${j.runStage}` : ''} · queue state ${j.status} · by ${j.triggerSource}${j.claimedBy ? ` · worker ${j.claimedBy}` : ''}${j.runId ? ` · run ${shortId(j.runId)}` : ''}${j.errorMessage ? `\n  ${j.errorMessage.slice(0, 160)}` : ''}`),
      ].join('\n'))
    }
  }

  const subagents = subagentJobs.get(projectNamespace)?.snapshot
  if (subagents && subagents.status !== 'idle') {
    sections.push([
      `### Implementation sub-agents (${subagents.status}${subagents.error ? ` — ${subagents.error}` : ''})`,
      ...subagents.workstreams.map((w) => `- ${w.workstream}: ${w.status}${w.branch ? ` · branch ${w.branch}` : ''}${w.pullRequestUrl ? ` · PR ${w.pullRequestUrl}` : ''}${w.summary ? ` — ${w.summary.slice(0, 200)}` : ''}`),
    ].join('\n'))
  }

  try {
    const tracker = await buildTaskTrackerRead(projectPath)
    const items = tracker.items ?? []
    if (items.length) {
      const counts = items.reduce<Record<string, number>>((acc, item) => { acc[item.status] = (acc[item.status] ?? 0) + 1; return acc }, {})
      const blocked = items.filter((i) => i.status === 'blocked').slice(0, 5)
      sections.push([
        `### Task tracker (${tracker.featureDir ?? 'active feature'})`,
        `- ${items.length} tasks: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}`,
        ...blocked.map((b) => `- blocked: ${b.id} ${b.description.slice(0, 120)}${b.dependencies.length ? ` — depends on ${b.dependencies.join(', ')}` : ''}`),
      ].join('\n'))
    }
  } catch {
    // no tracker yet
  }

  try {
    const artifacts = await collectProjectArtifacts(projectNamespace, projectPath)
    if (artifacts.links.length) {
      sections.push(`### Artifacts on disk\n${artifacts.links.map((a) => `- ${a.stepLabel}: ${a.relativePath}`).join('\n')}\nVerification: ${artifacts.verificationStatus}; scope: ${artifacts.scope.requirements} requirements, ${artifacts.scope.tasks} tasks, ${artifacts.scope.workstreams} workstreams.`)
    }
  } catch {
    // ignore
  }

  sections.push([
    `### Things the user can do from the UI`,
    `- Paused run: "Approve and continue" / "Continue" / type an answer (or answer_run).`,
    `- Failed/interrupted run: "Rerun from <stage>" or "Rerun from start" (or rerun_run).`,
    `- Steps: Run specify/plan/tasks/testplan/parallelize/implement/orchestrate/verify buttons (or run_step). "Run implementation agents" starts parallel workstreams (or run_implementation_agents).`,
    `- Repos: Retry clone on the overview (or retry_clone); knowledge scope in the Context tab; integrations via the Integrations chip.`,
  ].join('\n'))

  return { markdown: sections.join('\n\n'), projectId: project?.projectId, latestRunId: focus?.runId }
}

/**
 * State-changing tools for the assistant. Each one calls this server's own
 * HTTP API so validation and side effects stay in one place.
 */
function buildAssistantActionTools(projectNamespace: string, projectId: string | undefined, onAction: (line: string) => void): ToolDefinition[] {
  const base = `http://127.0.0.1:${port}`
  const call = async (method: 'POST' | 'GET', path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: unknown }> => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
    let data: unknown = null
    try { data = await response.json() } catch { /* no body */ }
    return { ok: response.ok, status: response.status, data }
  }
  const result = (text: string, details: unknown = {}) => ({ content: [{ type: 'text' as const, text }], details })
  const describe = (r: { ok: boolean; status: number; data: unknown }) => {
    const d = r.data as { error?: string; status?: string; stage?: string; runId?: string } | null
    if (!r.ok) return `Failed (${r.status}): ${d?.error ?? JSON.stringify(r.data)}`
    return `OK${d?.runId ? ` — run ${shortId(d.runId)}` : ''}${d?.status ? ` is now ${d.status}` : ''}${d?.stage ? ` at ${d.stage}` : ''}.`
  }
  const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required } as unknown as ToolDefinition['parameters'])

  const tools: ToolDefinition[] = [
    {
      name: 'rerun_run',
      label: 'Rerun a run',
      description: 'Re-run a failed, interrupted or finished run from the stage it stopped at (default), from an explicit stage, or from the start. Use the full run id from the snapshot.',
      parameters: obj({ runId: { type: 'string' }, fromStage: { type: 'string', description: 'Stage name, or "start". Omit to resume from the stage the run stopped at.' } }, ['runId']),
      async execute(_id, params) {
        const p = params as { runId: string; fromStage?: string }
        onAction(`rerun_run ${shortId(p.runId)}${p.fromStage ? ` from ${p.fromStage}` : ''}`)
        return result(describe(await call('POST', `/api/runs/${encodeURIComponent(p.runId)}/rerun`, p.fromStage ? { fromStage: p.fromStage } : {})))
      },
    },
    {
      name: 'answer_run',
      label: 'Answer or approve a paused run',
      description: 'Send an answer to a run that is paused for clarification or review. Use "approve" to approve a review gate, "continue" to unblock a false-positive clarification, or the user\'s actual answer text.',
      parameters: obj({ runId: { type: 'string' }, answer: { type: 'string' } }, ['runId', 'answer']),
      async execute(_id, params) {
        const p = params as { runId: string; answer: string }
        onAction(`answer_run ${shortId(p.runId)}: ${p.answer.slice(0, 60)}`)
        return result(describe(await call('POST', `/api/runs/${encodeURIComponent(p.runId)}/answer`, { answer: p.answer })))
      },
    },
    {
      name: 'run_step',
      label: 'Run a pipeline step',
      description: 'Start a single stage for this project (init, specify, clarify, plan, tasks, testplan, parallelize, analyze, implement, orchestrate, verify). Fails if a run is already in flight or the stage\'s prerequisites are missing; set force=true to redo a stage whose artifact already exists.',
      parameters: obj({ step: { type: 'string' }, force: { type: 'boolean' }, feature: { type: 'string', description: 'Feature description; required for specify.' } }, ['step']),
      async execute(_id, params) {
        const p = params as { step: string; force?: boolean; feature?: string }
        onAction(`run_step ${p.step}`)
        return result(describe(await call('POST', `/api/projects/${projectNamespace}/execute-step`, { step: p.step, force: p.force, feature: p.feature })))
      },
    },
    {
      name: 'run_implementation_agents',
      label: 'Run parallel implementation sub-agents',
      description: 'Start the parallel workstream sub-agents (needs parallel-workstreams.md). Optional maxAgents (default 4).',
      parameters: obj({ maxAgents: { type: 'integer', minimum: 1, maximum: 8 } }, []),
      async execute(_id, params) {
        const p = params as { maxAgents?: number }
        onAction(`run_implementation_agents (${p.maxAgents ?? 4})`)
        return result(describe(await call('POST', `/api/projects/${projectNamespace}/subagents/run`, { maxAgents: p.maxAgents ?? 4 })))
      },
    },
  ]
  if (projectId) {
    tools.push(
      {
        name: 'open_pull_request',
        label: 'Commit, push and open a pull request',
        description: 'For a GitHub-hosted repo on this project: commit any uncommitted changes on the current branch of its checkout, push, and open (or update) the pull request against the default branch. repoId from the snapshot (defaults to the primary repo). Do this only when the user asked for a PR/MR.',
        parameters: obj({ repoId: { type: 'string' }, title: { type: 'string' }, summary: { type: 'string', description: 'What the change does; becomes the PR body.' } }, []),
        async execute(_id, params) {
          const p = params as { repoId?: string; title?: string; summary?: string }
          onAction(`open_pull_request ${p.repoId ? shortId(p.repoId) : 'primary'}`)
          try {
            const registry = await import('./lib/project-registry')
            const repos = await registry.listRepos(projectId)
            const repo = p.repoId ? repos.find((r) => r.repoId === p.repoId) : (repos.find((r) => r.isPrimary && r.githubRepo) ?? repos.find((r) => r.githubRepo))
            if (!repo?.githubRepo || !repo.localPath) return result('Failed: no GitHub-hosted repository with a local checkout on this project.', { error: true })
            const branch = await gitCurrentBranch(repo.localPath)
            const base = await gitDefaultBranch(repo.localPath, repo.githubRepo)
            if (branch === base) return result(`Failed: the checkout is on the default branch (${base}); create or check out a feature branch first.`, { error: true })
            const ref = await publishBranchAsPullRequest({
              cwd: repo.localPath,
              githubRepo: repo.githubRepo,
              branch,
              base,
              commitMessage: p.title ?? `Changes on ${branch}`,
              title: p.title ?? branch,
              body: pullRequestBody({ summary: p.summary ?? `Changes on \`${branch}\`, opened via the project assistant.` }),
            })
            return ref
              ? result(`${ref.created ? 'Opened' : 'Updated'} PR #${ref.number}: ${ref.url} (${branch} → ${base}).`, { url: ref.url })
              : result(`Nothing to publish: ${branch} has no commits ahead of ${base}.`, {})
          } catch (error) {
            return result(`Failed: ${error instanceof Error ? error.message : String(error)}`, { error: true })
          }
        },
      },
      {
        name: 'retry_clone',
        label: 'Retry cloning a GitHub repo',
        description: 'Re-run the clone of a GitHub-hosted repo registered on this project (repoId from the snapshot).',
        parameters: obj({ repoId: { type: 'string' } }, ['repoId']),
        async execute(_id, params) {
          const p = params as { repoId: string }
          onAction(`retry_clone ${shortId(p.repoId)}`)
          return result(describe(await call('POST', `/api/projects/${projectId}/repos/${encodeURIComponent(p.repoId)}/clone`, {})))
        },
      },
      {
        name: 'restart_onboarding',
        label: 'Restart project onboarding',
        description: 'Re-run onboarding: clone remote repos, initialize Spec Kit, inventory and learn the codebase, refresh project memory.',
        parameters: obj({}, []),
        async execute() {
          onAction('restart_onboarding')
          return result(describe(await call('POST', `/api/projects/${projectId}/onboarding`, {})))
        },
      },
    )
  }
  return tools
}

/** Worker restarts stamp this wording; the UI shows such runs as interrupted, not failed. */
function isInterruptedRun(row: Pick<RunRow, 'errorMessage'>): boolean {
  return /worker (shutting down|restarted)|interrupted by a worker restart|re-queued/i.test(row.errorMessage ?? '')
}

/**
 * Put a run back on the queue at `fromStage` (undefined → from the start) and
 * hand it to the dispatcher. Shared by the rerun route and the answer fallback.
 */
async function requeueRun(
  row: RunRow,
  fromStage: StageName | undefined,
  note: string,
  triggerSource: 'user' | 'api',
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!row.projectId) {
    return { ok: false, error: 'This run is not attached to a project, so it cannot be re-queued. Start a new run instead.' }
  }
  await dbRequeueRunFromStage(row.runId, fromStage ?? null, note)
  await dbAppendEvent({ runId: row.runId, kind: 'requeued', payload: { fromStage: fromStage ?? null, reason: note } })
  await enqueueJob({
    projectId: row.projectId,
    kind: 'pipeline_run',
    triggerSource,
    payload: { runId: row.runId, ...(fromStage ? { fromStage } : {}) },
    runId: row.runId,
  })
  return { ok: true }
}

async function snapshotFromRow(row: RunRow): Promise<RunSnapshot> {
  const events = await dbListEvents(row.runId)
  const log = events
    .filter((e) => e.kind === 'log')
    .map((e) => {
      const payload = e.payload as { chunk?: string } | null
      return payload?.chunk ?? ''
    })
    .join('')
  const stages = (row.templateJson?.steps ?? []).map((s) => s.stage as StageName)
  return {
    runId: row.runId,
    projectNamespace: row.projectNamespace,
    projectLabel: row.projectLabel,
    projectPath: row.projectPath,
    feature: row.feature,
    pipeline: row.pipelineName,
    stages,
    reviewHarness: (row.templateJson?.steps ?? []).some((s) => s.review),
    humanInLoop: (row.templateJson?.steps ?? []).some((s) => s.humanGate),
    status: row.status === 'queued' ? 'running' : row.status,
    stage: row.currentStage,
    pauseKind: row.pauseKind,
    log,
    executiveSummary: buildExecutiveSummary(row),
    timeline: buildTimelineFromEvents(events),
    sessionFile: row.sessionFile,
    error: row.errorMessage,
    interrupted: isInterruptedRun(row),
    queued: row.status === 'queued',
    rerunnable: row.status === 'error' || row.status === 'completed' || row.status === 'paused',
    retryCount: row.retryCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function buildExecutiveSummary(row: RunRow): string {
  switch (row.status) {
    case 'queued':    return row.errorMessage?.trim()
      ? `Queued: ${row.errorMessage.trim()}`
      : `Queued for pipeline ${row.pipelineName}.`
    case 'running':   return `Running ${row.pipelineName}${row.currentStage ? ` at stage ${row.currentStage}` : ''}.`
    case 'paused':    return row.errorMessage?.trim()
      ? `Paused for ${row.pauseKind ?? 'input'} at ${row.currentStage ?? 'current stage'}. ${row.errorMessage.trim()}`
      : `Paused for ${row.pauseKind ?? 'input'} at ${row.currentStage ?? 'current stage'}.`
    case 'completed': return `Completed ${row.pipelineName}.`
    case 'error':     return isInterruptedRun(row)
      ? `Interrupted${row.currentStage ? ` during stage ${row.currentStage}` : ''}: ${row.errorMessage}. Rerun to continue from that stage.`
      : `Failed${row.currentStage ? ` at stage ${row.currentStage}` : ''}: ${row.errorMessage ?? 'unknown error'}. Rerun to try again.`
    default:          return row.pipelineName
  }
}

function buildTimelineFromEvents(events: EventRow[]): TimelineEntry[] {
  return events
    .filter((e) => e.kind !== 'log')
    .map((e) => {
      const payload = (e.payload ?? {}) as Record<string, unknown>
      return {
        id: String(e.eventId),
        kind: eventKindToTimelineKind(e.kind),
        stage: (payload.stage as StageName | undefined) ?? undefined,
        title: eventKindToTitle(e.kind, payload),
        detail: typeof payload.message === 'string' ? payload.message : undefined,
        status: eventKindToStatus(e.kind),
        createdAt: e.createdAt,
      }
    })
}

function eventKindToTimelineKind(kind: string): TimelineEntry['kind'] {
  if (kind.startsWith('gate') || kind === 'paused') return 'review'
  if (kind === 'run_started' || kind === 'run_completed' || kind === 'error') return 'run'
  return 'stage'
}

function eventKindToTitle(kind: string, payload: Record<string, unknown>): string {
  switch (kind) {
    case 'run_started':   return 'Run started'
    case 'run_completed': return 'Run completed'
    case 'paused':        return `Paused for ${(payload.pauseKind as string) ?? 'input'}`
    case 'gate_resolved': return 'Human response applied'
    case 'error':         return typeof payload.message === 'string' ? `Error: ${payload.message}` : 'Error'
    default:              return kind
  }
}

function eventKindToStatus(kind: string): TimelineEntry['status'] {
  if (kind === 'error') return 'error'
  if (kind === 'paused') return 'paused'
  if (kind === 'run_completed') return 'completed'
  return 'running'
}

function attachDbEventStream(req: Request, runId: string): Response {
  const encoder = new TextEncoder()
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let closed = false
  let listenSql: ReturnType<typeof getDb> | undefined

  const stream = new ReadableStream({
    async start(controller) {
      const push = (chunk: string) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(chunk))
        } catch {
          cleanup()
        }
      }

      const emitSnapshot = async () => {
        const row = await dbGetRun(runId)
        if (!row) return
        const snapshot = await snapshotFromRow(row)
        push(`data: ${JSON.stringify(snapshot)}\n\n`)
      }

      await emitSnapshot()

      // Dedicated connection for LISTEN — postgres.js needs a reserved conn.
      listenSql = getDb()
      await listenSql.listen('pipeline_event', async (payload) => {
        if (payload === runId) {
          await emitSnapshot()
        }
      })

      heartbeat = setInterval(() => {
        push(': keep-alive\n\n')
      }, 15000)

      req.signal.addEventListener('abort', cleanup)
    },
    cancel: cleanup,
  })

  function cleanup(): void {
    closed = true
    if (heartbeat) {
      clearInterval(heartbeat)
      heartbeat = undefined
    }
    // postgres.js LISTEN handle isn't easily unlistened per-caller in this simple wrapper;
    // the shared connection stays subscribed and no-ops for other runIds. Acceptable
    // for Phase 2 MVP — Phase 3 will move to a per-stream connection pool.
  }

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  })
}

async function isRunResumable(runId: string): Promise<boolean> {
  const row = await dbGetRun(runId)
  return row?.status === 'paused'
}

async function tryServeStaticAsset(pathname: string): Promise<Response | null> {
  const relativePath = pathname.replace(/^\/+/, '')
  if (!relativePath) return null

  const normalizedPath = normalize(relativePath)
  if (!normalizedPath || normalizedPath.startsWith('..') || normalizedPath.includes('..')) return null

  const filePath = join(publicDir, normalizedPath)
  const file = Bun.file(filePath)
  if (!(await file.exists())) return null
  return new Response(file, { headers: { 'content-type': getContentType(filePath) } })
}

async function listHistory(): Promise<HistoryResponse> {
  const [dbProjects, dbRuns] = await Promise.all([
    import('./lib/project-registry').then((m) => m.listProjects()),
    dbListAllRuns(200),
  ])

  const primaryPaths = new Map<string, string>()
  await Promise.all(dbProjects.map(async (p) => {
    const repos = await import('./lib/project-registry').then((m) => m.listRepos(p.projectId))
    const primary = pickRunnableRepo(repos)
    if (primary?.localPath) primaryPaths.set(p.projectId, primary.localPath)
  }))

  const projects: HistoryProjectSummary[] = dbProjects.map((p) => ({
    namespace: p.slug,
    label: p.name,
    path: primaryPaths.get(p.projectId) ?? '',
    lastUpdated: p.updatedAt,
  }))

  const runs: HistoryRunSummary[] = dbRuns.map((row) => ({
    runId: row.runId,
    projectNamespace: row.projectNamespace,
    projectLabel: row.projectLabel,
    projectPath: row.projectPath,
    feature: row.feature,
    stages: (row.templateJson?.steps ?? []).map((s) => s.stage as StageName),
    status: row.status === 'queued' ? 'running' : row.status,
    stage: row.currentStage,
    pauseKind: row.pauseKind,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }))

  projects.sort((a, b) => b.lastUpdated.localeCompare(a.lastUpdated))
  runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

  return { projects, runs }
}

async function buildBoard(): Promise<BoardResponse> {
  const history = await listHistory()
  const cards: BoardCard[] = []

  for (const project of history.projects) {
    const latestRun = history.runs.find((run) => run.projectNamespace === project.namespace)
    const artifacts = await collectProjectArtifacts(project.namespace, project.path)

    // Board derivations that used to blend legacy filesystem state (kanban override,
    // automation status, agent-in-progress, per-project estimate cache) are simplified
    // to DB-only signals after the Phase 4A legacy cleanup.
    // Board lane = highest artifact milestone the project has reached, NOT the run
    // process status. A brand-new project with no artifacts stays at 'backlog' even
    // if a run errored or is queued. Progression: backlog → initialized → specified
    // → planned → tasked → implementing → done.
    let status: BoardStatus = 'backlog'
    if (artifacts.initialized) status = 'initialized'
    if (artifacts.specified) status = 'specified'
    if (artifacts.planned) status = 'planned'
    if (artifacts.tasked) status = 'tasked'
    // 'implementing' lane is reserved for actual implementation/QA activity —
    // the run is (or was) at implement, orchestrate, or verify. Merely having
    // tasks.md doesn't count; users see 'tasked' until code work begins.
    if (artifacts.tasked && latestRun && ['running', 'paused', 'completed'].includes(latestRun.status)
        && latestRun.stage && ['implement', 'orchestrate', 'verify'].includes(latestRun.stage)) {
      status = 'implementing'
    }
    if (artifacts.verifiedPass) status = 'done'

    cards.push({
      projectNamespace: project.namespace,
      projectLabel: project.label,
      projectPath: project.path,
      status,
      verificationStatus: artifacts.verifiedPass ? 'pass' : artifacts.verificationStatus,
      estimate: latestRun?.status === 'completed' ? 'complete' : 'in-progress',
      currentAgent: latestRun?.stage ?? (latestRun?.status === 'running' ? 'running' : ''),
      gateReadiness: [],
      automationState: {
        state: latestRun?.status === 'paused' ? 'needs_approval' : latestRun?.status === 'running' ? 'running' : 'idle',
        message: latestRun?.status ?? 'no runs yet',
        updatedAt: latestRun?.updatedAt ?? project.lastUpdated,
      },
      recommendedAction: {
        label: latestRun ? 'Open project' : 'Create first feature',
        tab: 'specs',
        step: (latestRun?.stage as StageName | undefined) ?? 'init',
        reason: latestRun?.status === 'paused' ? 'Awaiting human input' : latestRun ? 'Continue where the run left off' : 'No runs yet',
      },
      updatedAt: latestRun?.updatedAt ?? project.lastUpdated,
      feature: latestRun?.feature,
      latestRun,
      artifactLinks: artifacts.links,
      artifactDiffs: artifacts.diffs,
    })
  }

  cards.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

  return {
    columns: BOARD_COLUMNS.map((column) => ({
      id: column,
      title: BOARD_TITLES[column],
      cards: cards.filter((card) => card.status === column),
    })),
  }
}

async function collectProjectArtifacts(projectNamespace: string, projectRoot: string): Promise<ProjectArtifacts> {
  const links: BoardArtifactLink[] = []
  const flags = {
    initialized: false,
    specified: false,
    planned: false,
    tasked: false,
    verifiedPass: false,
    verificationStatus: 'missing' as 'pass' | 'partial' | 'fail' | 'missing',
    scope: {
      requirements: 0,
      tasks: 0,
      contracts: 0,
      workstreams: 0,
    },
  }

  if (await pathExists(join(projectRoot, '.specify'))) {
    flags.initialized = true
    await pushArtifactIfExists(links, projectNamespace, projectRoot, '.specify/memory/constitution.md', 'Initialized', 'Constitution')
    await pushArtifactIfExists(links, projectNamespace, projectRoot, '.specify/hooks.yml', 'Initialized', 'Hooks config')
    await pushArtifactIfExists(links, projectNamespace, projectRoot, 'AGENTS.md', 'Initialized', 'Agent context')
  }

  const latestFeature = await getLatestFeatureDir(projectRoot)
  if (!latestFeature) {
    const artifactState = { diffs: [] as ArtifactDiffEntry[] }
    return { ...flags, links, diffs: artifactState.diffs.slice(0, 8) }
  }

  const featurePrefix = `Feature ${latestFeature.featureId}`
  const specPath = join(projectRoot, `${latestFeature.relativePath}/spec.md`)
  const tasksPath = join(projectRoot, `${latestFeature.relativePath}/tasks.md`)
  const parallelPath = join(projectRoot, `${latestFeature.relativePath}/parallel-workstreams.md`)

  if (await pushArtifactIfExists(links, projectNamespace, projectRoot, `${latestFeature.relativePath}/spec.md`, 'Specified', `${featurePrefix} spec`)) {
    flags.specified = true
  }
  if (await pushArtifactIfExists(links, projectNamespace, projectRoot, `${latestFeature.relativePath}/plan.md`, 'Planned', `${featurePrefix} plan`)) {
    flags.planned = true
  }
  if (await pushArtifactIfExists(links, projectNamespace, projectRoot, `${latestFeature.relativePath}/tasks.md`, 'Tasked', `${featurePrefix} tasks`)) {
    flags.tasked = true
  }

  await pushArtifactIfExists(links, projectNamespace, projectRoot, `${latestFeature.relativePath}/test-plan.md`, 'Test Plan', `${featurePrefix} test plan`)
  await pushArtifactIfExists(links, projectNamespace, projectRoot, `${latestFeature.relativePath}/parallel-workstreams.md`, 'Parallelize', `${featurePrefix} parallel workstreams`)
  await pushArtifactIfExists(links, projectNamespace, projectRoot, `${latestFeature.relativePath}/merge-orchestrator.md`, 'Orchestrate', `${featurePrefix} merge orchestrator`)
  if (await pushArtifactIfExists(links, projectNamespace, projectRoot, `${latestFeature.relativePath}/verification-report.md`, 'Verify', `${featurePrefix} verification report`)) {
    flags.verificationStatus = await getVerificationStatus(join(projectRoot, `${latestFeature.relativePath}/verification-report.md`))
    flags.verifiedPass = flags.verificationStatus === 'pass'
  }
  await pushArtifactIfExists(links, projectNamespace, projectRoot, `${latestFeature.relativePath}/research.md`, 'Planned', `${featurePrefix} research`)
  await pushArtifactIfExists(links, projectNamespace, projectRoot, `${latestFeature.relativePath}/data-model.md`, 'Planned', `${featurePrefix} data model`)
  await pushArtifactIfExists(links, projectNamespace, projectRoot, `${latestFeature.relativePath}/quickstart.md`, 'Planned', `${featurePrefix} quickstart`)

  const contractDir = join(projectRoot, latestFeature.relativePath, 'contracts')
  for (const file of await safeReadDir(contractDir)) {
    if (file.startsWith('.')) {
      continue
    }

    const relativePath = `${latestFeature.relativePath}/contracts/${file}`
    if (await pushArtifactIfExists(links, projectNamespace, projectRoot, relativePath, 'Planned', `${featurePrefix} contract: ${file}`)) {
      flags.scope.contracts += 1
    }
  }

  const artifactState = { diffs: [] as ArtifactDiffEntry[] }
  return { ...flags, links, diffs: artifactState.diffs.slice(0, 8) }
}

async function getLatestFeatureDir(projectRoot: string): Promise<{ featureId: string; relativePath: string } | null> {
  const specsDir = join(projectRoot, 'specs')
  const entries = await safeReadDir(specsDir)
  const dirs: string[] = []

  for (const entry of entries) {
    if (await pathExists(join(specsDir, entry, 'spec.md')) || await pathExists(join(specsDir, entry))) {
      dirs.push(entry)
    }
  }

  dirs.sort((a, b) => b.localeCompare(a))
  if (dirs.length === 0) {
    return null
  }

  return {
    featureId: dirs[0],
    relativePath: `specs/${dirs[0]}`,
  }
}

async function pushArtifactIfExists(
  links: BoardArtifactLink[],
  projectNamespace: string,
  projectRoot: string,
  relativePath: string,
  stepLabel: string,
  label: string,
): Promise<boolean> {
  const filePath = join(projectRoot, relativePath)
  if (!(await pathExists(filePath))) {
    return false
  }

  links.push({
    label,
    stepLabel,
    href: `/api/projects/${projectNamespace}/artifact?path=${encodeURIComponent(relativePath)}`,
    relativePath,
    contentHash: await hashFile(filePath),
  })
  return true
}






























async function buildQAOverview(projectNamespace: string, projectRoot: string): Promise<QAOverview> {
  const latestFeature = await getLatestFeatureDir(projectRoot)
  if (!latestFeature) {
    return {
      verificationPassed: false,
      verificationStatus: 'missing',
      artifacts: [],
      subagents: [],
      currentJob: subagentJobs.get(projectNamespace)?.snapshot ?? createIdleSubagentSnapshot(projectNamespace),
      jobHistory: [],
    }
  }

  const featureDir = latestFeature.relativePath
  const artifactPaths = [
    { label: 'Test plan', path: `${featureDir}/test-plan.md` },
    { label: 'Parallel workstreams', path: `${featureDir}/parallel-workstreams.md` },
    { label: 'Verification report', path: `${featureDir}/verification-report.md` },
  ]

  const artifacts = await Promise.all(artifactPaths.map(async (artifact) => ({
    label: artifact.label,
    path: artifact.path,
    exists: await pathExists(join(projectRoot, artifact.path)),
    content: await readTextPreview(join(projectRoot, artifact.path)),
  })))

  const verificationStatus = await getVerificationStatus(join(projectRoot, `${featureDir}/verification-report.md`))

  return {
    featureDir,
    verificationPassed: verificationStatus === 'pass',
    verificationStatus,
    artifacts,
    subagents: await readSubagentReports(projectRoot, featureDir),
    currentJob: subagentJobs.get(projectNamespace)?.snapshot ?? createIdleSubagentSnapshot(projectNamespace),
    jobHistory: await readSubagentJobHistory(projectRoot, featureDir),
  }
}


async function readLatestRunSnapshot(projectNamespace: string): Promise<RunSnapshot | null> {
  const dbRow = await dbGetLatestRunForProject(projectNamespace)
  return dbRow ? await snapshotFromRow(dbRow) : null
}













async function readProjectMeta(namespace: string): Promise<HistoryProjectSummary | null> {
  const dbProject = await import('./lib/project-registry').then((m) => m.getProjectBySlug(namespace))
  if (!dbProject) return null

  const repos = await import('./lib/project-registry').then((m) => m.listRepos(dbProject.projectId))
  const primary = pickRunnableRepo(repos)
  if (!primary?.localPath) return null

  return {
    namespace,
    label: dbProject.name,
    path: primary.localPath,
    lastUpdated: dbProject.updatedAt,
  }
}

function resolveArtifactPath(projectRoot: string, relativePath: string): string | null {
  const normalizedRelative = normalize(relativePath)
  if (!normalizedRelative || normalizedRelative.startsWith('..') || normalizedRelative.includes(`..${sep}`)) {
    return null
  }

  const resolved = resolvePath(projectRoot, normalizedRelative)
  const resolvedRoot = resolvePath(projectRoot)
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${sep}`)) {
    return null
  }

  return resolved
}

function createIdleSubagentSnapshot(projectNamespace: string): SubagentJobSnapshot {
  const now = new Date().toISOString()
  return {
    projectNamespace,
    status: 'idle',
    workstreams: [],
    updatedAt: now,
  }
}

function ensureSubagentJob(projectNamespace: string): SubAgentJobRecord {
  let job = subagentJobs.get(projectNamespace)
  if (!job) {
    job = {
      snapshot: createIdleSubagentSnapshot(projectNamespace),
      listeners: new Set(),
      activeSessions: new Map(),
    }
    subagentJobs.set(projectNamespace, job)
  }
  return job
}

function updateSubagentJob(job: SubAgentJobRecord, event: import('./lib/aidlc').ParallelSubAgentProgressEvent): void {
  job.snapshot.updatedAt = new Date().toISOString()
  if (event.featureDir) {
    job.snapshot.featureDir = event.featureDir
  }

  if (event.type === 'job_start') {
    job.snapshot.status = 'running'
  } else if (event.type === 'job_complete') {
    job.snapshot.status = 'completed'
    job.snapshot.completedAt = new Date().toISOString()
  } else if (event.type === 'job_error') {
    job.snapshot.status = 'error'
    job.snapshot.error = event.error
  }

  if (event.workstream) {
    const existing = job.snapshot.workstreams.find((item) => item.workstream === event.workstream)
    const nextStatus = event.type === 'workstream_complete'
      ? 'completed'
      : event.type === 'job_error' || event.type === 'workstream_error'
        ? 'error'
        : 'running'

    if (existing) {
      existing.status = nextStatus
      existing.summary = event.summary ?? existing.summary
      existing.log = event.log ?? existing.log
      existing.outputFile = event.outputFile ?? existing.outputFile
      existing.runtimeMs = event.runtimeMs ?? existing.runtimeMs
      existing.estimatedTokens = event.estimatedTokens ?? existing.estimatedTokens
      existing.branch = event.branch ?? existing.branch
      existing.baseBranch = event.baseBranch ?? existing.baseBranch
      existing.pullRequestUrl = event.pullRequestUrl ?? existing.pullRequestUrl
    } else {
      job.snapshot.workstreams.push({
        workstream: event.workstream,
        status: nextStatus,
        summary: event.summary,
        log: event.log,
        outputFile: event.outputFile,
        runtimeMs: event.runtimeMs,
        estimatedTokens: event.estimatedTokens,
        branch: event.branch,
        baseBranch: event.baseBranch,
        pullRequestUrl: event.pullRequestUrl,
      })
    }
  }

  emitSubagentJob(job)
}

function emitSubagentJob(job: SubAgentJobRecord): void {
  const snapshot = structuredClone(job.snapshot)
  for (const listener of job.listeners) {
    listener(snapshot)
  }
}

function attachSubagentEventStream(req: Request, job: SubAgentJobRecord): Response {
  const encoder = new TextEncoder()
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let send: ((snapshot: SubagentJobSnapshot) => void) | undefined

  const stream = new ReadableStream({
    start(controller) {
      const push = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk))
        } catch {
          cleanup()
        }
      }

      send = (snapshot: SubagentJobSnapshot) => {
        push(`data: ${JSON.stringify(snapshot)}\n\n`)
      }

      job.listeners.add(send)
      send(structuredClone(job.snapshot))

      heartbeat = setInterval(() => {
        push(': keep-alive\n\n')
      }, 15000)

      req.signal.addEventListener('abort', cleanup)
    },
    cancel: cleanup,
  })

  function cleanup(): void {
    if (heartbeat) {
      clearInterval(heartbeat)
      heartbeat = undefined
    }
    if (send) {
      job.listeners.delete(send)
      send = undefined
    }
  }

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  })
}

/**
 * Model for sub-agent jobs: explicit request → model of the project's latest
 * run → known-good Anthropic default. Same rule as run creation, so sub-agents
 * never fall through to Pi's global default provider.
 */
async function resolveSubagentModel(projectNamespace: string, requested?: string): Promise<string> {
  if (requested?.trim()) return requested.trim()
  const latest = await dbGetLatestRunForProject(projectNamespace)
  const inherited = latest?.optionsJson?.model
  return inherited?.trim() ? inherited.trim() : 'anthropic/claude-sonnet-4-5'
}

/** Repositories with local checkouts, so multi-repo workstreams can run in the right one. */
async function subagentRepoTargets(projectNamespace: string): Promise<{ projectId?: string; targets: import('./lib/aidlc').WorkstreamRepoTarget[] }> {
  const project = await import('./lib/project-registry').then((m) => m.getProjectBySlug(projectNamespace))
  if (!project) return { targets: [] }
  const repos = await import('./lib/project-registry').then((m) => m.listRepos(project.projectId))
  return {
    projectId: project.projectId,
    targets: repos
      .filter((r) => Boolean(r.localPath))
      .map((r) => ({ label: r.label, githubRepo: r.githubRepo, localPath: r.localPath!, isPrimary: r.isPrimary })),
  }
}

async function startSubagentJob(
  job: SubAgentJobRecord,
  projectPath: string,
  sharedContextPrompt: string,
  maxAgents?: number,
  model?: string,
  repoTargets?: import('./lib/aidlc').WorkstreamRepoTarget[],
  projectId?: string,
): Promise<void> {
  job.snapshot = {
    projectNamespace: job.snapshot.projectNamespace,
    status: 'running',
    workstreams: [],
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  job.activeSessions.clear()
  emitSubagentJob(job)

  try {
    const result = await runAIDLCParallelSubAgents({
      cwd: projectPath,
      sharedContextPrompt,
      maxAgents,
      model,
      repoTargets,
      projectId,
      // GitHub-hosted workstream repos get a branch + PR each (stacked when dependent).
      pullRequests: { enabled: true },
      registerSession: (workstream, session) => {
        job.activeSessions.set(workstream, session)
      },
      unregisterSession: (workstream) => {
        job.activeSessions.delete(workstream)
      },
      onProgress: (event) => updateSubagentJob(job, event),
    })
    // Subagent job history persistence retired in the legacy cleanup; live status is in memory + pipeline_events.
    void result
  } catch (error) {
    job.snapshot.status = 'error'
    job.snapshot.error = error instanceof Error ? error.message : String(error)
    job.snapshot.updatedAt = new Date().toISOString()
    emitSubagentJob(job)
  }
}


interface TrackerItem {
  id: string
  parallel: boolean
  story?: string
  description: string
  raw: string
  group: string
  checked: boolean
  status: string
  updatedAt: string
  dependencies: string[]
}

async function buildTaskTrackerRead(projectRoot: string): Promise<{ featureDir?: string; items: TrackerItem[]; graph: { nodes: Array<{ id: string; label: string; phase: string; story?: string; parallel: boolean; status: string }>; edges: Array<{ from: string; to: string }> } }> {
  const empty = { items: [], graph: { nodes: [], edges: [] } }
  const latest = await getLatestFeatureDir(projectRoot)
  if (!latest) return empty
  const tasksMd = await readTextIfExists(join(projectRoot, latest.relativePath, 'tasks.md'))
  if (!tasksMd) return { featureDir: latest.relativePath, ...empty }

  const items: TrackerItem[] = []
  let group = 'General'
  const now = new Date().toISOString()

  for (const rawLine of tasksMd.split('\n')) {
    const line = rawLine.trimEnd()
    const groupMatch = line.match(/^##\s+(.*)$/)
    if (groupMatch) { group = groupMatch[1]!.trim(); continue }
    const taskMatch = line.match(/^\s*-\s+\[([ xX])\]\s+([A-Z]+\d+)\s+(.*)$/)
    if (!taskMatch) continue
    const [, checkChar, id, rest] = taskMatch
    const parallel = /\[P\]/.test(rest!)
    const storyMatch = rest!.match(/\[(US\d+|Story\s*\d+)\]/)
    const story = storyMatch?.[1]
    const description = rest!.replace(/\[P\]/g, '').replace(/\[(US\d+|Story\s*\d+)\]/g, '').trim()
    const checked = checkChar!.toLowerCase() === 'x'
    items.push({
      id: id!,
      parallel,
      story,
      description,
      raw: line.trim(),
      group,
      checked,
      status: checked ? 'done' : 'todo',
      updatedAt: now,
      dependencies: [],
    })
  }

  // Derive dependencies:
  // 1. Within a phase, sequential (non-[P]) tasks depend on the previous task in that phase.
  // 2. [P] tasks in a phase depend on the last sequential-anchor before them (i.e. share a parent).
  // 3. The first task of phase N depends on the LAST task of phase N-1 (bridges phases).
  const phases: Array<{ name: string; items: TrackerItem[] }> = []
  for (const it of items) {
    const last = phases[phases.length - 1]
    if (!last || last.name !== it.group) phases.push({ name: it.group, items: [it] })
    else last.items.push(it)
  }

  let previousPhaseLast: string | undefined
  for (const phase of phases) {
    let anchor: string | undefined = previousPhaseLast
    for (const item of phase.items) {
      if (anchor) item.dependencies.push(anchor)
      if (!item.parallel) anchor = item.id // sequential tasks become the new anchor for anything after
    }
    // Bridge to next phase from the LAST item in this phase (anchor if last was parallel-run set)
    previousPhaseLast = phase.items[phase.items.length - 1]?.id
  }

  const graph = {
    nodes: items.map((it) => ({ id: it.id, label: it.id, phase: it.group, story: it.story, parallel: it.parallel, status: it.status })),
    edges: items.flatMap((it) => it.dependencies.map((from) => ({ from, to: it.id }))),
  }

  return { featureDir: latest.relativePath, items, graph }
}

async function readTextIfExists(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8')
  } catch {
    return ''
  }
}

async function readSubagentJobHistory(projectRoot: string, featureDir: string): Promise<SubagentJobSnapshot[]> {
  const dir = join(projectRoot, featureDir, 'subagents', 'jobs')
  const files = await safeReadDir(dir)
  const jobs: SubagentJobSnapshot[] = []

  for (const file of files.filter((entry) => entry.endsWith('.json')).sort().reverse()) {
    try {
      const raw = await readFile(join(dir, file), 'utf8')
      jobs.push(JSON.parse(raw) as SubagentJobSnapshot)
    } catch {
      continue
    }
  }

  return jobs.slice(0, 10)
}

async function readSubagentReports(projectRoot: string, featureDir: string): Promise<ParallelSubAgentResult[]> {
  const dir = join(projectRoot, featureDir, 'subagents')
  const files = await safeReadDir(dir)
  const results: ParallelSubAgentResult[] = []

  for (const file of files.filter((entry) => entry.endsWith('.md')).sort()) {
    const fullPath = join(dir, file)
    const content = await readTextIfExists(fullPath)
    results.push({
      workstream: file.replace(/\.md$/, ''),
      outputFile: `${featureDir}/subagents/${file}`,
      summary: content.split('\n').find((line) => line.trim()) ?? 'Sub-agent report',
      log: content,
      runtimeMs: 0,
      estimatedTokens: Math.max(1, Math.ceil(content.length / 4)),
    })
  }

  return results
}

async function getVerificationStatus(filePath: string): Promise<'pass' | 'partial' | 'fail' | 'missing'> {
  const content = await readTextIfExists(filePath)
  if (!content.trim()) {
    return 'missing'
  }
  if (/^Verification Status:\s*PASS/im.test(content)) {
    return 'pass'
  }
  if (/^Verification Status:\s*PARTIAL/im.test(content)) {
    return 'partial'
  }
  if (/^Verification Status:\s*FAIL/im.test(content)) {
    return 'fail'
  }
  return 'partial'
}

async function verificationReportPasses(filePath: string): Promise<boolean> {
  return (await getVerificationStatus(filePath)) === 'pass'
}

async function readTextPreview(filePath: string): Promise<string | undefined> {
  const content = await readTextIfExists(filePath)
  return content ? content.slice(0, 6000) : undefined
}

async function safeReadDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

const DEFAULT_PIPELINE_NAME = 'aidlc-classic'

function toFlowOptions(body: CreateRunRequest): FlowOptions {
  return {
    cwd: '', // resolved from project.repo below
    feature: body.feature?.trim(),
    constitution: body.constitution?.trim(),
    planContext: body.planContext?.trim(),
    checklistDomain: body.checklistDomain?.trim(),
    model: body.model?.trim(),
    thinking: normalizeThinkingLevel(body.thinking),
    persistSession: body.persistSession === true,
    nonInteractive: false,
    verbose: body.verbose === true,
  }
}

function composeProjectMemory(manualText: string, autoSummary: string): string {
  const parts = []
  if (manualText.trim()) {
    parts.push(manualText.trim())
  }
  if (autoSummary.trim()) {
    parts.push(`## Auto summary\n${autoSummary.trim()}`)
  }
  return parts.join('\n\n').trim()
}

function summarizeRunSnapshot(snapshot: RunSnapshot, log: string): string {
  const lines = log
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  const lastMeaningful = lines.slice(-6)
  const highlights = lastMeaningful
    .filter((line) => !line.startsWith('[tool:'))
    .slice(-3)
    .join(' | ')

  const statusLead = snapshot.status === 'error'
    ? `Run failed${snapshot.stage ? ` at ${snapshot.stage}` : ''}.`
    : snapshot.status === 'paused'
      ? `Run is waiting for ${snapshot.pauseKind === 'review' ? 'review' : 'clarification'}${snapshot.stage ? ` at ${snapshot.stage}` : ''}.`
      : snapshot.status === 'completed'
        ? `Run completed${snapshot.stage ? ` through ${snapshot.stage}` : ''}.`
        : `Run is active${snapshot.stage ? ` at ${snapshot.stage}` : ''}.`

  return [statusLead, highlights || snapshot.error || 'No additional details yet.'].join(' ')
}

function extractRelatedContext(text: string, contextBundle: Awaited<ReturnType<typeof buildContextBundle>>) {
  const haystack = text.toLowerCase()
  const relatedStages = (Object.keys(STAGE_DEFINITIONS) as StageName[]).filter((stage) => haystack.includes(stage.toLowerCase()))
  const relatedArtifacts = contextBundle.featureArtifacts
    .filter((artifact) => haystack.includes(artifact.label.toLowerCase()) || haystack.includes(artifact.path.toLowerCase()))
    .slice(0, 6)
    .map((artifact) => ({
      label: artifact.label,
      path: artifact.path,
      excerpt: buildArtifactExcerpt(artifact.content),
    }))

  return {
    relatedStages,
    relatedArtifacts,
  }
}

function buildArtifactExcerpt(content: string): string {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(' ')
    .slice(0, 240)
}




async function hashFile(filePath: string): Promise<string> {
  const content = await readFile(filePath)
  return createHash('sha256').update(content).digest('hex').slice(0, 12)
}

function cloneSnapshot(snapshot: RunSnapshot): RunSnapshot {
  return {
    ...snapshot,
    timeline: snapshot.timeline.map((entry) => ({ ...entry })),
  }
}

async function readJson<T>(req: Request): Promise<T> {
  const raw = (await req.text()).trim()
  return raw ? (JSON.parse(raw) as T) : ({} as T)
}

function sendJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function sendHtml(status: number, html: string): Response {
  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}

function getContentType(filePath: string): string {
  switch (extname(filePath)) {
    case '.js':
      return 'text/javascript; charset=utf-8'
    case '.css':
      return 'text/css; charset=utf-8'
    case '.html':
      return 'text/html; charset=utf-8'
    case '.json':
      return 'application/json; charset=utf-8'
    case '.md':
    case '.txt':
    case '.log':
    case '.yml':
    case '.yaml':
      return 'text/plain; charset=utf-8'
    default:
      return 'application/octet-stream'
  }
}

function renderMarkdownPreview(options: { title: string; markdown: string; rawHref: string }): string {
  const title = escapeHtml(options.title)
  const content = marked.parse(options.markdown) as string

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <style>
      :root { color-scheme: dark; }
      body {
        margin: 0;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif;
        background: #0a1120;
        color: #e6edff;
      }
      .shell {
        max-width: 980px;
        margin: 0 auto;
        padding: 32px 20px 56px;
      }
      .topbar {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        align-items: center;
        margin-bottom: 24px;
        padding: 16px 18px;
        border-radius: 18px;
        background: rgba(17, 27, 50, 0.88);
        border: 1px solid rgba(120, 146, 255, 0.16);
      }
      .topbar a {
        color: #8fdcff;
        text-decoration: none;
        font-weight: 700;
      }
      .doc {
        padding: 28px;
        border-radius: 20px;
        background: rgba(12, 19, 36, 0.92);
        border: 1px solid rgba(120, 146, 255, 0.14);
        box-shadow: 0 20px 60px rgba(0,0,0,.28);
      }
      .doc h1, .doc h2, .doc h3 { color: #f3f7ff; }
      .doc p, .doc li { line-height: 1.7; }
      .doc code {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        background: rgba(34, 47, 84, 0.72);
        padding: .15rem .35rem;
        border-radius: 6px;
      }
      .doc pre {
        overflow: auto;
        padding: 16px;
        border-radius: 14px;
        background: #050b16;
        border: 1px solid rgba(120, 146, 255, 0.12);
      }
      .doc pre code { background: transparent; padding: 0; }
      .doc blockquote {
        margin: 0;
        padding: 12px 16px;
        border-left: 4px solid #7ea2ff;
        background: rgba(25, 36, 68, 0.5);
        border-radius: 0 12px 12px 0;
      }
      .doc table {
        width: 100%;
        border-collapse: collapse;
        margin: 16px 0;
      }
      .doc th, .doc td {
        border: 1px solid rgba(120, 146, 255, 0.16);
        padding: 10px 12px;
        text-align: left;
      }
      .doc a { color: #8fdcff; }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="topbar">
        <strong>${title}</strong>
        <a href="${options.rawHref}">View raw markdown</a>
      </div>
      <article class="doc markdown-body">${content}</article>
    </div>
  </body>
</html>`
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

const BOARD_COLUMNS = ['backlog', 'initialized', 'specified', 'planned', 'tasked', 'implementing', 'done'] as const
const BOARD_TITLES: Record<BoardStatus, string> = {
  backlog: 'Backlog',
  initialized: 'Initialized',
  specified: 'Specified',
  planned: 'Planned',
  tasked: 'Tasked',
  implementing: 'Implementing',
  done: 'Done',
}

type BoardStatus = (typeof BOARD_COLUMNS)[number]

interface AssistantHistoryEntry {
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  kind: 'chat' | 'input' | 'review' | 'agent'
  runId?: string
  sessionFile?: string
  relatedStages?: StageName[]
  relatedArtifacts?: Array<{ label: string; path: string; excerpt?: string }>
}

interface TimelineEntry {
  id: string
  kind: 'run' | 'stage' | 'review' | 'input'
  stage?: StageName
  title: string
  detail?: string
  status: 'running' | 'paused' | 'completed' | 'error'
  createdAt: string
}

interface TimelineDraft {
  kind: TimelineEntry['kind']
  stage?: StageName
  title: string
  detail?: string
  status: TimelineEntry['status']
  createdAt?: string
}

interface RunSnapshot {
  runId: string
  projectNamespace: string
  projectLabel: string
  projectPath: string
  feature?: string
  pipeline?: string
  stages: StageName[]
  reviewHarness: boolean
  humanInLoop: boolean
  status: 'running' | 'paused' | 'completed' | 'error'
  stage?: StageName
  pauseKind?: PauseKind
  log: string
  executiveSummary?: string
  timeline: TimelineEntry[]
  sessionFile?: string
  error?: string
  /** True when the error/pause came from a worker restart rather than the pipeline itself. */
  interrupted?: boolean
  /** True while the run waits for a worker slot (status is reported as 'running' for compatibility). */
  queued?: boolean
  /** True when POST /api/runs/:id/rerun is allowed for this run. */
  rerunnable?: boolean
  retryCount?: number
  createdAt: string
  updatedAt: string
}

interface HistoryProjectSummary {
  namespace: string
  label: string
  path: string
  lastUpdated: string
}

interface HistoryRunSummary {
  runId: string
  projectNamespace: string
  projectLabel: string
  projectPath: string
  feature?: string
  stages: StageName[]
  status: RunSnapshot['status']
  stage?: StageName
  pauseKind?: PauseKind
  createdAt: string
  updatedAt: string
}

interface HistoryResponse {
  projects: HistoryProjectSummary[]
  runs: HistoryRunSummary[]
}

interface BoardArtifactLink {
  label: string
  stepLabel: string
  href: string
  relativePath: string
  contentHash?: string
}

interface ArtifactSnapshotEntry {
  relativePath: string
  label: string
  stepLabel: string
  contentHash: string
}

interface ArtifactDiffEntry {
  id: string
  relativePath: string
  label: string
  stepLabel: string
  change: 'added' | 'updated' | 'removed'
  previousHash?: string
  currentHash?: string
  createdAt: string
}

interface PersistedArtifactState {
  files: Record<string, ArtifactSnapshotEntry>
  diffs: ArtifactDiffEntry[]
  updatedAt: string
}

interface ProjectArtifacts {
  initialized: boolean
  specified: boolean
  planned: boolean
  tasked: boolean
  verifiedPass: boolean
  verificationStatus: 'pass' | 'partial' | 'fail' | 'missing'
  scope: {
    requirements: number
    tasks: number
    contracts: number
    workstreams: number
  }
  links: BoardArtifactLink[]
  diffs: ArtifactDiffEntry[]
}

interface GateReadinessRecord {
  stage: StageName
  tab: 'specs' | 'tracker' | 'testplan' | 'implementation' | 'qa' | 'assistant'
  color: 'green' | 'yellow' | 'red'
  reason: string
}

interface RecommendedActionRecord {
  step: StageName
  label: string
  tab: GateReadinessRecord['tab']
  reason: string
}

interface BoardCard {
  projectNamespace: string
  projectLabel: string
  projectPath: string
  status: BoardStatus
  verificationStatus: 'pass' | 'partial' | 'fail' | 'missing'
  currentAgent: string
  estimate: string
  gateReadiness: GateReadinessRecord[]
  automationState?: AutomationStateRecord
  recommendedAction?: RecommendedActionRecord
  updatedAt: string
  feature?: string
  latestRun?: HistoryRunSummary
  artifactLinks: BoardArtifactLink[]
  artifactDiffs: ArtifactDiffEntry[]
  statusOverride?: BoardStatus
}

interface BoardColumn {
  id: BoardStatus
  title: string
  cards: BoardCard[]
}

interface BoardResponse {
  columns: BoardColumn[]
}

interface QAArtifactPreview {
  label: string
  path: string
  exists: boolean
  content?: string
}

interface TaskTrackerMetadata {
  checked: boolean
  status: 'todo' | 'in_progress' | 'done' | 'blocked'
  note?: string
  lastRunReport?: string
  updatedAt: string
}

interface TaskTrackerParsedItem {
  id: string
  parallel: boolean
  story?: string
  description: string
  raw: string
  group: string
}

interface TaskTrackerItemRecord extends TaskTrackerMetadata, TaskTrackerParsedItem {}

interface QAOverview {
  featureDir?: string
  verificationPassed: boolean
  verificationStatus: 'pass' | 'partial' | 'fail' | 'missing'
  artifacts: QAArtifactPreview[]
  subagents: ParallelSubAgentResult[]
  currentJob: SubagentJobSnapshot
  jobHistory: SubagentJobSnapshot[]
}

interface PersistedProjectMeta {
  namespace: string
  label: string
  path: string
  lastUpdated: string
}

interface ProjectMemoryRecord {
  manualText: string
  autoSummary: string
  text: string
  updatedAt: string
}

interface ProjectBootstrapRequest {
  projectPath: string
  projectName?: string
  description?: string
}

interface ProjectBootstrapResponse {
  projectNamespace: string
  projectLabel: string
  projectPath: string
  created: boolean
  initializedGit: boolean
}

interface ProjectStatusUpdateRequest {
  status: BoardStatus
}

interface BoardStatusOverrideRecord {
  status: BoardStatus
  updatedAt: string
}

interface AutomationStateRecord {
  state: 'idle' | 'running' | 'needs_approval' | 'needs_clarification' | 'error' | 'blocked' | 'completed'
  message: string
  currentStage?: StageName
  assistantPrompt?: string
  actionLabel?: string
  updatedAt: string
}

interface SubagentWorkstreamStatus {
  workstream: string
  status: 'running' | 'completed' | 'error'
  summary?: string
  log?: string
  outputFile?: string
  runtimeMs?: number
  estimatedTokens?: number
  branch?: string
  baseBranch?: string
  pullRequestUrl?: string
}

interface SubagentJobSnapshot {
  projectNamespace: string
  status: 'idle' | 'running' | 'completed' | 'error'
  featureDir?: string
  workstreams: SubagentWorkstreamStatus[]
  startedAt?: string
  completedAt?: string
  updatedAt: string
  error?: string
}

interface SubAgentJobRecord {
  snapshot: SubagentJobSnapshot
  listeners: Set<(snapshot: SubagentJobSnapshot) => void>
  activeSessions: Map<string, import('@earendil-works/pi-coding-agent').AgentSession>
}

interface CreateRunRequest {
  projectId?: string
  targetRepoId?: string
  pipeline?: string
  feature?: string
  constitution?: string
  planContext?: string
  checklistDomain?: string
  model?: string
  thinking?: string
  persistSession?: boolean
  dryRun?: boolean
  verbose?: boolean
}

interface AnswerRunRequest {
  answer?: string
}
