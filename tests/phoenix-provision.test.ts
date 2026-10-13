import { describe, expect, test } from 'bun:test'
import { provisionPhoenix } from '../src/lib/phoenix-provision'
import type { GraphQL, RailwayWorkerConfig } from '../src/lib/worker-platform-railway'

const config = {
  token: 't', tokenType: 'workspace', railwayProjectId: 'proj', environmentId: 'env', repo: 'r', branch: 'b',
  webServiceName: 'spaces', postgresServiceName: 'Postgres', size: { vcpus: 2, memoryGb: 4 },
} as RailwayWorkerConfig

/** A Railway API that answers from `state` and records every call. */
function fakeRailway(state: { services: Array<{ id: string; name: string }>; volumes: Array<{ id: string; serviceId: string }>; domains: string[] }) {
  const calls: Array<{ op: string; variables: Record<string, any> }> = []
  const gql: GraphQL = async <T>(query: string, variables: Record<string, unknown> = {}) => {
    const op = /(?:mutation|query)\s+(\w+)/.exec(query)![1]!
    calls.push({ op, variables: variables as Record<string, any> })
    switch (op) {
      case 'project': return { project: { services: { edges: state.services.map((node) => ({ node })) } } } as T
      case 'environment': return { environment: { volumeInstances: { edges: state.volumes.map((v) => ({ node: { serviceId: v.serviceId } })) } } } as T
      case 'serviceCreate': state.services.push({ id: 'svc-phoenix', name: (variables.input as { name: string }).name }); return { serviceCreate: { id: 'svc-phoenix' } } as T
      case 'volumeCreate': state.volumes.push({ id: 'vol-1', serviceId: (variables.input as { serviceId: string }).serviceId }); return { volumeCreate: { id: 'vol-1' } } as T
      case 'domains': return { domains: { serviceDomains: state.domains.map((domain) => ({ domain })), customDomains: [] } } as T
      case 'serviceDomainCreate': state.domains.push('phoenix-production.up.railway.app'); return { serviceDomainCreate: { domain: 'phoenix-production.up.railway.app' } } as T
      default: return {} as T
    }
  }
  return { gql, calls, ops: () => calls.map((c) => c.op) }
}

describe('Phoenix provisioning on Railway', () => {
  test('creates the service with generated secrets, a volume and a domain, and points Spaces at it', async () => {
    const railway = fakeRailway({ services: [{ id: 'svc-web', name: 'spaces' }], volumes: [], domains: [] })
    let n = 0
    const result = await provisionPhoenix({ config, webServiceId: 'svc-web', workerServiceIds: ['svc-w1', 'svc-w2'], region: 'us-east4-eqdc4a', gql: railway.gql, secret: () => `p1secret${++n}`.padEnd(40, '0') })

    expect(result).toEqual({ serviceId: 'svc-phoenix', created: true, endpoint: 'http://phoenix.railway.internal:6006', domain: 'phoenix-production.up.railway.app', workers: 2 })
    const create = railway.calls.find((c) => c.op === 'serviceCreate')!.variables.input
    expect(create.source).toEqual({ image: 'arizephoenix/phoenix:latest' })
    expect(create.variables).toMatchObject({ PHOENIX_WORKING_DIR: '/mnt/data', PHOENIX_HOST: '::', PHOENIX_PORT: '6006', PHOENIX_ENABLE_AUTH: 'true' })
    // Three different generated secrets; the admin secret is what Spaces sends traces with.
    const { PHOENIX_SECRET, PHOENIX_ADMIN_SECRET, PHOENIX_DEFAULT_ADMIN_INITIAL_PASSWORD } = create.variables
    expect(new Set([PHOENIX_SECRET, PHOENIX_ADMIN_SECRET, PHOENIX_DEFAULT_ADMIN_INITIAL_PASSWORD]).size).toBe(3)
    expect(railway.calls.find((c) => c.op === 'serviceInstanceUpdate')!.variables.input.multiRegionConfig).toEqual({ 'us-east4-eqdc4a': { numReplicas: 1 } })
    expect(railway.calls.find((c) => c.op === 'volumeCreate')!.variables.input).toMatchObject({ serviceId: 'svc-phoenix', mountPath: '/mnt/data' })
    expect(railway.calls.find((c) => c.op === 'serviceDomainCreate')!.variables.input).toMatchObject({ serviceId: 'svc-phoenix', targetPort: 6006 })
    expect(railway.ops()).toContain('serviceInstanceDeployV2')

    const upserts = railway.calls.filter((c) => c.op === 'variableCollectionUpsert').map((c) => c.variables.input)
    expect(upserts.every((u) => u.skipDeploys === true)).toBe(true)
    expect(upserts.find((u) => u.serviceId === 'svc-web')!.variables).toEqual({ PHOENIX_COLLECTOR_ENDPOINT: 'http://phoenix.railway.internal:6006', PHOENIX_API_KEY: '${{phoenix.PHOENIX_ADMIN_SECRET}}' })
    expect(upserts.find((u) => u.serviceId === 'svc-w1')!.variables).toEqual({ PHOENIX_COLLECTOR_ENDPOINT: '${{spaces.PHOENIX_COLLECTOR_ENDPOINT}}', PHOENIX_API_KEY: '${{spaces.PHOENIX_API_KEY}}' })
  })

  test('a second run changes nothing but the variables (secrets are not regenerated)', async () => {
    const railway = fakeRailway({ services: [{ id: 'svc-web', name: 'spaces' }, { id: 'svc-phoenix', name: 'phoenix' }], volumes: [{ id: 'vol-1', serviceId: 'svc-phoenix' }], domains: ['phoenix-production.up.railway.app'] })
    const result = await provisionPhoenix({ config, webServiceId: 'svc-web', workerServiceIds: [], gql: railway.gql })
    expect(result.created).toBe(false)
    expect(result.domain).toBe('phoenix-production.up.railway.app')
    expect(railway.ops()).toEqual(['project', 'environment', 'domains', 'variableCollectionUpsert'])
  })

  test('a worker that refuses its variables does not stop the rest', async () => {
    const railway = fakeRailway({ services: [{ id: 'svc-phoenix', name: 'phoenix' }], volumes: [{ id: 'vol-1', serviceId: 'svc-phoenix' }], domains: ['d'] })
    const gql: GraphQL = async (query, variables) => {
      if ((variables as any)?.input?.serviceId === 'svc-gone') throw new Error('Service not found')
      return railway.gql(query, variables)
    }
    const result = await provisionPhoenix({ config, webServiceId: 'svc-web', workerServiceIds: ['svc-gone', 'svc-w1'], gql })
    expect(result.workers).toBe(1)
  })
})
