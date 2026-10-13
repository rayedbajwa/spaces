/**
 * Creating and removing each project's worker service on Railway
 * (specs/014-project-workers, phase 2).
 *
 * A project worker is a Railway service built from this repository, with its own
 * volume at /data, private networking only, sleeping when idle, and the
 * variables that make it `SPACES_ROLE=project` for one project. Provisioning
 * uses the deployment's own provisioning token (RAILWAY_PROVISIONER_TOKEN, a
 * project token for this Railway project's environment), never a user's
 * Railway connection.
 *
 * Steps are recorded as they complete (service id, then volume id), so a
 * provisioning that failed halfway resumes instead of creating duplicates.
 */

import { getDb } from './db'
import { log } from './logger'
import { railwayGraphQLRequest, type RailwayTokenType } from './railway'

const provisionLog = log.child({ mod: 'worker-provisioner' })

export interface ProvisionerConfig {
  token: string
  tokenType: RailwayTokenType
  railwayProjectId: string
  environmentId: string
  repo: string
  branch: string
  /** The web service's name in Railway, for variable references. */
  webServiceName: string
  postgresServiceName: string
  vcpus: number
  memoryGb: number
  port: number
}

/** Provisioning settings, or undefined when this deployment does not provision workers. */
export function provisionerConfig(env: NodeJS.ProcessEnv = process.env): ProvisionerConfig | undefined {
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
    vcpus: Number(env.PROJECT_WORKER_VCPUS ?? '2') || 2,
    memoryGb: Number(env.PROJECT_WORKER_MEMORY_GB ?? '2') || 2,
    port: Number(env.PROJECT_WORKER_PORT ?? '8080') || 8080,
  }
}

/** The worker service's name: spaces-proj-<code>, lowercase, Railway-safe. */
export function workerServiceName(project: { code: string | null; slug: string }): string {
  const base = (project.code || project.slug).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  return `spaces-proj-${base}`.slice(0, 48)
}

/** The variables a project worker starts with; secrets are references to the web service's. */
export function workerVariables(config: ProvisionerConfig, projectId: string): Record<string, string> {
  const web = config.webServiceName
  return {
    SPACES_ROLE: 'project',
    WORKER_PROJECT_ID: projectId,
    PORT: String(config.port),
    HOST: '::',
    DATABASE_URL: `\${{${config.postgresServiceName}.DATABASE_URL}}`,
    ENCRYPTION_KEY: `\${{${web}.ENCRYPTION_KEY}}`,
    SPACES_INTERNAL_TOKEN: `\${{${web}.SPACES_INTERNAL_TOKEN}}`,
    PUBLIC_URL: `\${{${web}.PUBLIC_URL}}`,
    GIT_COMMIT: '${{RAILWAY_GIT_COMMIT_SHA}}',
  }
}

export type GraphQL = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>

function client(config: ProvisionerConfig, fetchImpl?: typeof fetch): GraphQL {
  return <T>(query: string, variables: Record<string, unknown> = {}) => railwayGraphQLRequest<T>(config.token, config.tokenType, query, variables, fetchImpl)
}

export interface ProjectWorkerRow {
  projectId: string
  internalUrl: string | null
  railwayServiceId: string | null
  railwayVolumeId: string | null
  state: 'pending' | 'provisioning' | 'ready' | 'sleeping' | 'updating' | 'failed' | 'removing'
  version: string | null
  lastSeenAt: string | null
  diskUsedBytes: number | null
  lastError: string | null
  updatedAt: string
}

function columns(prefix = ''): string {
  return `${prefix}project_id AS "projectId", ${prefix}internal_url AS "internalUrl", ${prefix}railway_service_id AS "railwayServiceId",
  ${prefix}railway_volume_id AS "railwayVolumeId", ${prefix}state AS state, ${prefix}version AS version, ${prefix}last_seen_at AS "lastSeenAt",
  ${prefix}disk_used_bytes AS "diskUsedBytes", ${prefix}last_error AS "lastError", ${prefix}updated_at AS "updatedAt"`
}
const ROW_COLS = columns()

export async function getProjectWorker(projectId: string): Promise<ProjectWorkerRow | undefined> {
  const sql = getDb()
  const [row] = await sql<ProjectWorkerRow[]>`SELECT ${sql.unsafe(ROW_COLS)} FROM project_workers WHERE project_id = ${projectId}`
  return row
}

export async function listProjectWorkers(): Promise<Array<ProjectWorkerRow & { projectName: string; projectCode: string | null }>> {
  const sql = getDb()
  return await sql<Array<ProjectWorkerRow & { projectName: string; projectCode: string | null }>>`
    SELECT ${sql.unsafe(columns('w.'))}, p.name AS "projectName", p.code AS "projectCode"
      FROM project_workers w JOIN projects p ON p.project_id = w.project_id
     ORDER BY p.name
  `
}

