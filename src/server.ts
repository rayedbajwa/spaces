import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, normalize } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { ensureFrontendBuilt } from './build-web'
import {
  buildDefaultStages,
  getDryRunPlan,
  normalizeThinkingLevel,
  parseStages,
  PDLCFlow,
  resolveCwd,
  type FlowOptions,
  type PauseKind,
  type StageName,
} from './lib/pdlc'

const srcDir = dirname(fileURLToPath(import.meta.url))
const webDir = join(srcDir, 'web')
const publicDir = join(srcDir, '..', 'public')
const port = Number(process.env.PORT ?? '3000')
const runs = new Map<string, RunRecord>()

await ensureFrontendBuilt()

const server = createServer(async (req, res) => {
  try {
    await route(req, res)
  } catch (error) {
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : String(error),
    })
  }
})

server.listen(port, () => {
  console.log(`PDLC web UI running at http://localhost:${port}`)
  console.log(`Serving frontend assets from ${publicDir}`)
})

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET'
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

  if (method === 'GET' && url.pathname === '/') {
    const html = await readFile(join(webDir, 'index.html'), 'utf8')
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
    return
  }

  if (method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { ok: true })
    return
  }

  if (method === 'GET' && url.pathname === '/api/runs/:example') {
    sendJson(res, 404, { error: 'Not found.' })
    return
  }

  if (method === 'GET' && url.pathname.startsWith('/api/runs/')) {
    const parts = url.pathname.split('/').filter(Boolean)
    const runId = parts[2]
    const action = parts[3]
    const record = runId ? runs.get(runId) : undefined

    if (!record) {
      sendJson(res, 404, { error: 'Run not found.' })
      return
    }

    if (action === 'events') {
      attachEventStream(req, res, record)
      return
    }

    sendJson(res, 200, record.snapshot)
    return
  }

  if (method === 'POST' && url.pathname === '/api/runs') {
    const body = await readJson<CreateRunRequest>(req)
    const options = toFlowOptions(body)
    const stages = toStages(body)

    if (body.dryRun) {
      sendJson(res, 200, {
        status: 'dry-run',
        plan: getDryRunPlan(options, stages),
      })
      return
    }

    const record = createRunRecord(options, stages)
    runs.set(record.runId, record)
    void startFlow(record)

    sendJson(res, 202, record.snapshot)
    return
  }

  if (method === 'POST' && /^\/api\/runs\/[^/]+\/answer$/.test(url.pathname)) {
    const parts = url.pathname.split('/').filter(Boolean)
    const runId = parts[2]
    const record = runId ? runs.get(runId) : undefined

    if (!record) {
      sendJson(res, 404, { error: 'Run not found.' })
      return
    }

    if (record.snapshot.status !== 'paused') {
      sendJson(res, 409, { error: 'Run is not waiting for clarification.' })
      return
    }

    const body = await readJson<AnswerRunRequest>(req)
    const answer = body.answer?.trim()
    if (!answer) {
      sendJson(res, 400, { error: 'Answer is required.' })
      return
    }

    void resumeFlow(record, answer)
    sendJson(res, 202, record.snapshot)
    return
  }

  if (method === 'GET') {
    const served = await tryServeStaticAsset(url.pathname, res)
    if (served) {
      return
    }
  }

  sendJson(res, 404, { error: 'Not found.' })
}

function createRunRecord(options: FlowOptions, stages: StageName[]): RunRecord {
  const runId = randomUUID()
  const snapshot: RunSnapshot = {
    runId,
    status: 'running',
    stage: stages[0],
    log: '',
  }

  const listeners = new Set<(snapshot: RunSnapshot) => void>()
  const flow = new PDLCFlow(options, stages, {
    stdout: (chunk) => appendLog(snapshot, listeners, chunk),
    stderr: (chunk) => appendLog(snapshot, listeners, chunk),
  })

  return {
    runId,
    flow,
    snapshot,
    listeners,
    stages,
    active: false,
  }
}

async function startFlow(record: RunRecord): Promise<void> {
  record.active = true
  emit(record)

  try {
    const result = await record.flow.start()
    applyFlowProgress(record, result)
  } catch (error) {
    applyRunError(record, error)
  }
}

async function resumeFlow(record: RunRecord, answer: string): Promise<void> {
  record.active = true
  record.snapshot.status = 'running'
  record.snapshot.pauseKind = undefined
  record.snapshot.error = undefined
  emit(record)

  try {
    const result = await record.flow.answer(answer)
    applyFlowProgress(record, result)
  } catch (error) {
    applyRunError(record, error)
  }
}

