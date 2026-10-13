import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { getDb } from '../src/lib/db'
import {
  checkProvisioner, getProjectWorker, provisionProjectWorker, recordWorkerBootstrap,
  removeProjectWorker, takeWorkerBootstrap, workerPlatform, workerPlatformProblem, workerServiceName,
} from '../src/lib/worker-provisioner'
import { RailwayError } from '../src/lib/railway'
import { railwayPlatform, railwayWorkerConfig, type GraphQL, type RailwayWorkerConfig } from '../src/lib/worker-platform-railway'
import { createApprovalFixture } from './helpers/approval-fixture'

/** 014-project-workers, phase 2: provisioning against a fake Railway API. */

const fixture = await createApprovalFixture({ withServer: false })
const { projectA, projectTeamB } = fixture
afterAll(async () => { await fixture.stop() })

const config: RailwayWorkerConfig = {
  token: 'test-token', tokenType: 'project', railwayProjectId: 'rp-1', environmentId: 'env-1', repo: 'acme/spaces', branch: 'main',
  webServiceName: 'spaces', postgresServiceName: 'Postgres', size: { vcpus: 2, memoryGb: 2, diskGb: 5 },
}

function fakeRailway(fail: Partial<Record<string, string>> = {}) {
  const calls: Array<{ op: string; variables: Record<string, any> }> = []
  let n = 0
  const gql: GraphQL = async <T,>(query: string, variables: Record<string, unknown> = {}) => {
    const op = /(?:mutation|query)\s+(\w+)/.exec(query)![1]!
    calls.push({ op, variables: variables as Record<string, any> })
    if (fail[op]) {
      const message = fail[op]!; delete fail[op]
      // Railway's own client turns 'Not Authorized' into a credential error.
      throw message === 'Not Authorized' ? new RailwayError('railway_auth', 'Railway rejected the credential.') : new Error(message)
    }
    n += 1
    const data: Record<string, unknown> = {
      serviceCreate: { serviceCreate: { id: `svc-${n}` } },
      volumeCreate: { volumeCreate: { id: `vol-${n}` } },
      project: { project: { services: { edges: [{ node: { id: 'a' } }, { node: { id: 'b' } }] } } },
    }
    return (data[op] ?? { [op]: true }) as T
  }
  return { calls, gql, ops: () => calls.map((c) => c.op) }
}

beforeEach(async () => {
  await getDb()`DELETE FROM project_workers WHERE project_id IN (${projectA.projectId}, ${projectTeamB.projectId})`
})

describe('provisioning a project worker', () => {
  test('creates the service, sizes it, adds a volume, deploys and records its private address', async () => {
    const railway = fakeRailway()
    const worker = await provisionProjectWorker(projectA.projectId, { platform: railwayPlatform(config, railway.gql) })
    expect(railway.ops()).toEqual(['serviceCreate', 'serviceInstanceUpdate', 'serviceInstanceLimitsUpdate', 'volumeCreate', 'serviceInstanceDeployV2'])
    const create = railway.calls[0]!.variables.input
    expect(create.branch).toBe('main') // the test config; the default is spaces-workers
    expect(create.source).toEqual({ repo: 'acme/spaces' })
    expect(create.variables.SPACES_ROLE).toBe('project')
    expect(create.variables.WORKER_PROJECT_ID).toBe(projectA.projectId)
    expect(create.variables.DATABASE_URL).toBe('${{Postgres.DATABASE_URL}}')
    expect(create.variables.SPACES_INTERNAL_TOKEN).toBe('${{spaces.SPACES_INTERNAL_TOKEN}}')
    expect(railway.calls[1]!.variables.input).toMatchObject({ sleepApplication: true, numReplicas: 1 })
    expect(railway.calls[2]!.variables.input).toMatchObject({ vCPUs: 2, memoryGB: 2 })
    expect(railway.calls[3]!.variables.input).toMatchObject({ mountPath: '/data', serviceId: 'svc-1' })
    expect(worker.state).toBe('ready')
    expect(worker.internalUrl).toBe(`http://${create.name}.railway.internal:8080`)
  })

  test('a failure halfway is recorded, and a retry resumes without a second service', async () => {
    const railway = fakeRailway({ volumeCreate: 'volume quota reached' })
    await expect(provisionProjectWorker(projectA.projectId, { platform: railwayPlatform(config, railway.gql) })).rejects.toThrow('volume quota reached')
    const failed = await getProjectWorker(projectA.projectId)
    expect(failed).toMatchObject({ state: 'failed', serviceRef: 'svc-1', lastError: 'volume quota reached' })
    const ready = await provisionProjectWorker(projectA.projectId, { platform: railwayPlatform(config, railway.gql) })
    expect(ready.state).toBe('ready')
    expect(railway.ops().filter((op) => op === 'serviceCreate')).toHaveLength(1)
  })

  test('a refused size does not stop provisioning', async () => {
    const railway = fakeRailway({ serviceInstanceLimitsUpdate: 'plan does not allow' })
    expect((await provisionProjectWorker(projectA.projectId, { platform: railwayPlatform(config, railway.gql) })).state).toBe('ready')
  })

  test('concurrent requests create one service', async () => {
    const railway = fakeRailway()
    await Promise.all([1, 2, 3].map(() => provisionProjectWorker(projectA.projectId, { platform: railwayPlatform(config, railway.gql) })))
    expect(railway.ops().filter((op) => op === 'serviceCreate')).toHaveLength(1)
  })

  test('removing a worker deletes its volume and service and forgets it', async () => {
    const railway = fakeRailway()
    const worker = await provisionProjectWorker(projectTeamB.projectId, { platform: railwayPlatform(config, railway.gql) })
    railway.calls.length = 0
    await removeProjectWorker(worker, { platform: railwayPlatform(config, railway.gql) })
    expect(railway.calls.map((c) => [c.op, c.variables])).toEqual([['volumeDelete', { volumeId: worker.volumeRef }], ['serviceDelete', { id: worker.serviceRef }]])
    expect(await getProjectWorker(projectTeamB.projectId)).toBeUndefined()
  })
})

