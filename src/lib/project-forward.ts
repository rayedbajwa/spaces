/**
 * Forwarding project work from the web service to the project's worker
 * (specs/014-project-workers).
 *
 * In the `web` role there is no workspace disk, so anything project-scoped that
 * may read or write a workspace, run git or run an agent is sent to the
 * project's worker, which runs the same server code next to the project's disk.
 * The request goes through unchanged (the worker shares the database, so the
 * session cookie authenticates there too) with the internal token added.
 *
 * Forwarding is the default for project routes: a route wrongly forwarded only
 * costs a hop, a route wrongly kept would silently read "missing" files. Only
 * routes known to need nothing but the database stay on the web service.
 */

import { getDb } from './db'
import { log } from './logger'
import { INTERNAL_TOKEN_HEADER, internalToken, isWebRole } from './role'
import { getProjectWorker, provisionProjectWorker, workerPlatform } from './worker-provisioner'
import { wakeIfSleeping } from './worker-sleep'
import { hasLocalProjectFiles } from './project-migration'

const forwardLog = log.child({ mod: 'project-forward' })

/** Project routes (after /api/projects/:project) served from the database on the web service. */
const DATABASE_ONLY: Array<{ methods: string[]; rest: RegExp }> = [
  { methods: ['GET', 'PATCH'], rest: /^$/ },
  { methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], rest: /^\/responsibilities(\/.*)?$/ },
  { methods: ['POST'], rest: /^\/(archive|unarchive)$/ },
  { methods: ['POST', 'DELETE'], rest: /^\/integrations(\/[^/]+)?$/ },
  { methods: ['GET'], rest: /^\/usage$/ },
  { methods: ['GET', 'PATCH'], rest: /^\/orchestrator$/ },
  { methods: ['GET'], rest: /^\/jobs$/ },
  { methods: ['POST'], rest: /^\/jobs\/[^/]+\/kill$/ },
  { methods: ['GET', 'POST', 'PUT', 'DELETE'], rest: /^\/deployment(\/[^/]+)?$/ },
  { methods: ['GET'], rest: /^\/worker$/ },
]

export type ForwardTarget =
  | { kind: 'project'; idOrSlug: string }
  | { kind: 'run'; runId: string }
  | { kind: 'run-create' }

/**
 * Whether a request must run on the project's worker, and how to find the
 * project. Undefined: the web service handles it.
 */
export function forwardTarget(method: string, pathname: string): ForwardTarget | undefined {
  const project = /^\/api\/projects\/([^/]+)(\/.*)?$/.exec(pathname)
  if (project) {
    const idOrSlug = decodeURIComponent(project[1]!)
    if (idOrSlug === 'by-code') return undefined
    const rest = project[2] ?? ''
    if (DATABASE_ONLY.some((r) => r.methods.includes(method) && r.rest.test(rest))) return undefined
    return { kind: 'project', idOrSlug }
  }
  const run = /^\/api\/runs\/([^/]+)(\/.*)?$/.exec(pathname)
  if (run) return { kind: 'run', runId: decodeURIComponent(run[1]!) }
  if (method === 'POST' && pathname === '/api/runs') return { kind: 'run-create' }
  return undefined
}

/** The project a forward target belongs to. */
export async function resolveForwardProject(target: ForwardTarget, body?: unknown): Promise<string | undefined> {
  const sql = getDb()
  if (target.kind === 'project') {
    const isId = /^[0-9a-f-]{36}$/.test(target.idOrSlug)
    const [row] = isId
      ? await sql<Array<{ projectId: string }>>`SELECT project_id AS "projectId" FROM projects WHERE project_id = ${target.idOrSlug}`
      : await sql<Array<{ projectId: string }>>`SELECT project_id AS "projectId" FROM projects WHERE slug = ${target.idOrSlug}`
    return row?.projectId
  }
  if (target.kind === 'run') {
    const [row] = await sql<Array<{ projectId: string | null }>>`
      SELECT p.project_id AS "projectId" FROM pipeline_runs r JOIN projects p ON p.slug = r.project_namespace WHERE r.run_id = ${target.runId}
    `.catch(() => [] as Array<{ projectId: string | null }>)
    return row?.projectId ?? undefined
  }
  const projectId = (body as { projectId?: unknown } | undefined)?.projectId
  return typeof projectId === 'string' ? projectId : undefined
}

