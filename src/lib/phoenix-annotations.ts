/**
 * Run outcomes and people's decisions as Phoenix annotations.
 *
 * A run is a Phoenix session (lib/tracing.ts), so what happens to it beyond
 * the agents' turns is recorded on the session:
 *
 *   - `run-status`: the run's status on every change (running, paused for
 *     review or clarification, completed, error, cancelled), with the stage
 *     and the error;
 *   - `run-cost`: when the run ends, its cost in USD with tokens and model
 *     calls by stage (from the run's usage events);
 *   - `human-decision`: each answer a person gives at a gate (approve, approve
 *     with notes, request changes, a clarification answer), by whom and with
 *     what they wrote, as a HUMAN annotation.
 *
 * `ensureAnnotationConfigs` registers these (and `turn-quality`, for rating
 * turns by hand) so Phoenix shows them with their labels and scales.
 *
 * Off unless tracing is (PHOENIX_COLLECTOR_ENDPOINT). Text is masked like the
 * spans. Never throws: a failed annotation is logged and dropped.
 */

import { getDb } from './db'
import { maskOutput, redactSecretValues } from './guardrails'
import { log } from './logger'
import { tracingEndpoint } from './tracing'

const annotationLog = log.child({ mod: 'phoenix-annotations' })

const MAX_TEXT = 4_000

export interface SessionAnnotation {
  name: string
  kind: 'HUMAN' | 'CODE' | 'LLM'
  label?: string | null
  score?: number | null
  explanation?: string | null
  /** Distinguishes annotations of the same name on one session (one per gate); empty = one, replaced. */
  identifier?: string
  metadata?: Record<string, unknown>
}

type Fetch = typeof fetch

function scrub(text: string): string {
  const masked = redactSecretValues(maskOutput(text))
  return masked.length > MAX_TEXT ? `${masked.slice(0, MAX_TEXT)}…` : masked
}

