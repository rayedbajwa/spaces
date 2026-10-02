/**
 * Railway Public GraphQL client (010-railway-deployment).
 *
 * One focused module for the external contract: credential selection, the
 * documented read operations, the single release mutation
 * (`serviceInstanceDeployV2`), GraphQL error inspection and status
 * normalization. It never creates or reconfigures Railway infrastructure, and
 * it never puts a credential into a log line, error message or return value.
 *
 * Railway answers HTTP 200 for authorization denials, so the GraphQL `errors`
 * array is always inspected — a raw HTTP status is not enough.
 */

import { getAppIntegration, IntegrationCredentialsError } from './app-integrations'
import { getIntegrationAccessToken, IntegrationNotConnectedError } from './integration-token'

export const RAILWAY_API_URL = 'https://backboard.railway.com/graphql/v2'

export type RailwayTokenType = 'account' | 'workspace' | 'project'

export type RailwayErrorCode =
  | 'railway_auth'
  | 'railway_forbidden'
  | 'railway_target_missing'
  | 'railway_rate_limited'
  | 'railway_unavailable'
  | 'railway_read_only_credential'
  | 'railway_error'

export class RailwayError extends Error {
  readonly code: RailwayErrorCode
  readonly retryable: boolean
  readonly status?: number
  readonly retryAfterMs?: number
  /** True when the credential itself must be replaced before a retry can work. */
  readonly reconnect: boolean

  constructor(code: RailwayErrorCode, message: string, options: { retryable?: boolean; status?: number; retryAfterMs?: number } = {}) {
    super(message)
    this.name = 'RailwayError'
    this.code = code
    this.retryable = options.retryable ?? false
    this.status = options.status
    this.retryAfterMs = options.retryAfterMs
    this.reconnect = code === 'railway_auth'
  }
}

/** The exact header Railway expects for each credential type. Project tokens use their own header. */
export function railwayAuthHeaders(token: string, tokenType: RailwayTokenType = 'workspace'): Record<string, string> {
  return tokenType === 'project'
    ? { 'Project-Access-Token': token }
    : { Authorization: `Bearer ${token}` }
}

export type NormalizedDeploymentStatus =
  | 'queued'
  | 'building'
  | 'deploying'
  | 'in_progress'
  | 'success'
  | 'failed'
  | 'sleeping'
  | 'unknown'

/** Normalize a raw Railway status to the Spaces vocabulary. Only SUCCESS is a confirmed current state. */
export function normalizeRailwayStatus(raw: string | null | undefined): NormalizedDeploymentStatus {
  switch ((raw ?? '').toUpperCase()) {
    case 'QUEUED': return 'queued'
    case 'BUILDING': return 'building'
    case 'DEPLOYING': return 'deploying'
    case 'WAITING': return 'in_progress'
    case 'SUCCESS': return 'success'
    case 'FAILED':
    case 'CRASHED': return 'failed'
    case 'SLEEPING': return 'sleeping'
    default: return 'unknown'
  }
}

export interface RailwayDeployment {
  id: string | null
  railwayStatus: string | null
  status: NormalizedDeploymentStatus
  createdAt: string | null
  /** Public service URL when Railway reports one. */
  serviceUrl: string | null
  /** Link to the deployment in the Railway dashboard, when derivable. */
  deploymentUrl: string | null
}

export interface RailwayTargetRef {
  workspaceId: string
  railwayProjectId: string
  serviceId: string
  environmentId: string
}

export interface RailwayServiceTarget {
  id: string
  name: string
}

export interface RailwayEnvironmentTarget {
  id: string
  name: string
}

export interface RailwayProjectTarget {
  id: string
  name: string
  services: RailwayServiceTarget[]
  environments: RailwayEnvironmentTarget[]
}

export interface RailwayWorkspaceTargets {
  id: string
  name: string
  projects: RailwayProjectTarget[]
}