describe('provisioner settings and check', () => {
  test('no platform without settings; Railway with its token; a project token by default', () => {
    expect(workerPlatform({})).toBeUndefined()
    expect(workerPlatformProblem({})).toContain('PROJECT_WORKER_PLATFORM')
    expect(workerPlatform({ RAILWAY_PROVISIONER_TOKEN: 't', RAILWAY_PROJECT_ID: 'p', RAILWAY_ENVIRONMENT_ID: 'e' })?.kind).toBe('railway')
    expect(railwayWorkerConfig({ RAILWAY_PROVISIONER_TOKEN: 't', RAILWAY_PROJECT_ID: 'p', RAILWAY_ENVIRONMENT_ID: 'e' })).toMatchObject({ tokenType: 'project', size: { vcpus: 2, memoryGb: 2, diskGb: 5 }, webServiceName: 'spaces' })
    expect(workerPlatform({ PROJECT_WORKER_PLATFORM: 'docker', PROJECT_WORKER_IMAGE: 'spaces:local', PROJECT_WORKER_DOCKER_NETWORK: 'spaces' })?.kind).toBe('docker')
    expect(workerPlatformProblem({ PROJECT_WORKER_PLATFORM: 'kubernetes' })).toContain('PROJECT_WORKER_IMAGE')
    expect(workerServiceName({ code: 'DEFA-1', slug: 'x' })).toBe('spaces-proj-defa-1')
  })

  test('the check reads without creating anything unless a probe is asked for', async () => {
    const railway = fakeRailway()
    expect(await checkProvisioner({ platform: railwayPlatform(config, railway.gql) })).toEqual({ configured: true, platform: 'railway', canRead: true, detail: '2 services (project token)' })
    expect(railway.ops()).toEqual(['project'])
  })

  test('the probe creates and deletes a throwaway service and volume, and cleans up after a failure', async () => {
    const ok = fakeRailway()
    expect((await checkProvisioner({ probe: true, platform: railwayPlatform(config, ok.gql) })).canCreate).toBe(true)
    expect(ok.ops()).toEqual(['project', 'serviceCreate', 'volumeCreate', 'volumeDelete', 'serviceDelete'])
    const refused = fakeRailway({ volumeCreate: 'Not Authorized' })
    const result = await checkProvisioner({ probe: true, platform: railwayPlatform(config, refused.gql) })
    expect(result.canCreate).toBe(false)
    expect(result.error).toContain('provisioning token')
    expect(refused.ops()).toEqual(['project', 'serviceCreate', 'volumeCreate', 'serviceDelete'])
  })

  test('a token that can create but not delete is reported, with what was left behind', async () => {
    const railway = fakeRailway({ serviceDelete: 'Not Authorized' })
    const result = await checkProvisioner({ probe: true, platform: railwayPlatform(config, railway.gql) })
    expect(result).toMatchObject({ canCreate: true, canDelete: false })
    expect(result.error).toContain('provisioning token')
    expect(result.error).toContain('workspace token')
    expect(result.error).toContain('Left behind: service spaces-provisioner-probe-')
  })

  test('refusals name the provisioning token, not the organization connection', async () => {
    const railway = fakeRailway({ serviceDelete: 'Not Authorized' })
    await expect(railwayPlatform(config, railway.gql).remove({ name: 'w' }, { serviceRef: 's', volumeRef: null })).rejects.toThrow('Railway refused the provisioning token (RAILWAY_PROVISIONER_TOKEN) for serviceDelete')
  })

  test('a recorded bootstrap is taken once', async () => {
    await recordWorkerBootstrap(projectA.projectId, { model: 'm', feature: 'first feature' })
    expect(await takeWorkerBootstrap(projectA.projectId)).toEqual({ model: 'm', feature: 'first feature' })
    expect(await takeWorkerBootstrap(projectA.projectId)).toBeUndefined()
  })
})
