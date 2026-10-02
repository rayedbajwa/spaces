/**
 * A local Railway GraphQL mock (010-railway-deployment).
 *
 * Implements exactly the documented operations the Spaces client uses, so
 * connect/link/status/release can be exercised without a Railway account.
 * Credentials and error conditions are configurable per test.
 */

export interface MockRailwayService { id: string; name: string }
export interface MockRailwayEnvironment { id: string; name: string }
export interface MockRailwayProject {
  id: string
  name: string
  services: MockRailwayService[]
  environments: MockRailwayEnvironment[]
}
export interface MockRailwayWorkspace { id: string; name: string; projects: MockRailwayProject[] }

export interface MockRailwayDeployment {
  id: string
  status: string
  createdAt: string
  staticUrl?: string
  url?: string
}

export interface MockRailwayState {
  token: string
  tokenType: 'account' | 'workspace' | 'project'
  accountName: string
  accountEmail: string
  workspaces: MockRailwayWorkspace[]
  /** Workspaces keyed by the credential token; falls back to `workspaces` when unset. */
  workspacesByToken?: Record<string, MockRailwayWorkspace[]>
  /** Latest deployment keyed by `serviceId:environmentId`. */
  deployments: Record<string, MockRailwayDeployment>
  /** Number of serviceInstanceDeployV2 mutations received. */
  triggerCount: number
  /** Requests received, for asserting auth headers and operation coverage. */
  requests: Array<{ operation: string; headers: Record<string, string> }>
  /** Force every request to answer with a GraphQL "Not Authorized" error. */
  rejectAuth?: boolean
  /** Force the next trigger mutation to answer with a failure. */
  failNextTrigger?: boolean
  /** Answer every request with HTTP 429 instead of GraphQL. */
  rateLimit?: boolean
  /** Answer every request with HTTP 503 instead of GraphQL. */
  unavailable?: boolean
  /** Answer the OAuth token endpoint with a 400 instead of an access token. */
  oauthTokenError?: boolean
}

export function defaultMockRailway(overrides: Partial<MockRailwayState> = {}): MockRailwayState {
  return {
    token: 'mock-railway-workspace-token',
    tokenType: 'workspace',
    accountName: 'Mock Account',
    accountEmail: 'mock@example.test',
    workspaces: [
      {
        id: 'ws-1',
        name: 'Acme Workspace',
        projects: [
          {
            id: 'proj-1',
            name: 'Acme App',
            services: [{ id: 'svc-1', name: 'web' }, { id: 'svc-2', name: 'api' }],
            environments: [{ id: 'env-1', name: 'production' }, { id: 'env-2', name: 'staging' }],
          },
        ],
      },
    ],
    deployments: {
      'svc-1:env-1': { id: 'dep-1', status: 'SUCCESS', createdAt: '2026-10-01T10:00:00.000Z', staticUrl: 'https://acme-web.up.railway.app' },
    },
    triggerCount: 0,
    requests: [],
    ...overrides,
  }
}

function operationOf(query: string): string {
  if (query.includes('serviceInstanceDeployV2')) return 'serviceInstanceDeployV2'
  if (query.includes('projectToken')) return 'projectToken'
  if (query.includes('deployments(')) return 'deployments'
  if (query.includes('serviceInstance(')) return 'serviceInstance'
  if (query.includes('projects(workspaceId')) return 'projects'
  if (query.includes('project(id')) return 'project'
  if (query.includes('me {')) return 'me'
  return 'unknown'
}

