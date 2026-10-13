/**
 * Arize Phoenix on Railway, created by Spaces itself (no CI, no dashboard).
 *
 * With PHOENIX_AUTO_PROVISION=1 the web service makes sure the Railway project
 * has a `phoenix` service, with the deployment's provisioning token (the one
 * that creates project workers):
 *
 *   - the arizephoenix/phoenix image, a volume at /mnt/data, authentication on;
 *   - a generated PHOENIX_SECRET, PHOENIX_ADMIN_SECRET (the bearer token Spaces
 *     sends traces with) and PHOENIX_DEFAULT_ADMIN_INITIAL_PASSWORD (the UI's
 *     first `admin@localhost` login), kept only as the service's variables;
 *   - a public domain for the UI;
 *   - PHOENIX_COLLECTOR_ENDPOINT and PHOENIX_API_KEY on the web service and on
 *     every project worker, as references, so the secret lives in one place.
 *
 * Every step checks first, so it is safe on each start. Variables are set
 * without redeploying anything: this process starts tracing at once, and
 * workers pick them up on their next deploy (Spaces moves idle workers to its
 * own version). Run it by hand with `bun run phoenix:provision`.
 */

import { randomBytes } from 'node:crypto'
import { log } from './logger'
import { railwayGraphQLRequest } from './railway'
import { provisionerError, type GraphQL, type RailwayWorkerConfig } from './worker-platform-railway'

const phoenixLog = log.child({ mod: 'phoenix-provision' })

export const PHOENIX_PORT = 6006

export interface PhoenixProvisionResult {
  serviceId: string
  created: boolean
  endpoint: string
  domain?: string
  /** Project worker services given the tracing references. */
  workers: number
}

export interface PhoenixProvisionOptions {
  config: RailwayWorkerConfig
  /** The web service (RAILWAY_SERVICE_ID). */
  webServiceId: string
  /** Railway service ids of the project workers. */
  workerServiceIds: string[]
  serviceName?: string
  image?: string
  /** Region to run in (the web service's), so Phoenix is next to its senders. */
  region?: string
  gql?: GraphQL
  secret?: () => string
}

/** A random secret Phoenix accepts (≥ 32 characters with a digit and a lowercase letter). */
function generateSecret(): string {
  return `p1${randomBytes(32).toString('hex')}`
}

