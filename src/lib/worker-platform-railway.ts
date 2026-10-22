/**
 * Project workers on Railway: a service built from this repository, a volume at
 * /data, sleeping when idle, private networking only. Uses the deployment's own
 * provisioning token (RAILWAY_PROVISIONER_TOKEN, a project token for this
 * Railway project's environment), never a user's Railway connection.
 */

import { log } from './logger'
import { RailwayError, railwayGraphQLRequest, type RailwayTokenType } from './railway'
import { workerSize, type WorkerPlatform, type WorkerSize, type WorkerSpec } from './worker-platform'

const railwayLog = log.child({ mod: 'worker-platform-railway' })

export interface RailwayWorkerConfig {
  token: string
  tokenType: RailwayTokenType
  railwayProjectId: string
  environmentId: string
  repo: string
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
    webServiceName: env.RAILWAY_SERVICE_NAME?.trim() || 'spaces',
    postgresServiceName: env.PROJECT_WORKER_POSTGRES_SERVICE?.trim() || 'Postgres',
    size: workerSize(env),
  }
}

const TRACING_VARIABLES = ['PHOENIX_COLLECTOR_ENDPOINT', 'PHOENIX_API_KEY', 'PHOENIX_PROJECT_NAME'] as const

/** Secrets as references to the web service's variables, so they are kept in one place. */
export function railwayWorkerVariables(config: RailwayWorkerConfig, spec: WorkerSpec, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const web = config.webServiceName
  // Agent tracing (lib/tracing.ts) goes where the web service's does, when it is set.
  const tracing = Object.fromEntries(TRACING_VARIABLES.filter((key) => env[key]?.trim()).map((key) => [key, `\${{${web}.${key}}}`]))
  return {
    ...tracing,
    ...spec.env,
    // Railway's private network is IPv6: listen on :: as well.
    HOST: '::',
    DATABASE_URL: `\${{${config.postgresServiceName}.DATABASE_URL}}`,
    ENCRYPTION_KEY: `\${{${web}.ENCRYPTION_KEY}}`,
    SPACES_INTERNAL_TOKEN: `\${{${web}.SPACES_INTERNAL_TOKEN}}`,
    // During a secret rotation (lib/crypto-vault.ts, lib/role.ts); empty otherwise.
    ENCRYPTION_KEY_PREVIOUS: `\${{${web}.ENCRYPTION_KEY_PREVIOUS}}`,
    SPACES_INTERNAL_TOKEN_PREVIOUS: `\${{${web}.SPACES_INTERNAL_TOKEN_PREVIOUS}}`,
    PUBLIC_URL: `\${{${web}.PUBLIC_URL}}`,
    GIT_COMMIT: '${{RAILWAY_GIT_COMMIT_SHA}}',
  }
}

export type GraphQL = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>

/**
 * Railway's errors name the organization's Railway connection; here the
 * credential is the deployment's provisioning token, so say which call it
 * refused and what to change.
 */
export function provisionerError(error: unknown, operation: string, tokenType: RailwayTokenType): Error {
  if (error instanceof RailwayError && (error.code === 'railway_auth' || error.code === 'railway_forbidden')) {
    const hint = tokenType === 'project'
      ? ' A project token can create services and volumes but not delete them: use a workspace token (RAILWAY_PROVISIONER_TOKEN_TYPE=workspace).'
      : ''
    return new Error(`Railway refused the provisioning token (RAILWAY_PROVISIONER_TOKEN) for ${operation}.${hint}`)
  }
  return error instanceof Error ? error : new Error(String(error))
}

