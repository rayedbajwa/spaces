/**
 * Project workers on Kubernetes (any cluster; minikube for engineers): per
 * project a PersistentVolumeClaim for /data, a single-replica Deployment that
 * runs this image as `SPACES_ROLE=project`, and a ClusterIP Service for its
 * private address. Talks to the Kubernetes API directly: in the cluster with
 * the pod's service account (deploy/kubernetes grants it a namespaced Role),
 * outside it with KUBE_API_URL and KUBE_TOKEN.
 */

import { existsSync, readFileSync } from 'node:fs'
import { workerSize, sharedSecrets, type WorkerPlatform, type WorkerSize, type WorkerSpec } from './worker-platform'

const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount'
const MANAGED = { 'app.kubernetes.io/managed-by': 'spaces', 'spaces.dev/role': 'project-worker' }

export interface KubernetesWorkerConfig {
  apiUrl: string
  token: string
  ca?: string
  insecure: boolean
  namespace: string
  image: string
  imagePullPolicy: 'Always' | 'IfNotPresent' | 'Never'
  /** A Secret holding DATABASE_URL, ENCRYPTION_KEY, SPACES_INTERNAL_TOKEN and PUBLIC_URL; copied from this process when unset. */
  secretName?: string
  storageClass?: string
  cpuRequest: string
  memoryRequest: string
  size: WorkerSize
}

export function kubernetesWorkerConfig(env: NodeJS.ProcessEnv = process.env, readFile: (path: string) => string = (path) => readFileSync(path, 'utf8')): KubernetesWorkerConfig | undefined {
  const image = env.PROJECT_WORKER_IMAGE?.trim()
  if (!image) return undefined
  const inCluster = Boolean(env.KUBERNETES_SERVICE_HOST) && existsSync(`${SA_DIR}/token`)
  const apiUrl = env.KUBE_API_URL?.trim() || (inCluster ? `https://${env.KUBERNETES_SERVICE_HOST}:${env.KUBERNETES_SERVICE_PORT ?? '443'}` : undefined)
  const token = env.KUBE_TOKEN?.trim() || (inCluster ? readFile(`${SA_DIR}/token`).trim() : undefined)
  if (!apiUrl || !token) return undefined
  const caFile = env.KUBE_CA_FILE?.trim() || (inCluster ? `${SA_DIR}/ca.crt` : undefined)
  const namespace = env.PROJECT_WORKER_NAMESPACE?.trim() || (inCluster && existsSync(`${SA_DIR}/namespace`) ? readFile(`${SA_DIR}/namespace`).trim() : 'spaces')
  const policy = env.PROJECT_WORKER_IMAGE_PULL_POLICY?.trim()
  return {
    apiUrl: apiUrl.replace(/\/+$/, ''),
    token,
    ca: caFile && existsSync(caFile) ? readFile(caFile) : undefined,
    insecure: env.KUBE_INSECURE === '1',
    namespace,
    image,
    imagePullPolicy: policy === 'Always' || policy === 'Never' ? policy : 'IfNotPresent',
    secretName: env.PROJECT_WORKER_SECRET?.trim() || undefined,
    storageClass: env.PROJECT_WORKER_STORAGE_CLASS?.trim() || undefined,
    cpuRequest: env.PROJECT_WORKER_CPU_REQUEST?.trim() || '250m',
    memoryRequest: env.PROJECT_WORKER_MEMORY_REQUEST?.trim() || '512Mi',
    size: workerSize(env),
  }
}

export type KubeCall = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>

