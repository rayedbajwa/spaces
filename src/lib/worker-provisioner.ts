/**
 * Creating and removing each project's worker (specs/014-project-workers,
 * phase 2), on whichever platform this deployment uses: Railway in production,
 * Kubernetes (minikube included) or the local Docker engine for engineers.
 *
 * PROJECT_WORKER_PLATFORM picks it (railway | kubernetes | docker); without it,
 * a deployment with RAILWAY_PROVISIONER_TOKEN uses Railway. Steps are recorded
 * as they complete (service, volume), so a provisioning that failed halfway
 * resumes instead of creating duplicates.
 */

import { getDb } from './db'
import { log } from './logger'
import { runningVersion, type WorkerPlatform, type WorkerPlatformKind, type WorkerRefs, type WorkerSpec } from './worker-platform'
import { dockerPlatform, dockerWorkerConfig } from './worker-platform-docker'
import { kubernetesPlatform, kubernetesWorkerConfig } from './worker-platform-kubernetes'
import { railwayPlatform, railwayWorkerConfig } from './worker-platform-railway'

const provisionLog = log.child({ mod: 'worker-provisioner' })

/** The platform this deployment provisions project workers on, if any. */
export function workerPlatform(env: NodeJS.ProcessEnv = process.env): WorkerPlatform | undefined {
  const chosen = env.PROJECT_WORKER_PLATFORM?.trim().toLowerCase() as WorkerPlatformKind | undefined
  const kind = chosen || (env.RAILWAY_PROVISIONER_TOKEN?.trim() ? 'railway' : undefined)
  if (kind === 'railway') { const c = railwayWorkerConfig(env); return c ? railwayPlatform(c) : undefined }
  if (kind === 'kubernetes') { const c = kubernetesWorkerConfig(env); return c ? kubernetesPlatform(c) : undefined }
  if (kind === 'docker') { const c = dockerWorkerConfig(env); return c ? dockerPlatform(c) : undefined }
  return undefined
}

/** What is missing when the chosen platform is not usable (shown on the Project workers page). */
export function workerPlatformProblem(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const chosen = env.PROJECT_WORKER_PLATFORM?.trim().toLowerCase()
  if (!chosen && !env.RAILWAY_PROVISIONER_TOKEN?.trim()) return 'No platform set: PROJECT_WORKER_PLATFORM (railway, kubernetes or docker), or RAILWAY_PROVISIONER_TOKEN on Railway.'
  if (workerPlatform(env)) return undefined
  if (!chosen || chosen === 'railway') return 'Railway needs RAILWAY_PROVISIONER_TOKEN, plus RAILWAY_PROJECT_ID and RAILWAY_ENVIRONMENT_ID (set by Railway).'
  if (chosen === 'kubernetes') return 'Kubernetes needs PROJECT_WORKER_IMAGE, and either a service account in the cluster or KUBE_API_URL with KUBE_TOKEN.'
  if (chosen === 'docker') return 'Docker needs PROJECT_WORKER_IMAGE, PROJECT_WORKER_DOCKER_NETWORK and the Docker socket.'
  return `Unknown PROJECT_WORKER_PLATFORM "${chosen}".`
}

/** The worker's name: spaces-proj-<code>, lowercase, safe as a hostname on every platform. */
export function workerServiceName(project: { code: string | null; slug: string }): string {
  const base = (project.code || project.slug).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  return `spaces-proj-${base}`.slice(0, 48).replace(/-+$/, '')
}

const WORKER_PORT = 8080

export function workerSpec(projectId: string, project: { code: string | null; slug: string }): WorkerSpec {
  const port = Number(process.env.PROJECT_WORKER_PORT ?? WORKER_PORT) || WORKER_PORT
  return {
    projectId,
    name: workerServiceName(project),
    port,
    version: runningVersion(),
    env: {
      SPACES_ROLE: 'project',
      WORKER_PROJECT_ID: projectId,
      PORT: String(port),
      // How long a worker waits with nothing to do before it lets the platform sleep it.
      ...(process.env.PROJECT_WORKER_IDLE_SECONDS?.trim() ? { PROJECT_WORKER_IDLE_SECONDS: process.env.PROJECT_WORKER_IDLE_SECONDS.trim() } : {}),
    },
  }
}

export interface ProjectWorkerRow {
  projectId: string
  internalUrl: string | null
  platform: WorkerPlatformKind | null
  serviceRef: string | null
  volumeRef: string | null
  state: 'pending' | 'provisioning' | 'ready' | 'sleeping' | 'updating' | 'failed' | 'removing'
  version: string | null
  lastSeenAt: string | null
  diskUsedBytes: number | null
  lastError: string | null
  updatedAt: string
}

