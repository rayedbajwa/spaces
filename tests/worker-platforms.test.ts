import { describe, expect, test } from 'bun:test'
import { dockerContainer, dockerPlatform, dockerWorkerConfig, type DockerCall } from '../src/lib/worker-platform-docker'
import { kubernetesManifests, kubernetesPlatform, kubernetesWorkerConfig, type KubeCall, type KubernetesWorkerConfig } from '../src/lib/worker-platform-kubernetes'
import type { WorkerRefs, WorkerSpec } from '../src/lib/worker-platform'

/** 014-project-workers: project workers on Kubernetes (minikube) and the local Docker engine. */

const spec: WorkerSpec = { projectId: 'p-1', name: 'spaces-proj-defa-1', port: 8080, version: 'abc1234', env: { SPACES_ROLE: 'project', WORKER_PROJECT_ID: 'p-1', PORT: '8080' } }

function recorder() {
  const refs: WorkerRefs = { serviceRef: null, volumeRef: null }
  return { refs, record: async (r: Partial<WorkerRefs>) => { Object.assign(refs, r) } }
}

function fake(answers: Record<string, number> = {}) {
  const calls: Array<{ method: string; path: string; body: any }> = []
  const call = async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body })
    const key = `${method} ${path.split('?')[0]}`
    const status = answers[key] ?? (method === 'POST' ? 201 : 200)
    return { status, body: method === 'GET' ? (path.startsWith('/containers') ? [{ Id: 'a' }] : { items: [{}, {}] }) : {} }
  }
  return { calls, call: call as KubeCall & DockerCall }
}

describe('kubernetes', () => {
  const config: KubernetesWorkerConfig = {
    apiUrl: 'https://kube', token: 't', insecure: false, namespace: 'spaces', image: 'spaces:local', imagePullPolicy: 'Never',
    secretName: 'spaces-secrets', cpuRequest: '250m', memoryRequest: '512Mi', size: { vcpus: 2, memoryGb: 2, diskGb: 5 },
  }

  test('config: needs an image, and a cluster service account or KUBE_API_URL with KUBE_TOKEN', () => {
    expect(kubernetesWorkerConfig({ KUBE_API_URL: 'https://k', KUBE_TOKEN: 't' })).toBeUndefined()
    expect(kubernetesWorkerConfig({ PROJECT_WORKER_IMAGE: 'spaces:local', KUBE_API_URL: 'https://k/', KUBE_TOKEN: 't', PROJECT_WORKER_IMAGE_PULL_POLICY: 'Never' }))
      .toMatchObject({ apiUrl: 'https://k', namespace: 'spaces', imagePullPolicy: 'Never', size: { vcpus: 2, memoryGb: 2, diskGb: 5 } })
  })

  test('a worker is a 5Gi claim, a one-replica Recreate deployment of the image and a ClusterIP service', () => {
    const m = kubernetesManifests(config, spec) as any
    expect(m.pvc.spec.resources.requests.storage).toBe('5Gi')
    expect(m.deployment.spec).toMatchObject({ replicas: 1, strategy: { type: 'Recreate' } })
    const container = m.deployment.spec.template.spec.containers[0]
    expect(container).toMatchObject({ image: 'spaces:local', imagePullPolicy: 'Never', args: ['bun', 'run', 'src/standalone.ts'], envFrom: [{ secretRef: { name: 'spaces-secrets' } }] })
    expect(container.resources.limits).toEqual({ cpu: '2', memory: '2Gi' })
    expect(container.env).toContainEqual({ name: 'SPACES_ROLE', value: 'project' })
    expect(container.env.find((e: any) => e.name === 'DATABASE_URL')).toBeUndefined() // from the Secret
    expect(m.service.spec).toMatchObject({ type: 'ClusterIP', ports: [{ port: 8080 }] })
  })

  test('create makes the claim, deployment and service, records refs, and gives the cluster address', async () => {
    const api = fake()
    const r = recorder()
    const { internalUrl } = await kubernetesPlatform(config, api.call).create(spec, r.refs, r.record)
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /api/v1/namespaces/spaces/persistentvolumeclaims', 'POST /apis/apps/v1/namespaces/spaces/deployments', 'POST /api/v1/namespaces/spaces/services',
    ])
    expect(r.refs).toEqual({ serviceRef: 'spaces-proj-defa-1', volumeRef: 'spaces-proj-defa-1-data' })
    expect(internalUrl).toBe('http://spaces-proj-defa-1.spaces.svc.cluster.local:8080')
  })

  test('objects that already exist are kept (a retry resumes); other errors fail', async () => {
    const r = recorder()
    await kubernetesPlatform(config, fake({ 'POST /apis/apps/v1/namespaces/spaces/deployments': 409 }).call).create(spec, r.refs, r.record)
    await expect(kubernetesPlatform(config, fake({ 'POST /api/v1/namespaces/spaces/services': 403 }).call).create(spec, recorder().refs, recorder().record)).rejects.toThrow('403')
  })

  test('an update patches the version annotation and image, so the pod is replaced', async () => {
    const api = fake()
    await kubernetesPlatform(config, api.call).update({ ...spec, version: 'def5678' }, { serviceRef: 'spaces-proj-defa-1', volumeRef: null })
    expect(api.calls[0]).toMatchObject({ method: 'PATCH', path: '/apis/apps/v1/namespaces/spaces/deployments/spaces-proj-defa-1' })
    expect(api.calls[0]!.body.spec.template.metadata.annotations['spaces.dev/version']).toBe('def5678')
    expect(api.calls[0]!.body.spec.template.spec.containers[0].image).toBe('spaces:local')
  })

  test('an update leaves the replicas alone, so a stopped worker stays stopped', async () => {
    const api = fake()
    await kubernetesPlatform(config, api.call).update({ ...spec, version: 'def5678' }, { serviceRef: 'spaces-proj-defa-1', volumeRef: null })
    expect(api.calls[0]!.body.spec.replicas).toBeUndefined()
    // Every update replaces the pod, even when the template already names the version.
    expect(Date.parse(api.calls[0]!.body.spec.template.metadata.annotations['kubectl.kubernetes.io/restartedAt'])).toBeGreaterThan(0)
  })

  test('scale sets the Deployment replicas (stop or start, the claim stays)', async () => {
    const api = fake()
    const platform = kubernetesPlatform(config, api.call)
    await platform.scale!(spec, { serviceRef: 'spaces-proj-defa-1', volumeRef: 'spaces-proj-defa-1-data' }, 0)
    await platform.scale!(spec, { serviceRef: 'spaces-proj-defa-1', volumeRef: 'spaces-proj-defa-1-data' }, 1)
    expect(api.calls).toEqual([
      { method: 'PATCH', path: '/apis/apps/v1/namespaces/spaces/deployments/spaces-proj-defa-1', body: { spec: { replicas: 0 } } },
      { method: 'PATCH', path: '/apis/apps/v1/namespaces/spaces/deployments/spaces-proj-defa-1', body: { spec: { replicas: 1 } } },
    ])
    await expect(kubernetesPlatform(config, fake({ 'PATCH /apis/apps/v1/namespaces/spaces/deployments/spaces-proj-defa-1': 403 }).call).scale!(spec, { serviceRef: 'spaces-proj-defa-1', volumeRef: null }, 0)).rejects.toThrow('scale deployment to 0')
  })

  test('the probe is a server-side dry run; remove deletes all three, ignoring ones already gone', async () => {
    const api = fake()
    const check = await kubernetesPlatform(config, api.call).check(true)
    expect(check).toMatchObject({ canRead: true, canCreate: true })
    expect(api.calls.filter((c) => c.method === 'POST').every((c) => c.path.endsWith('?dryRun=All'))).toBe(true)
    const gone = fake({ 'DELETE /api/v1/namespaces/spaces/services/spaces-proj-defa-1': 404 })
    await kubernetesPlatform(config, gone.call).remove(spec, { serviceRef: 'spaces-proj-defa-1', volumeRef: 'spaces-proj-defa-1-data' })
    expect(gone.calls.map((c) => c.method)).toEqual(['DELETE', 'DELETE', 'DELETE'])
  })
})

