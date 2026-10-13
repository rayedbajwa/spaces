import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { getDb } from '../src/lib/db'
import {
  checkProvisioner, getProjectWorker, provisionerConfig, provisionProjectWorker, recordWorkerBootstrap,
  removeProjectWorker, takeWorkerBootstrap, workerServiceName, type GraphQL, type ProvisionerConfig,
} from '../src/lib/worker-provisioner'
import { createApprovalFixture } from './helpers/approval-fixture'

/** 014-project-workers, phase 2: provisioning against a fake Railway API. */

const fixture = await createApprovalFixture({ withServer: false })
const { projectA, projectTeamB } = fixture
afterAll(async () => { await fixture.stop() })

const config: ProvisionerConfig = {
  token: 'test-token', tokenType: 'project', railwayProjectId: 'rp-1', environmentId: 'env-1', repo: 'acme/spaces', branch: 'main',
  webServiceName: 'spaces', postgresServiceName: 'Postgres', vcpus: 2, memoryGb: 2, port: 8080,
}

function fakeRailway(fail: Partial<Record<string, string>> = {}) {
  const calls: Array<{ op: string; variables: Record<string, any> }> = []
  let n = 0
  const gql: GraphQL = async <T,>(query: string, variables: Record<string, unknown> = {}) => {
    const op = /(?:mutation|query)\s+(\w+)/.exec(query)![1]!
    calls.push({ op, variables: variables as Record<string, any> })
    if (fail[op]) { const message = fail[op]!; delete fail[op]; throw new Error(message) }
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
    const worker = await provisionProjectWorker(projectA.projectId, { config, gql: railway.gql })
    expect(railway.ops()).toEqual(['serviceCreate', 'serviceInstanceUpdate', 'serviceInstanceLimitsUpdate', 'volumeCreate', 'serviceInstanceDeployV2'])
    const create = railway.calls[0]!.variables.input
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
    await expect(provisionProjectWorker(projectA.projectId, { config, gql: railway.gql })).rejects.toThrow('volume quota reached')
    const failed = await getProjectWorker(projectA.projectId)
    expect(failed).toMatchObject({ state: 'failed', railwayServiceId: 'svc-1', lastError: 'volume quota reached' })
    const ready = await provisionProjectWorker(projectA.projectId, { config, gql: railway.gql })
    expect(ready.state).toBe('ready')
    expect(railway.ops().filter((op) => op === 'serviceCreate')).toHaveLength(1)
  })

  test('a refused size does not stop provisioning', async () => {
    const railway = fakeRailway({ serviceInstanceLimitsUpdate: 'plan does not allow' })
    expect((await provisionProjectWorker(projectA.projectId, { config, gql: railway.gql })).state).toBe('ready')
  })

  test('concurrent requests create one service', async () => {
    const railway = fakeRailway()
    await Promise.all([1, 2, 3].map(() => provisionProjectWorker(projectA.projectId, { config, gql: railway.gql })))
    expect(railway.ops().filter((op) => op === 'serviceCreate')).toHaveLength(1)
  })

  test('removing a worker deletes its volume and service and forgets it', async () => {
    const railway = fakeRailway()
    const worker = await provisionProjectWorker(projectTeamB.projectId, { config, gql: railway.gql })
    railway.calls.length = 0
    await removeProjectWorker(worker, { config, gql: railway.gql })
    expect(railway.calls.map((c) => [c.op, c.variables])).toEqual([['volumeDelete', { volumeId: worker.railwayVolumeId }], ['serviceDelete', { id: worker.railwayServiceId }]])
    expect(await getProjectWorker(projectTeamB.projectId)).toBeUndefined()
  })
})

describe('provisioner settings and check', () => {
  test('unset without the token; a project token by default', () => {
    expect(provisionerConfig({})).toBeUndefined()
    const c = provisionerConfig({ RAILWAY_PROVISIONER_TOKEN: 't', RAILWAY_PROJECT_ID: 'p', RAILWAY_ENVIRONMENT_ID: 'e' })
    expect(c).toMatchObject({ tokenType: 'project', vcpus: 2, memoryGb: 2, webServiceName: 'spaces' })
    expect(workerServiceName({ code: 'DEFA-1', slug: 'x' })).toBe('spaces-proj-defa-1')
  })

  test('the check reads without creating anything unless a probe is asked for', async () => {
    const railway = fakeRailway()
    expect(await checkProvisioner({ config, gql: railway.gql })).toEqual({ configured: true, tokenType: 'project', canRead: true, services: 2 })
    expect(railway.ops()).toEqual(['project'])
  })

  test('the probe creates and deletes a throwaway service and volume, and cleans up after a failure', async () => {
    const ok = fakeRailway()
    expect((await checkProvisioner({ probe: true, config, gql: ok.gql })).canCreate).toBe(true)
    expect(ok.ops()).toEqual(['project', 'serviceCreate', 'volumeCreate', 'volumeDelete', 'serviceDelete'])
    const refused = fakeRailway({ volumeCreate: 'Not Authorized' })
    const result = await checkProvisioner({ probe: true, config, gql: refused.gql })
    expect(result).toMatchObject({ canCreate: false, error: 'Not Authorized' })
    expect(refused.ops()).toEqual(['project', 'serviceCreate', 'volumeCreate', 'serviceDelete'])
  })

  test('a recorded bootstrap is taken once', async () => {
    await recordWorkerBootstrap(projectA.projectId, { model: 'm', feature: 'first feature' })
    expect(await takeWorkerBootstrap(projectA.projectId)).toEqual({ model: 'm', feature: 'first feature' })
    expect(await takeWorkerBootstrap(projectA.projectId)).toBeUndefined()
  })
})