export async function provisionPhoenix(options: PhoenixProvisionOptions): Promise<PhoenixProvisionResult> {
  const { config } = options
  const name = options.serviceName ?? 'phoenix'
  const secret = options.secret ?? generateSecret
  const raw: GraphQL = options.gql ?? (<T>(query: string, variables: Record<string, unknown> = {}) => railwayGraphQLRequest<T>(config.token, config.tokenType, query, variables))
  const call: GraphQL = async <T>(query: string, variables: Record<string, unknown> = {}) => {
    try {
      return await raw<T>(query, variables)
    } catch (error) {
      throw provisionerError(error, /(?:mutation|query)\s+(\w+)/.exec(query)?.[1] ?? 'a request', config.tokenType)
    }
  }
  const scope = { projectId: config.railwayProjectId, environmentId: config.environmentId }

  const project = await call<{ project: { services: { edges: Array<{ node: { id: string; name: string } }> } } }>(
    `query project($id: String!) { project(id: $id) { services { edges { node { id name } } } } }`,
    { id: config.railwayProjectId },
  )
  let serviceId = project.project.services.edges.find((e) => e.node.name === name)?.node.id
  const created = !serviceId
  if (!serviceId) {
    serviceId = (await call<{ serviceCreate: { id: string } }>(
      `mutation serviceCreate($input: ServiceCreateInput!) { serviceCreate(input: $input) { id } }`,
      {
        input: {
          projectId: config.railwayProjectId,
          name,
          source: { image: options.image ?? 'arizephoenix/phoenix:latest' },
          variables: {
            PHOENIX_WORKING_DIR: '/mnt/data',
            // Railway's private network is IPv6.
            PHOENIX_HOST: '::',
            PHOENIX_PORT: String(PHOENIX_PORT),
            PORT: String(PHOENIX_PORT),
            PHOENIX_ENABLE_AUTH: 'true',
            PHOENIX_SECRET: secret(),
            PHOENIX_ADMIN_SECRET: secret(),
            PHOENIX_DEFAULT_ADMIN_INITIAL_PASSWORD: secret().slice(0, 24),
          },
        },
      },
    )).serviceCreate.id
    phoenixLog.info('created the Phoenix service', { name, serviceId })
    await call(
      `mutation serviceInstanceUpdate($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }`,
      { serviceId, environmentId: config.environmentId, input: { numReplicas: 1, restartPolicyType: 'ON_FAILURE', ...(options.region ? { multiRegionConfig: { [options.region]: { numReplicas: 1 } } } : {}) } },
    ).catch((error) => phoenixLog.warn('Phoenix service settings not applied', { error: error instanceof Error ? error.message : String(error) }))
  }

  const volumes = await call<{ environment: { volumeInstances: { edges: Array<{ node: { serviceId: string | null } }> } } }>(
    `query environment($id: String!) { environment(id: $id) { volumeInstances { edges { node { serviceId } } } } }`,
    { id: config.environmentId },
  )
  const hasVolume = volumes.environment.volumeInstances.edges.some((v) => v.node.serviceId === serviceId)
  if (!hasVolume) {
    await call(
      `mutation volumeCreate($input: VolumeCreateInput!) { volumeCreate(input: $input) { id } }`,
      { input: { ...scope, serviceId, mountPath: '/mnt/data' } },
    )
  }

  const domains = await call<{ domains: { serviceDomains: Array<{ domain: string }>; customDomains: Array<{ domain: string }> } }>(
    `query domains($projectId: String!, $environmentId: String!, $serviceId: String!) { domains(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) { serviceDomains { domain } customDomains { domain } } }`,
    { ...scope, serviceId },
  )
  let domain = domains.domains.customDomains[0]?.domain ?? domains.domains.serviceDomains[0]?.domain
  if (!domain) {
    domain = (await call<{ serviceDomainCreate: { domain: string } }>(
      `mutation serviceDomainCreate($input: ServiceDomainCreateInput!) { serviceDomainCreate(input: $input) { domain } }`,
      { input: { serviceId, environmentId: config.environmentId, targetPort: PHOENIX_PORT } },
    )).serviceDomainCreate.domain
  }

  if (created || !hasVolume) {
    await call(
      `mutation serviceInstanceDeployV2($serviceId: String!, $environmentId: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId) }`,
      { serviceId, environmentId: config.environmentId },
    )
  }

  // Where to send traces, and with what: references to Phoenix's own variables.
  const endpoint = `http://${name}.railway.internal:${PHOENIX_PORT}`
  const upsert = (target: string, variables: Record<string, string>) => call(
    `mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }`,
    { input: { ...scope, serviceId: target, variables, skipDeploys: true } },
  )
  await upsert(options.webServiceId, { PHOENIX_COLLECTOR_ENDPOINT: endpoint, PHOENIX_API_KEY: `\${{${name}.PHOENIX_ADMIN_SECRET}}` })
  const web = config.webServiceName
  let workers = 0
  for (const workerServiceId of options.workerServiceIds) {
    try {
      await upsert(workerServiceId, { PHOENIX_COLLECTOR_ENDPOINT: `\${{${web}.PHOENIX_COLLECTOR_ENDPOINT}}`, PHOENIX_API_KEY: `\${{${web}.PHOENIX_API_KEY}}` })
      workers++
    } catch (error) {
      phoenixLog.warn('tracing variables not set on a project worker', { serviceId: workerServiceId, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { serviceId, created, endpoint, domain, workers }
}

/** Phoenix's admin secret, read back to start tracing in this process without a redeploy. */
export async function readPhoenixAdminSecret(config: RailwayWorkerConfig, serviceId: string, gql?: GraphQL): Promise<string | undefined> {
  const call: GraphQL = gql ?? (<T>(query: string, variables: Record<string, unknown> = {}) => railwayGraphQLRequest<T>(config.token, config.tokenType, query, variables))
  const data = await call<{ variables: Record<string, string> }>(
    `query variables($projectId: String!, $environmentId: String!, $serviceId: String) { variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) }`,
    { projectId: config.railwayProjectId, environmentId: config.environmentId, serviceId },
  )
  return data.variables.PHOENIX_ADMIN_SECRET
}

/**
 * On web start-up: provision Phoenix when asked to and not done yet, then
 * start tracing in this process. Never throws; a failure is logged.
 */
export async function ensurePhoenix(env: NodeJS.ProcessEnv = process.env): Promise<PhoenixProvisionResult | undefined> {
  if (env.PHOENIX_AUTO_PROVISION?.trim() !== '1') return undefined
  const { railwayWorkerConfig } = await import('./worker-platform-railway')
  const config = railwayWorkerConfig(env)
  const webServiceId = env.RAILWAY_SERVICE_ID?.trim()
  if (!config || !webServiceId) {
    phoenixLog.warn('PHOENIX_AUTO_PROVISION needs RAILWAY_PROVISIONER_TOKEN on a Railway service')
    return undefined
  }
  try {
    const { getDb } = await import('./db')
    const rows = await getDb()<Array<{ serviceRef: string }>>`SELECT service_ref AS "serviceRef" FROM project_workers WHERE platform = 'railway' AND service_ref IS NOT NULL AND state <> 'removing'`
    const result = await provisionPhoenix({ config, webServiceId, workerServiceIds: rows.map((r) => r.serviceRef), region: env.RAILWAY_REPLICA_REGION?.trim() || undefined })
    if (!env.PHOENIX_COLLECTOR_ENDPOINT?.trim()) {
      const key = await readPhoenixAdminSecret(config, result.serviceId).catch(() => undefined)
      env.PHOENIX_COLLECTOR_ENDPOINT = result.endpoint
      if (key) env.PHOENIX_API_KEY = key
    }
    phoenixLog.info('Phoenix ready', { ...result, ui: result.domain ? `https://${result.domain}` : undefined })
    return result
  } catch (error) {
    phoenixLog.warn('Phoenix provisioning failed', { error: error instanceof Error ? error.message : String(error) })
    return undefined
  }
}