describe('docker', () => {
  const config = { socketPath: '/var/run/docker.sock', image: 'spaces:local', network: 'spaces_default', size: { vcpus: 2, memoryGb: 2, diskGb: 5 } }

  test('config: needs an image and the compose network', () => {
    expect(dockerWorkerConfig({ PROJECT_WORKER_IMAGE: 'spaces:local' })).toBeUndefined()
    expect(dockerWorkerConfig({ PROJECT_WORKER_IMAGE: 'spaces:local', PROJECT_WORKER_DOCKER_NETWORK: 'net' })).toMatchObject({ socketPath: '/var/run/docker.sock', network: 'net' })
  })

  test('a worker is a named volume and a container on the network, reachable by its name', async () => {
    const container = dockerContainer(config, spec) as any
    expect(container.HostConfig).toMatchObject({ NetworkMode: 'spaces_default', NanoCpus: 2e9, Memory: 2 * 1024 ** 3, Mounts: [{ Source: 'spaces-proj-defa-1-data', Target: '/data' }] })
    expect(container.Env).toContain('SPACES_ROLE=project')
    const api = fake()
    const r = recorder()
    const { internalUrl } = await dockerPlatform(config, api.call).create(spec, r.refs, r.record)
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /volumes/create', 'POST /containers/create?name=spaces-proj-defa-1', 'POST /containers/spaces-proj-defa-1/start'])
    expect(internalUrl).toBe('http://spaces-proj-defa-1:8080')
    expect(r.refs).toEqual({ serviceRef: 'spaces-proj-defa-1', volumeRef: 'spaces-proj-defa-1-data' })
  })

  test('an existing container is started again; remove force-deletes the container and its volume', async () => {
    const r = recorder()
    await dockerPlatform(config, fake({ 'POST /containers/create': 409, 'POST /containers/spaces-proj-defa-1/start': 304 }).call).create(spec, r.refs, r.record)
    const api = fake()
    await dockerPlatform(config, api.call).remove(spec, { serviceRef: 'spaces-proj-defa-1', volumeRef: 'spaces-proj-defa-1-data' })
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['DELETE /containers/spaces-proj-defa-1?force=true', 'DELETE /volumes/spaces-proj-defa-1-data'])
  })

  test('an update replaces the container on the same volume', async () => {
    const api = fake()
    await dockerPlatform(config, api.call).update(spec, { serviceRef: 'spaces-proj-defa-1', volumeRef: 'spaces-proj-defa-1-data' })
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['DELETE /containers/spaces-proj-defa-1?force=true', 'POST /containers/create?name=spaces-proj-defa-1', 'POST /containers/spaces-proj-defa-1/start'])
    expect(api.calls[1]!.body.HostConfig.Mounts[0].Source).toBe('spaces-proj-defa-1-data')
  })

  test('the check lists worker containers; the probe makes and removes a volume', async () => {
    const api = fake()
    expect(await dockerPlatform(config, api.call).check(true)).toMatchObject({ canRead: true, canCreate: true, detail: '1 project worker containers on spaces_default' })
    expect(api.calls.map((c) => c.method)).toEqual(['GET', 'POST', 'DELETE'])
  })
})
