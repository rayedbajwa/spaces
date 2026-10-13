/**
 * Where project workers run (specs/014-project-workers): Railway in production,
 * Kubernetes (any cluster, minikube included) or the local Docker engine for
 * engineers. Each platform makes the same three things for a project — a
 * service, a volume at /data and a private address — and removes them again.
 */

export type WorkerPlatformKind = 'railway' | 'kubernetes' | 'docker'

/** What a project's worker is: its name, its environment and the port it listens on. */
export interface WorkerSpec {
  projectId: string
  /** spaces-proj-<code>: the service, container or deployment name, and its private hostname. */
  name: string
  /** SPACES_ROLE=project, WORKER_PROJECT_ID, PORT. Platforms add the shared secrets their own way. */
  env: Record<string, string>
  port: number
  /** The Spaces version (git commit) this worker should run: the web service's own. */
  version: string
}

/** A platform's ids for what it made, recorded as each exists so a retry resumes. */
export interface WorkerRefs {
  serviceRef: string | null
  volumeRef: string | null
}

export interface PlatformCheck {
  canRead: boolean
  /** How much the platform reports it holds (services, pods, containers). */
  detail?: string
  canCreate?: boolean
  /** Whether what the probe made could be deleted again (removing workers needs it). */
  canDelete?: boolean
  error?: string
}

export interface WorkerPlatform {
  kind: WorkerPlatformKind
  /**
   * Make what is missing (refs from an earlier attempt are kept), recording each
   * ref as soon as it exists, and start the worker. Returns its private address.
   */
  create(spec: WorkerSpec, existing: WorkerRefs, record: (refs: Partial<WorkerRefs>) => Promise<void>): Promise<{ internalUrl: string }>
  /** Move the worker to `spec.version`, keeping its volume. Called only while it is idle. */
  update(spec: WorkerSpec, refs: WorkerRefs): Promise<void>
  /** Remove the worker and its volume (its workspace files go with it). */
  remove(spec: Pick<WorkerSpec, 'name'>, refs: WorkerRefs): Promise<void>
  /** Read access always; with `probe`, make and delete something throwaway. */
  check(probe: boolean): Promise<PlatformCheck>
}

/** Sizes shared by every platform (FR-012: 2 vCPU, 2 GB, 5 GB). */
export interface WorkerSize {
  vcpus: number
  memoryGb: number
  diskGb: number
}

export function workerSize(env: NodeJS.ProcessEnv = process.env): WorkerSize {
  return {
    vcpus: Number(env.PROJECT_WORKER_VCPUS ?? '2') || 2,
    memoryGb: Number(env.PROJECT_WORKER_MEMORY_GB ?? '2') || 2,
    diskGb: Number(env.PROJECT_WORKER_DISK_GB ?? '5') || 5,
  }
}

/**
 * The secrets a worker shares with the web service, copied from this process.
 * Railway uses references and Kubernetes a Secret instead, when configured.
 */
export function sharedSecrets(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  const database = env.PROJECT_WORKER_DATABASE_URL?.trim() || env.DATABASE_URL?.trim()
  if (database) out.DATABASE_URL = database
  for (const key of ['ENCRYPTION_KEY', 'SPACES_INTERNAL_TOKEN', 'PUBLIC_URL'] as const) {
    const value = env[key]?.trim()
    if (value) out[key] = value
  }
  return out
}

/** The version this process runs: the git commit it was built from. */
export function runningVersion(env: NodeJS.ProcessEnv = process.env): string {
  return env.GIT_COMMIT?.trim() || env.RAILWAY_GIT_COMMIT_SHA?.trim() || 'unknown'
}