export interface RailwayIdentity {
  kind: 'account' | 'workspace' | 'project'
  accountName?: string
  accountEmail?: string
  workspaceId?: string
  workspaceName?: string
  projectId?: string
  environmentId?: string
}

interface GraphQLResponse<T> {
  data?: T
  errors?: Array<{ message?: string; extensions?: { code?: string } }>
}

function apiUrl(): string {
  return process.env.RAILWAY_API_URL?.trim() || RAILWAY_API_URL
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, seconds) * 1000
  const date = Date.parse(header)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined
}

/** Map GraphQL error text to a structured, actionable, token-free error. */
function errorFromGraphQLErrors(errors: Array<{ message?: string; extensions?: { code?: string } }>): RailwayError {
  const first = errors[0]
  const message = (first?.message ?? 'Railway returned an error.').trim()
  const lower = message.toLowerCase()
  if (lower.includes('not authorized') || lower.includes('unauthenticated') || lower.includes('unauthorized')) {
    return new RailwayError('railway_auth', 'Railway rejected the credential. Reconnect Railway under Organization → Integrations.')
  }
  if (lower.includes('forbidden') || lower.includes('permission') || lower.includes('access denied')) {
    return new RailwayError('railway_forbidden', 'This Railway credential cannot view or release the selected target. Use a credential that can see the service and reconnect it.')
  }
  if (lower.includes('not found') || lower.includes('does not exist') || lower.includes('no project') || lower.includes('unknown project')) {
    return new RailwayError('railway_target_missing', 'The Railway project, service or environment was not found. Re-link the deployment target.')
  }
  if (lower.includes('read-only') || lower.includes('read only') || lower.includes('viewer')) {
    return new RailwayError('railway_read_only_credential', 'This Railway credential is viewer-only and cannot trigger a deployment. Reconnect with a workspace or project token that can release.')
  }
  return new RailwayError('railway_error', `Railway error: ${message.slice(0, 200)}`)
}

/**
 * Send one GraphQL request. Exported so tests can point the client at a local
 * mock without a live Railway account.
 */