async function phoenix(path: string, init: RequestInit, fetchImpl: Fetch = fetch): Promise<Response | undefined> {
  const endpoint = tracingEndpoint()
  if (!endpoint) return undefined
  const key = process.env.PHOENIX_API_KEY?.trim()
  return fetchImpl(`${endpoint}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}), ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(10_000),
  })
}

/** Record annotations on a run's Phoenix session. */
export async function annotateRun(runId: string, annotations: SessionAnnotation[], fetchImpl?: Fetch): Promise<void> {
  if (!tracingEndpoint() || annotations.length === 0) return
  try {
    const response = await phoenix('/v1/session_annotations', {
      method: 'POST',
      body: JSON.stringify({
        data: annotations.map((a) => ({
          session_id: runId,
          name: a.name,
          annotator_kind: a.kind,
          identifier: a.identifier ?? '',
          result: { label: a.label ?? null, score: a.score ?? null, explanation: a.explanation ? scrub(a.explanation) : null },
          metadata: a.metadata ?? {},
        })),
      }),
    }, fetchImpl)
    if (response && !response.ok) annotationLog.warn('Phoenix refused a run annotation', { runId, status: response.status, body: (await response.text()).slice(0, 300) })
  } catch (error) {
    annotationLog.warn('run annotation not sent', { runId, error: error instanceof Error ? error.message : String(error) })
  }
}

const ENDED = new Set(['completed', 'error', 'cancelled'])

/** On a status change: the status, and the cost once the run has ended. */
export async function reportRunStatus(runId: string, change: { status: string; pauseKind?: string | null; stage?: string | null; error?: string | null }, fetchImpl?: Fetch): Promise<void> {
  if (!tracingEndpoint()) return
  const label = change.status === 'paused' && change.pauseKind ? `paused (${change.pauseKind})` : change.status
  const annotations: SessionAnnotation[] = [{
    name: 'run-status',
    kind: 'CODE',
    label,
    score: change.status === 'completed' ? 1 : change.status === 'error' ? 0 : null,
    explanation: change.error || (change.stage ? `stage ${change.stage}` : null),
    metadata: { status: change.status, pauseKind: change.pauseKind ?? null, stage: change.stage ?? null, at: new Date().toISOString() },
  }]
  if (ENDED.has(change.status)) {
    const cost = await runCost(runId).catch(() => undefined)
    if (cost) annotations.push({ name: 'run-cost', kind: 'CODE', label: `$${cost.costUsd.toFixed(4)}`, score: cost.costUsd, explanation: `${cost.calls} model calls, ${cost.inputTokens} input and ${cost.outputTokens} output tokens`, metadata: { ...cost } })
  }
  await annotateRun(runId, annotations, fetchImpl)
}

export interface RunCost {
  costUsd: number
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  byStage: Record<string, { costUsd: number; calls: number }>
}

/** What a run cost, from its usage events. */
export async function runCost(runId: string): Promise<RunCost | undefined> {
  const rows = await getDb()<Array<{ stage: string | null; cost: number; calls: number; input: number; output: number; cacheRead: number }>>`
    SELECT payload->>'stage' AS stage,
           coalesce(sum((payload->>'costUsd')::float8), 0) AS cost,
           count(*)::int AS calls,
           coalesce(sum((payload->>'inputTokens')::bigint), 0)::float8 AS input,
           coalesce(sum((payload->>'outputTokens')::bigint), 0)::float8 AS output,
           coalesce(sum((payload->>'cacheReadTokens')::bigint), 0)::float8 AS "cacheRead"
      FROM pipeline_events
     WHERE run_id = ${runId} AND kind = 'usage'
     GROUP BY 1
  `
  if (rows.length === 0) return undefined
  const byStage: RunCost['byStage'] = {}
  let costUsd = 0, calls = 0, inputTokens = 0, outputTokens = 0, cacheReadTokens = 0
  for (const r of rows) {
    byStage[r.stage ?? 'unknown'] = { costUsd: Number(r.cost), calls: r.calls }
    costUsd += Number(r.cost); calls += r.calls; inputTokens += Number(r.input); outputTokens += Number(r.output); cacheReadTokens += Number(r.cacheRead)
  }
  return { costUsd: Math.round(costUsd * 1e6) / 1e6, calls, inputTokens, outputTokens, cacheReadTokens, byStage }
}

/** A person's answer at a gate, as a HUMAN annotation (one per gate). */
export async function reportGateAnswer(runId: string, answer: {
  gateId?: string
  stage: string | null
  pauseKind: string
  text: string
  outcome?: string | null
  /** User id or email of who answered. */
  by?: string | null
  via?: string | null
}, fetchImpl?: Fetch): Promise<void> {
  if (!tracingEndpoint()) return
  let who = answer.by ?? null
  if (who && /^[0-9a-f-]{36}$/.test(who)) {
    const [user] = await getDb()<Array<{ email: string; name: string | null }>>`SELECT email, name FROM users WHERE user_id = ${who}`.catch(() => [])
    if (user) who = user.name ? `${user.name} <${user.email}>` : user.email
  }
  let outcome = answer.outcome ?? (answer.pauseKind === 'clarification' ? 'answered' : 'responded')
  if (!answer.outcome && answer.pauseKind === 'review') {
    // An answer typed in the app reads as approval the way the engine reads it.
    const { parseApprovalAnswer } = await import('./aidlc')
    const parsed = parseApprovalAnswer(answer.text)
    outcome = parsed.approved ? (parsed.note ? 'approve_with_notes' : 'approve') : 'request_changes'
  }
  await annotateRun(runId, [{
    name: 'human-decision',
    kind: 'HUMAN',
    label: outcome,
    score: outcome === 'approve' || outcome === 'approve_with_notes' ? 1 : outcome === 'request_changes' ? 0 : null,
    explanation: answer.text,
    identifier: answer.gateId ?? `${answer.stage ?? 'run'}:${Date.now()}`,
    metadata: { stage: answer.stage, gate: answer.pauseKind, by: who, via: answer.via ?? 'app' },
  }], fetchImpl)
}

/** The annotation configs Spaces writes, so Phoenix shows their labels and scales (and people can use them). */
export const ANNOTATION_CONFIGS = [
  { name: 'run-status', type: 'CATEGORICAL', description: 'The run\'s status (Spaces).', optimization_direction: 'MAXIMIZE', values: [{ label: 'completed', score: 1 }, { label: 'running', score: 0.5 }, { label: 'queued', score: 0.5 }, { label: 'paused (review)', score: 0.5 }, { label: 'paused (clarification)', score: 0.5 }, { label: 'paused (user)', score: 0.5 }, { label: 'cancelled', score: 0 }, { label: 'error', score: 0 }] },
  { name: 'run-cost', type: 'CONTINUOUS', description: 'What the run cost in USD (Spaces usage events).', optimization_direction: 'MINIMIZE', lower_bound: 0, upper_bound: null },
  { name: 'human-decision', type: 'CATEGORICAL', description: 'A person\'s answer at a gate in Spaces.', optimization_direction: 'MAXIMIZE', values: [{ label: 'approve', score: 1 }, { label: 'approve_with_notes', score: 1 }, { label: 'request_changes', score: 0 }, { label: 'answered', score: 0.5 }, { label: 'responded', score: 0.5 }] },
  { name: 'turn-quality', type: 'CATEGORICAL', description: 'Rate an agent turn by hand.', optimization_direction: 'MAXIMIZE', values: [{ label: 'good', score: 1 }, { label: 'needs work', score: 0.5 }, { label: 'bad', score: 0 }] },
] as const

/** Create the configs that are missing and show them on the project. Never throws. */
export async function ensureAnnotationConfigs(project = process.env.PHOENIX_PROJECT_NAME?.trim() || 'spaces', fetchImpl?: Fetch): Promise<void> {
  if (!tracingEndpoint()) return
  try {
    const listed = await phoenix('/v1/annotation_configs?limit=100', { method: 'GET' }, fetchImpl)
    if (!listed?.ok) return
    const existing = ((await listed.json()) as { data: Array<{ id: string; name: string }> }).data
    const ids = new Map(existing.map((c) => [c.name, c.id]))
    for (const config of ANNOTATION_CONFIGS) {
      if (ids.has(config.name)) continue
      const created = await phoenix('/v1/annotation_configs', { method: 'POST', body: JSON.stringify(config) }, fetchImpl)
      if (created?.ok) ids.set(config.name, ((await created.json()) as { data: { id: string } }).data.id)
      else annotationLog.warn('annotation config not created', { name: config.name, status: created?.status })
    }
    // Show them on the project (the project may not exist before its first span).
    const current = await phoenix(`/v1/projects/${encodeURIComponent(project)}/annotation_configs`, { method: 'GET' }, fetchImpl)
    if (!current?.ok) return
    const shown = new Set(((await current.json()) as { data: Array<{ id: string }> }).data.map((c) => c.id))
    const wanted = ANNOTATION_CONFIGS.map((c) => ids.get(c.name)).filter((id): id is string => Boolean(id))
    if (wanted.every((id) => shown.has(id))) return
    await phoenix(`/v1/projects/${encodeURIComponent(project)}/annotation_configs`, { method: 'PUT', body: JSON.stringify({ annotation_config_ids: [...new Set([...shown, ...wanted])] }) }, fetchImpl)
  } catch (error) {
    annotationLog.warn('annotation configs not set up', { error: error instanceof Error ? error.message : String(error) })
  }
}
