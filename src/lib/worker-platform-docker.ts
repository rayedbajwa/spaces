/**
 * Project workers on the local Docker engine, for engineers: per project a
 * named volume for /data and a container on the compose network, reachable by
 * its name. Talks to the Docker Engine API over its unix socket (mounted into
 * the web container by docker-compose.workers.yml).
 */

import { workerSize, sharedSecrets, type WorkerPlatform, type WorkerSize, type WorkerSpec } from './worker-platform'

const LABELS = { 'spaces.dev/role': 'project-worker', 'app.kubernetes.io/managed-by': 'spaces' }

export interface DockerWorkerConfig {
  socketPath: string
  image: string
  /** The network the web service is on; workers join it and are reached by name. */
  network: string
  size: WorkerSize
}

export function dockerWorkerConfig(env: NodeJS.ProcessEnv = process.env): DockerWorkerConfig | undefined {
  const image = env.PROJECT_WORKER_IMAGE?.trim()
  const network = env.PROJECT_WORKER_DOCKER_NETWORK?.trim()
  if (!image || !network) return undefined
  return { socketPath: env.DOCKER_SOCKET?.trim() || '/var/run/docker.sock', image, network, size: workerSize(env) }
}

export type DockerCall = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>

function dockerClient(config: DockerWorkerConfig): DockerCall {
  return async (method, path, body) => {
    const res = await fetch(`http://docker${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      unix: config.socketPath,
    } as RequestInit)
    const text = await res.text()
    let parsed: unknown = text
    try { parsed = text ? JSON.parse(text) : undefined } catch { /* plain text */ }
    return { status: res.status, body: parsed }
  }
}

function dockerError(what: string, res: { status: number; body: any }): Error {
  const message = typeof res.body === 'object' && res.body?.message ? res.body.message : String(res.body ?? '').slice(0, 200)
  return new Error(`Docker ${what}: ${res.status} ${message}`.trim())
}

/** The container definition for a project worker. */
export function dockerContainer(config: DockerWorkerConfig, spec: WorkerSpec): object {
  const env = { ...spec.env, ...sharedSecrets() }
  return {
    Image: config.image,
    Cmd: ['bun', 'run', 'src/standalone.ts'],
    Env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
    Labels: { ...LABELS, 'spaces.dev/project': spec.projectId },
    ExposedPorts: { [`${spec.port}/tcp`]: {} },
    StopTimeout: 900,
    HostConfig: {
      Mounts: [{ Type: 'volume', Source: `${spec.name}-data`, Target: '/data' }],
      RestartPolicy: { Name: 'unless-stopped' },
      NanoCpus: Math.round(config.size.vcpus * 1e9),
      Memory: Math.round(config.size.memoryGb * 1024 ** 3),
      NetworkMode: config.network,
    },
    NetworkingConfig: { EndpointsConfig: { [config.network]: { Aliases: [spec.name] } } },
  }
}

export function dockerPlatform(config: DockerWorkerConfig, call: DockerCall = dockerClient(config)): WorkerPlatform {
  return {
    kind: 'docker',
    async create(spec, existing, record) {
      const volume = `${spec.name}-data`
      if (!existing.volumeRef) {
        const res = await call('POST', '/volumes/create', { Name: volume, Labels: { ...LABELS, 'spaces.dev/project': spec.projectId } })
        if (res.status >= 300) throw dockerError('create volume', res)
        await record({ volumeRef: volume })
      }
      const created = await call('POST', `/containers/create?name=${encodeURIComponent(spec.name)}`, dockerContainer(config, spec))
      if (created.status >= 300 && created.status !== 409) throw dockerError('create container', created)
      if (!existing.serviceRef) await record({ serviceRef: spec.name })
      const started = await call('POST', `/containers/${encodeURIComponent(spec.name)}/start`)
      if (started.status >= 300 && started.status !== 304) throw dockerError('start container', started)
      return { internalUrl: `http://${spec.name}:${spec.port}` }
    },
    async remove(spec, refs) {
      const container = await call('DELETE', `/containers/${encodeURIComponent(refs.serviceRef ?? spec.name)}?force=true`)
      if (container.status >= 300 && container.status !== 404) throw dockerError('remove container', container)
      const volume = await call('DELETE', `/volumes/${encodeURIComponent(refs.volumeRef ?? `${spec.name}-data`)}`)
      if (volume.status >= 300 && volume.status !== 404) throw dockerError('remove volume', volume)
    },
    async check(probe) {
      const list = await call('GET', `/containers/json?all=true&filters=${encodeURIComponent(JSON.stringify({ label: ['spaces.dev/role=project-worker'] }))}`)
        .catch((error) => ({ status: 0, body: { message: error instanceof Error ? error.message : String(error) } }))
      if (list.status !== 200) return { canRead: false, error: dockerError('list containers', list).message }
      const detail = `${(list.body ?? []).length} project worker containers on ${config.network}`
      if (!probe) return { canRead: true, detail }
      const name = `spaces-provisioner-probe-${Date.now().toString(36)}`
      const made = await call('POST', '/volumes/create', { Name: name, Labels: LABELS })
      if (made.status >= 300) return { canRead: true, detail, canCreate: false, error: dockerError('create volume', made).message }
      await call('DELETE', `/volumes/${encodeURIComponent(name)}`).catch(() => undefined)
      return { canRead: true, detail, canCreate: true }
    },
  }
}
