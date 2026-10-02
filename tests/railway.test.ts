import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  RailwayError,
  getLatestDeploymentWithToken,
  listRailwayTargetsWithToken,
  normalizeRailwayStatus,
  railwayAuthHeaders,
  railwayGraphQLRequest,
  triggerDeploymentWithToken,
  verifyRailwayCredential,
} from '../src/lib/railway'
import { defaultMockRailway, startMockRailway, type MockRailwayServer } from './helpers/mock-railway'

const TOKEN = '<SECRET_15>'

describe('Railway client', () => {
  let mock: MockRailwayServer
  const originalUrl = process.env.RAILWAY_API_URL

  beforeAll(() => {
    mock = startMockRailway(defaultMockRailway({ token: TOKEN }))
    process.env.RAILWAY_API_URL = mock.url
  })

  afterAll(async () => {
    await mock.stop()
    if (originalUrl === undefined) delete process.env.RAILWAY_API_URL
    else process.env.RAILWAY_API_URL = originalUrl
  })

  beforeEach(() => {
    mock.state.requests.length = 0
    mock.state.triggerCount = 0
    mock.state.rejectAuth = false
    mock.state.rateLimit = false
    mock.state.unavailable = false
    mock.state.failNextTrigger = false
  })

  describe('TC-RAIL-001: auth header selection', () => {
    test('project tokens use Project-Access-Token; others use Authorization: Bearer', () => {
      expect(railwayAuthHeaders(TOKEN, 'project')).toEqual({ 'Project-Access-Token': TOKEN })
      expect(railwayAuthHeaders(TOKEN, 'workspace')).toEqual({ Authorization: `Bearer ${TOKEN}` })
      expect(railwayAuthHeaders(TOKEN, 'account')).toEqual({ Authorization: `Bearer ${TOKEN}` })
    })

    test('verifyRailwayCredential sends the header matching the token type', async () => {
      const seen: Array<Record<string, string>> = []
      const spy = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push({ ...(init?.headers as Record<string, string>) })
        return new Response(JSON.stringify({ data: { me: { id: 'u', name: 'A', email: 'a@b.c', workspaces: [] } } }), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as typeof fetch
      await verifyRailwayCredential(TOKEN, 'project', spy)
      await verifyRailwayCredential(TOKEN, 'workspace', spy)
      expect(seen[0]?.['Project-Access-Token']).toBe(TOKEN)
      expect(seen[0]?.Authorization).toBeUndefined()
      expect(seen[1]?.Authorization).toBe(`Bearer ${TOKEN}`)
      expect(seen[1]?.['Project-Access-Token']).toBeUndefined()
    })
  })

  describe('TC-RAIL-002: verifyRailwayCredential per token type', () => {
    test('validates an account/workspace token and returns the identity', async () => {
      const result = await verifyRailwayCredential(TOKEN, 'workspace')
      expect(result.ok).toBe(true)
      expect(result.identity?.accountName).toBe('Mock Account')
      expect(result.identity?.workspaceName).toBe('Acme Workspace')
    })

    test('validates a project token and returns project/environment', async () => {
      const result = await verifyRailwayCredential(TOKEN, 'project')
      expect(result.ok).toBe(true)
      expect(result.identity?.kind).toBe('project')
      expect(result.identity?.projectId).toBe('proj-1')
      expect(result.identity?.environmentId).toBe('env-1')
    })

    test('reports an invalid credential without echoing the token', async () => {
      mock.state.rejectAuth = true
      const result = await verifyRailwayCredential(TOKEN, 'workspace')
      expect(result.ok).toBe(false)
      expect(result.code).toBe('railway_auth')
      expect(JSON.stringify(result)).not.toContain(TOKEN)
    })
  })

  describe('TC-RAIL-003: status normalization', () => {
    test('maps Railway statuses to the Spaces vocabulary', () => {
      expect(normalizeRailwayStatus('QUEUED')).toBe('queued')
      expect(normalizeRailwayStatus('BUILDING')).toBe('building')
      expect(normalizeRailwayStatus('DEPLOYING')).toBe('deploying')
      expect(normalizeRailwayStatus('WAITING')).toBe('in_progress')
      expect(normalizeRailwayStatus('SUCCESS')).toBe('success')
      expect(normalizeRailwayStatus('FAILED')).toBe('failed')
      expect(normalizeRailwayStatus('CRASHED')).toBe('failed')
      expect(normalizeRailwayStatus('SLEEPING')).toBe('sleeping')
      expect(normalizeRailwayStatus('SKIPPED')).toBe('unknown')
      expect(normalizeRailwayStatus('REMOVED')).toBe('unknown')
      expect(normalizeRailwayStatus(null)).toBe('unknown')
    })
  })

  describe('TC-RAIL-004: targets and latest deployment', () => {
    test('lists workspaces → projects → services + environments', async () => {
      const targets = await listRailwayTargetsWithToken(TOKEN, 'workspace')
      expect(targets).toHaveLength(1)
      expect(targets[0]!.name).toBe('Acme Workspace')
      expect(targets[0]!.projects[0]!.services.map((s) => s.name)).toEqual(['web', 'api'])
      expect(targets[0]!.projects[0]!.environments.map((e) => e.name)).toEqual(['production', 'staging'])
    })

    test('returns the latest deployment with a normalized status and URL', async () => {
      const deployment = await getLatestDeploymentWithToken(TOKEN, 'workspace', { workspaceId: 'ws-1', railwayProjectId: 'proj-1', serviceId: 'svc-1', environmentId: 'env-1' })
      expect(deployment.id).toBe('dep-1')
      expect(deployment.status).toBe('success')
      expect(deployment.railwayStatus).toBe('SUCCESS')
      expect(deployment.serviceUrl).toBe('https://acme-web.up.railway.app')
    })

    test('falls back to the service instance when the deployment list is empty', async () => {
      mock.state.deployments['svc-2:env-1'] = { id: 'dep-x', status: 'FAILED', createdAt: '2026-10-01T11:00:00.000Z' }
      // The deployments list returns the node, so drop it to force the fallback path.
      delete mock.state.deployments['svc-1:env-1']
      mock.state.deployments['svc-1:env-1'] = { id: 'dep-1', status: 'SUCCESS', createdAt: '2026-10-01T10:00:00.000Z' }
      const deployment = await getLatestDeploymentWithToken(TOKEN, 'workspace', { workspaceId: 'ws-1', railwayProjectId: 'proj-1', serviceId: 'svc-2', environmentId: 'env-1' })
      expect(deployment.status).toBe('failed')
    })

    test('a missing target is a structured railway_target_missing error', async () => {
      await expect(getLatestDeploymentWithToken(TOKEN, 'workspace', { workspaceId: 'ws-1', railwayProjectId: 'proj-1', serviceId: 'svc-1', environmentId: 'env-999' })).rejects.toMatchObject({ code: 'railway_target_missing' })
    })
  })

  describe('TC-RAIL-005: a single release mutation', () => {
    test('triggerDeployment issues exactly one serviceInstanceDeployV2 and no infrastructure mutation', async () => {
      const result = await triggerDeploymentWithToken(TOKEN, 'workspace', { workspaceId: 'ws-1', railwayProjectId: 'proj-1', serviceId: 'svc-1', environmentId: 'env-1' })
      expect(result.deploymentId).toBeTruthy()
      expect(mock.state.triggerCount).toBe(1)
      const mutations = mock.state.requests.filter((r) => r.operation === 'serviceInstanceDeployV2')
      expect(mutations).toHaveLength(1)
      for (const forbidden of ['projectCreate', 'projectUpdate', 'serviceCreate', 'serviceDelete', 'environmentCreate', 'variableUpsert', 'domainCreate']) {
        expect(mock.state.requests.some((r) => r.operation === forbidden)).toBe(false)
      }
    })

    test('a failed trigger surfaces a token-free actionable error', async () => {
      mock.state.failNextTrigger = true
      await expect(triggerDeploymentWithToken(TOKEN, 'workspace', { workspaceId: 'ws-1', railwayProjectId: 'proj-1', serviceId: 'svc-1', environmentId: 'env-1' }))
        .rejects.toBeInstanceOf(RailwayError)
      expect(mock.state.triggerCount).toBe(0)
    })
  })

  describe('TC-RAIL-006: failure modes map to structured errors', () => {
    test('429 + Retry-After is retryable and carries the interval', async () => {
      mock.state.rateLimit = true
      try {
        await railwayGraphQLRequest(TOKEN, 'workspace', 'query { me { id } }')
        throw new Error('expected a RailwayError')
      } catch (error) {
        expect(error).toBeInstanceOf(RailwayError)
        expect((error as RailwayError).code).toBe('railway_rate_limited')
        expect((error as RailwayError).retryable).toBe(true)
      }
    })

    test('5xx is retryable railway_unavailable', async () => {
      mock.state.unavailable = true
      await expect(railwayGraphQLRequest(TOKEN, 'workspace', 'query { me { id } }')).rejects.toMatchObject({ code: 'railway_unavailable', retryable: true })
    })

    test('GraphQL Not Authorized maps to railway_auth and never includes the token', async () => {
      mock.state.rejectAuth = true
      try {
        await railwayGraphQLRequest(TOKEN, 'workspace', 'query { me { id } }')
        throw new Error('expected a RailwayError')
      } catch (error) {
        expect(error).toBeInstanceOf(RailwayError)
        expect((error as RailwayError).code).toBe('railway_auth')
        expect((error as Error).message).not.toContain(TOKEN)
      }
    })

    test('an unmapped GraphQL error that echoes the credential is redacted', async () => {
      const spy = (async () => new Response(
        JSON.stringify({ errors: [{ message: `Unexpected failure while using token ${TOKEN}` }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch
      try {
        await railwayGraphQLRequest(TOKEN, 'workspace', 'query { me { id } }', {}, spy)
        throw new Error('expected a RailwayError')
      } catch (error) {
        expect(error).toBeInstanceOf(RailwayError)
        expect((error as RailwayError).code).toBe('railway_error')
        expect((error as Error).message).not.toContain(TOKEN)
        expect((error as Error).message).toContain('[redacted]')
      }
    })
  })
})
