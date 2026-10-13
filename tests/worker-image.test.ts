import { describe, expect, test } from 'bun:test'
import { imageAvailable, imageRef, railwayPlatform, railwayWorkerVariables, type GraphQL, type RailwayWorkerConfig } from '../src/lib/worker-platform-railway'

/** 014-project-workers: Railway workers run a prebuilt image instead of building from source. */

const config: RailwayWorkerConfig = {
  token: 't', tokenType: 'workspace', railwayProjectId: 'rp', environmentId: 'env', repo: 'acme/spaces', branch: 'spaces-workers',
  webServiceName: 'spaces', postgresServiceName: 'Postgres', size: { vcpus: 2, memoryGb: 2, diskGb: 5 }, image: 'ghcr.io/acme/spaces-worker',
}
const spec = { projectId: 'p1', name: 'spaces-proj-x', port: 8080, version: 'abc1234def', env: { SPACES_ROLE: 'project' } }

function fake() {
  const calls: Array<{ op: string; variables: Record<string, any> }> = []
  const gql: GraphQL = async <T,>(query: string, variables: Record<string, unknown> = {}) => {
    const op = /(?:mutation|query)\s+(\w+)/.exec(query)![1]!
    calls.push({ op, variables: variables as Record<string, any> })
    return ({ serviceCreate: { serviceCreate: { id: 'svc' } }, volumeCreate: { volumeCreate: { id: 'vol' } } }[op] ?? { [op]: true }) as T
  }
  return { calls, gql }
}

describe('worker image', () => {
  test('the image is tagged with the commit, or latest when unknown; an explicit tag is kept', () => {
    expect(imageRef('ghcr.io/acme/spaces-worker', 'abc1234def')).toBe('ghcr.io/acme/spaces-worker:abc1234def')
    expect(imageRef('ghcr.io/acme/spaces-worker', 'unknown')).toBe('ghcr.io/acme/spaces-worker:latest')
    expect(imageRef('ghcr.io/acme/spaces-worker:v2', 'abc1234def')).toBe('ghcr.io/acme/spaces-worker:v2')
  })

  test('an image worker carries no GIT_COMMIT reference (the image has its own)', () => {
    expect(railwayWorkerVariables(config, spec).GIT_COMMIT).toBeUndefined()
    expect(railwayWorkerVariables({ ...config, image: undefined }, spec).GIT_COMMIT).toBe('${{RAILWAY_GIT_COMMIT_SHA}}')
  })

  test('updating moves the service to the version image, sets the start command, drops GIT_COMMIT and deploys', async () => {
    const railway = fake()
    await railwayPlatform(config, railway.gql).update(spec, { serviceRef: 'svc', volumeRef: 'vol' })
    expect(railway.calls.map((c) => c.op)).toEqual(['serviceConnect', 'serviceInstanceUpdate', 'variableDelete', 'serviceInstanceDeployV2'])
    expect(railway.calls[0]!.variables).toEqual({ id: 'svc', input: { image: 'ghcr.io/acme/spaces-worker:abc1234def' } })
    expect(railway.calls[1]!.variables.input).toEqual({ startCommand: 'bun run src/standalone.ts' })
    expect(railway.calls[2]!.variables.input.name).toBe('GIT_COMMIT')
  })

  test('a published image is found through the registry; a missing one is not', async () => {
    const registry = (present: boolean) => (async (url: string) => url.includes('/token')
      ? new Response(JSON.stringify({ token: 'anon' }))
      : new Response(null, { status: present ? 200 : 404 })) as unknown as typeof fetch
    expect(await imageAvailable('ghcr.io/acme/spaces-worker:abc1234def', registry(true))).toBe(true)
    expect(await imageAvailable('ghcr.io/acme/spaces-worker:abc1234def', registry(false))).toBe(false)
    expect(await imageAvailable('registry.example.com/x:1', registry(false))).toBe(true)
  })
})
