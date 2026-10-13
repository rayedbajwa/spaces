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
  branch: string
  /**
   * A prebuilt image (e.g. ghcr.io/rayedbajwa/spaces-worker), tagged with the
   * commit by CI. When set, workers run it instead of building from the repo:
   * creating or updating one is a pull, not a build.
   */
  image?: string
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
    // Workers follow a branch nobody pushes to, so a push to main does not
    // redeploy them; Spaces deploys the exact commit to each one when idle.
    branch: env.PROJECT_WORKER_BRANCH?.trim() || 'spaces-workers',
    image: env.PROJECT_WORKER_IMAGE?.trim() || undefined,
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
    // A built-from-repo worker learns its commit from Railway; an image carries it.
    ...(config.image ? {} : { GIT_COMMIT: '${{RAILWAY_GIT_COMMIT_SHA}}' }),
  }
}

/** The image reference for a version: the commit tag CI pushed, or latest when unknown. */
export function imageRef(image: string, version: string): string {
  if (/:[^/]+$/.test(image) || image.includes('@')) return image
  return `${image}:${/^[0-9a-f]{7,40}$/.test(version) ? version : 'latest'}`
}

/**
 * Whether the image for a version has been pushed yet. CI pushes it after the
 * commit lands, possibly after the web service already runs it; an update waits
 * for it. Public GitHub Container Registry images are checked anonymously;
 * other registries are assumed ready.
 */
export async function imageAvailable(ref: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const match = /^ghcr\.io\/([^:@]+):(.+)$/.exec(ref)
  if (!match) return true
  const [, repository, tag] = match
  try {
    const tokenRes = await fetchImpl(`https://ghcr.io/token?scope=repository:${repository}:pull`)
    const token = ((await tokenRes.json()) as { token?: string }).token
    const res = await fetchImpl(`https://ghcr.io/v2/${repository}/manifests/${tag}`, {
      method: 'HEAD',
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        accept: 'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json',
      },
    })
    return res.ok
  } catch {
    return false
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
      // This commit's image may not be pushed yet: start from latest; the
      // rollout moves the worker to the commit once its image exists.
      const image = config.image
        ? (await imageAvailable(imageRef(config.image, spec.version)) ? imageRef(config.image, spec.version) : imageRef(config.image, 'latest'))
        : undefined
      if (!serviceId) {
        serviceId = (await call<{ serviceCreate: { id: string } }>(
          `mutation serviceCreate($input: ServiceCreateInput!) { serviceCreate(input: $input) { id } }`,
          { input: {
            projectId: config.railwayProjectId,
            name: spec.name,
            ...(image ? { source: { image } } : { source: { repo: config.repo }, branch: config.branch }),
            variables: railwayWorkerVariables(config, spec),
          } },
        )).serviceCreate.id
        await record({ serviceRef: serviceId })
      }
      env.serviceId = serviceId
      await call(
        `mutation serviceInstanceUpdate($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }`,
        // An image does not come with railway.json: give it the start command too.
        { ...env, input: { sleepApplication: true, numReplicas: 1, healthcheckPath: '/health', ...(config.image ? { startCommand: 'bun run src/standalone.ts' } : {}) } },
      )
      // Size it; a plan or API that refuses leaves Railway's default, which still works.
      await call(
        `mutation serviceInstanceLimitsUpdate($input: ServiceInstanceLimitsUpdateInput!) { serviceInstanceLimitsUpdate(input: $input) }`,
        { input: { ...env, vCPUs: config.size.vcpus, memoryGB: config.size.memoryGb } },
      ).catch((error) => railwayLog.warn('worker size not applied', { service: spec.name, error: error instanceof Error ? error.message : String(error) }))
      if (!existing.volumeRef) await record({ volumeRef: await createVolume(serviceId) })
      if (config.image) await call(`mutation serviceInstanceDeployV2($serviceId: String!, $environmentId: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId) }`, env)
      else await deployVersion(serviceId, spec.version)
      return { internalUrl: `http://${spec.name}.railway.internal:${spec.port}` }
    },
    async update(spec, refs) {
      if (!refs.serviceRef) throw new Error('This worker has no Railway service yet.')
      if (config.image) {
        // Point the service at the version's image (this also moves a worker that
        // was built from the repo onto the image), then deploy it.
        const serviceId = refs.serviceRef
        await call(`mutation serviceConnect($id: String!, $input: ServiceConnectInput!) { serviceConnect(id: $id, input: $input) { id } }`, { id: serviceId, input: { image: imageRef(config.image, spec.version) } })
        await call(
          `mutation serviceInstanceUpdate($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }`,
          { serviceId, environmentId: config.environmentId, input: { startCommand: 'bun run src/standalone.ts' } },
        )
        // The built-from-repo GIT_COMMIT reference is empty on an image service and
        // would hide the image's own commit.
        await call(`mutation variableDelete($input: VariableDeleteInput!) { variableDelete(input: $input) }`, { input: { projectId: config.railwayProjectId, environmentId: config.environmentId, serviceId, name: 'GIT_COMMIT' } }).catch(() => undefined)
        await call(`mutation serviceInstanceDeployV2($serviceId: String!, $environmentId: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId) }`, { serviceId, environmentId: config.environmentId })
        return
      }
      await deployVersion(refs.serviceRef, spec.version)
    },
    async versionAvailable(version) {
      return config.image ? imageAvailable(imageRef(config.image, version)) : true
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