function kubeClient(config: KubernetesWorkerConfig): KubeCall {
  return async (method, path, body) => {
    const res = await fetch(`${config.apiUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${config.token}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': method === 'PATCH' ? 'application/strategic-merge-patch+json' : 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      tls: { ...(config.ca ? { ca: config.ca } : {}), rejectUnauthorized: !config.insecure },
    } as RequestInit)
    const text = await res.text()
    let parsed: unknown = text
    try { parsed = text ? JSON.parse(text) : undefined } catch { /* plain text */ }
    return { status: res.status, body: parsed }
  }
}

function kubeError(what: string, res: { status: number; body: any }): Error {
  const message = typeof res.body === 'object' && res.body?.message ? res.body.message : String(res.body ?? '').slice(0, 200)
  return new Error(`Kubernetes ${what}: ${res.status} ${message}`.trim())
}

/** The three objects a project worker is made of. */
export function kubernetesManifests(config: KubernetesWorkerConfig, spec: WorkerSpec): { pvc: object; deployment: object; service: object } {
  const labels = { ...MANAGED, app: spec.name, 'spaces.dev/project': spec.projectId }
  const claim = `${spec.name}-data`
  const env = { ...spec.env, ...(config.secretName ? {} : sharedSecrets()) }
  return {
    pvc: {
      apiVersion: 'v1', kind: 'PersistentVolumeClaim',
      metadata: { name: claim, labels },
      spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: `${config.size.diskGb}Gi` } }, ...(config.storageClass ? { storageClassName: config.storageClass } : {}) },
    },
    deployment: {
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: { name: spec.name, labels },
      spec: {
        replicas: 1,
        // One pod owns the ReadWriteOnce volume: the old one stops before the new one starts.
        strategy: { type: 'Recreate' },
        selector: { matchLabels: { app: spec.name } },
        template: {
          // The version annotation changes on every Spaces release, so patching it
          // replaces the pod even when the image tag (spaces:local) stays the same.
          metadata: { labels, annotations: { 'spaces.dev/version': spec.version } },
          spec: {
            terminationGracePeriodSeconds: 900,
            containers: [{
              name: 'worker',
              image: config.image,
              imagePullPolicy: config.imagePullPolicy,
              args: ['bun', 'run', 'src/standalone.ts'],
              ports: [{ name: 'http', containerPort: spec.port }],
              env: Object.entries(env).map(([name, value]) => ({ name, value })),
              ...(config.secretName ? { envFrom: [{ secretRef: { name: config.secretName } }] } : {}),
              resources: {
                requests: { cpu: config.cpuRequest, memory: config.memoryRequest },
                limits: { cpu: String(config.size.vcpus), memory: `${config.size.memoryGb}Gi` },
              },
              volumeMounts: [{ name: 'data', mountPath: '/data' }],
              readinessProbe: { httpGet: { path: '/health', port: spec.port }, initialDelaySeconds: 5, periodSeconds: 5 },
            }],
            volumes: [{ name: 'data', persistentVolumeClaim: { claimName: claim } }],
          },
        },
      },
    },
    service: {
      apiVersion: 'v1', kind: 'Service',
      metadata: { name: spec.name, labels },
      spec: { type: 'ClusterIP', selector: { app: spec.name }, ports: [{ name: 'http', port: spec.port, targetPort: spec.port }] },
    },
  }
}

export function kubernetesPlatform(config: KubernetesWorkerConfig, call: KubeCall = kubeClient(config)): WorkerPlatform {
  const ns = `/namespaces/${encodeURIComponent(config.namespace)}`
  const paths = {
    pvc: `/api/v1${ns}/persistentvolumeclaims`,
    deployment: `/apis/apps/v1${ns}/deployments`,
    service: `/api/v1${ns}/services`,
  }

  /** Create, treating "already exists" as done (a retry resumes). */
  async function ensure(kind: keyof typeof paths, body: object, dryRun = false): Promise<void> {
    const res = await call('POST', `${paths[kind]}${dryRun ? '?dryRun=All' : ''}`, body)
    if (res.status === 409 && !dryRun) return
    if (res.status >= 300) throw kubeError(`create ${kind}`, res)
  }
  async function remove(kind: keyof typeof paths, name: string): Promise<void> {
    const res = await call('DELETE', `${paths[kind]}/${encodeURIComponent(name)}`)
    if (res.status === 404) return
    if (res.status >= 300) throw kubeError(`delete ${kind}`, res)
  }

  return {
    kind: 'kubernetes',
    async create(spec, existing, record) {
      const manifests = kubernetesManifests(config, spec)
      if (!existing.volumeRef) {
        await ensure('pvc', manifests.pvc)
        await record({ volumeRef: `${spec.name}-data` })
      }
      await ensure('deployment', manifests.deployment)
      await ensure('service', manifests.service)
      if (!existing.serviceRef) await record({ serviceRef: spec.name })
      return { internalUrl: `http://${spec.name}.${config.namespace}.svc.cluster.local:${spec.port}` }
    },
    async update(spec, refs) {
      const name = refs.serviceRef ?? spec.name
      const res = await call('PATCH', `${paths.deployment}/${encodeURIComponent(name)}`, {
        spec: { template: { metadata: { annotations: { 'spaces.dev/version': spec.version } }, spec: { containers: [{ name: 'worker', image: config.image }] } } },
      })
      if (res.status >= 300) throw kubeError('update deployment', res)
    },
    async remove(spec, refs) {
      await remove('service', refs.serviceRef ?? spec.name)
      await remove('deployment', refs.serviceRef ?? spec.name)
      await remove('pvc', refs.volumeRef ?? `${spec.name}-data`)
    },
    async check(probe) {
      const list = await call('GET', `${paths.deployment}?labelSelector=${encodeURIComponent('spaces.dev/role=project-worker')}`).catch((error) => ({ status: 0, body: { message: error instanceof Error ? error.message : String(error) } }))
      if (list.status !== 200) return { canRead: false, error: kubeError('list deployments', list).message }
      const detail = `${(list.body?.items ?? []).length} project workers in namespace ${config.namespace}`
      if (!probe) return { canRead: true, detail }
      // Server-side dry run: the API checks permissions and admission for all
      // three objects without creating anything.
      try {
        const manifests = kubernetesManifests(config, { projectId: 'probe', name: `spaces-provisioner-probe-${Date.now().toString(36)}`, env: {}, port: 8080, version: 'probe' })
        await ensure('pvc', manifests.pvc, true)
        await ensure('deployment', manifests.deployment, true)
        await ensure('service', manifests.service, true)
        return { canRead: true, detail, canCreate: true }
      } catch (error) {
        return { canRead: true, detail, canCreate: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}