function graphql(body: unknown): Record<string, unknown> {
  const request = body as { query?: string; variables?: Record<string, unknown> }
  const state = requestState!
  const query = request.query ?? ''
  const operation = operationOf(query)
  state.requests.push({ operation, headers: currentHeaders })

  if (state.rateLimit) return { __http: 429 }
  if (state.unavailable) return { __http: 503 }
  if (state.rejectAuth) return { errors: [{ message: 'Not Authorized' }] }

  const variables = request.variables ?? {}
  const authToken = (currentHeaders.authorization?.replace(/^Bearer\s+/i, '') || currentHeaders['project-access-token'] || '')
  const workspaces = state.workspacesByToken?.[authToken] ?? state.workspaces
  switch (operation) {
    case 'me': {
      const list = workspaces.map((w) => ({ id: w.id, name: w.name }))
      return { data: { me: { id: 'user-1', name: state.accountName, email: state.accountEmail, workspaces: list } } }
    }
    case 'projects': {
      const workspace = workspaces.find((w) => w.id === variables.workspaceId) ?? workspaces[0]
      return { data: { projects: { edges: (workspace?.projects ?? []).map((p) => ({ node: { id: p.id, name: p.name } })) } } }
    }
    case 'project': {
      const id = variables.id
      for (const w of workspaces) {
        const project = w.projects.find((p) => p.id === id)
        if (project) {
          return {
            data: {
              project: {
                id: project.id,
                name: project.name,
                services: { edges: project.services.map((s) => ({ node: { id: s.id, name: s.name } })) },
                environments: { edges: project.environments.map((e) => ({ node: { id: e.id, name: e.name } })) },
              },
            },
          }
        }
      }
      return { data: { project: null } }
    }
    case 'projectToken': {
      const project = workspaces.flatMap((w) => w.projects)[0]
      return { data: { projectToken: { projectId: project?.id ?? 'proj-1', environmentId: project?.environments[0]?.id ?? 'env-1' } } }
    }
    case 'deployments': {
      const input = variables.input as { serviceId?: string; environmentId?: string } | undefined
      const key = `${input?.serviceId}:${input?.environmentId}`
      const deployment = state.deployments[key]
      return { data: { deployments: { edges: deployment ? [{ node: deployment }] : [] } } }
    }
    case 'serviceInstance': {
      const key = `${variables.serviceId}:${variables.environmentId}`
      const deployment = state.deployments[key]
      return { data: { serviceInstance: deployment ? { latestDeployment: deployment } : null } }
    }
    case 'serviceInstanceDeployV2': {
      const key = `${variables.serviceId}:${variables.environmentId}`
      if (state.failNextTrigger) {
        state.failNextTrigger = false
        return { errors: [{ message: 'Deployment failed to start' }] }
      }
      state.triggerCount += 1
      const id = `dep-${state.triggerCount + 1}`
      state.deployments[key] = { id, status: 'BUILDING', createdAt: new Date().toISOString(), staticUrl: 'https://acme-web.up.railway.app' }
      return { data: { serviceInstanceDeployV2: id } }
    }
    default:
      return { errors: [{ message: `Unsupported mock operation: ${query.slice(0, 60)}` }] }
  }
}

let requestState: MockRailwayState | undefined
let currentHeaders: Record<string, string> = {}

export interface MockRailwayServer {
  url: string
  state: MockRailwayState
  stop: () => Promise<void>
}

/** Start the mock on its own port. `RAILWAY_API_URL` is NOT set globally; tests pass it where needed. */
export function startMockRailway(state: MockRailwayState = defaultMockRailway()): MockRailwayServer {
  requestState = state
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      currentHeaders = Object.fromEntries(request.headers.entries())
      const url = new URL(request.url)
      // The OAuth token endpoint shares the mock's origin so the callback flow
      // can be exercised with `OAUTH_RAILWAY_TOKEN_URL` pointed at it.
      if (url.pathname.endsWith('/oauth/token')) {
        if (state.oauthTokenError) {
          return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400, headers: { 'content-type': 'application/json' } })
        }
        return new Response(JSON.stringify({ access_token: state.token, token_type: 'bearer', refresh_token: 'mock-refresh-token', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (!url.pathname.endsWith('/graphql/v2')) return new Response('not found', { status: 404 })
      const body = await request.json().catch(() => ({}))
      const result = graphql(body) as Record<string, unknown>
      if (result.__http) {
        const status = result.__http as number
        return new Response(JSON.stringify({ errors: [{ message: `HTTP ${status}` }] }), { status, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/graphql/v2`,
    state,
    stop: () => new Promise<void>((resolve) => server.stop(true).then(() => resolve())),
  }
}

export type { MockRailwayState as MockRailwayStateType }
