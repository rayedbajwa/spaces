/**
 * Project workers on Railway: a service built from this repository, a volume at
 * /data, sleeping when idle, private networking only. Uses the deployment's own
 * provisioning token (RAILWAY_PROVISIONER_TOKEN, a project token for this
 * Railway project's environment), never a user's Railway connection.
 */

import { log } from './logger'
import { railwayGraphQLRequest, type RailwayTokenType } from './railway'
import { workerSize, type WorkerPlatform, type WorkerSize, type WorkerSpec } from './worker-platform'

const railwayLog = log.child({ mod: 'worker-platform-railway' })

export interface RailwayWorkerConfig {
  token: string
  tokenType: RailwayTokenType
  railwayProjectId: string
  environmentId: string
  repo: string
  branch: string
  /** The web service's name in Railway, for variable references. */
  webServiceName: string
  postgresServiceName: string
  size: WorkerSize
}

export function railwayWorkerConfig(env: NodeJS.ProcessEnv = process.env): RailwayWorkerConfig | undefined {
  const token = env.RAILWAY_PROVISIONER_TOKEN?.trim()
  const railwayProjectId = env.RAILWAY_PROJECT_ID?.trim()
  const environmentId = env.RAILWAY_ENVIRONMENT_ID?.trim()
  if (!token || !railwayProjectId || !environmentId) return undefined
  const type = env.RAILWAY_PROVISIONER_TOKEN_TYPE?.trim()
  return {
    token,
    tokenType: type === 'workspace' || type === 'account' ? type : 'project',
    railwayProjectId,
    environmentId,
    repo: env.PROJECT_WORKER_REPO?.trim() || 'rayedbajwa/spaces',
    branch: env.PROJECT_WORKER_BRANCH?.trim() || 'main',
    webServiceName: env.RAILWAY_SERVICE_NAME?.trim() || 'spaces',
    postgresServiceName: env.PROJECT_WORKER_POSTGRES_SERVICE?.trim() || 'Postgres',
    size: workerSize(env),
  }
}

/** Secrets as references to the web service's variables, so they are kept in one place. */
export function railwayWorkerVariables(config: RailwayWorkerConfig, spec: WorkerSpec): Record<string, string> {
  const web = config.webServiceName
  return {
    ...spec.env,
    // Railway's private network is IPv6: listen on :: as well.
    HOST: '::',
    DATABASE_URL: `\${{${config.postgresServiceName}.DATABASE_URL}}`,
    ENCRYPTION_KEY: `\${{${web}.ENCRYPTION_KEY}}`,
    SPACES_INTERNAL_TOKEN: `\${{${web}.SPACES_INTERNAL_TOKEN}}`,
    PUBLIC_URL: `\${{${web}.PUBLIC_URL}}`,
    GIT_COMMIT: '${{RAILWAY_GIT_COMMIT_SHA}}',
  }
}

export type GraphQL = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>

export function railwayPlatform(config: RailwayWorkerConfig, gql?: GraphQL): WorkerPlatform {
  const call: GraphQL = gql ?? (<T>(query: string, variables: Record<string, unknown> = {}) => railwayGraphQLRequest<T>(config.token, config.tokenType, query, variables))
  const env = { serviceId: '', environmentId: config.environmentId }

  async function deleteVolume(volumeId: string) {
    await call(`mutation volumeDelete($volumeId: String!) { volumeDelete(volumeId: $volumeId) }`, { volumeId })
  }
  async function deleteService(id: string) {
    await call(`mutation serviceDelete($id: String!) { serviceDelete(id: $id) }`, { id })
  }
  async function createVolume(serviceId: string): Promise<string> {
    return (await call<{ volumeCreate: { id: string } }>(
      `mutation volumeCreate($input: VolumeCreateInput!) { volumeCreate(input: $input) { id } }`,
      { input: { projectId: config.railwayProjectId, environmentId: config.environmentId, serviceId, mountPath: '/data' } },
    )).volumeCreate.id
  }

  return {
    kind: 'railway',
    async create(spec, existing, record) {
      let serviceId = existing.serviceRef
      if (!serviceId) {
        serviceId = (await call<{ serviceCreate: { id: string } }>(
          `mutation serviceCreate($input: ServiceCreateInput!) { serviceCreate(input: $input) { id } }`,
          { input: { projectId: config.railwayProjectId, name: spec.name, source: { repo: config.repo }, branch: config.branch, variables: railwayWorkerVariables(config, spec) } },
        )).serviceCreate.id
        await record({ serviceRef: serviceId })
      }
      env.serviceId = serviceId
      await call(
        `mutation serviceInstanceUpdate($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }`,
        { ...env, input: { sleepApplication: true, numReplicas: 1, healthcheckPath: '/health' } },
      )
      // Size it; a plan or API that refuses leaves Railway's default, which still works.
      await call(
        `mutation serviceInstanceLimitsUpdate($input: ServiceInstanceLimitsUpdateInput!) { serviceInstanceLimitsUpdate(input: $input) }`,
        { input: { ...env, vCPUs: config.size.vcpus, memoryGB: config.size.memoryGb } },
      ).catch((error) => railwayLog.warn('worker size not applied', { service: spec.name, error: error instanceof Error ? error.message : String(error) }))
      if (!existing.volumeRef) await record({ volumeRef: await createVolume(serviceId) })
      await call(`mutation serviceInstanceDeployV2($serviceId: String!, $environmentId: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId) }`, env)
      return { internalUrl: `http://${spec.name}.railway.internal:${spec.port}` }
    },
    async remove(_spec, refs) {
      if (refs.volumeRef) await deleteVolume(refs.volumeRef)
      if (refs.serviceRef) await deleteService(refs.serviceRef)
    },
    async check(probe) {
      let detail: string
      try {
        const data = await call<{ project: { services: { edges: unknown[] } } }>(
          `query project($id: String!) { project(id: $id) { services { edges { node { id } } } } }`,
          { id: config.railwayProjectId },
        )
        detail = `${data.project.services.edges.length} services (${config.tokenType} token)`
      } catch (error) {
        return { canRead: false, error: error instanceof Error ? error.message : String(error) }
      }
      if (!probe) return { canRead: true, detail }
      let serviceId: string | undefined
      let volumeId: string | undefined
      try {
        serviceId = (await call<{ serviceCreate: { id: string } }>(
          `mutation serviceCreate($input: ServiceCreateInput!) { serviceCreate(input: $input) { id } }`,
          { input: { projectId: config.railwayProjectId, name: `spaces-provisioner-probe-${Date.now().toString(36)}` } },
        )).serviceCreate.id
        volumeId = await createVolume(serviceId)
        return { canRead: true, detail, canCreate: true }
      } catch (error) {
        return { canRead: true, detail, canCreate: false, error: error instanceof Error ? error.message : String(error) }
      } finally {
        // Always clean up whatever the probe made.
        if (volumeId) await deleteVolume(volumeId).catch(() => undefined)
        if (serviceId) await deleteService(serviceId).catch(() => undefined)
      }
    },
  }
}