/** Record what a new project's worker should do once it is up (the wizard's first feature). */
export async function recordWorkerBootstrap(projectId: string, input: { model: string; feature?: string }): Promise<void> {
  await getDb()`
    INSERT INTO project_workers (project_id, bootstrap_json) VALUES (${projectId}, ${getDb().json(input as never)})
    ON CONFLICT (project_id) DO UPDATE SET bootstrap_json = EXCLUDED.bootstrap_json, updated_at = now()
  `
}

/** The bootstrap a project worker still has to run, cleared as it is taken. */
export async function takeWorkerBootstrap(projectId: string): Promise<{ model: string; feature?: string } | undefined> {
  const [row] = await getDb()<Array<{ bootstrap: { model: string; feature?: string } | null }>>`
    UPDATE project_workers w SET bootstrap_json = NULL, updated_at = now()
      FROM (SELECT project_id, bootstrap_json FROM project_workers WHERE project_id = ${projectId} FOR UPDATE) old
     WHERE w.project_id = old.project_id AND old.bootstrap_json IS NOT NULL
    RETURNING old.bootstrap_json AS bootstrap
  `
  return row?.bootstrap ?? undefined
}

const inFlight = new Map<string, Promise<ProjectWorkerRow>>()

/**
 * Create the project's worker service and volume (idempotent). Concurrent calls
 * in this process share one attempt; across processes the row's state claims it.
 */
export function provisionProjectWorker(projectId: string, options: { config?: ProvisionerConfig; gql?: GraphQL } = {}): Promise<ProjectWorkerRow> {
  const existing = inFlight.get(projectId)
  if (existing) return existing
  const attempt = doProvision(projectId, options).finally(() => inFlight.delete(projectId))
  inFlight.set(projectId, attempt)
  return attempt
}

async function doProvision(projectId: string, options: { config?: ProvisionerConfig; gql?: GraphQL }): Promise<ProjectWorkerRow> {
  const config = options.config ?? provisionerConfig()
  if (!config) throw new Error('Project workers are not set up: RAILWAY_PROVISIONER_TOKEN is missing.')
  const gql = options.gql ?? client(config)
  const sql = getDb()
  const [project] = await sql<Array<{ code: string | null; slug: string }>>`SELECT code, slug FROM projects WHERE project_id = ${projectId}`
  if (!project) throw new Error('Project not found.')

  await sql`INSERT INTO project_workers (project_id) VALUES (${projectId}) ON CONFLICT (project_id) DO NOTHING`
  // Claim it: one provisioner at a time. A claim older than 15 minutes is abandoned.
  const [claimed] = await sql<ProjectWorkerRow[]>`
    UPDATE project_workers SET state = 'provisioning', last_error = NULL, updated_at = now()
     WHERE project_id = ${projectId}
       AND (state IN ('pending', 'failed') OR (state = 'provisioning' AND updated_at < now() - interval '15 minutes'))
    RETURNING ${sql.unsafe(ROW_COLS)}
  `
  if (!claimed) return (await getProjectWorker(projectId))!

  const name = workerServiceName(project)
  try {
    let serviceId = claimed.railwayServiceId
    if (!serviceId) {
      const created = await gql<{ serviceCreate: { id: string } }>(
        `mutation serviceCreate($input: ServiceCreateInput!) { serviceCreate(input: $input) { id } }`,
        { input: { projectId: config.railwayProjectId, name, source: { repo: config.repo }, branch: config.branch, variables: workerVariables(config, projectId) } },
      )
      serviceId = created.serviceCreate.id
      await sql`UPDATE project_workers SET railway_service_id = ${serviceId}, updated_at = now() WHERE project_id = ${projectId}`
    }
    await gql(
      `mutation serviceInstanceUpdate($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }`,
      { serviceId, environmentId: config.environmentId, input: { sleepApplication: true, numReplicas: 1, healthcheckPath: '/health' } },
    )
    // Size it; a plan or API that refuses leaves Railway's default, which still works.
    await gql(
      `mutation serviceInstanceLimitsUpdate($input: ServiceInstanceLimitsUpdateInput!) { serviceInstanceLimitsUpdate(input: $input) }`,
      { input: { serviceId, environmentId: config.environmentId, vCPUs: config.vcpus, memoryGB: config.memoryGb } },
    ).catch((error) => provisionLog.warn('worker size not applied', { projectId, error: error instanceof Error ? error.message : String(error) }))
    let volumeId = claimed.railwayVolumeId
    if (!volumeId) {
      const volume = await gql<{ volumeCreate: { id: string } }>(
        `mutation volumeCreate($input: VolumeCreateInput!) { volumeCreate(input: $input) { id } }`,
        { input: { projectId: config.railwayProjectId, environmentId: config.environmentId, serviceId, mountPath: '/data' } },
      )
      volumeId = volume.volumeCreate.id
      await sql`UPDATE project_workers SET railway_volume_id = ${volumeId}, updated_at = now() WHERE project_id = ${projectId}`
    }
    await gql(
      `mutation serviceInstanceDeployV2($serviceId: String!, $environmentId: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId) }`,
      { serviceId, environmentId: config.environmentId },
    )
    const internalUrl = `http://${name}.railway.internal:${config.port}`
    const [ready] = await sql<ProjectWorkerRow[]>`
      UPDATE project_workers SET state = 'ready', internal_url = ${internalUrl}, last_error = NULL, updated_at = now()
       WHERE project_id = ${projectId}
      RETURNING ${sql.unsafe(ROW_COLS)}
    `
    provisionLog.info('project worker provisioned', { projectId, service: name })
    return ready!
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500)
    await sql`UPDATE project_workers SET state = 'failed', last_error = ${message}, updated_at = now() WHERE project_id = ${projectId}`
    provisionLog.warn('project worker provisioning failed', { projectId, error: message })
    throw error
  }
}