export async function railwayGraphQLRequest<T>(
  token: string,
  tokenType: RailwayTokenType,
  query: string,
  variables: Record<string, unknown> = {},
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  let response: Response
  try {
    response = await fetchImpl(apiUrl(), {
      method: 'POST',
      headers: {
        ...railwayAuthHeaders(token, tokenType),
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    })
  } catch (error) {
    // Network failure — transient; the run should continue and mark status unknown.
    throw new RailwayError('railway_unavailable', `Railway is unreachable: ${error instanceof Error ? error.message : 'network error'}`.slice(0, 240), { retryable: true })
  }

  if (response.status === 429) {
    throw new RailwayError('railway_rate_limited', 'Railway rate-limited the request. Retry after the indicated interval.', { retryable: true, status: 429, retryAfterMs: parseRetryAfter(response.headers.get('retry-after')) })
  }
  if (response.status === 401) {
    throw new RailwayError('railway_auth', 'Railway rejected the credential. Reconnect Railway under Organization → Integrations.', { status: 401 })
  }
  if (response.status === 403) {
    throw new RailwayError('railway_forbidden', 'This Railway credential is not permitted to access the target.', { status: 403 })
  }
  if (response.status >= 500) {
    throw new RailwayError('railway_unavailable', `Railway returned ${response.status}. Try again shortly.`, { retryable: true, status: response.status })
  }

  let body: GraphQLResponse<T>
  try {
    body = (await response.json()) as GraphQLResponse<T>
  } catch {
    throw new RailwayError('railway_unavailable', `Railway returned an unreadable response (${response.status}).`, { retryable: true, status: response.status })
  }
  if (body.errors?.length) throw errorFromGraphQLErrors(body.errors)
  if (!response.ok) {
    throw new RailwayError('railway_error', `Railway returned ${response.status}.`, { status: response.status })
  }
  return body.data as T
}

/** The organization's Railway credential and its type, or throws a structured error. */
export async function railwayCredentialFor(orgId: string): Promise<{ token: string; tokenType: RailwayTokenType }> {
  const row = await getAppIntegration(orgId, 'railway')
  if (row?.status !== 'connected') throw new IntegrationNotConnectedError('railway')
  const tokenType = (row.configJson?.tokenType as RailwayTokenType | undefined) ?? 'workspace'
  let token: string
  try {
    token = await getIntegrationAccessToken(orgId, 'railway')
  } catch (error) {
    if (error instanceof IntegrationCredentialsError || error instanceof IntegrationNotConnectedError) throw error
    throw new RailwayError('railway_auth', 'The saved Railway credential can no longer be read. Reconnect Railway under Organization → Integrations.')
  }
  return { token, tokenType }
}

/** GraphQL using the organization's sealed Railway credential. */
export async function railwayGraphQL<T>(orgId: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const { token, tokenType } = await railwayCredentialFor(orgId)
  return railwayGraphQLRequest<T>(token, tokenType, query, variables)
}

// ---- identity probes ----

interface MeResult { me: { id: string; name: string | null; email: string | null; workspaces?: Array<{ id: string; name: string }> } | null }
interface ProjectTokenResult { projectToken: { projectId: string; environmentId: string } | null }

export interface RailwayVerification {
  ok: boolean
  identity?: RailwayIdentity
  workspaces?: Array<{ id: string; name: string }>
  targets?: RailwayWorkspaceTargets[]
  error?: string
  code?: RailwayErrorCode
}

/**
 * Validate a credential without saving it. Probes `me`/`me.workspaces` for
 * account, workspace and OAuth credentials, and `projectToken` for a project
 * token. The token never appears in the result.
 */
export async function verifyRailwayCredential(token: string, tokenType: RailwayTokenType = 'workspace', fetchImpl: typeof fetch = fetch): Promise<RailwayVerification> {
  try {
    if (tokenType === 'project') {
      const data = await railwayGraphQLRequest<ProjectTokenResult>(token, 'project', `query { projectToken { projectId environmentId } }`, {}, fetchImpl)
      if (!data.projectToken) return { ok: false, error: 'Railway did not recognize this project token.', code: 'railway_target_missing' }
      return { ok: true, identity: { kind: 'project', projectId: data.projectToken.projectId, environmentId: data.projectToken.environmentId } }
    }
    // Account, workspace and OAuth tokens all identify through `me`; workspaces
    // tell us whether the credential is scoped to one workspace or many.
    const data = await railwayGraphQLRequest<MeResult>(
      token,
      tokenType,
      `query { me { id name email workspaces { id name } } }`,
      {},
      fetchImpl,
    )
    if (!data.me) return { ok: false, error: 'Railway did not return an account for this credential.', code: 'railway_auth' }
    const workspaces = data.me.workspaces ?? []
    const identity: RailwayIdentity = {
      kind: workspaces.length <= 1 && tokenType === 'workspace' ? 'workspace' : 'account',
      accountName: data.me.name ?? undefined,
      accountEmail: data.me.email ?? undefined,
      ...(workspaces[0] ? { workspaceId: workspaces[0].id, workspaceName: workspaces[0].name } : {}),
    }
    return { ok: true, identity, workspaces }
  } catch (error) {
    if (error instanceof RailwayError) return { ok: false, error: error.message, code: error.code }
    if (error instanceof IntegrationNotConnectedError || error instanceof IntegrationCredentialsError) return { ok: false, error: error.message, code: 'railway_auth' }
    return { ok: false, error: error instanceof Error ? error.message : 'Railway verification failed.', code: 'railway_error' }
  }
}

// ---- targets ----

interface WorkspacesResult { me: { workspaces: Array<{ id: string; name: string }> } | null }
interface ProjectsResult { projects: { edges: Array<{ node: { id: string; name: string } }> } }
interface ProjectDetailResult {
  project: {
    id: string
    name: string
    services: { edges: Array<{ node: { id: string; name: string } }> }
    environments: { edges: Array<{ node: { id: string; name: string } }> }
  } | null
}

function nodes<T>(connection: { edges?: Array<{ node: T }> } | T[] | undefined): T[] {
  if (!connection) return []
  if (Array.isArray(connection)) return connection
  return (connection.edges ?? []).map((edge) => edge.node)
}

/** Every service + environment the credential can see, grouped by workspace → project. */
export async function listRailwayTargets(orgId: string): Promise<RailwayWorkspaceTargets[]> {
  const { token, tokenType } = await railwayCredentialFor(orgId)
  return listRailwayTargetsWithToken(token, tokenType)
}

export async function listRailwayTargetsWithToken(token: string, tokenType: RailwayTokenType, fetchImpl: typeof fetch = fetch): Promise<RailwayWorkspaceTargets[]> {
  if (tokenType === 'project') {
    const projectToken = await railwayGraphQLRequest<ProjectTokenResult>(token, 'project', `query { projectToken { projectId environmentId } }`, {}, fetchImpl)
    const projectId = projectToken.projectToken?.projectId
    if (!projectId) throw new RailwayError('railway_target_missing', 'Railway did not return a project for this project token.')
    const detail = await railwayGraphQLRequest<ProjectDetailResult>(token, 'project', `query project($id: String!) { project(id: $id) { id name services { edges { node { id name } } } environments { edges { node { id name } } } } }`, { id: projectId }, fetchImpl)
    if (!detail.project) throw new RailwayError('railway_target_missing', 'Railway did not return the project for this project token.')
    return [{
      id: `project-token:${detail.project.id}`,
      name: detail.project.name,
      projects: [{ id: detail.project.id, name: detail.project.name, services: nodes(detail.project.services), environments: nodes(detail.project.environments) }],
    }]
  }

  const me = await railwayGraphQLRequest<WorkspacesResult>(token, tokenType, `query { me { workspaces { id name } } }`, {}, fetchImpl)
  const workspaces = me.me?.workspaces ?? []
  const out: RailwayWorkspaceTargets[] = []
  for (const workspace of workspaces) {
    const projects = await railwayGraphQLRequest<ProjectsResult>(token, tokenType, `query workspaceProjects($workspaceId: String!) { projects(workspaceId: $workspaceId) { edges { node { id name } } } }`, { workspaceId: workspace.id }, fetchImpl)
    const grouped: RailwayProjectTarget[] = []
    for (const project of nodes(projects.projects)) {
      const detail = await railwayGraphQLRequest<ProjectDetailResult>(token, tokenType, `query project($id: String!) { project(id: $id) { id name services { edges { node { id name } } } environments { edges { node { id name } } } } }`, { id: project.id }, fetchImpl)
      if (!detail.project) continue
      grouped.push({ id: detail.project.id, name: detail.project.name, services: nodes(detail.project.services), environments: nodes(detail.project.environments) })
    }
    out.push({ id: workspace.id, name: workspace.name, projects: grouped })
  }
  return out
}

// ---- deployments ----

interface DeploymentsResult {
  deployments: { edges: Array<{ node: { id: string; status: string; createdAt: string | null; url?: string | null; staticUrl?: string | null } }> }
}
interface ServiceInstanceResult {
  serviceInstance: { latestDeployment: { id: string; status: string; createdAt: string | null; url?: string | null; staticUrl?: string | null } | null } | null
}

function deploymentUrl(projectId: string, serviceId: string): string {
  return `https://railway.com/project/${projectId}/service/${serviceId}`
}

function toDeployment(node: { id: string; status: string; createdAt: string | null; url?: string | null; staticUrl?: string | null } | null | undefined, projectId: string, serviceId: string): RailwayDeployment {
  if (!node) return { id: null, railwayStatus: null, status: 'unknown', createdAt: null, serviceUrl: null, deploymentUrl: null }
  return {
    id: node.id,
    railwayStatus: node.status ?? null,
    status: normalizeRailwayStatus(node.status),
    createdAt: node.createdAt ?? null,
    serviceUrl: node.staticUrl ?? node.url ?? null,
    deploymentUrl: deploymentUrl(projectId, serviceId),
  }
}

/**
 * The latest deployment for a target. `deployments(input, first: 1)` is the
 * authoritative source; the service-instance query is a fallback for projects
 * where the list is empty. A Railway "not found/not authorized" propagates as a
 * structured error so a link can be marked invalid rather than shown stale.
 */
export async function getLatestDeployment(orgId: string, target: RailwayTargetRef): Promise<RailwayDeployment> {
  const { token, tokenType } = await railwayCredentialFor(orgId)
  return getLatestDeploymentWithToken(token, tokenType, target)
}

export async function getLatestDeploymentWithToken(token: string, tokenType: RailwayTokenType, target: RailwayTargetRef, fetchImpl: typeof fetch = fetch): Promise<RailwayDeployment> {
  try {
    const data = await railwayGraphQLRequest<DeploymentsResult>(
      token,
      tokenType,
      `query deployments($input: DeploymentListInput!) { deployments(input: $input, first: 1) { edges { node { id status createdAt url staticUrl } } } }`,
      { input: { projectId: target.railwayProjectId, serviceId: target.serviceId, environmentId: target.environmentId } },
      fetchImpl,
    )
    const node = data.deployments?.edges?.[0]?.node
    if (node) return toDeployment(node, target.railwayProjectId, target.serviceId)
  } catch (error) {
    // A missing target is decisive; everything else falls through to the instance query.
    if (error instanceof RailwayError && error.code === 'railway_target_missing') throw error
    if (error instanceof RailwayError && (error.code === 'railway_auth' || error.code === 'railway_forbidden')) throw error
  }
  const instance = await railwayGraphQLRequest<ServiceInstanceResult>(
    token,
    tokenType,
    `query serviceInstance($serviceId: String!, $environmentId: String!) { serviceInstance(serviceId: $serviceId, environmentId: $environmentId) { latestDeployment { id status createdAt url } } }`,
    { serviceId: target.serviceId, environmentId: target.environmentId },
    fetchImpl,
  )
  if (!instance.serviceInstance) throw new RailwayError('railway_target_missing', 'The Railway service or environment was not found. Re-link the deployment target.')
  return toDeployment(instance.serviceInstance.latestDeployment, target.railwayProjectId, target.serviceId)
}

// ---- release ----

interface DeployV2Result { serviceInstanceDeployV2: string }

/**
 * Trigger exactly one deployment. This is the only mutating Railway operation
 * Spaces exposes; no create/update/delete/variable/domain mutation exists.
 */
export async function triggerDeployment(orgId: string, target: RailwayTargetRef): Promise<{ deploymentId: string | null }> {
  const { token, tokenType } = await railwayCredentialFor(orgId)
  return triggerDeploymentWithToken(token, tokenType, target)
}

export async function triggerDeploymentWithToken(token: string, tokenType: RailwayTokenType, target: RailwayTargetRef, fetchImpl: typeof fetch = fetch): Promise<{ deploymentId: string | null }> {
  const data = await railwayGraphQLRequest<DeployV2Result>(
    token,
    tokenType,
    `mutation serviceInstanceDeployV2($serviceId: String!, $environmentId: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId) }`,
    { serviceId: target.serviceId, environmentId: target.environmentId },
    fetchImpl,
  )
  return { deploymentId: data.serviceInstanceDeployV2 ?? null }
}

/** A stable reference for an active target row. */
export function targetRef(row: { railwayProjectId: string; serviceId: string; environmentId: string; workspaceId: string }): RailwayTargetRef {
  return { workspaceId: row.workspaceId, railwayProjectId: row.railwayProjectId, serviceId: row.serviceId, environmentId: row.environmentId }
}