function columns(prefix = ''): string {
  return `${prefix}project_id AS "projectId", ${prefix}internal_url AS "internalUrl", ${prefix}platform AS platform,
  ${prefix}service_ref AS "serviceRef", ${prefix}volume_ref AS "volumeRef", ${prefix}state AS state, ${prefix}version AS version,
  ${prefix}last_seen_at AS "lastSeenAt", ${prefix}disk_used_bytes AS "diskUsedBytes", ${prefix}last_error AS "lastError", ${prefix}updated_at AS "updatedAt"`
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
 * Create the project's worker (idempotent). Concurrent calls in this process
 * share one attempt; across processes the row's state claims it.
 */
export function provisionProjectWorker(projectId: string, options: { platform?: WorkerPlatform } = {}): Promise<ProjectWorkerRow> {
  const existing = inFlight.get(projectId)
  if (existing) return existing
  const attempt = doProvision(projectId, options).finally(() => inFlight.delete(projectId))
  inFlight.set(projectId, attempt)
  return attempt
}

async function doProvision(projectId: string, options: { platform?: WorkerPlatform }): Promise<ProjectWorkerRow> {
  const platform = options.platform ?? workerPlatform()
  if (!platform) throw new Error(workerPlatformProblem() ?? 'Project workers are not set up.')
  const sql = getDb()
  const [project] = await sql<Array<{ code: string | null; slug: string }>>`SELECT code, slug FROM projects WHERE project_id = ${projectId}`
  if (!project) throw new Error('Project not found.')

  await sql`INSERT INTO project_workers (project_id) VALUES (${projectId}) ON CONFLICT (project_id) DO NOTHING`
  // Claim it: one provisioner at a time. A claim older than 15 minutes is abandoned.
  const [claimed] = await sql<ProjectWorkerRow[]>`
    UPDATE project_workers SET state = 'provisioning', platform = ${platform.kind}, last_error = NULL, updated_at = now()
     WHERE project_id = ${projectId}
       AND (state IN ('pending', 'failed') OR (state = 'provisioning' AND updated_at < now() - interval '15 minutes'))
    RETURNING ${sql.unsafe(ROW_COLS)}
  `
  if (!claimed) return (await getProjectWorker(projectId))!

  const spec = workerSpec(projectId, project)
  // Refs belong to the platform that made them; a worker moved to another platform starts over.
  const existing: WorkerRefs = claimed.platform === platform.kind || claimed.platform === null
    ? { serviceRef: claimed.serviceRef, volumeRef: claimed.volumeRef }
    : { serviceRef: null, volumeRef: null }
  const record = async (refs: Partial<WorkerRefs>) => {
    if (refs.serviceRef !== undefined) await sql`UPDATE project_workers SET service_ref = ${refs.serviceRef}, updated_at = now() WHERE project_id = ${projectId}`
    if (refs.volumeRef !== undefined) await sql`UPDATE project_workers SET volume_ref = ${refs.volumeRef}, updated_at = now() WHERE project_id = ${projectId}`
  }
  try {
    const { internalUrl } = await platform.create(spec, existing, record)
    const [ready] = await sql<ProjectWorkerRow[]>`
      UPDATE project_workers SET state = 'ready', internal_url = ${internalUrl}, last_error = NULL, updated_at = now()
       WHERE project_id = ${projectId}
      RETURNING ${sql.unsafe(ROW_COLS)}
    `
    provisionLog.info('project worker provisioned', { projectId, platform: platform.kind, name: spec.name })
    return ready!
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500)
    await sql`UPDATE project_workers SET state = 'failed', last_error = ${message}, updated_at = now() WHERE project_id = ${projectId}`
    provisionLog.warn('project worker provisioning failed', { projectId, platform: platform.kind, error: message })
    throw error
  }
}

/** Remove a project's worker and its volume (project deleted, or by the super admin). */
export async function removeProjectWorker(worker: Pick<ProjectWorkerRow, 'projectId' | 'serviceRef' | 'volumeRef'>, options: { platform?: WorkerPlatform; name?: string } = {}): Promise<void> {
  const platform = options.platform ?? workerPlatform()
  if (platform && (worker.serviceRef || worker.volumeRef)) {
    const name = options.name ?? worker.serviceRef ?? ''
    await platform.remove({ name }, { serviceRef: worker.serviceRef, volumeRef: worker.volumeRef })
  }
  await getDb()`DELETE FROM project_workers WHERE project_id = ${worker.projectId}`.catch(() => undefined)
  provisionLog.info('project worker removed', { projectId: worker.projectId })
}

export interface ProvisionerCheck {
  configured: boolean
  platform?: WorkerPlatformKind
  canRead?: boolean
  detail?: string
  /** Only when a probe was asked for. */
  canCreate?: boolean
  error?: string
}

/**
 * Check the platform: that it is set up and readable, and — only with `probe`
 * — that it can create what a worker needs (a throwaway that is removed, or a
 * server-side dry run on Kubernetes).
 */
export async function checkProvisioner(options: { probe?: boolean; platform?: WorkerPlatform } = {}): Promise<ProvisionerCheck> {
  const platform = options.platform ?? workerPlatform()
  if (!platform) return { configured: false, error: workerPlatformProblem() }
  const result = await platform.check(options.probe === true)
  return { configured: true, platform: platform.kind, ...result }
}