/** Remove a project's worker service and its volume (project deleted). */
export async function removeProjectWorker(worker: Pick<ProjectWorkerRow, 'projectId' | 'railwayServiceId' | 'railwayVolumeId'>, options: { config?: ProvisionerConfig; gql?: GraphQL } = {}): Promise<void> {
  const config = options.config ?? provisionerConfig()
  if (!config) return
  const gql = options.gql ?? client(config)
  if (worker.railwayVolumeId) {
    await gql(`mutation volumeDelete($volumeId: String!) { volumeDelete(volumeId: $volumeId) }`, { volumeId: worker.railwayVolumeId })
  }
  if (worker.railwayServiceId) {
    await gql(`mutation serviceDelete($id: String!) { serviceDelete(id: $id) }`, { id: worker.railwayServiceId })
  }
  await getDb()`DELETE FROM project_workers WHERE project_id = ${worker.projectId}`.catch(() => undefined)
  provisionLog.info('project worker removed', { projectId: worker.projectId })
}

export interface ProvisionerCheck {
  configured: boolean
  tokenType?: RailwayTokenType
  canRead?: boolean
  services?: number
  /** Only when a probe was asked for: a throwaway service and volume were created and deleted. */
  canCreate?: boolean
  error?: string
}

/**
 * Check the provisioning token: that it is set and can read this Railway
 * project, and — only when `probe` is true — that it can create and delete a
 * service and a volume (a throwaway pair, removed straight away).
 */
export async function checkProvisioner(options: { probe?: boolean; config?: ProvisionerConfig; gql?: GraphQL } = {}): Promise<ProvisionerCheck> {
  const config = options.config ?? provisionerConfig()
  if (!config) return { configured: false, error: 'RAILWAY_PROVISIONER_TOKEN is not set on this service.' }
  const gql = options.gql ?? client(config)
  const result: ProvisionerCheck = { configured: true, tokenType: config.tokenType }
  try {
    const data = await gql<{ project: { services: { edges: unknown[] } } }>(
      `query project($id: String!) { project(id: $id) { services { edges { node { id } } } } }`,
      { id: config.railwayProjectId },
    )
    result.canRead = true
    result.services = data.project.services.edges.length
  } catch (error) {
    return { ...result, canRead: false, error: error instanceof Error ? error.message : String(error) }
  }
  if (!options.probe) return result
  let serviceId: string | undefined
  let volumeId: string | undefined
  try {
    serviceId = (await gql<{ serviceCreate: { id: string } }>(
      `mutation serviceCreate($input: ServiceCreateInput!) { serviceCreate(input: $input) { id } }`,
      { input: { projectId: config.railwayProjectId, name: `spaces-provisioner-probe-${Date.now().toString(36)}` } },
    )).serviceCreate.id
    volumeId = (await gql<{ volumeCreate: { id: string } }>(
      `mutation volumeCreate($input: VolumeCreateInput!) { volumeCreate(input: $input) { id } }`,
      { input: { projectId: config.railwayProjectId, environmentId: config.environmentId, serviceId, mountPath: '/data' } },
    )).volumeCreate.id
    result.canCreate = true
  } catch (error) {
    result.canCreate = false
    result.error = error instanceof Error ? error.message : String(error)
  } finally {
    // Always clean up whatever the probe made.
    if (volumeId) await gql(`mutation volumeDelete($volumeId: String!) { volumeDelete(volumeId: $volumeId) }`, { volumeId }).catch(() => undefined)
    if (serviceId) await gql(`mutation serviceDelete($id: String!) { serviceDelete(id: $id) }`, { id: serviceId }).catch(() => undefined)
  }
  return result
}