/** The private-network address of a project's worker. */
export async function workerBaseUrl(projectId: string): Promise<string | undefined> {
  const [row] = await getDb()<Array<{ internalUrl: string | null; code: string | null; slug: string }>>`
    SELECT w.internal_url AS "internalUrl", p.code, p.slug
      FROM projects p LEFT JOIN project_workers w ON w.project_id = p.project_id
     WHERE p.project_id = ${projectId}
  `
  if (!row) return undefined
  if (row.internalUrl) return row.internalUrl.replace(/\/+$/, '')
  // Before provisioning records a URL: a template such as
  // http://spaces-proj-{code}.railway.internal:3000 (or a local port in tests).
  const template = process.env.PROJECT_WORKER_URL_TEMPLATE?.trim()
  if (!template) return undefined
  return template
    .replaceAll('{projectId}', projectId)
    .replaceAll('{code}', (row.code ?? row.slug).toLowerCase())
    .replaceAll('{slug}', row.slug)
    .replace(/\/+$/, '')
}

const HOP_HEADERS = new Set(['host', 'connection', 'content-length', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'proxy-connection', INTERNAL_TOKEN_HEADER])

export interface ForwardOptions {
  /** How long to keep retrying a worker that is waking up (502/503, refused). */
  wakeTimeoutMs?: number
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

const DEFAULT_WAKE_TIMEOUT_MS = 30_000
/** A worker Spaces stopped (Kubernetes) needs its pod scheduled and started. */
const STOPPED_WAKE_TIMEOUT_MS = 180_000

function unavailable(code: 'worker_unavailable' | 'worker_waking' | 'worker_provisioning', message: string): Response {
  return new Response(JSON.stringify({ error: message, code }), { status: 503, headers: { 'content-type': 'application/json; charset=utf-8', 'retry-after': '5' } })
}

/**
 * Send a request to the project's worker and stream its answer back. A sleeping
 * worker answers 502/503 or refuses the connection while it starts, so those
 * are retried with backoff until the wake timeout.
 */
export async function forwardToProject(req: Request, projectId: string, body: ArrayBuffer | undefined, options: ForwardOptions = {}): Promise<Response> {
  const base = await workerBaseUrl(projectId)
  const token = internalToken()
  if (!token) return unavailable('worker_unavailable', 'Project workers are not configured (SPACES_INTERNAL_TOKEN).')
  if (!base) {
    // First use of a project that has no worker yet: create it, and say so —
    // unless its files are still on this service's disk (not moved yet): an
    // empty worker would hide them, and a project with an active worker can
    // no longer be moved.
    if (workerPlatform() && await hasLocalProjectFiles(projectId)) {
      return unavailable('worker_unavailable', "This project's files are still on the shared service. Move it first: account menu → Project workers → Existing projects → Move.")
    }
    if (workerPlatform()) {
      const worker = await getProjectWorker(projectId)
      if (worker?.state === 'failed' && worker.lastError) return unavailable('worker_unavailable', `This project's worker could not be created: ${worker.lastError}`)
      void provisionProjectWorker(projectId).catch(() => undefined)
      return unavailable('worker_provisioning', "This project's worker is being set up. It takes a few minutes the first time.")
    }
    return unavailable('worker_unavailable', 'This project has no worker yet.')
  }
  // A worker Spaces stopped while idle is started first, and given time to come up.
  const started = await wakeIfSleeping(projectId).catch(() => false)
  const url = new URL(req.url)
  const target = `${base}${url.pathname}${url.search}`
  const headers = new Headers()
  req.headers.forEach((value, key) => { if (!HOP_HEADERS.has(key.toLowerCase())) headers.set(key, value) })
  headers.set(INTERNAL_TOKEN_HEADER, token)
  if (!headers.has('x-forwarded-host')) headers.set('x-forwarded-host', url.host)
  if (!headers.has('x-forwarded-proto')) headers.set('x-forwarded-proto', url.protocol.replace(':', ''))

  const doFetch = options.fetchImpl ?? fetch
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const deadline = Date.now() + Math.max(options.wakeTimeoutMs ?? DEFAULT_WAKE_TIMEOUT_MS, started ? STOPPED_WAKE_TIMEOUT_MS : 0)
  let delay = 500
  for (;;) {
    try {
      const res = await doFetch(target, { method: req.method, headers, body: body && body.byteLength > 0 ? body : undefined, redirect: 'manual', signal: req.signal })
      if ((res.status !== 502 && res.status !== 503) || Date.now() >= deadline) return passThrough(res)
      await res.body?.cancel().catch(() => undefined)
    } catch (error) {
      if (req.signal?.aborted) return unavailable('worker_unavailable', 'The request was cancelled.')
      if (Date.now() >= deadline) {
        forwardLog.warn('project worker unreachable', { projectId, error: error instanceof Error ? error.message : String(error) })
        return unavailable('worker_waking', "This project's worker is starting. Try again in a moment.")
      }
    }
    await sleep(delay)
    delay = Math.min(delay * 2, 4_000)
  }
}

function passThrough(res: Response): Response {
  const headers = new Headers(res.headers)
  // fetch already decoded the body; the length and encoding no longer apply.
  headers.delete('content-encoding')
  headers.delete('content-length')
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

/**
 * Call a project worker's internal API and read its JSON answer. Undefined when
 * it cannot be reached within the timeout (the caller falls back to stored data).
 */
export async function callProjectWorker<T>(projectId: string, path: string, init: { method?: string; body?: unknown; timeoutMs?: number; wakeTimeoutMs?: number; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {}): Promise<T | undefined> {
  const base = await workerBaseUrl(projectId)
  const token = internalToken()
  if (!base || !token) return undefined
  const sleep = init.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  // Only a caller that waits for a waking worker starts a stopped one: reads
  // that just decorate the board must not keep idle workers running.
  const started = (init.wakeTimeoutMs ?? 0) > 0 && await wakeIfSleeping(projectId).catch(() => false)
  const deadline = Date.now() + Math.max(init.wakeTimeoutMs ?? 0, started ? STOPPED_WAKE_TIMEOUT_MS : 0)
  let delay = 500
  for (;;) {
    try {
      const res = await (init.fetchImpl ?? fetch)(`${base}${path}`, {
        method: init.method ?? 'GET',
        headers: { [INTERNAL_TOKEN_HEADER]: token, ...(init.body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(init.timeoutMs ?? 5_000),
      })
      if (res.ok) return (await res.json()) as T
      // Waking (502/503) is worth waiting for; any other answer is final.
      if (res.status !== 502 && res.status !== 503) return undefined
    } catch {
      // Refused or timed out: the worker may be starting.
    }
    if (Date.now() >= deadline) return undefined
    await sleep(delay)
    delay = Math.min(delay * 2, 4_000)
  }
}

const activeCache = new Map<string, { at: number; active: boolean }>()

/**
 * Whether a project's work runs on its own worker: always in the web role; in
 * the shared (`all`) role only for projects already moved to one (phase 5).
 */
export async function isRemoteProject(projectId: string): Promise<boolean> {
  if (isWebRole()) return true
  const cached = activeCache.get(projectId)
  if (cached && Date.now() - cached.at < 10_000) return cached.active
  const [row] = await getDb()<Array<{ active: boolean }>>`SELECT active FROM project_workers WHERE project_id = ${projectId} AND active AND internal_url IS NOT NULL`
  const active = Boolean(row?.active)
  activeCache.set(projectId, { at: Date.now(), active })
  return active
}

/** Forget cached answers (a project was just moved). */
export function forgetRemoteProject(projectId: string): void {
  activeCache.delete(projectId)
}
