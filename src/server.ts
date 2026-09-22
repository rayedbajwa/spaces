import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, normalize, resolve as resolvePath, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import packageMetadata from '../package.json'
import { marked } from 'marked'
import { ensureFrontendBuilt } from './build-web'
import { buildContextBundle } from './lib/context-builder'
import { createPromotionProposal, decidePromotionProposal, listPromotionProposals } from './lib/org-governance'
import { normalizeThinkingLevel, QUESTION_PATTERN, resolveCwd, runAIDLCAssistantChat, runAIDLCMergeOrchestrator, runAIDLCParallelSubAgents, runAIDLCSpecificTask, runAIDLCSpecificWorkstream, STAGE_DEFINITIONS, type FlowOptions, type ParallelSubAgentResult, type PauseKind, type StageName, parseApprovalAnswer } from './lib/aidlc'
import { PipelineEngine } from './lib/pipeline-engine'
import { getTemplate, listTemplates } from './lib/pipeline-loader'
import type { PipelineTemplate } from './lib/pipeline-template'
import { closeDb, getDb, ignoreShutdownDbErrors } from './lib/db'
import { enqueueJob, getOrchestrator, listJobsForProject, upsertOrchestrator } from './lib/dispatcher'
import { assertEnvOrExit } from './lib/env'
import { beginAuthorization, consumeState, exchangeCode, resolveGitHubLoginProvider, resolveProvider } from './lib/oauth'
import { deleteOAuthApp, isOAuthProviderId, listOAuthApps, recordGitHubInstallation, saveGitHubAppFromManifest, saveOAuthApp } from './lib/oauth-apps'
import { consumeManifestState, convertGitHubAppManifest, githubAppManifestPage } from './lib/github-app'
import { withExpiry } from './lib/integration-token'
import { configuredProvidersFor, deleteProviderKey, importProviderKeysFromEnv, isProviderId, listenProviderKeys, listProviderKeys, reverifyProviderKey, saveProviderKey, scrubProviderKeysFromEnv } from './lib/provider-keys'
import { createOrganization, getDefaultOrgId, getOrganization, listOrganizations, orgIdForProject, orgIdForProjectSlug } from './lib/orgs'
import { disconnectAppIntegration, listAppIntegrations, upsertAppIntegration, type AppIntegrationKind } from './lib/app-integrations'
import { listLiveWorkers, sendAnswerToOwner } from './lib/worker-registry'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AssistantChatTurn } from './lib/aidlc'
import { checkProviderKeys } from './lib/provider-check'
import { defaultModel, getModelPolicy, getTierRouting, updateModelPolicy, warmModelRouting, type ModelPolicy } from './lib/model-policy'
import {
  createKnowledgeSource, deleteKnowledgeDocument, deleteKnowledgeSource, getKnowledgeSource, getKnowledgeStatus,
  indexKnowledgeDocument, KNOWLEDGE_SOURCE_KINDS, listKnowledgeDocuments, listKnowledgeSources, resetKnowledgeSourceCursor,
  searchOrgKnowledge, updateKnowledgeSource, type KnowledgeSourceKind,
} from './lib/knowledge-store'
import { importQueueSnapshot, queueKnowledgeImport, recoverInterruptedImports } from './lib/knowledge-import'
import { listImportCatalog, validateSourceConfig, type CatalogIntegration } from './lib/knowledge-connectors'
import { confirmPhraseFor, deleteProjectCompletely, previewProjectDeletion, ProjectBusyError, ProjectNotArchivedError } from './lib/project-delete'
import { cancelProjectWork } from './lib/project-cancel'
import { ResponsibilityError, migrateProjectResponsibilities, replaceAssignments } from './lib/project-responsibilities'
import { ensureGovernanceWorkspace, exportProjectState, governanceEnabled, listRepoCatalog, syncGitHubRepoCatalog } from './lib/governance'
import { suggestRepositoriesAndWorkAreas } from './lib/suggestions'
import {
  acceptInvite,
  authDisabled,
  authenticate,
  clearSessionCookie,
  countUsers,
  createInvite,
  createSession,
  createTeam,
  createUser,
  deleteSession,
  getInviteByToken,
  getMembership,
  getOrgMemory,
  getTeam,
  getTeamMemory,
  getUserByEmail,
  getUserByGitHubLogin,
  linkGitHub,
  listInvites,
  listMembers,
  listTeamsForUser,
  readCookie,
  removeMember,
  renameTeam,
  revokeInvite,
  roleAtLeast,
  SESSION_COOKIE,
  sessionCookie,
  setActiveTeam,
  setMemberRole,
  updateOrgMemory,
  updateTeamKnowledge,
  updateTeamMemory,
  verifyPassword,
  bootstrapOrganization,
  type AuthContext,
  type InviteRole,
  type TeamRole,
} from './lib/auth'
import { findLatestFeatureDirAbsolute, parsePlanRepositories } from './lib/aidlc'
import { createRun as dbCreateRun, getLatestRunForProject as dbGetLatestRunForProject, getRun as dbGetRun, listAllRuns as dbListAllRuns, listEvents as dbListEvents, requeueRunFromStage as dbRequeueRunFromStage, listRunsForProject as dbListRunsForProject, appendEvent as dbAppendEvent, resolveOpenGate as dbResolveOpenGate, updateRunStatus as dbUpdateRunStatus, type EventRow, type RunRow, appendReviewerNote } from './lib/run-store'
import {
  addRepo as projAddRepo,
  createProject as projCreate,
  getProject as projGet,
  getProjectDetail as projGetDetail,
  getRepo as projGetRepo,
  updateRepo as projUpdateRepo,
  listProjects as projList,
  setProjectArchived as projSetArchived,
  setProjectPaused as projSetPaused,
  ensureProjectCodes,
  getProjectByCode as projGetByCode,
  getIntegration as projGetIntegration,
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
import { GitHubNotConnectedError, GitHubPermissionError, createGitHubRepository, listGitHubRepos, scheduleRepoClone, workspaceRoot } from './lib/github'
import { conventional, currentBranch as gitCurrentBranch, defaultBranch as gitDefaultBranch, publishBranchAsPullRequest, pullRequestBody } from './lib/pull-requests'
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
import { publicOrigin } from './lib/public-url'
import { EMPTY_USAGE, summarizeOrgUsage, summarizeProjectUsage, summarizeRunUsage, summarizeUsageByProject, type UsageSummary } from './lib/run-usage'
import { readTaskProgress } from './lib/run-resume'
import { laneForProject } from './lib/board-drop'
import { readAcceptance, recordAcceptance, withdrawAcceptance, type Acceptance } from './lib/acceptance'
import { acceptanceRecommended, describeSummary, summarizeVerification, type VerificationSummary } from './lib/verification-summary'
import { reapAbandonedJobs } from './lib/job-reaper'
import { describeGitHubActor, forgetGitHubAppState, githubAppAlive } from './lib/github-app-auth'
import { resolveVersionMetadata } from './lib/version-metadata'
import { newRepoUrl, sanitizeRepoName } from './lib/repo-proposal'

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
const versionMetadata = resolveVersionMetadata({ packageMetadata })
// Provider keys live in the database, per organization: keys left in the
// environment are imported once into the default organization and scrubbed so
// no tenant inherits them from the process. Routing is warmed per organization.
const bootOrgId = await getDefaultOrgId()
await importProviderKeysFromEnv(bootOrgId).catch((error) => serverLog.warn('provider key import failed', { error: error instanceof Error ? error.message : String(error) }))
scrubProviderKeysFromEnv()
await listenProviderKeys((orgId) => { void warmModelRouting(orgId, serverLog).catch(() => undefined) }).catch(() => undefined)
void checkProviderKeys(serverLog)
// What each tenant holds after the schema migrated, so an upgraded deployment
// can be checked from its logs without reading the database by hand.
void (async () => {
  const sql = getDb()
  const rows = await sql<Array<{ slug: string; name: string; teams: number; projects: number; keys: number; integrations: number; oauthApps: number; githubApp: string | null; knowledgeSources: number; users: number }>>`
    SELECT o.slug, o.name,
           (SELECT count(*)::int FROM teams t WHERE t.org_id = o.org_id) AS teams,
           (SELECT count(*)::int FROM projects p JOIN teams t ON t.team_id = p.team_id WHERE t.org_id = o.org_id) AS projects,
           (SELECT count(*)::int FROM provider_keys k WHERE k.org_id = o.org_id) AS keys,
           (SELECT count(*)::int FROM app_integrations a WHERE a.org_id = o.org_id AND a.status = 'connected') AS integrations,
           (SELECT count(*)::int FROM oauth_apps a WHERE a.org_id = o.org_id) AS "oauthApps",
           (SELECT a.config_json->>'appSlug' FROM oauth_apps a WHERE a.org_id = o.org_id AND a.provider = 'github') AS "githubApp",
           (SELECT count(*)::int FROM knowledge_sources s WHERE s.org_id = o.org_id) AS "knowledgeSources",
           (SELECT count(DISTINCT m.user_id)::int FROM team_members m JOIN teams t ON t.team_id = m.team_id WHERE t.org_id = o.org_id) AS users
      FROM organizations o ORDER BY o.created_at ASC
  `
  for (const row of rows) serverLog.info('tenant', { org: row.slug, name: row.name, users: row.users, teams: row.teams, projects: row.projects, providerKeys: row.keys, integrations: row.integrations, appCredentials: row.oauthApps, githubApp: row.githubApp ?? undefined, knowledgeSources: row.knowledgeSources })
  if (!authDisabled()) {
    serverLog.info(resolveGitHubLoginProvider()
      ? 'sign in with GitHub is available for this deployment'
      : 'sign in with GitHub is not set up; people sign in with email and password')
  }
  const [orphans] = await sql<Array<{ projects: number }>>`SELECT count(*)::int AS projects FROM projects WHERE team_id IS NULL`
  if (orphans?.projects) serverLog.warn('projects belong to no team and are unreachable while sign-in is on', { count: orphans.projects })
})().catch((error) => serverLog.warn('tenant report failed', { error: error instanceof Error ? error.message : String(error) }))
// The workspace volume fills with clones, dependencies and worktrees that
// nothing reclaims, and a full volume kills runs mid-stage. Sweep at boot and
// hourly, and say how much room is left.
{
  const housekeeping = async () => {
    const { diskUsage, ensureDiskSpace, formatBytes } = await import('./lib/disk-housekeeping')
    const { workspaceRoot } = await import('./lib/github')
    const root = workspaceRoot()
    const usage = (await ensureDiskSpace(root)) ?? (await diskUsage(root))
    if (usage) serverLog.info('workspace volume', { free: formatBytes(usage.freeBytes), total: formatBytes(usage.totalBytes), used: `${Math.round((1 - usage.freeRatio) * 100)}%` })
  }
  void housekeeping().catch((error) => serverLog.warn('workspace housekeeping failed', { error: error instanceof Error ? error.message : String(error) }))
  setInterval(() => { void housekeeping().catch(() => undefined) }, 60 * 60_000)
}
// A worker killed mid-flight leaves its job claimed for ever, which blocks the
// whole project. Workers sweep for those, but a project whose worker never
// spawned has nobody to sweep for it, so the server sweeps too.
{
  const sweep = () => reapAbandonedJobs()
    .catch((error) => serverLog.warn('abandoned job sweep failed', { error: error instanceof Error ? error.message : String(error) }))
  void sweep()
  setInterval(() => { void sweep() }, 60_000)
}
// Older projects get their readable code (TEAM-N) on first boot after the upgrade.
void ensureProjectCodes().then((n) => { if (n > 0) serverLog.info('assigned project codes', { count: n }) }).catch((error) => serverLog.warn('project code backfill failed', { error: error instanceof Error ? error.message : String(error) }))
// Knowledge imports run inside this process; ones cut off by the last restart
// must not look like they are still running.
void recoverInterruptedImports().then((n) => { if (n > 0) serverLog.warn('marked interrupted knowledge imports as failed', { count: n }) }).catch(() => undefined)
// Keep the GitHub repository catalog fresh (on boot when connected, then every 6h).
{
  const syncCatalog = async () => {
    for (const org of await listOrganizations().catch(() => [])) {
      await syncGitHubRepoCatalog(org.orgId).catch((error) => {
        if (!(error instanceof GitHubNotConnectedError)) serverLog.warn('GitHub catalog sync failed', { org: org.slug, error: error instanceof Error ? error.message : String(error) })
      })
    }
  }
  void syncCatalog()
  setInterval(() => { void syncCatalog() }, 6 * 60 * 60_000)
}

// Queries still in flight when the pool closes are part of shutting down, not a crash.
ignoreShutdownDbErrors((reason) => serverLog.error('unhandled rejection', reason instanceof Error ? reason : new Error(String(reason))))

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
  // Behind a TLS-terminating proxy the public scheme/host differ from req.url.
  const origin = publicOrigin(req, url)

  if (method === 'GET' && url.pathname === '/') {
    const html = await readFile(join(webDir, 'index.html'), 'utf8')
    return sendHtml(200, html)
  }

  if (method === 'GET' && url.pathname === '/health') {
    return sendJson(200, { ok: true })
  }

  if (method === 'GET' && url.pathname === '/api/version') {
    return sendJson(200, versionMetadata)
  }

  // Older project links used /p/<code>; send them to /spaces/<code>.
  if (method === 'GET' && url.pathname.startsWith('/p/')) {
    return Response.redirect(`${origin}/spaces/${url.pathname.slice('/p/'.length)}${url.search}`, 301)
  }

  // Client-side routes (sign-in page, invite acceptance, project pages) load the SPA shell.
  if (method === 'GET' && (url.pathname === '/login' || url.pathname.startsWith('/invite/') || url.pathname.startsWith('/spaces/') || url.pathname.startsWith('/teams/') || url.pathname === '/organization')) {
    const html = await readFile(join(webDir, 'index.html'), 'utf8')
    return sendHtml(200, html)
  }

  // ---- Authentication -------------------------------------------------------
  // Sessions are HttpOnly cookies; only their hash is stored. AUTH_DISABLED=1
  // keeps the old open behaviour for single-user local development.

  const isApi = url.pathname.startsWith('/api/')
  let auth: AuthContext | undefined = isApi || url.pathname.startsWith('/api') ? await authenticate(req).catch(() => undefined) : undefined

  /**
   * Endpoints a browser reaches without a session: starting GitHub sign-in and
   * every provider callback, which arrives straight from the provider. Both
   * carry a one-time state, and the callback takes the organization from that
   * state rather than from the caller.
   */
  const isPublicOAuth = method === 'GET' && (
    /^\/api\/oauth\/[^/]+\/callback$/.test(url.pathname) ||
    (url.pathname === '/api/oauth/github/authorize' && url.searchParams.get('mode') === 'login')
  )

  // An account that belongs to no team has no tenant: nothing beyond its own
  // session, team creation and invites is visible until it joins or creates one.
  if (auth && auth.teams.length === 0 && isApi && !isPublicOAuth && !/^\/api\/(auth|me|teams|invites)(\/|$)/.test(url.pathname)) {
    return sendJson(403, { error: 'You are not in a team yet. Create one or accept an invite first.', code: 'no_team' })
  }
  /** The caller's organization (tenant): the active team's, or the default one when sign-in is disabled. */
  const orgIdOf = async (): Promise<string> => auth?.orgId ?? (await getDefaultOrgId())

  if (method === 'GET' && url.pathname === '/api/auth/status') {
    const statusOrg = await getDefaultOrgId()
    // Sign-in belongs to the deployment, not to a tenant: it has its own GitHub app.
    const githubLogin = Boolean(resolveGitHubLoginProvider())
    return sendJson(200, { authEnabled: !authDisabled(), needsBootstrap: (await countUsers()) === 0, githubLogin, defaultModel: await defaultModel(statusOrg), modelsReady: (await configuredProvidersFor(statusOrg)).length > 0 })
  }

  if (method === 'POST' && url.pathname === '/api/auth/register') {
    const body = await readJson<{ email?: string; password?: string; name?: string; inviteToken?: string; organizationName?: string }>(req)
    const email = body.email?.trim()
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return sendJson(400, { error: 'A valid email is required.' })
    if (!body.password || body.password.length < 10) return sendJson(400, { error: 'Password must be at least 10 characters.' })
    if (await getUserByEmail(email)) return sendJson(409, { error: 'An account with this email already exists. Sign in instead.' })
    const first = (await countUsers()) === 0
    const invite = body.inviteToken ? await getInviteByToken(body.inviteToken) : undefined
    // Registration is open only for the very first user or with a valid invite.
    if (!first && !invite && process.env.OPEN_REGISTRATION !== '1') {
      return sendJson(403, { error: body.inviteToken ? 'This invite link is invalid, expired or already used.' : 'Registration is by invitation. Ask a team owner or admin for an invite link.' })
    }
    // Check the invite before creating anything, so a mismatched email does not leave a stray account.
    if (invite && invite.email.toLowerCase() !== email.toLowerCase()) {
      return sendJson(400, { error: `This invite was issued to ${invite.email}; register with that address to accept it.` })
    }
    const user = await createUser({ email, name: body.name?.trim() || email.split('@')[0]!, password: body.password })
    let teamId: string | undefined
    if (invite) teamId = (await acceptInvite(body.inviteToken!, user)).teamId
    // Without an invite the account starts its own organization (the first one adopts anything from before tenancy).
    else teamId = (await bootstrapOrganization(user, { organizationName: body.organizationName, adoptLegacy: first })).team.teamId
    const { token } = await createSession(user.userId, req, teamId)
    return new Response(JSON.stringify({ ok: true, user, bootstrapped: first }), { status: 201, headers: { 'content-type': 'application/json', 'set-cookie': sessionCookie(token, req) } })
  }

  if (method === 'POST' && url.pathname === '/api/auth/login') {
    const body = await readJson<{ email?: string; password?: string; inviteToken?: string }>(req)
    if (!body.email || !body.password) return sendJson(400, { error: 'Email and password are required.' })
    const user = await verifyPassword(body.email, body.password)
    if (!user) return sendJson(401, { error: 'Invalid email or password.' })
    let teamId: string | undefined
    if (body.inviteToken) {
      try { teamId = (await acceptInvite(body.inviteToken, user)).teamId } catch (error) { return sendJson(400, { error: error instanceof Error ? error.message : String(error) }) }
    }
    const { token } = await createSession(user.userId, req, teamId)
    return new Response(JSON.stringify({ ok: true, user }), { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': sessionCookie(token, req) } })
  }

  if (method === 'POST' && url.pathname === '/api/auth/logout') {
    const token = readCookie(req, SESSION_COOKIE)
    if (token) await deleteSession(token).catch(() => undefined)
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': clearSessionCookie() } })
  }

  // Invite preview is public (the invitee is not signed in yet); acceptance needs a session.
  if (method === 'GET' && /^\/api\/invites\/[^/]+$/.test(url.pathname)) {
    const invite = await getInviteByToken(decodeURIComponent(url.pathname.split('/')[3]!))
    if (!invite) return sendJson(404, { error: 'This invite link is invalid, expired or already used.' })
    return sendJson(200, { email: invite.email, role: invite.role, teamName: invite.teamName, teamSlug: invite.teamSlug, expiresAt: invite.expiresAt })
  }

  if (isApi && !authDisabled() && !auth && !isPublicOAuth) {
    return sendJson(401, { error: 'Sign in required.', code: 'unauthenticated' })
  }

  if (method === 'GET' && url.pathname === '/api/me') {
    const meOrg = await orgIdOf()
    const modelsReady = (await configuredProvidersFor(meOrg)).length > 0
    const organization = await getOrganization(meOrg).catch(() => undefined)
    if (!auth) return sendJson(200, { authEnabled: false, user: null, teams: [], activeTeam: null, organization: organization ?? null, org: await getOrgMemory(meOrg), defaultModel: await defaultModel(meOrg), modelsReady })
    return sendJson(200, { authEnabled: true, user: auth.user, teams: auth.teams, activeTeam: auth.activeTeam ?? null, organization: organization ?? null, org: await getOrgMemory(meOrg), defaultModel: await defaultModel(meOrg), modelsReady })
  }

  if (method === 'POST' && url.pathname === '/api/me/team' && auth) {
    const body = await readJson<{ teamId?: string }>(req)
    const team = auth.teams.find((t) => t.teamId === body.teamId)
    if (!team) return sendJson(404, { error: 'You are not a member of that team.' })
    await setActiveTeam(auth.sessionId, team.teamId)
    return sendJson(200, { activeTeam: team })
  }

  if (method === 'POST' && /^\/api\/invites\/[^/]+\/accept$/.test(url.pathname) && auth) {
    try {
      const team = await acceptInvite(decodeURIComponent(url.pathname.split('/')[3]!), auth.user)
      await setActiveTeam(auth.sessionId, team.teamId)
      return sendJson(200, { team, teams: await listTeamsForUser(auth.user.userId) })
    } catch (error) {
      return sendJson(400, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  // ---- Teams ("spaces"): each owns projects, memory and knowledge defaults ----

  const teamRole = (teamId: string): TeamRole | undefined => auth?.teams.find((t) => t.teamId === teamId)?.role
  const requireOrgAdmin = (message: string) => {
    if (authDisabled()) return null
    return !auth || !auth.teams.some((t) => t.orgId === auth.orgId && roleAtLeast(t.role, 'admin')) ? sendJson(403, { error: message }) : null
  }
  const requireProjectRole = (project: { teamId?: string | null } | undefined, needed: TeamRole, message: string) => {
    if (!auth || !project?.teamId) return null
    const role = teamRole(project.teamId)
    // Not a member of the owning team at all: nothing about the project is visible.
    if (!role) return sendJson(403, { error: 'This project belongs to a team you are not a member of.' })
    return roleAtLeast(role, needed) ? null : sendJson(403, { error: message })
  }
  /** Runs are reachable only through their project's team. */
  const requireRunAccess = async (row: RunRow, needed: TeamRole, message: string) => {
    if (!auth) return null
    const project = row.projectId ? await projGet(row.projectId) : await import('./lib/project-registry').then((m) => m.getProjectBySlug(row.projectNamespace))
    if (!project) return sendJson(403, { error: 'This run belongs to a project you cannot access.' })
    return requireProjectRole(project, needed, message)
  }

  if (method === 'GET' && url.pathname === '/api/teams' && auth) {
    return sendJson(200, { teams: auth.teams, activeTeam: auth.activeTeam ?? null })
  }

  if (method === 'POST' && url.pathname === '/api/teams' && auth) {
    const body = await readJson<{ name?: string }>(req)
    if (!body.name?.trim()) return sendJson(400, { error: 'Team name is required.' })
    // A new team joins the caller's organization; an account without one starts its own.
    const orgId = auth.orgId ?? (await createOrganization({ name: `${auth.user.name.split(' ')[0] || auth.user.email.split('@')[0]}'s organization`, createdBy: auth.user.userId })).orgId
    const team = await createTeam({ name: body.name, createdBy: auth.user.userId, orgId })
    await setActiveTeam(auth.sessionId, team.teamId)
    return sendJson(201, { team, teams: await listTeamsForUser(auth.user.userId) })
  }

  if (/^\/api\/teams\/[0-9a-f-]{36}(\/|$)/.test(url.pathname) && auth) {
    const teamId = url.pathname.split('/')[3]!
    const role = teamRole(teamId)
    if (!role) return sendJson(403, { error: 'You are not a member of this team.' })
    const rest = url.pathname.slice(`/api/teams/${teamId}`.length)
    const requireRole = (needed: TeamRole) => (roleAtLeast(role, needed) ? null : sendJson(403, { error: `This action needs the ${needed} role.` }))

    if (method === 'GET' && rest === '') {
      const team = await getTeam(teamId)
      return sendJson(200, { team, role, members: await listMembers(teamId), invites: roleAtLeast(role, 'admin') ? await listInvites(teamId) : [], memory: await getTeamMemory(teamId) })
    }
    if (method === 'PATCH' && rest === '') {
      const denied = requireRole('admin'); if (denied) return denied
      const body = await readJson<{ name?: string }>(req)
      if (body.name?.trim()) await renameTeam(teamId, body.name)
      return sendJson(200, { team: await getTeam(teamId) })
    }
    if (method === 'GET' && rest === '/members') return sendJson(200, { members: await listMembers(teamId) })
    // Every project of the team, archived ones included, for the team page.
    if (method === 'GET' && rest === '/projects') return sendJson(200, { projects: await projList(teamId) })
    if (method === 'PATCH' && /^\/members\/[0-9a-f-]{36}$/.test(rest)) {
      const denied = requireRole('admin'); if (denied) return denied
      const userId = rest.split('/')[2]!
      const body = await readJson<{ role?: TeamRole }>(req)
      if (!body.role || !['owner', 'admin', 'member', 'viewer'].includes(body.role)) return sendJson(400, { error: 'role must be owner, admin, member or viewer.' })
      if (body.role === 'owner' && role !== 'owner') return sendJson(403, { error: 'Only an owner can make someone an owner.' })
      try { await setMemberRole(teamId, userId, body.role) } catch (error) { return sendJson(409, { error: error instanceof Error ? error.message : String(error) }) }
      return sendJson(200, { members: await listMembers(teamId) })
    }
    if (method === 'DELETE' && /^\/members\/[0-9a-f-]{36}$/.test(rest)) {
      const userId = rest.split('/')[2]!
      if (userId !== auth.user.userId) { const denied = requireRole('admin'); if (denied) return denied }
      try { await removeMember(teamId, userId, auth.user.userId) } catch (error) { return sendJson(409, { error: error instanceof Error ? error.message : String(error) }) }
      return sendJson(200, { members: await listMembers(teamId) })
    }
    if (method === 'GET' && rest === '/invites') {
      const denied = requireRole('admin'); if (denied) return denied
      return sendJson(200, { invites: await listInvites(teamId) })
    }
    if (method === 'POST' && rest === '/invites') {
      const denied = requireRole('admin'); if (denied) return denied
      const body = await readJson<{ email?: string; role?: InviteRole }>(req)
      if (!body.email?.trim()) return sendJson(400, { error: 'email is required.' })
      const inviteRole: InviteRole = body.role && ['admin', 'member', 'viewer'].includes(body.role) ? body.role : 'member'
      const { invite, token } = await createInvite({ teamId, email: body.email, role: inviteRole, invitedBy: auth.user.userId })
      // No mail server: the inviter shares this link. It only works for the invited email.
      return sendJson(201, { invite, link: `${origin}/invite/${token}`, invites: await listInvites(teamId) })
    }
    if (method === 'DELETE' && /^\/invites\/[0-9a-f-]{36}$/.test(rest)) {
      const denied = requireRole('admin'); if (denied) return denied
      await revokeInvite(teamId, rest.split('/')[2]!)
      return sendJson(200, { invites: await listInvites(teamId) })
    }
    if (method === 'GET' && rest === '/memory') return sendJson(200, await getTeamMemory(teamId))
    if (method === 'PUT' && rest === '/memory') {
      const denied = requireRole('member'); if (denied) return denied
      const body = await readJson<{ text?: string; manualText?: string }>(req)
      await updateTeamMemory(teamId, body.manualText ?? body.text ?? '')
      return sendJson(200, await getTeamMemory(teamId))
    }
    if (method === 'GET' && rest === '/knowledge') return sendJson(200, { config: (await getTeam(teamId))?.knowledgeJson ?? {} })
    if (method === 'PUT' && rest === '/knowledge') {
      const denied = requireRole('admin'); if (denied) return denied
      const body = await readJson<Record<string, unknown>>(req)
      await updateTeamKnowledge(teamId, body)
      return sendJson(200, { config: body })
    }
    return sendJson(404, { error: 'Not found.' })
  }

  // ---- Organization: memory shared by every team (owners/admins edit) ----

  if (method === 'GET' && url.pathname === '/api/org/memory') {
    return sendJson(200, await getOrgMemory(await orgIdOf()))
  }
  if (method === 'PUT' && url.pathname === '/api/org/memory') {
    const denied = requireOrgAdmin('Only team owners or admins can edit organization memory.'); if (denied) return denied
    const body = await readJson<{ name?: string; text?: string; manualText?: string }>(req)
    await updateOrgMemory(await orgIdOf(), { name: body.name?.trim() || undefined, manualText: body.manualText ?? body.text })
    return sendJson(200, await getOrgMemory(await orgIdOf()))
  }

  // ---- LLM provider keys (organization-level, encrypted) ----

  if (method === 'GET' && url.pathname === '/api/org/provider-keys') {
    const denied = requireOrgAdmin('Only team owners or admins can view provider keys.'); if (denied) return denied
    return sendJson(200, { keys: await listProviderKeys(await orgIdOf()) })
  }
  if (/^\/api\/org\/provider-keys\/[a-z]+(\/verify)?$/.test(url.pathname) && (method === 'PUT' || method === 'DELETE' || method === 'POST')) {
    const parts = url.pathname.split('/')
    const provider = parts[4]!
    if (!isProviderId(provider)) return sendJson(404, { error: `Unknown provider "${provider}".` })
    const denied = requireOrgAdmin('Only team owners or admins can manage provider keys.'); if (denied) return denied
    const orgId = await orgIdOf()
    try {
      if (method === 'DELETE') {
        await deleteProviderKey(orgId, provider)
        serverLog.info('provider key removed', { provider, by: auth?.user.email ?? 'local' })
      } else if (method === 'POST' && parts[5] === 'verify') {
        const result = await reverifyProviderKey(orgId, provider)
        return sendJson(200, { result, keys: await listProviderKeys(orgId) })
      } else if (method === 'PUT') {
        const body = await readJson<{ key?: string }>(req)
        const result = await saveProviderKey(orgId, provider, body.key ?? '', auth?.user.userId ?? null)
        serverLog.info('provider key saved', { provider, by: auth?.user.email ?? 'local', status: result.status })
        await warmModelRouting(orgId, serverLog).catch(() => undefined)
        return sendJson(200, { result, keys: await listProviderKeys(orgId), routing: await getTierRouting(orgId, true) })
      } else {
        return sendJson(405, { error: 'Method not allowed.' })
      }
    } catch (error) {
      return sendJson(400, { error: error instanceof Error ? error.message : String(error) })
    }
    return sendJson(200, { keys: await listProviderKeys(orgId), routing: await getTierRouting(orgId, true) })
  }

  // ---- Organization model routing: automatic per provider, tuned by policy ----

  if (method === 'GET' && url.pathname === '/api/org/models') {
    const routing = await getTierRouting(await orgIdOf(), url.searchParams.get('refresh') === '1')
    return sendJson(200, routing)
  }
  if (method === 'PUT' && url.pathname === '/api/org/models') {
    const denied = requireOrgAdmin('Only team owners or admins can change model routing.'); if (denied) return denied
    const body = await readJson<Partial<ModelPolicy>>(req)
    await updateModelPolicy(await orgIdOf(), body)
    const routing = await getTierRouting(await orgIdOf(), true)
    serverLog.info('model policy updated', { by: auth?.user.email ?? 'local', preference: routing.policy.preference, provider: routing.provider, ...routing.tiers })
    return sendJson(200, routing)
  }

  // ---- Organization knowledge base (RAG): import from integrations, search ----
  // Sources belong to the organization (every team sees them) or to one team.
  // Owners/admins of a team import for that team; any owner/admin may import
  // for the organization. Everyone signed in can search what they can see.

  if (url.pathname === '/api/org/knowledge' || url.pathname.startsWith('/api/org/knowledge/')) {
    const rest = url.pathname.slice('/api/org/knowledge'.length)
    const knowledgeOrg = await orgIdOf()
    const myTeamIds: string[] | 'all' = auth ? auth.teams.filter((t) => t.orgId === knowledgeOrg).map((t) => t.teamId) : 'all'
    const scope = { orgId: knowledgeOrg, teamIds: myTeamIds }
    const canEditOrg = !auth || auth.teams.some((t) => t.orgId === knowledgeOrg && roleAtLeast(t.role, 'admin'))
    const canEditScope = (teamId: string | null) => !auth || (teamId ? roleAtLeast(teamRole(teamId) ?? 'viewer', 'admin') : canEditOrg)
    const visible = (teamId: string | null) => myTeamIds === 'all' || teamId === null || myTeamIds.includes(teamId)
    const forbidden = () => sendJson(403, { error: 'Only team owners or admins can change the knowledge base.' })

    if (method === 'GET' && rest === '/status') return sendJson(200, await getKnowledgeStatus(scope))

    // What a connected integration offers to import: spaces, projects, teams, initiatives, repositories.
    if (method === 'GET' && rest === '/catalog') {
      const integration = url.searchParams.get('integration') as CatalogIntegration | null
      if (!integration || !['confluence', 'jira', 'linear', 'github'].includes(integration)) return sendJson(400, { error: 'integration must be confluence, jira, linear or github.' })
      try {
        return sendJson(200, { integration, entries: await listImportCatalog(knowledgeOrg, integration) })
      } catch (error) {
        if (error instanceof KnowledgeSourceNotConnectedError) return sendJson(409, { error: error.message, entries: [] })
        return sendJson(502, { error: error instanceof Error ? error.message : String(error), entries: [] })
      }
    }

    if (method === 'GET' && rest === '/sources') {
      return sendJson(200, { sources: await listKnowledgeSources(scope), importing: importQueueSnapshot() })
    }

    if (method === 'POST' && rest === '/sources') {
      const body = await readJson<{ kind?: KnowledgeSourceKind; label?: string; config?: Record<string, unknown>; teamId?: string | null }>(req)
      if (!body.kind || !KNOWLEDGE_SOURCE_KINDS.includes(body.kind)) return sendJson(400, { error: `kind must be one of ${KNOWLEDGE_SOURCE_KINDS.join(', ')}.` })
      const teamId = body.teamId?.trim() || null
      if (teamId && auth && !auth.teams.some((t) => t.teamId === teamId)) return sendJson(403, { error: 'You are not a member of that team.' })
      if (!canEditScope(teamId)) return forbidden()
      const config = body.config && typeof body.config === 'object' ? body.config : {}
      const problem = validateSourceConfig(body.kind, config)
      if (problem) return sendJson(400, { error: problem })
      if (!body.label?.trim()) return sendJson(400, { error: 'label is required.' })
      const source = await createKnowledgeSource({ orgId: knowledgeOrg, kind: body.kind, label: body.label, config, teamId, createdBy: auth?.user.userId ?? null })
      if (source.kind !== 'manual') queueKnowledgeImport(source.sourceId)
      return sendJson(201, { source })
    }

    // Notes (misc): free text added straight to a "Notes" source of the chosen scope.
    if (method === 'POST' && rest === '/notes') {
      const body = await readJson<{ title?: string; content?: string; url?: string; teamId?: string | null }>(req)
      const teamId = body.teamId?.trim() || null
      if (teamId && auth && !auth.teams.some((t) => t.teamId === teamId)) return sendJson(403, { error: 'You are not a member of that team.' })
      if (!canEditScope(teamId)) return forbidden()
      if (!body.title?.trim() || !body.content?.trim()) return sendJson(400, { error: 'title and content are required.' })
      const existing = (await listKnowledgeSources({ orgId: knowledgeOrg, teamIds: teamId ? [teamId] : [] })).find((s) => s.kind === 'manual' && s.teamId === teamId)
      const source = existing ?? await createKnowledgeSource({ orgId: knowledgeOrg, kind: 'manual', label: 'Notes', teamId, createdBy: auth?.user.userId ?? null })
      const result = await indexKnowledgeDocument(source, { externalId: `note:${crypto.randomUUID()}`, title: body.title, content: body.content, url: body.url?.trim() || undefined, metadata: { addedBy: auth?.user.email ?? 'local' } })
      return sendJson(201, { source: await getKnowledgeSource(source.sourceId), result })
    }

    if (method === 'GET' && rest === '/search') {
      const query = url.searchParams.get('q')?.trim() ?? ''
      if (!query) return sendJson(400, { error: 'q is required.' })
      const limit = Number(url.searchParams.get('limit') ?? '8')
      const sourceIds = (url.searchParams.get('sources') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
      const result = await searchOrgKnowledge({ query, scope: { orgId: knowledgeOrg, teamIds: myTeamIds, sourceIds: sourceIds.length ? sourceIds : undefined }, limit, perDocument: url.searchParams.get('perDocument') !== '0' })
      return sendJson(200, result)
    }

    const sourceMatch = /^\/sources\/([0-9a-f-]{36})(\/.*)?$/.exec(rest)
    if (sourceMatch) {
      const sourceId = sourceMatch[1]!
      const sub = sourceMatch[2] ?? ''
      const source = await getKnowledgeSource(sourceId)
      // An organization-level source has no team, so team membership alone would
      // make it readable from any tenant that knows its id.
      if (!source || source.orgId !== knowledgeOrg || !visible(source.teamId)) return sendJson(404, { error: 'Knowledge source not found.' })

      if (method === 'GET' && sub === '') return sendJson(200, { source, documents: await listKnowledgeDocuments(sourceId, Number(url.searchParams.get('limit') ?? '100')) })
      if (method === 'PATCH' && sub === '') {
        if (!canEditScope(source.teamId)) return forbidden()
        const body = await readJson<{ label?: string; config?: Record<string, unknown>; enabled?: boolean }>(req)
        if (body.config) {
          const problem = validateSourceConfig(source.kind, body.config)
          if (problem) return sendJson(400, { error: problem })
        }
        const updated = await updateKnowledgeSource(sourceId, { label: body.label, config: body.config, enabled: body.enabled })
        if (body.config && source.kind !== 'manual') queueKnowledgeImport(sourceId)
        return sendJson(200, { source: updated })
      }
      if (method === 'DELETE' && sub === '') {
        if (!canEditScope(source.teamId)) return forbidden()
        await deleteKnowledgeSource(sourceId)
        return sendJson(200, { ok: true })
      }
      if (method === 'POST' && sub === '/import') {
        if (!canEditScope(source.teamId)) return forbidden()
        if (source.kind === 'manual') return sendJson(400, { error: 'Notes have nothing to import; add notes instead.' })
        const body = await readJson<{ full?: boolean }>(req)
        if (body.full) await resetKnowledgeSourceCursor(sourceId)
        const queued = queueKnowledgeImport(sourceId)
        return sendJson(202, { queued, source: await getKnowledgeSource(sourceId), importing: importQueueSnapshot() })
      }
      if (method === 'POST' && sub === '/documents') {
        if (!canEditScope(source.teamId)) return forbidden()
        const body = await readJson<{ externalId?: string; title?: string; content?: string; url?: string }>(req)
        if (!body.title?.trim() || !body.content?.trim()) return sendJson(400, { error: 'title and content are required.' })
        const result = await indexKnowledgeDocument(source, { externalId: body.externalId?.trim() || `note:${crypto.randomUUID()}`, title: body.title, content: body.content, url: body.url?.trim() || undefined, metadata: { addedBy: auth?.user.email ?? 'local' } })
        return sendJson(201, { result, source: await getKnowledgeSource(sourceId) })
      }
      const docMatch = /^\/documents\/([0-9a-f-]{36})$/.exec(sub)
      if (method === 'DELETE' && docMatch) {
        if (!canEditScope(source.teamId)) return forbidden()
        return sendJson(200, { ok: await deleteKnowledgeDocument(docMatch[1]!) })
      }
    }
    return sendJson(404, { error: 'Unknown knowledge endpoint.' })
  }

  // ---- Authorization: viewers read only; projects belong to teams ----

  if (auth && isApi && method !== 'GET') {
    const active = auth.activeTeam
    const readOnlyPath = /^\/api\/(me|auth|invites|projects\/[^/]+\/chat)(\/|$)/.test(url.pathname)
    if (active && active.role === 'viewer' && !readOnlyPath) {
      return sendJson(403, { error: 'Viewers cannot change anything. Ask a team admin for the member role.' })
    }
  }

  if (auth) {
    const match = /^\/api\/projects\/([^/]+)(\/|$)/.exec(url.pathname)
    if (match) {
      const idOrSlug = decodeURIComponent(match[1]!)
      const project = /^[0-9a-f-]{36}$/.test(idOrSlug)
        ? await projGet(idOrSlug)
        : await import('./lib/project-registry').then((m) => m.getProjectBySlug(idOrSlug))
      // Fails closed: a project whose team the caller is not in is invisible, and so
      // is a project with no team at all (nothing to authorize against).
      if (project && (!project.teamId || !auth.teams.some((t) => t.teamId === project.teamId))) {
        return sendJson(403, { error: 'This project belongs to a team you are not a member of.' })
      }
    }
  }

  if (method === 'GET' && url.pathname === '/api/history') {
    const history = await listHistory()
    if (!auth) return sendJson(200, history)
    if (!auth.activeTeam) return sendJson(200, { ...history, projects: [], runs: [] })
    // Team scope: only this team's projects and their runs.
    const slugs = new Set((await projList(auth.activeTeam.teamId)).map((p) => p.slug))
    return sendJson(200, {
      ...history,
      projects: history.projects.filter((p) => slugs.has(p.namespace)),
      runs: history.runs.filter((r) => slugs.has(r.projectNamespace)),
    })
  }

  // ---- Project registry (Phase 4A) ----

  if (method === 'GET' && url.pathname === '/api/projects') {
    // Scoped to the active team ("space"); unscoped only when auth is disabled.
    if (auth && !auth.activeTeam) return sendJson(200, [])
    return sendJson(200, await projList(auth?.activeTeam?.teamId))
  }

  if (method === 'POST' && url.pathname === '/api/projects') {
    const body = await readJson<{
      name?: string
      description?: string
      repos?: Array<{ label: string; kind: RepoKind; localPath?: string; githubRepo?: string; isPrimary?: boolean }>
      integrations?: Array<{ kind: IntegrationKind; displayName?: string; config?: Record<string, unknown> }>
      /** Model used by the onboarding "learn the codebase" agent. */
      model?: string
      /** First feature description; feeds repository/work-area suggestions. */
      feature?: string
    }>(req)
    if (!body.name?.trim()) return sendJson(400, { error: 'name is required' })
    if (auth && !auth.activeTeam) return sendJson(400, { error: 'Create or join a team before creating a project.' })
    // Onboarding and every stage need a model: refuse rather than create a project that cannot run.
    if ((await configuredProvidersFor(await orgIdOf())).length === 0) return sendJson(409, { error: 'No model provider key is set. Add an Anthropic, OpenAI or OpenRouter key under Organization → Models first.', code: 'no_provider_key' })
    const project = await projCreate({ name: body.name.trim(), description: body.description?.trim(), teamId: auth?.activeTeam?.teamId ?? null, createdBy: auth?.user.userId ?? null })
    for (const r of body.repos ?? []) {
      await projAddRepo({ projectId: project.projectId, ...r })
    }
    for (const i of body.integrations ?? []) {
      await projUpsertIntegration({ projectId: project.projectId, ...i })
    }
    // Onboarding runs in the background: clone remote repos FIRST, then inventory
    // the codebase, have an agent learn it, and store the result as project memory.
    // The wizard polls GET /api/projects/:id/onboarding and waits before the first run.
    // Governing workspace: the project's primary "repo" for specs, memory and
    // reports, so no code repository has to be selected up front.
    if (governanceEnabled()) {
      await ensureGovernanceWorkspace(project).catch((error) => serverLog.warn('governance workspace creation failed', { slug: project.slug, error: error instanceof Error ? error.message : String(error) }))
    }
    void startProjectOnboarding(project, { model: body.model?.trim() || await defaultModel(await orgIdOf()), feature: body.feature?.trim() || undefined })
    const detail = await projGetDetail(project.projectId)
    return sendJson(201, { ...detail, onboarding: getOnboardingSnapshot(project.projectId) })
  }

  // Project responsibilities: accountability data is visible to owning-team members;
  // mutations and repair are restricted to team owners/admins.
  if (/^\/api\/projects\/[0-9a-f-]{36}\/responsibilities(?:\/.*)?$/.test(url.pathname)) {
    const parts = url.pathname.split('/')
    const projectId = parts[3]!
    const project = await projGet(projectId)
    if (!project) return sendJson(404, { error: 'Project not found.' })
    // A project with no owning team has no eligibility boundary. Refuse rather
    // than exposing accountability data to every authenticated account (FR-019).
    if (!authDisabled() && !project.teamId) return sendJson(403, { error: 'This project has no owning team; adopt it into a team before managing responsibilities.' })
    const denied = requireProjectRole(project, method === 'GET' ? 'member' : 'admin', method === 'GET' ? 'Only team members can view project responsibilities.' : 'Only team owners or admins can manage project responsibilities.')
    if (denied) return denied
    try {
      if (method === 'GET' && parts.length === 5) {
        // Accessing responsibility state triggers an idempotent repair: missing
        // standard definitions are seeded and an eligible Owner selected (FR-002).
        const result = await migrateProjectResponsibilities(projectId, auth?.user.userId)
        return sendJson(200, { projectId, repairNeeded: result.repairNeeded, responsibilities: result.responsibilities })
      }
      if (method === 'POST' && parts.length === 6 && parts[4] === 'responsibilities' && parts[5] === 'migrate') {
        const result = await migrateProjectResponsibilities(projectId, auth?.user.userId)
        return sendJson(200, { projectId, ...result })
      }
      if (method === 'PUT' && parts.length === 7 && parts[4] === 'responsibilities' && parts[6] === 'assignments') {
        const responsibilityId = parts[5]!
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(responsibilityId)) return sendJson(400, { error: 'responsibilityId must be a UUID string.' })
        const body = await readJson<{ userIds?: unknown }>(req)
        if (!Array.isArray(body.userIds) || body.userIds.some((id) => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))) return sendJson(400, { error: 'userIds must be an array of UUID strings.' })
        const updated = await replaceAssignments(projectId, responsibilityId, body.userIds, auth?.user.userId)
        return sendJson(200, updated)
      }
      return sendJson(404, { error: 'Unknown responsibility endpoint.' })
    } catch (error) {
      if (error instanceof ResponsibilityError) {
        const status = error.code === 'not_found' ? 404 : error.code === 'conflict' ? 409 : error.code === 'ineligible' || error.code === 'invalid' ? 400 : 500
        return sendJson(status, { error: error.message, code: error.code })
      }
      if (error instanceof SyntaxError) return sendJson(400, { error: 'Request body must be valid JSON.' })
      throw error
    }
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
    const denied = requireProjectRole(project, 'member', 'Only team members can re-run onboarding.'); if (denied) return denied
    if (project.archivedAt) return sendJson(409, { error: 'This project is archived. Unarchive it before re-running onboarding.' })
    if ((await configuredProvidersFor(await orgIdOf())).length === 0) return sendJson(409, { error: 'No model provider key is set. Add an Anthropic, OpenAI or OpenRouter key under Organization → Models first.', code: 'no_provider_key' })
    const body = await readJson<{ model?: string }>(req)
    void startProjectOnboarding(project, { model: body.model?.trim() || await defaultModel(await orgIdOf()) })
    return sendJson(202, getOnboardingSnapshot(projectId))
  }

  // Project page by readable code (PLAT-12): detail plus the board card fields the page needs.
  if (method === 'GET' && /^\/api\/projects\/by-code\/[A-Za-z0-9-]+$/.test(url.pathname)) {
    const code = decodeURIComponent(url.pathname.split('/').pop()!)
    const project = await projGetByCode(code)
    if (!project) return sendJson(404, { error: `No project with code ${code.toUpperCase()}.` })
    if (auth && project.teamId && !teamRole(project.teamId)) return sendJson(403, { error: 'This project belongs to a team you are not a member of.' })
    const detail = await projGetDetail(project.projectId)
    return sendJson(200, { ...detail, code: project.code, slug: project.slug })
  }

  if (method === 'GET' && /^\/api\/projects\/[0-9a-f-]{36}$/.test(url.pathname)) {
    const projectId = url.pathname.split('/').pop()!
    const detail = await projGetDetail(projectId)
    if (!detail) return sendJson(404, { error: 'Project not found.' })
    return sendJson(200, detail)
  }

  if (method === 'PATCH' && /^\/api\/projects\/[0-9a-f-]{36}$/.test(url.pathname)) {
    const projectId = url.pathname.split('/').pop()!
    const project = await projGet(projectId)
    if (!project) return sendJson(404, { error: 'Project not found.' })
    const denied = requireProjectRole(project, 'member', 'Only team members can edit project details.'); if (denied) return denied
    const body = await readJson<{ name?: string; description?: string }>(req)
    const updated = await projUpdate(projectId, body)
    if (!updated) return sendJson(404, { error: 'Project not found.' })
    return sendJson(200, updated)
  }

  // What deleting the project would remove, and whether it is allowed right now.
  if (method === 'GET' && /^\/api\/projects\/[0-9a-f-]{36}\/deletion-check$/.test(url.pathname)) {
    const projectId = url.pathname.split('/')[3]!
    const project = await projGet(projectId)
    if (!project) return sendJson(404, { error: 'Project not found.' })
    const role = project.teamId ? teamRole(project.teamId) : undefined
    const allowed = !auth || !project.teamId || roleAtLeast(role ?? 'viewer', 'admin')
    return sendJson(200, { ...(await previewProjectDeletion(project)), allowed })
  }

  // Pause (reversible): queued jobs wait and running runs stop before their next
  // stage. Resume lets jobs dispatch again and re-queues the runs that paused.
  if (method === 'POST' && /^\/api\/projects\/[0-9a-f-]{36}\/(pause|resume)$/.test(url.pathname)) {
    const projectId = url.pathname.split('/')[3]!
    const pause = url.pathname.endsWith('/pause')
    const project = await projGet(projectId)
    if (!project) return sendJson(404, { error: 'Project not found.' })
    if (auth && project.teamId && !roleAtLeast(teamRole(project.teamId) ?? 'viewer', 'admin')) return sendJson(403, { error: `Only team owners or admins can ${pause ? 'pause' : 'resume'} a project.` })
    if (project.archivedAt) return sendJson(409, { error: 'This project is archived. Unarchive it first.' })
    const { getDb } = await import('./lib/db')
    const sql = getDb()
    if (pause) {
      const updated = await projSetPaused(projectId, true)
      const running = await sql<Array<{ runId: string }>>`SELECT run_id AS "runId" FROM pipeline_runs WHERE (project_namespace = ${project.slug} OR project_id = ${projectId}) AND status = 'running'`
      for (const { runId } of running) await sql`SELECT pg_notify('run_pause', ${runId})`
      const [held] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM project_jobs WHERE project_id = ${projectId} AND status = 'queued'`
      serverLog.info('project paused', { slug: project.slug, by: auth?.user.email ?? 'local', pausingRuns: running.length, heldJobs: held?.n ?? 0 })
      return sendJson(200, { ...updated, pausingRuns: running.length, heldJobs: held?.n ?? 0 })
    }
    const updated = await projSetPaused(projectId, false)
    const { requeueRunFromStage } = await import('./lib/run-store')
    const pausedRuns = await sql<Array<{ runId: string; currentStage: StageName | null }>>`
      SELECT run_id AS "runId", current_stage AS "currentStage" FROM pipeline_runs
      WHERE (project_namespace = ${project.slug} OR project_id = ${projectId}) AND status = 'paused' AND pause_kind = 'user'
    `
    for (const { runId, currentStage } of pausedRuns) {
      await requeueRunFromStage(runId, currentStage, 'Resumed by a user.')
      await enqueueJob({ projectId, kind: 'pipeline_run', triggerSource: 'user', payload: { runId, ...(currentStage ? { fromStage: currentStage } : {}) }, runId })
    }
    // Held jobs need no re-insert; wake the dispatchers so they claim them now.
    await sql`SELECT pg_notify('project_job', ${projectId})`
    serverLog.info('project resumed', { slug: project.slug, by: auth?.user.email ?? 'local', resumedRuns: pausedRuns.length })
    return sendJson(200, { ...updated, resumedRuns: pausedRuns.length })
  }

  // Archive (reversible): hidden from the board, no new runs or jobs, everything kept.
  if (method === 'POST' && /^\/api\/projects\/[0-9a-f-]{36}\/(archive|unarchive)$/.test(url.pathname)) {
    const projectId = url.pathname.split('/')[3]!
    const archive = url.pathname.endsWith('/archive')
    const project = await projGet(projectId)
    if (!project) return sendJson(404, { error: 'Project not found.' })
    if (auth && project.teamId && !roleAtLeast(teamRole(project.teamId) ?? 'viewer', 'admin')) return sendJson(403, { error: `Only team owners or admins can ${archive ? 'archive' : 'unarchive'} a project.` })
    // Archiving stops the project: anything queued, running or paused is cancelled first.
    const cancelled = archive ? await cancelProjectWork(project, 'Cancelled: project archived') : { jobsCancelled: 0, runsCancelled: 0, runIds: [] }
    const updated = await projSetArchived(projectId, archive)
    serverLog.info(archive ? 'project archived' : 'project unarchived', { slug: project.slug, by: auth?.user.email ?? 'local', ...cancelled })
    return sendJson(200, { ...updated, cancelled })
  }

  // Delete a project and everything it owns. Permanent, so it takes friction:
  // the project must be archived, the caller an owner/admin of its team, no
  // work in progress, and the body must carry "delete <slug>".
  if (method === 'DELETE' && /^\/api\/projects\/[0-9a-f-]{36}$/.test(url.pathname)) {
    const projectId = url.pathname.split('/').pop()!
    const project = await projGet(projectId)
    if (!project) return sendJson(404, { error: 'Project not found.' })
    if (auth && project.teamId && !roleAtLeast(teamRole(project.teamId) ?? 'viewer', 'admin')) return sendJson(403, { error: 'Only team owners or admins can delete a project.' })
    const body = await readJson<{ confirm?: string }>(req)
    if (!project.archivedAt) return sendJson(409, { error: new ProjectNotArchivedError().message, code: 'not_archived' })
    if ((body.confirm ?? '').trim().toLowerCase().replace(/\s+/g, ' ') !== confirmPhraseFor(project)) return sendJson(400, { error: `Type "${confirmPhraseFor(project)}" to confirm.` })
    try {
      const report = await deleteProjectCompletely(project, body.confirm!)
      serverLog.info('project deleted', { slug: project.slug, by: auth?.user.email ?? 'local', runs: report.runsDeleted, removed: report.removedPaths.length })
      return sendJson(200, report)
    } catch (error) {
      if (error instanceof ProjectBusyError) return sendJson(409, { error: `This project is still active: ${error.activity.reasons.join('; ')}. Finish or cancel that work first.`, activity: error.activity })
      if (error instanceof ProjectNotArchivedError) return sendJson(409, { error: error.message, code: 'not_archived' })
      return sendJson(500, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  if (method === 'POST' && /^\/api\/projects\/[0-9a-f-]{36}\/repos$/.test(url.pathname)) {
    const projectId = url.pathname.split('/')[3]!
    const project = await projGet(projectId)
    if (!project) return sendJson(404, { error: 'Project not found.' })
    const denied = requireProjectRole(project, 'member', 'Only team members can add repositories.'); if (denied) return denied
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

  // Discovery proposed a repository that does not exist yet: create it through
  // the connected GitHub account, register it and clone it. When the token may
  // not create repositories, answer 403 with a prefilled GitHub link instead.
  if (method === 'POST' && /^\/api\/projects\/[0-9a-f-]{36}\/repos\/create$/.test(url.pathname)) {
    const projectId = url.pathname.split('/')[3]!
    const project = await projGet(projectId)
    if (!project) return sendJson(404, { error: 'Project not found.' })
    if (auth && project.teamId && !roleAtLeast(teamRole(project.teamId) ?? 'viewer', 'member')) return sendJson(403, { error: 'Only team members can add repositories.' })
    const body = await readJson<{ name?: string; owner?: string; description?: string; visibility?: 'private' | 'public' }>(req)
    const name = sanitizeRepoName(body.name ?? '')
    if (!name) return sendJson(400, { error: 'A repository name is required (letters, digits, "-", "_" and ".").' })
    const manualUrl = newRepoUrl({ name, owner: body.owner?.trim() || undefined, description: body.description ?? project.description ?? '', visibility: body.visibility === 'public' ? 'public' : 'private' })
    try {
      const created = await createGitHubRepository(await orgIdForProject(projectId), { name, owner: body.owner, description: body.description ?? project.description, private: body.visibility !== 'public' })
      const existing = await import('./lib/project-registry').then((m) => m.listRepos(projectId))
      const isPrimary = !existing.some((r) => r.label !== 'governance')
      const repo = await projAddRepo({ projectId, label: created.name, kind: 'github', githubRepo: created.fullName, isPrimary })
      void scheduleRepoClone(repo).then(() => refreshRepositoryKnowledge(projectId, repo.repoId)).catch(() => undefined)
      serverLog.info('repository created from discovery proposal', { slug: project.slug, repo: created.fullName, by: auth?.user.email ?? 'local' })
      return sendJson(201, { repo, fullName: created.fullName, htmlUrl: created.htmlUrl })
    } catch (error) {
      if (error instanceof GitHubNotConnectedError) return sendJson(409, { error: 'Connect GitHub under Organization → Integrations first, or create the repository by hand and attach it.', code: 'github_not_connected', manualUrl })
      if (error instanceof GitHubPermissionError) return sendJson(403, { error: error.message, code: 'insufficient_permissions', manualUrl })
      return sendJson(500, { error: error instanceof Error ? error.message : String(error), manualUrl })
    }
  }

  // Re-learn one repository (inventory + brief) and recompose project memory.
  if (method === 'POST' && /^\/api\/projects\/[0-9a-f-]{36}\/repos\/[0-9a-f-]{36}\/learn$/.test(url.pathname)) {
    const projectId = url.pathname.split('/')[3]!
    const repoId = url.pathname.split('/')[5]!
    const repo = await projGetRepo(repoId)
    if (!repo) return sendJson(404, { error: 'Repo not found.' })
    if (repo.projectId !== projectId) return sendJson(404, { error: 'Repo not found in this project.' })
    const project = await projGet(projectId)
    const denied = requireProjectRole(project, 'member', 'Only team members can learn repositories.'); if (denied) return denied
    if (!repo.localPath) return sendJson(409, { error: 'Repository has no local checkout yet; clone it first.' })
    void refreshRepositoryKnowledge(projectId, repoId).catch(() => undefined)
    return sendJson(202, { ok: true, repoId, status: 'learning' })
  }

  // Edit a registered repo (label, path, owner/name, primary). Changing the
  // GitHub owner/name re-queues a clone.
  if (method === 'PATCH' && /^\/api\/projects\/[0-9a-f-]{36}\/repos\/[0-9a-f-]{36}$/.test(url.pathname)) {
    const projectId = url.pathname.split('/')[3]!
    const repoId = url.pathname.split('/')[5]!
    const existing = await projGetRepo(repoId)
    if (!existing) return sendJson(404, { error: 'Repo not found.' })
    if (existing.projectId !== projectId) return sendJson(404, { error: 'Repo not found in this project.' })
    const project = await projGet(projectId)
    const denied = requireProjectRole(project, 'member', 'Only team members can edit repositories.'); if (denied) return denied
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
    const projectId = url.pathname.split('/')[3]!
    const repoId = url.pathname.split('/')[5]!
    const repo = await projGetRepo(repoId)
    if (!repo) return sendJson(404, { error: 'Repo not found.' })
    if (repo.projectId !== projectId) return sendJson(404, { error: 'Repo not found in this project.' })
    const project = await projGet(projectId)
    const denied = requireProjectRole(project, 'member', 'Only team members can clone repositories.'); if (denied) return denied
    if (repo.kind !== 'github' || !repo.githubRepo) return sendJson(400, { error: 'Only GitHub repos can be cloned.' })
    void scheduleRepoClone(repo).then(() => refreshRepositoryKnowledge(repo.projectId, repo.repoId)).catch(() => undefined)
    const refreshed = await projGetRepo(repoId)
    return sendJson(202, refreshed ?? repo)
  }

  // ---- Workers (shared or per-project via src/supervisor.ts) ----

  if (method === 'GET' && url.pathname === '/api/workers') {
    const workers = await listLiveWorkers()
    if (!auth) return sendJson(200, { workers })
    // A per-project worker names the project it serves, so only that project's
    // team sees it; shared workers belong to no tenant.
    const mine = new Set((await Promise.all(auth.teams.map((t) => projList(t.teamId)))).flat().map((p) => p.projectId))
    return sendJson(200, { workers: workers.filter((w) => !w.projectId || mine.has(w.projectId)) })
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
    return sendJson(200, { sources: await listConnectedKnowledgeSources(await orgIdOf()) })
  }

  // Per-project knowledge scope: which integrations/repos this project's agents may query.
  if (method === 'GET' && /^\/api\/projects\/[0-9a-f-]{36}\/knowledge$/.test(url.pathname)) {
    const projectId = url.pathname.split('/')[3]!
    const project = await projGet(projectId)
    if (!project) return sendJson(404, { error: 'Project not found.' })
    const { resolveKnowledgeScope } = await import('./lib/integration-sources')
    const projectOrg = await orgIdForProject(projectId)
    const scope = await resolveKnowledgeScope(projectOrg, projectId)
    const connected = await listConnectedKnowledgeSources(projectOrg)
    const repos = (await import('./lib/project-registry').then((m) => m.listRepos(projectId)))
      .map((r) => r.githubRepo).filter((r): r is string => Boolean(r))
    return sendJson(200, { config: project.knowledgeJson ?? {}, effective: scope, connected, registeredRepos: repos })
  }

  if (method === 'PUT' && /^\/api\/projects\/[0-9a-f-]{36}\/knowledge$/.test(url.pathname)) {
    const projectId = url.pathname.split('/')[3]!
    const project = await projGet(projectId)
    if (!project) return sendJson(404, { error: 'Project not found.' })
    const denied = requireProjectRole(project, 'member', 'Only team members can update project knowledge scope.'); if (denied) return denied
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
      return sendJson(200, { hits: await searchKnowledge(await orgIdOf(), { source, query, limit, repos }) })
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
      return sendJson(200, await getKnowledgeItem(await orgIdOf(), { source, id, repos }))
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
    const denied = requireProjectRole(project, 'member', 'Only team members can import project sources.'); if (denied) return denied
    const body = await readJson<{ source?: KnowledgeSource; id?: string; scope?: string }>(req)
    if (!body.source || !body.id?.trim()) return sendJson(400, { error: 'source and id are required.' })
    const repos = (await import('./lib/project-registry').then((m) => m.listRepos(projectId)))
      .map((r) => r.githubRepo).filter((r): r is string => Boolean(r))
    try {
      const doc = await getKnowledgeItem(await orgIdForProject(projectId), { source: body.source, id: body.id.trim(), repos })
      await saveKnowledgeSnapshot(projectId, doc, body.scope)
      return sendJson(201, doc)
    } catch (error) {
      if (error instanceof KnowledgeSourceNotConnectedError) return sendJson(409, { error: error.message })
      return sendJson(502, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  // Repositories and work areas suggested for a project (after onboarding / after plan).
  if (method === 'GET' && /^\/api\/projects\/[0-9a-f-]{36}\/suggestions$/.test(url.pathname)) {
    const projectId = url.pathname.split('/')[3]!
    const project = await projGet(projectId)
    if (!project) return sendJson(404, { error: 'Project not found.' })
    return sendJson(200, { suggestions: project.suggestionsJson ?? null })
  }

  if (method === 'POST' && /^\/api\/projects\/[0-9a-f-]{36}\/suggestions$/.test(url.pathname)) {
    const projectId = url.pathname.split('/')[3]!
    const project = await projGet(projectId)
    if (!project) return sendJson(404, { error: 'Project not found.' })
    const denied = requireProjectRole(project, 'member', 'Only team members can generate project suggestions.'); if (denied) return denied
    const body = await readJson<{ basis?: 'project' | 'plan'; feature?: string; model?: string }>(req).catch(() => ({} as { basis?: 'project' | 'plan'; feature?: string; model?: string }))
    try {
      const suggestions = await suggestRepositoriesAndWorkAreas(projectId, { basis: body.basis ?? 'project', feature: body.feature, model: body.model })
      if (!suggestions) return sendJson(409, { error: 'Nothing to base suggestions on yet: connect GitHub so the repository catalog syncs, or add a description/plan.' })
      return sendJson(200, { suggestions })
    } catch (error) {
      return sendJson(502, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  // Synced GitHub repository catalog (name, language, topics, README use case).
  if (method === 'GET' && url.pathname === '/api/github/catalog') {
    return sendJson(200, { repositories: await listRepoCatalog(await orgIdOf(), Number(url.searchParams.get('limit') ?? '200')) })
  }

  if (method === 'POST' && url.pathname === '/api/github/catalog/sync') {
    try {
      return sendJson(200, await syncGitHubRepoCatalog(await orgIdOf()))
    } catch (error) {
      if (error instanceof GitHubNotConnectedError) return sendJson(409, { error: error.message })
      return sendJson(502, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  // Export the project's durable state (memory, knowledge, manifest) into its
  // governing workspace and commit (the workspace's git history is the archive).
  if (method === 'POST' && /^\/api\/projects\/[0-9a-f-]{36}\/export$/.test(url.pathname)) {
    const projectId = url.pathname.split('/')[3]!
    const project = await projGet(projectId)
    if (!project) return sendJson(404, { error: 'Project not found.' })
    const denied = requireProjectRole(project, 'member', 'Only team members can export project state.'); if (denied) return denied
    if (governanceEnabled()) await ensureGovernanceWorkspace(project).catch(() => undefined)
    const result = await exportProjectState(projectId, 'manual export')
    if (!result) return sendJson(409, { error: 'Project has no governing workspace.' })
    return sendJson(200, result)
  }

  // Repos visible to the connected GitHub account — powers the wizard autocomplete.
  if (method === 'GET' && url.pathname === '/api/github/repos') {
    try {
      const repos = await listGitHubRepos(await orgIdOf())
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
    if (!existing) return sendJson(404, { error: 'Repo not found.' })
    if (existing.projectId !== projectId) return sendJson(404, { error: 'Repo not found in this project.' })
    const project = await projGet(projectId)
    const denied = requireProjectRole(project, 'member', 'Only team members can remove repositories.'); if (denied) return denied
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
    const denied = requireProjectRole(project, 'member', 'Only team members can manage project integrations.'); if (denied) return denied
    const body = await readJson<{ kind?: IntegrationKind; displayName?: string; config?: Record<string, unknown> }>(req)
    if (!body.kind) return sendJson(400, { error: 'kind is required' })
    const integration = await projUpsertIntegration({ projectId, kind: body.kind, displayName: body.displayName, config: body.config })
    return sendJson(201, integration)
  }

  if (method === 'DELETE' && /^\/api\/projects\/[0-9a-f-]{36}\/integrations\/[0-9a-f-]{36}$/.test(url.pathname)) {
    const projectId = url.pathname.split('/')[3]!
    const integrationId = url.pathname.split('/').pop()!
    const project = await projGet(projectId)
    if (!project) return sendJson(404, { error: 'Project not found.' })
    const denied = requireProjectRole(project, 'member', 'Only team members can manage project integrations.'); if (denied) return denied
    const integration = await projGetIntegration(integrationId)
    if (!integration || integration.projectId !== projectId) return sendJson(404, { error: 'Integration not found in this project.' })
    await projRemoveIntegration(integrationId)
    return sendJson(204, {})
  }

  /** A project named in a query parameter is only honoured for its own team's members. */
  const visibleProjectNamespace = async (slug: string | null): Promise<string | undefined> => {
    if (!slug) return undefined
    if (!auth) return slug
    const project = await import('./lib/project-registry').then((m) => m.getProjectBySlug(slug))
    if (!project?.teamId || !auth.teams.some((t) => t.teamId === project.teamId)) return undefined
    return slug
  }

  if (method === 'GET' && url.pathname === '/api/pipelines') {
    const projectNamespace = await visibleProjectNamespace(url.searchParams.get('project'))
    return sendJson(200, await listTemplates(projectNamespace))
  }

  if (method === 'GET' && /^\/api\/pipelines\/[^/]+$/.test(url.pathname)) {
    const name = url.pathname.split('/').filter(Boolean)[2]!
    const projectNamespace = await visibleProjectNamespace(url.searchParams.get('project'))
    try {
      const { template, source, path } = await getTemplate(name, projectNamespace)
      return sendJson(200, { template, source, path, plan: PipelineEngine.describePlan(template) })
    } catch (error) {
      return sendJson(404, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  if (method === 'GET' && url.pathname === '/api/board') {
    const board = await buildBoard()
    // Archived projects leave the board unless ?archived=1 asks for them (marked as such).
    const projects = auth && !auth.activeTeam ? [] : await projList(auth?.activeTeam?.teamId)
    const archivedBySlug = new Map(projects.filter((p) => p.archivedAt).map((p) => [p.slug, p.archivedAt!]))
    const pausedBySlug = new Map(projects.filter((p) => p.pausedAt).map((p) => [p.slug, p.pausedAt!]))
    const codeBySlug = new Map(projects.filter((p) => p.code).map((p) => [p.slug, p.code!]))
    const showArchived = url.searchParams.get('archived') === '1'
    const slugs = auth ? new Set(projects.map((p) => p.slug)) : undefined
    const columns = board.columns.map((c) => ({
      ...c,
      cards: c.cards
        .filter((card) => (!slugs || slugs.has(card.projectNamespace)) && (showArchived || !archivedBySlug.has(card.projectNamespace)))
        .map((card) => ({
          ...card,
          ...(codeBySlug.has(card.projectNamespace) ? { code: codeBySlug.get(card.projectNamespace) } : {}),
          ...(archivedBySlug.has(card.projectNamespace) ? { archivedAt: archivedBySlug.get(card.projectNamespace) } : {}),
          ...(pausedBySlug.has(card.projectNamespace) ? { pausedAt: pausedBySlug.get(card.projectNamespace) } : {}),
        })),
    }))
    const visibleArchived = [...archivedBySlug.keys()].filter((slug) => !slugs || slugs.has(slug)).length
    return sendJson(200, { ...board, columns, archivedCount: visibleArchived })
  }

  if (method === 'GET' && url.pathname === '/api/org/promotions') {
    return sendJson(200, await listPromotionProposals(await orgIdOf()))
  }

  if (method === 'POST' && /^\/api\/org\/promotions\/[^/]+\/decision$/.test(url.pathname)) {
    const parts = url.pathname.split('/').filter(Boolean)
    const proposalId = parts[3]
    const body = await readJson<{ decision: 'approved' | 'rejected'; notes?: string }>(req)
    const denied = requireOrgAdmin('Only team owners or admins can decide promotions.'); if (denied) return denied
    return sendJson(200, await decidePromotionProposal({ orgId: await orgIdOf(), proposalId, decision: body.decision, notes: body.notes }))
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

  // Tokens and cost: per project (totals, by stage, by model, by run) and organization-wide.
  if (method === 'GET' && /^\/api\/projects\/[^/]+\/usage$/.test(url.pathname)) {
    const [, , , projectNamespace] = url.pathname.split('/')
    return sendJson(200, await summarizeProjectUsage(projectNamespace))
  }
  if (method === 'GET' && url.pathname === '/api/org/usage') {
    const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days') ?? '30') || 30))
    const usageOrg = await orgIdOf()
    return sendJson(200, { days, ...(await summarizeOrgUsage(usageOrg, days)), actor: await describeGitHubActor(usageOrg).catch(() => null) })
  }

  if (method === 'GET' && /^\/api\/projects\/[^/]+\/qa$/.test(url.pathname)) {
    const [, , , projectNamespace] = url.pathname.split('/')
    const projectMeta = await readProjectMeta(projectNamespace)
    if (!projectMeta) {
      return sendJson(404, { error: 'Project namespace not found.' })
    }
    return sendJson(200, await buildQAOverview(projectNamespace, projectMeta.path))
  }

  /**
   * Accept a feature whose verification came back partial (or failed) and
   * finish it. The decision belongs to a person, so it is recorded with their
   * name, the verification status at the time and their reason, and the board
   * treats the feature as done from then on. Merging and deploying stay with
   * the ordinary deliver step, which the response points at.
   */
  if (method === 'POST' && /^\/api\/projects\/[^/]+\/accept$/.test(url.pathname)) {
    const [, , , projectNamespace] = url.pathname.split('/')
    const project = await import('./lib/project-registry').then((m) => m.getProjectBySlug(projectNamespace))
    if (!project) return sendJson(404, { error: 'Project not found.' })
    const denied = requireProjectRole(project, 'member', 'Only team members can accept a feature.'); if (denied) return denied
    const projectMeta = await readProjectMeta(projectNamespace)
    if (!projectMeta) return sendJson(404, { error: 'Project namespace not found.' })

    const body = await readJson<{ note?: string }>(req)
    const artifacts = await collectProjectArtifacts(projectNamespace, projectMeta.path)
    if (artifacts.verificationStatus === 'missing') {
      return sendJson(409, {
        error: 'There is nothing to accept yet: this feature has no verification report. Run verify first.',
        code: 'not_verified',
      })
    }
    if (artifacts.verifiedPass) {
      return sendJson(409, { error: 'Verification already passed, so there is nothing to accept. The feature is releasing: review, then deliver.', code: 'already_passed' })
    }

    const recorded = await recordAcceptance({
      projectPath: projectMeta.path,
      verificationStatus: artifacts.verificationStatus,
      acceptedBy: auth?.user.name || auth?.user.email || 'local user',
      note: body.note,
    })
    if (!recorded) return sendJson(409, { error: 'This project has no feature directory to accept.' })
    serverLog.info('feature accepted despite verification', { project: projectNamespace, status: artifacts.verificationStatus, by: recorded.acceptance.acceptedBy })

    // The caller runs the final step itself through the ordinary execute-step
    // route, so merging and deploying keep their own guards and approvals.
    return sendJson(200, {
      acceptance: recorded.acceptance,
      nextStep: nextStepFor(await collectProjectArtifacts(projectNamespace, projectMeta.path)),
    })
  }

  /** Undo an acceptance: the feature goes back to whatever its verification says. */
  if (method === 'DELETE' && /^\/api\/projects\/[^/]+\/accept$/.test(url.pathname)) {
    const [, , , projectNamespace] = url.pathname.split('/')
    const project = await import('./lib/project-registry').then((m) => m.getProjectBySlug(projectNamespace))
    if (!project) return sendJson(404, { error: 'Project not found.' })
    const denied = requireProjectRole(project, 'member', 'Only team members can withdraw an acceptance.'); if (denied) return denied
    const projectMeta = await readProjectMeta(projectNamespace)
    if (!projectMeta) return sendJson(404, { error: 'Project namespace not found.' })
    const withdrawn = await withdrawAcceptance(projectMeta.path)
    return sendJson(200, { withdrawn })
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
    const result = await runAIDLCSpecificTask({ cwd: projectMeta.path, orgId: await orgIdForProjectSlug(projectNamespace), taskId, sharedContextPrompt: contextBundle.promptBundle })
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
      orgId: await orgIdForProjectSlug(projectNamespace),
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
      orgId: await orgIdForProjectSlug(projectNamespace),
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
        orgId: await orgIdForProjectSlug(projectNamespace),
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

  // ---- OAuth app credentials (organization-level, required before connecting) ----

  if (method === 'GET' && url.pathname === '/api/oauth-apps') {
    const denied = requireOrgAdmin('Only team owners or admins can view app credentials.'); if (denied) return denied
    return sendJson(200, await listOAuthApps(await orgIdOf(), origin))
  }

  // GitHub App, created for the user through the manifest flow: this page
  // posts the manifest to GitHub, the user confirms there, GitHub redirects to
  // the manifest callback with a one-hour code that we convert into the app's
  // credentials. Installing the app then lands on /installed, which starts
  // the ordinary authorize flow to obtain the user token.
  if (method === 'GET' && url.pathname === '/api/oauth-apps/github/manifest') {
    const denied = requireOrgAdmin('Only team owners or admins can create the GitHub App.'); if (denied) return denied
    const organization = url.searchParams.get('org')?.trim() || undefined
    if (organization && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(organization)) return sendJson(400, { error: 'That is not a valid GitHub organization name.' })
    const { html } = githubAppManifestPage(origin, { organization, orgId: await orgIdOf() })
    return sendHtml(200, html)
  }
  if (method === 'GET' && url.pathname === '/api/oauth-apps/github/manifest/callback') {
    const back = (query: string) => new Response(null, { status: 302, headers: { location: `/organization?section=integrations&${query}` } })
    const code = url.searchParams.get('code')
    const manifestState = consumeManifestState(url.searchParams.get('state'))
    if (!code || !manifestState) return back(`error=${encodeURIComponent('The GitHub App setup link expired or was already used. Start again from Integrations.')}`)
    try {
      const app = await convertGitHubAppManifest(code)
      await saveGitHubAppFromManifest(manifestState.orgId, app, auth?.user.userId ?? null)
      forgetGitHubAppState(manifestState.orgId)
      serverLog.info('github app created from manifest', { slug: app.slug, owner: app.owner?.login, by: auth?.user.email ?? 'local' })
      return back('setup=github')
    } catch (error) {
      serverLog.warn('github app manifest conversion failed', { error: error instanceof Error ? error.message : String(error) })
      return back(`error=${encodeURIComponent(error instanceof Error ? error.message : String(error))}`)
    }
  }
  if (method === 'GET' && url.pathname === '/api/oauth-apps/github/installed') {
    const installationId = Number(url.searchParams.get('installation_id'))
    if (Number.isFinite(installationId) && installationId > 0) await recordGitHubInstallation(await orgIdOf(), installationId).catch(() => undefined)
    const returnTo = '/organization?section=integrations&connected=github'
    if (!(await resolveProvider(await orgIdOf(), 'github'))) return new Response(null, { status: 302, headers: { location: returnTo.replace('connected=github', `error=${encodeURIComponent('GitHub has no app credentials in Spaces; create the GitHub App first.')}`) } })
    return new Response(null, { status: 302, headers: { location: `/api/oauth/github/authorize?return=${encodeURIComponent(returnTo)}` } })
  }
  if ((method === 'PUT' || method === 'DELETE') && /^\/api\/oauth-apps\/[a-z]+$/.test(url.pathname)) {
    const provider = url.pathname.split('/').pop()!
    if (!isOAuthProviderId(provider)) return sendJson(404, { error: `Unknown provider "${provider}".` })
    const denied = requireOrgAdmin('Only team owners or admins can manage app credentials.'); if (denied) return denied
    if (method === 'DELETE') {
      await deleteOAuthApp(await orgIdOf(), provider)
      if (provider === 'github') forgetGitHubAppState(await orgIdOf())
      serverLog.info('oauth app credentials removed', { provider, by: auth?.user.email ?? 'local' })
      return sendJson(200, { ok: true, apps: await listOAuthApps(await orgIdOf(), origin) })
    }
    const body = await readJson<{ clientId?: string; clientSecret?: string }>(req)
    try {
      await saveOAuthApp(await orgIdOf(), provider, { clientId: body.clientId ?? '', clientSecret: body.clientSecret, updatedBy: auth?.user.userId ?? null })
      if (provider === 'github') forgetGitHubAppState(await orgIdOf())
    } catch (error) {
      return sendJson(400, { error: error instanceof Error ? error.message : String(error) })
    }
    serverLog.info('oauth app credentials saved', { provider, by: auth?.user.email ?? 'local' })
    return sendJson(200, { ok: true, apps: await listOAuthApps(await orgIdOf(), origin) })
  }

  // ---- App-level integrations ----

  if (method === 'GET' && url.pathname === '/api/integrations') {
    const denied = requireOrgAdmin('Only team owners or admins can view app integrations.'); if (denied) return denied
    return sendJson(200, await listAppIntegrations(await orgIdOf()))
  }

  if (method === 'DELETE' && /^\/api\/integrations\/[a-z]+$/.test(url.pathname)) {
    const denied = requireOrgAdmin('Only team owners or admins can disconnect app integrations.'); if (denied) return denied
    const kind = url.pathname.split('/').pop() as AppIntegrationKind
    await disconnectAppIntegration(await orgIdOf(), kind)
    return sendJson(200, { ok: true })
  }

  // ---- OAuth authorize + callback (app-level, no projectId) ----

  if (method === 'GET' && /^\/api\/oauth\/[^/]+\/authorize$/.test(url.pathname)) {
    const provider = url.pathname.split('/')[3]!
    // mode=login (GitHub only) signs a user in instead of storing an app-level token.
    const loginMode = provider === 'github' && url.searchParams.get('mode') === 'login'
    // Signing in uses the deployment's own GitHub app and never an organization's
    // integration credentials; connecting an integration always uses the caller's own.
    const cfg = loginMode ? resolveGitHubLoginProvider() : await resolveProvider(await orgIdOf(), provider)
    const authorizeOrg = loginMode ? undefined : await orgIdOf()
    if (!cfg) {
      const message = loginMode
        ? 'Signing in with GitHub is not set up for this site. Sign in with your email and password instead.'
        : `Provider "${provider}" has no app credentials yet. Set it up under Organization → Integrations.`
      return loginMode
        ? sendHtml(409, `<!doctype html><html><body style="font-family:system-ui;padding:40px;text-align:center"><h1>GitHub sign-in unavailable</h1><p>${message}</p><p><a href="/">Back to sign in</a></p></body></html>`)
        : sendJson(400, { error: message })
    }
    // A GitHub App deleted on GitHub would send the browser to a GitHub 404; say so instead.
    if (authorizeOrg && provider === 'github' && (await githubAppAlive(authorizeOrg).catch(() => undefined)) === false) {
      return sendJson(409, { error: 'This GitHub App no longer exists on GitHub. Create it again under Organization → Integrations.', code: 'github_app_missing' })
    }
    const callbackUrl = `${origin}/api/oauth/${provider}/callback`
    // projectId is legacy: keep it optional in state so old links don't 500.
    if (!loginMode) {
      const denied = requireOrgAdmin('Only team owners or admins can connect organization integrations.'); if (denied) return denied
    }
    const projectIdOrEmpty = loginMode ? `__login__:${url.searchParams.get('invite') ?? ''}` : (url.searchParams.get('projectId') ?? '')
    // Optional same-tab flows (GitHub App install) come back to a page in the app instead of a "close this window" notice.
    const wantedReturn = url.searchParams.get('return') ?? ''
    const returnTo = wantedReturn.startsWith('/') && !wantedReturn.startsWith('//') ? wantedReturn : undefined
    const { redirectUrl } = beginAuthorization(cfg, projectIdOrEmpty, callbackUrl, returnTo, authorizeOrg)
    return new Response(null, { status: 302, headers: { location: redirectUrl } })
  }

  if (method === 'GET' && /^\/api\/oauth\/[^/]+\/callback$/.test(url.pathname)) {
    const provider = url.pathname.split('/')[3]!
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    if (!code || !state) return sendJson(400, { error: 'Missing code or state.' })
    const pending = consumeState(state)
    if (!pending || pending.provider !== provider) return sendJson(400, { error: 'Invalid or expired OAuth state.' })
    // A sign-in comes back to the deployment's own app; an integration comes back
    // to the organization pinned in the state, so its token lands with that tenant.
    const signingIn = provider === 'github' && pending.projectId.startsWith('__login__')
    const callbackOrg = pending.orgId ?? (await getDefaultOrgId())
    const cfg = signingIn ? resolveGitHubLoginProvider() : await resolveProvider(callbackOrg, provider)
    if (!cfg) return sendJson(400, { error: signingIn ? 'Signing in with GitHub is not set up for this site.' : `Provider "${provider}" no longer has app credentials.` })

    const callbackUrl = `${origin}/api/oauth/${provider}/callback`
    try {
      const tokens = await exchangeCode(cfg, code, callbackUrl)

      // GitHub sign-in: find or create the user from the GitHub identity and
      // start a session (the token is used once, never stored as an integration).
      if (provider === 'github' && pending.projectId.startsWith('__login__')) {
        const inviteToken = pending.projectId.slice('__login__:'.length) || undefined
        const ghHeaders = { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'pi-speckit-pdlc' }
        const ghUser = (await (await fetch('https://api.github.com/user', { headers: ghHeaders })).json()) as { login: string; name?: string | null; email?: string | null; avatar_url?: string }
        let email = ghUser.email ?? undefined
        if (!email) {
          const emails = (await (await fetch('https://api.github.com/user/emails', { headers: ghHeaders })).json().catch(() => [])) as Array<{ email: string; primary: boolean; verified: boolean }>
          email = emails.find((e) => e.primary && e.verified)?.email ?? emails.find((e) => e.verified)?.email
        }
        if (!ghUser.login) return sendJson(502, { error: 'GitHub did not return a user.' })
        let user = await getUserByGitHubLogin(ghUser.login) ?? (email ? await getUserByEmail(email) : undefined)
        const first = (await countUsers()) === 0
        const invite = inviteToken ? await getInviteByToken(inviteToken) : undefined
        if (!user) {
          if (!first && !invite && process.env.OPEN_REGISTRATION !== '1') {
            return sendHtml(403, `<!doctype html><html><body style="font-family:system-ui;padding:40px;text-align:center"><h1>Invitation required</h1><p>No account exists for GitHub user <b>${ghUser.login}</b>. Ask a team owner or admin for an invite link, then sign in from it.</p></body></html>`)
          }
          if (!email) return sendHtml(400, `<!doctype html><html><body style="font-family:system-ui;padding:40px;text-align:center"><h1>No verified email</h1><p>Your GitHub account has no verified email we can use. Add one on GitHub and try again.</p></body></html>`)
          user = await createUser({ email, name: ghUser.name?.trim() || ghUser.login, githubLogin: ghUser.login, avatarUrl: ghUser.avatar_url })
        } else if (!user.githubLogin) {
          await linkGitHub(user.userId, ghUser.login, ghUser.avatar_url)
        }
        let teamId: string | undefined
        if (invite) { try { teamId = (await acceptInvite(inviteToken!, user)).teamId } catch { /* shown on the invite page later */ } }
        else if ((await listTeamsForUser(user.userId)).length === 0) teamId = (await bootstrapOrganization(user, { adoptLegacy: first })).team.teamId
        const { token: session } = await createSession(user.userId, req, teamId)
        return new Response(null, { status: 302, headers: { location: '/', 'set-cookie': sessionCookie(session, req) } })
      }

      // Atlassian OAuth grants access to both Jira and Confluence — record both slots.
      const kinds: AppIntegrationKind[] = provider === 'atlassian' ? ['jira', 'confluence'] : [provider as AppIntegrationKind]
      // expires_at lets token lookups refresh before expiry (GitHub App user tokens, Atlassian).
      const credentials = withExpiry(tokens as unknown as Record<string, unknown>)
      for (const kind of kinds) {
        await upsertAppIntegration({ orgId: callbackOrg, kind, status: 'connected', credentials })
      }
      // GitHub connected → index every visible repository (name, language,
      // topics, README use case) so plans can name repos without upfront selection.
      if (provider === 'github') {
        void syncGitHubRepoCatalog(callbackOrg).catch((error) => serverLog.warn('GitHub catalog sync failed', { error: error instanceof Error ? error.message : String(error) }))
      }
      if (pending.returnTo) return new Response(null, { status: 302, headers: { location: pending.returnTo } })
      return sendHtml(200, `<!doctype html><html><body style="font-family:system-ui;padding:40px;text-align:center"><h1>✅ ${provider} connected</h1><p>App-level integration stored. You can close this window and return to the app.</p><p><a href="/organization?section=integrations">Back to Spaces</a></p><script>window.close()</script></body></html>`)
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
      // A verified, accepted or delivered feature is finished work: running specify
      // again starts the next feature in a new numbered directory, so it is never a duplicate.
      const startsNextFeature = body.step === 'specify'
        && (projectArtifacts.verifiedPass || Boolean(projectArtifacts.accepted) || projectArtifacts.deliveryStatus === 'merged')
      if (alreadyDone[body.step] && !startsNextFeature) {
        return sendJson(409, {
          error: `${body.step} already produced its artifact for this project.`,
          hint: `Call again with {"force": true} to re-run anyway.`,
          currentState: alreadyDone,
        })
      }
    }

    // Guard 2: don't stack on top of in-flight work for this project. The
    // refusal names what is in the way — a run that is executing, one queued
    // behind a busy worker, or one waiting for a human — because "1 job queued
    // or running" tells nobody what to do about it.
    const sql = getDb()
    const inflight = await sql<Array<{ jobId: string; status: string; kind: string; createdAt: string; claimedBy: string | null; runId: string | null; runStatus: string | null; runStage: string | null; pauseKind: string | null }>>`
      SELECT j.job_id AS "jobId", j.status, j.kind, j.created_at AS "createdAt", j.claimed_by AS "claimedBy",
             j.run_id AS "runId", r.status AS "runStatus", r.current_stage AS "runStage", r.pause_kind AS "pauseKind"
        FROM project_jobs j
        LEFT JOIN pipeline_runs r ON r.run_id = j.run_id
       WHERE j.project_id = ${project.projectId} AND j.status IN ('queued','claimed','running')
       ORDER BY j.created_at ASC
    `
    if (inflight.length > 0 && !body.force) {
      const blocking = inflight[0]!
      const waitingMinutes = Math.round((Date.now() - Date.parse(blocking.createdAt)) / 60_000)
      const age = waitingMinutes >= 1 ? ` for ${waitingMinutes} minute${waitingMinutes === 1 ? '' : 's'}` : ''
      const error = blocking.runStatus === 'paused' && blocking.pauseKind && blocking.pauseKind !== 'user'
        ? `This project's run is waiting for you on ${blocking.runStage ?? 'a stage'}. Answer or approve it, then run ${body.step}.`
        : blocking.status === 'queued'
          ? `A ${blocking.kind.replace('_', ' ')} has been queued${age} and is waiting for a free worker. It starts on its own; ${body.step} can run once it finishes.`
          : `A ${blocking.kind.replace('_', ' ')} is running${blocking.runStage ? ` (stage ${blocking.runStage})` : ''}${age}. Wait for it to finish, or cancel the run first.`
      return sendJson(409, {
        error,
        code: 'project_busy',
        inFlight: inflight.map((job) => ({ jobId: job.jobId, kind: job.kind, status: job.status, runId: job.runId, runStatus: job.runStatus, stage: job.runStage, pauseKind: job.pauseKind, since: job.createdAt })),
        hint: 'Cancel the run from the project page to clear it, or send {"force": true} to queue this step behind it.',
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
    // one-off Run <step> clicks stay on the model the project has been using;
    // otherwise the deployment default (DEFAULT_MODEL / first configured provider).
    const latest = await dbGetLatestRunForProject(project.slug)
    const inheritedModel = latest?.optionsJson?.model
    const model = inheritedModel && inheritedModel.trim() ? inheritedModel.trim() : await defaultModel(await orgIdForProject(project.projectId))

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
        repoTargets: (await subagentRepoTargets(project.slug)).targets,
        projectMemory: contextBundle.project.memory,
        sharedContextPrompt: contextBundle.promptBundle,
        persistSession: true,
        nonInteractive: false,
        verbose: false,
        // "force" is how the caller says they meant it: it is also what allows
        // specify to open a new feature while the last one is unfinished.
        ...(body.force ? { allowNewFeature: true } : {}),
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
    const denied = await requireRunAccess(row, 'viewer', 'You cannot view this run.'); if (denied) return denied

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
    // A run is started through its project, so the project's team decides who may start it.
    const deniedRun = requireProjectRole(project, 'member', 'Only team members can start runs on this project.'); if (deniedRun) return deniedRun
    if (auth && !project.teamId) return sendJson(403, { error: 'This project belongs to a team you are not a member of.' })

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
    if (project.archivedAt) return sendJson(409, { error: 'This project is archived. Unarchive it before starting a run.' })
    // Model resolution: prefer explicit body.model → inherit from latest run →
    // the deployment default. Never leave it to Pi's global default provider.
    const latest = await dbGetLatestRunForProject(project.slug)
    const inheritedModel = latest?.optionsJson?.model
    const resolvedModel = body.model?.trim() || (inheritedModel?.trim() ? inheritedModel.trim() : await defaultModel(await orgIdForProject(project.projectId)))
    const baseOptions = toFlowOptions(body)
    const options: FlowOptions = {
      ...baseOptions,
      cwd,
      model: resolvedModel,
      projectId: project.projectId,
      // GitHub-hosted repo → implement/orchestrate/verify publish the feature branch as a PR.
      ...(repo.githubRepo ? { pullRequests: { githubRepo: repo.githubRepo } } : {}),
      // All checkouts (primary + secondary) so code stages set up every repo for development.
      repoTargets: (await subagentRepoTargets(projectNamespace)).targets,
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

    const deniedAnswer = await requireRunAccess(row, 'member', 'Only team members can answer or approve runs.'); if (deniedAnswer) return deniedAnswer
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
      const approval = parseApprovalAnswer(answer)
      const approved = row.pauseKind === 'review' && approval.approved
      const nextIdx = approved ? currentIdx + 1 : Math.max(0, currentIdx)
      if (approved && approval.note) await appendReviewerNote(runId, row.currentStage ?? null, approval.note)
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

  // Run controls from the agent output dock: pause at the next stage boundary
  // (or before start), resume a user pause, or cancel outright.
  if (method === 'POST' && /^\/api\/runs\/[^/]+\/(pause|resume|cancel)$/.test(url.pathname)) {
    const parts = url.pathname.split('/')
    const runId = parts[3]!
    const action = parts[4] as 'pause' | 'resume' | 'cancel'
    const row = await dbGetRun(runId)
    if (!row) return sendJson(404, { error: 'Run not found.' })
    const deniedControl = await requireRunAccess(row, 'member', 'Only team members can control runs.'); if (deniedControl) return deniedControl
    const { getDb } = await import('./lib/db')
    const sql = getDb()
    const by = auth?.user.email ?? 'local'
    if (action === 'pause') {
      if (row.status === 'running') {
        // The worker finishes the current stage, then records the run as paused (kind 'user').
        await sql`SELECT pg_notify('run_pause', ${runId})`
        await dbAppendEvent({ runId, kind: 'pause_requested', payload: { by, note: 'Pausing at the next stage boundary.' } })
      } else if (row.status === 'queued') {
        await sql`UPDATE project_jobs SET status = 'cancelled', ended_at = now(), error_message = 'Paused by a user before start' WHERE run_id = ${runId} AND status IN ('queued', 'claimed')`
        const firstStage = (row.templateJson?.steps ?? [])[0]?.stage as StageName | undefined
        await dbUpdateRunStatus(runId, { status: 'paused', pauseKind: 'user', currentStage: (row.currentStage as StageName | null) ?? firstStage ?? null, errorMessage: null })
        await dbAppendEvent({ runId, kind: 'paused', payload: { pauseKind: 'user', by, stage: row.currentStage ?? firstStage } })
      } else {
        return sendJson(409, { error: `Only a queued or running run can be paused (this one is ${row.status}).` })
      }
    } else if (action === 'resume') {
      if (row.status !== 'paused' || row.pauseKind !== 'user') return sendJson(409, { error: 'Only a run paused by a user can be resumed here; answer or approve other pauses instead.' })
      const requeued = await requeueRun(row, (row.currentStage as StageName | null) ?? undefined, 'Resumed by a user.', 'user')
      if (!requeued.ok) return sendJson(409, { error: requeued.error })
      await dbAppendEvent({ runId, kind: 'resumed', payload: { by, fromStage: row.currentStage } })
    } else {
      if (!['queued', 'running', 'paused'].includes(row.status)) return sendJson(409, { error: `This run already finished (${row.status}).` })
      await sql.begin(async (tx) => {
        await tx`UPDATE project_jobs SET status = 'cancelled', ended_at = now(), error_message = 'Cancelled by a user' WHERE run_id = ${runId} AND status IN ('queued', 'claimed', 'running')`
        await tx`UPDATE pipeline_runs SET status = 'cancelled', error_message = 'Cancelled by a user', pause_kind = NULL, owning_worker_id = NULL, updated_at = now() WHERE run_id = ${runId}`
        await tx`UPDATE pipeline_gates SET status = 'resolved', response = 'cancelled', resolved_at = now() WHERE run_id = ${runId} AND status = 'open'`
        await tx`INSERT INTO pipeline_events (run_id, kind, payload) VALUES (${runId}, 'cancelled', ${tx.json({ by, reason: 'Cancelled by a user' } as never)})`
      })
      await sql`SELECT pg_notify('run_cancel', ${runId})`
    }
    serverLog.info(`run ${action}`, { runId, by })
    const refreshed = await dbGetRun(runId)
    return sendJson(200, await snapshotFromRow(refreshed ?? row))
  }

  // Rerun a failed, interrupted, or completed run — from the stage where it stopped
  // (default) or from an explicit stage. Reuses the same run row so the timeline
  // stays continuous; retry_count records the attempt.
  if (method === 'POST' && /^\/api\/runs\/[^/]+\/rerun$/.test(url.pathname)) {
    const runId = url.pathname.split('/')[3]!
    const row = await dbGetRun(runId)
    if (!row) return sendJson(404, { error: 'Run not found.' })
    const deniedRerun = await requireRunAccess(row, 'member', 'Only team members can rerun runs.'); if (deniedRerun) return deniedRerun
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
            const actionOrg = await orgIdForProject(projectId)
            const base = await gitDefaultBranch(actionOrg, repo.localPath, repo.githubRepo)
            if (branch === base) return result(`Failed: the checkout is on the default branch (${base}); create or check out a feature branch first.`, { error: true })
            const ref = await publishBranchAsPullRequest({
              orgId: actionOrg,
              cwd: repo.localPath,
              githubRepo: repo.githubRepo,
              branch,
              base,
              // Conventional Commits, scoped to the branch; a user-supplied title is normalised too.
              scope: branch,
              commitMessage: p.title ?? conventional('feat', branch, p.summary?.split('\n')[0] ?? `changes on ${branch}`),
              title: p.title ?? conventional('feat', branch, p.summary?.split('\n')[0] ?? `changes on ${branch}`),
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

/**
 * Task counts for a run's feature, cached briefly: every event on a busy run
 * rebuilds the snapshot, and the implement stage ticks tasks off slowly.
 */
const taskProgressCache = new Map<string, { at: number; value: RunSnapshot['tasks'] }>()
async function runTaskProgress(row: RunRow): Promise<RunSnapshot['tasks']> {
  if (!row.projectPath) return undefined
  const cached = taskProgressCache.get(row.projectPath)
  if (cached && Date.now() - cached.at < 3_000) return cached.value
  const progress = await readTaskProgress(row.projectPath).catch(() => undefined)
  const value = progress ? { done: progress.done, total: progress.total, remaining: progress.remaining.length } : undefined
  taskProgressCache.set(row.projectPath, { at: Date.now(), value })
  return value
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
    usage: await summarizeRunUsage(row.runId),
    tasks: await runTaskProgress(row),
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
  const usageByProject = await summarizeUsageByProject()

  for (const project of history.projects) {
    // A run in flight always speaks for the project. Otherwise the most recently
    // started one does — not the most recently *touched*, which let a reaper
    // bumping an old failed run paint a healthy project red.
    const projectRuns = history.runs.filter((run) => run.projectNamespace === project.namespace)
    const active = projectRuns.filter((run) => run.status === 'running' || run.status === 'paused').sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const latestRun = active[0] ?? [...projectRuns].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
    const artifacts = await collectProjectArtifacts(project.namespace, project.path)

    // The lane follows what the project has produced, not the state of a run
    // process: a finished run records no current stage, so keying on that left a
    // project that had implemented and verified sitting in "Tasked".
    const tasks = await readTaskProgress(project.path).catch(() => undefined)
    const hasLaterArtifact = artifacts.links.some((link) =>
      ['Orchestrate', 'Verify', 'Review', 'Deliver'].includes(link.stepLabel))
    const status = laneForProject({
      initialized: artifacts.initialized,
      specified: artifacts.specified,
      planned: artifacts.planned,
      tasked: artifacts.tasked,
      verificationStatus: artifacts.verifiedPass ? 'pass' : artifacts.verificationStatus,
      accepted: Boolean(artifacts.accepted),
      deliveryStatus: artifacts.deliveryStatus,
      implementationArtifacts: hasLaterArtifact,
      tasksDone: tasks?.done ?? 0,
      activeStage: latestRun && ['running', 'paused'].includes(latestRun.status) ? latestRun.stage ?? null : null,
    })

    cards.push({
      projectNamespace: project.namespace,
      projectLabel: project.label,
      projectPath: project.path,
      status,
      verificationStatus: artifacts.verifiedPass ? 'pass' : artifacts.verificationStatus,
      accepted: artifacts.accepted,
      estimate: latestRun?.status === 'completed' ? 'complete' : 'in-progress',
      currentAgent: latestRun?.stage ?? (latestRun?.status === 'running' ? 'running' : ''),
      gateReadiness: [],
      automationState: {
        state: latestRun?.status === 'paused' ? 'needs_approval' : latestRun?.status === 'running' ? 'running' : 'idle',
        message: latestRun?.status ?? 'no runs yet',
        updatedAt: latestRun?.updatedAt ?? project.lastUpdated,
      },
      // The next step the project can take, from its artifacts; nothing while a
      // run is in flight (the agent bar owns that moment).
      recommendedAction: latestRun && (latestRun.status === 'running' || latestRun.status === 'paused') ? undefined : nextStepFor(artifacts),
      updatedAt: latestRun?.updatedAt ?? project.lastUpdated,
      feature: latestRun?.feature,
      latestRun,
      artifactLinks: artifacts.links,
      artifactDiffs: artifacts.diffs,
      usage: usageByProject.get(project.namespace) ?? EMPTY_USAGE,
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

/** Highest-milestone rule: the first stage whose artifact is missing is the next step. */
function nextStepFor(artifacts: ProjectArtifacts): BoardCard['recommendedAction'] {
  const has = (stepLabel: string) => artifacts.links.some((l) => l.stepLabel === stepLabel)
  if (!artifacts.initialized) return { step: 'init', label: 'Run init', tab: 'specs', reason: 'No Spec Kit workspace yet (.specify/).' }
  if (!artifacts.specified) return { step: 'specify', label: 'Run specify', tab: 'specs', reason: 'No spec.md yet. Research runs first when the template has it.' }
  if (!artifacts.planned) return { step: 'plan', label: 'Run plan', tab: 'specs', reason: 'Spec exists but no plan.md.' }
  if (!artifacts.tasked) return { step: 'tasks', label: 'Run tasks', tab: 'tracker', reason: 'Plan exists but no tasks.md.' }
  if (!has('Test Plan')) return { step: 'testplan', label: 'Run testplan', tab: 'testplan', reason: 'Tasks exist but no test-plan.md.' }
  if (!has('Parallelize')) return { step: 'parallelize', label: 'Run parallelize', tab: 'implementation', reason: 'No parallel-workstreams.md yet.' }
  if (artifacts.verificationStatus === 'missing') return { step: 'implement', label: 'Run implement', tab: 'implementation', reason: 'Ready to code — no verification report yet.' }
  if (artifacts.verifiedPass || artifacts.accepted) return releaseStepFor(artifacts)
  // Close enough that another verify run would land in the same place: suggest
  // the person accepts it. Accepting stays their decision and records why.
  if (acceptanceRecommended(artifacts.verificationStatus, artifacts.verificationSummary)) {
    return { step: 'accept', label: 'Accept and finish', tab: 'qa', reason: `Verification ${artifacts.verificationStatus}: ${describeSummary(artifacts.verificationSummary!)}. Accept it as it stands, or run verify again.` }
  }
  return { step: 'verify', label: 'Run verify', tab: 'qa', reason: `Verification status: ${artifacts.verificationStatus}.` }
}

/**
 * Releasing a verified (or accepted) feature: code review, then delivery —
 * merge, deploy and UAT — as separate steps. Done once delivery reports MERGED.
 */
function releaseStepFor(artifacts: ProjectArtifacts): BoardCard['recommendedAction'] {
  const basis = artifacts.verifiedPass
    ? 'Verified'
    : `Accepted by ${artifacts.accepted!.acceptedBy} at ${artifacts.accepted!.verificationStatus} verification`
  if (artifacts.deliveryStatus === 'merged') {
    return { step: 'specify', label: 'Start a new feature', tab: 'specs', reason: 'Delivered and merged. The next specify run starts a new feature.' }
  }
  if (artifacts.codeReviewStatus === 'changes_requested') {
    return { step: 'implement', label: 'Run implement', tab: 'implementation', reason: 'The code review requested changes; implement the findings, then review again.' }
  }
  if (artifacts.codeReviewStatus !== 'approved') {
    return { step: 'review', label: 'Run review', tab: 'qa', reason: `${basis}. Code review comes next, before merging and deploying.` }
  }
  if (artifacts.deliveryStatus) {
    return { step: 'deliver', label: 'Run deliver', tab: 'qa', reason: `Delivery is ${artifacts.deliveryStatus}: re-check the pull requests, then merge and deploy.` }
  }
  return { step: 'deliver', label: 'Run deliver', tab: 'qa', reason: 'Review approved. Merge, deploy and run UAT.' }
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
    accepted: await readAcceptance(projectRoot).catch(() => undefined) as Acceptance | undefined,
    verificationSummary: undefined as VerificationSummary | undefined,
    codeReviewStatus: undefined as 'approved' | 'changes_requested' | undefined,
    deliveryStatus: undefined as 'merged' | 'partial' | 'blocked' | undefined,
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
    const reportPath = join(projectRoot, `${latestFeature.relativePath}/verification-report.md`)
    flags.verificationStatus = await getVerificationStatus(reportPath)
    flags.verifiedPass = flags.verificationStatus === 'pass'
    flags.verificationSummary = summarizeVerification(await readTextIfExists(reportPath))
  }
  // Releasing: the code review and the delivery each leave a report with a status line.
  if (await pushArtifactIfExists(links, projectNamespace, projectRoot, `${latestFeature.relativePath}/code-review.md`, 'Review', `${featurePrefix} code review`)) {
    const review = /Code Review Status:\s*\**\s*(APPROVED|CHANGES[_ ]REQUESTED)/i.exec(await readTextIfExists(join(projectRoot, `${latestFeature.relativePath}/code-review.md`)))?.[1]
    flags.codeReviewStatus = review ? (/^approved$/i.test(review) ? 'approved' : 'changes_requested') : undefined
  }
  if (await pushArtifactIfExists(links, projectNamespace, projectRoot, `${latestFeature.relativePath}/delivery-report.md`, 'Deliver', `${featurePrefix} delivery report`)) {
    const delivery = /Delivery Status:\s*\**\s*(MERGED|PARTIAL|BLOCKED)/i.exec(await readTextIfExists(join(projectRoot, `${latestFeature.relativePath}/delivery-report.md`)))?.[1]
    flags.deliveryStatus = delivery ? (delivery.toLowerCase() as 'merged' | 'partial' | 'blocked') : undefined
  }
  await pushArtifactIfExists(links, projectNamespace, projectRoot, `${latestFeature.relativePath}/delivery-status.md`, 'Deliver', `${featurePrefix} delivery status`)
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
 * run → deployment default. Same rule as run creation, so sub-agents never
 * fall through to Pi's global default provider.
 */
async function resolveSubagentModel(projectNamespace: string, requested?: string): Promise<string> {
  if (requested?.trim()) return requested.trim()
  const latest = await dbGetLatestRunForProject(projectNamespace)
  const inherited = latest?.optionsJson?.model
  return inherited?.trim() ? inherited.trim() : await defaultModel(await orgIdForProjectSlug(projectNamespace))
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
    allowNewFeature: body.allowNewFeature === true,
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

const BOARD_COLUMNS = ['backlog', 'initialized', 'specified', 'planned', 'tasked', 'implementing', 'releasing', 'done'] as const
const BOARD_TITLES: Record<BoardStatus, string> = {
  backlog: 'Backlog',
  initialized: 'Initialized',
  specified: 'Specified',
  planned: 'Planned',
  tasked: 'Tasked',
  implementing: 'Implementing',
  releasing: 'Releasing',
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
  status: 'running' | 'paused' | 'completed' | 'error' | 'cancelled'
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
  status: 'running' | 'paused' | 'completed' | 'error' | 'cancelled'
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
  /** Tokens and cost recorded for this run so far. */
  usage?: UsageSummary
  /** Checked-off tasks of the feature being implemented, so progress is visible while it runs. */
  tasks?: { done: number; total: number; remaining: number }
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
  /** Set when a person accepted the feature despite a verification that did not pass. */
  accepted?: Acceptance
  /** Criteria met and critical issues open, as the verification report states them. */
  verificationSummary?: VerificationSummary
  codeReviewStatus?: 'approved' | 'changes_requested'
  /** From delivery-report.md; MERGED is what finishes a feature. */
  deliveryStatus?: 'merged' | 'partial' | 'blocked'
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
  /** A pipeline stage to run, or 'accept' to record that a person accepts the feature as it stands. */
  step: StageName | 'accept'
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
  /** Set when a person accepted the feature although verification did not pass. */
  accepted?: Acceptance
  currentAgent: string
  estimate: string
  gateReadiness: GateReadinessRecord[]
  /** Tokens and cost across every run of the project. */
  usage?: UsageSummary
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
  /** Archived projects the caller could reveal with ?archived=1. */
  archivedCount?: number
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
  /** Start a new feature even though the last one is unfinished (otherwise that one is continued). */
  allowNewFeature?: boolean
}

interface AnswerRunRequest {
  answer?: string
}