function applyFlowProgress(record: RunRecord, result: {
  status: 'paused' | 'completed'
  stage?: StageName
  pauseKind?: PauseKind
  log: string
  sessionFile?: string
}): void {
  record.active = false
  record.snapshot.log = result.log
  record.snapshot.stage = result.stage
  record.snapshot.sessionFile = result.sessionFile
  record.snapshot.status = result.status
  record.snapshot.pauseKind = result.pauseKind
  record.snapshot.error = undefined
  emit(record)

  if (result.status === 'completed') {
    scheduleCleanup(record.runId)
  }
}

function applyRunError(record: RunRecord, error: unknown): void {
  record.active = false
  record.snapshot.status = 'error'
  record.snapshot.error = error instanceof Error ? error.message : String(error)
  emit(record)
  scheduleCleanup(record.runId)
}

function appendLog(
  snapshot: RunSnapshot,
  listeners: Set<(snapshot: RunSnapshot) => void>,
  chunk: string,
): void {
  snapshot.log += chunk
  for (const listener of listeners) {
    listener({ ...snapshot })
  }
}

function emit(record: RunRecord): void {
  const next = { ...record.snapshot }
  for (const listener of record.listeners) {
    listener(next)
  }
}

function attachEventStream(req: IncomingMessage, res: ServerResponse, record: RunRecord): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  })

  const send = (snapshot: RunSnapshot) => {
    res.write(`data: ${JSON.stringify(snapshot)}\n\n`)
  }

  record.listeners.add(send)
  send(record.snapshot)

  const heartbeat = setInterval(() => {
    res.write(': keep-alive\n\n')
  }, 15000)

  req.on('close', () => {
    clearInterval(heartbeat)
    record.listeners.delete(send)
  })
}

async function tryServeStaticAsset(pathname: string, res: ServerResponse): Promise<boolean> {
  const relativePath = pathname.replace(/^\/+/, '')
  if (!relativePath) {
    return false
  }

  const normalizedPath = normalize(relativePath)
  if (!normalizedPath || normalizedPath.startsWith('..') || normalizedPath.includes('..')) {
    return false
  }

  const filePath = join(publicDir, normalizedPath)

  try {
    const content = await readFile(filePath)
    res.writeHead(200, { 'content-type': getContentType(filePath) })
    res.end(content)
    return true
  } catch (error) {
    console.warn(`Static asset miss for ${pathname}: ${filePath}`, error)
    return false
  }
}

function scheduleCleanup(runId: string): void {
  setTimeout(async () => {
    const record = runs.get(runId)
    if (!record || record.active) {
      return
    }
    await record.flow.dispose()
    runs.delete(runId)
  }, 5 * 60 * 1000)
}

function toStages(body: CreateRunRequest): StageName[] {
  return body.stages
    ? parseStages(body.stages)
    : buildDefaultStages({
        withConstitution: body.withConstitution,
        withClarify: body.withClarify,
        withImplement: body.withImplement,
      })
}

function toFlowOptions(body: CreateRunRequest): FlowOptions {
  return {
    cwd: resolveCwd(body.cwd),
    feature: body.feature?.trim(),
    constitution: body.constitution?.trim(),
    planContext: body.planContext?.trim(),
    checklistDomain: body.checklistDomain?.trim(),
    model: body.model?.trim(),
    thinking: normalizeThinkingLevel(body.thinking),
    persistSession: body.persistSession === true,
    nonInteractive: false,
    reviewHarness: body.reviewHarness !== false,
    humanInLoop: body.humanInLoop !== false,
    verbose: body.verbose === true,
  }
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = []

  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim()
  return raw ? (JSON.parse(raw) as T) : ({} as T)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function getContentType(filePath: string): string {
  switch (extname(filePath)) {
    case '.js':
      return 'text/javascript; charset=utf-8'
    case '.css':
      return 'text/css; charset=utf-8'
    case '.html':
      return 'text/html; charset=utf-8'
    case '.json':
      return 'application/json; charset=utf-8'
    default:
      return 'application/octet-stream'
  }
}

interface RunRecord {
  runId: string
  flow: PDLCFlow
  snapshot: RunSnapshot
  listeners: Set<(snapshot: RunSnapshot) => void>
  stages: StageName[]
  active: boolean
}

interface RunSnapshot {
  runId: string
  status: 'running' | 'paused' | 'completed' | 'error'
  stage?: StageName
  pauseKind?: PauseKind
  log: string
  sessionFile?: string
  error?: string
}

interface CreateRunRequest {
  cwd?: string
  feature?: string
  constitution?: string
  planContext?: string
  checklistDomain?: string
  stages?: string
  model?: string
  thinking?: string
  withConstitution?: boolean
  withClarify?: boolean
  withImplement?: boolean
  persistSession?: boolean
  reviewHarness?: boolean
  humanInLoop?: boolean
  dryRun?: boolean
  verbose?: boolean
}

interface AnswerRunRequest {
  answer?: string
}