export function railwayPlatform(config: RailwayWorkerConfig, gql?: GraphQL): WorkerPlatform {
  const raw: GraphQL = gql ?? (<T>(query: string, variables: Record<string, unknown> = {}) => railwayGraphQLRequest<T>(config.token, config.tokenType, query, variables))
  const call: GraphQL = async <T>(query: string, variables: Record<string, unknown> = {}) => {
    try {
      return await raw<T>(query, variables)
    } catch (error) {
      throw provisionerError(error, /(?:mutation|query)\s+(\w+)/.exec(query)?.[1] ?? 'a request', config.tokenType)
    }
  }
  const env = { serviceId: '', environmentId: config.environmentId }

  /** Deploy an exact commit (the web service's), or the branch head when the version is unknown. */
  async function deployVersion(serviceId: string, version: string) {
    if (/^[0-9a-f]{7,40}$/.test(version)) {
      await call(`mutation serviceInstanceDeployV2($serviceId: String!, $environmentId: String!, $commitSha: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId, commitSha: $commitSha) }`, { serviceId, environmentId: config.environmentId, commitSha: version })
    } else {
      await call(`mutation serviceInstanceDeployV2($serviceId: String!, $environmentId: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId) }`, { serviceId, environmentId: config.environmentId })
    }
  }
  async function deleteVolume(volumeId: string) {
    await call(`mutation volumeDelete($volumeId: String!) { volumeDelete(volumeId: $volumeId) }`, { volumeId })
  }
  async function deleteService(id: string) {
    await call(`mutation serviceDelete($id: String!) { serviceDelete(id: $id) }`, { id })
  }
  /**
   * Workers deploy only when Spaces deploys them: the web service's exact
   * commit, once idle (lib/worker-rollout.ts). Railway may attach a deployment
   * trigger to a service built from a repository (a push to its branch would
   * redeploy it, mid-stage too), so any is removed. Only the web service
   * deploys on a push to main.
   */
  async function removeDeployTriggers(serviceId: string): Promise<number> {
    const data = await call<{ deploymentTriggers: { edges: Array<{ node: { id: string } }> } }>(
      `query deploymentTriggers($projectId: String!, $environmentId: String!, $serviceId: String!) { deploymentTriggers(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) { edges { node { id } } } }`,
      { projectId: config.railwayProjectId, environmentId: config.environmentId, serviceId },
    )
    for (const edge of data.deploymentTriggers.edges) {
      await call(`mutation deploymentTriggerDelete($id: String!) { deploymentTriggerDelete(id: $id) }`, { id: edge.node.id })
    }
    if (data.deploymentTriggers.edges.length) railwayLog.info('removed deployment triggers from a project worker', { serviceId, count: data.deploymentTriggers.edges.length })
    return data.deploymentTriggers.edges.length
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
          { input: { projectId: config.railwayProjectId, name: spec.name, source: { repo: config.repo }, variables: railwayWorkerVariables(config, spec) } },
        )).serviceCreate.id
        await record({ serviceRef: serviceId })
      }
      env.serviceId = serviceId
      await removeDeployTriggers(serviceId)
      await call(
        `mutation serviceInstanceUpdate($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }`,
        // Railway ignores railway.json for services created through the API: without
        // these it builds with Railpack (no Chromium, psql or gosu) and starts only
        // the server, so no job process ever runs.
        { ...env, input: { sleepApplication: true, numReplicas: 1, healthcheckPath: '/health', healthcheckTimeout: 300, dockerfilePath: 'Dockerfile', startCommand: 'bun run src/standalone.ts' } },
      )
      // Size it; a plan or API that refuses leaves Railway's default, which still works.
      await call(
        `mutation serviceInstanceLimitsUpdate($input: ServiceInstanceLimitsUpdateInput!) { serviceInstanceLimitsUpdate(input: $input) }`,
        { input: { ...env, vCPUs: config.size.vcpus, memoryGB: config.size.memoryGb } },
      ).catch((error) => railwayLog.warn('worker size not applied', { service: spec.name, error: error instanceof Error ? error.message : String(error) }))
      if (!existing.volumeRef) await record({ volumeRef: await createVolume(serviceId) })
      await deployVersion(serviceId, spec.version)
      return { internalUrl: `http://${spec.name}.railway.internal:${spec.port}` }
    },
    async isAsleep(refs) {
      if (!refs.serviceRef) return false
      const data = await call<{ deployments: { edges: Array<{ node: { status: string } }> } }>(
        `query deployments($input: DeploymentListInput!) { deployments(first: 1, input: $input) { edges { node { status } } } }`,
        { input: { projectId: config.railwayProjectId, environmentId: config.environmentId, serviceId: refs.serviceRef } },
      )
      return data.deployments.edges[0]?.node.status === 'SLEEPING'
    },
    async update(spec, refs) {
      if (!refs.serviceRef) throw new Error('This worker has no Railway service yet.')
      // Workers made before Spaces removed them keep a trigger until their next update.
      await removeDeployTriggers(refs.serviceRef).catch((error) => railwayLog.warn('deployment triggers not checked', { serviceId: refs.serviceRef, error: error instanceof Error ? error.message : String(error) }))
      await deployVersion(refs.serviceRef, spec.version)
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
      const name = `spaces-provisioner-probe-${Date.now().toString(36)}`
      let serviceId: string | undefined
      let volumeId: string | undefined
      let createError: string | undefined
      try {
        serviceId = (await call<{ serviceCreate: { id: string } }>(
          `mutation serviceCreate($input: ServiceCreateInput!) { serviceCreate(input: $input) { id } }`,
          { input: { projectId: config.railwayProjectId, name } },
        )).serviceCreate.id
        volumeId = await createVolume(serviceId)
      } catch (error) {
        createError = error instanceof Error ? error.message : String(error)
      }
      // Deleting is part of the check: a token that cannot delete leaves
      // workers behind when projects are deleted, and the probe would too.
      const leftovers: string[] = []
      let deleteError: string | undefined
      if (volumeId) await deleteVolume(volumeId).catch((error) => { leftovers.push(`volume ${volumeId}`); deleteError ??= error instanceof Error ? error.message : String(error) })
      if (serviceId) await deleteService(serviceId).catch((error) => { leftovers.push(`service ${name}`); deleteError ??= error instanceof Error ? error.message : String(error) })
      const canDelete = Boolean(serviceId) && leftovers.length === 0
      const problems = [createError, deleteError && `${deleteError} Left behind: ${leftovers.join(', ')} (delete it in the Railway dashboard).`].filter(Boolean)
      return { canRead: true, detail, canCreate: !createError, canDelete: serviceId ? canDelete : undefined, ...(problems.length ? { error: problems.join(' ') } : {}) }
    },
  }
}
