/**
 * Agent traces for Arize Phoenix (OpenInference over OTLP).
 *
 * Every agent session — a pipeline stage, a task or workstream run, a
 * sub-agent, the project assistant — is traced from its Pi events: a trace per
 * agent turn, its root an AGENT span with an LLM span (model, provider,
 * tokens, cost, output) and a TOOL span per tool call underneath. Spans carry
 * the organization, project, run and stage so Phoenix can be filtered by them,
 * and the run is the Phoenix session that groups its turns.
 *
 * Off unless PHOENIX_COLLECTOR_ENDPOINT is set (e.g.
 * http://phoenix.railway.internal:6006). Text sent to Phoenix goes through the
 * organization's data guardrails first, on top of the session's own guard;
 * secrets are redacted whatever the guardrail mode, and text is cut to a
 * bounded size. Tracing never throws into an agent.
 */

import { randomUUID } from 'node:crypto'
import { context, SpanStatusCode, trace, type Span, type Tracer } from '@opentelemetry/api'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BasicTracerProvider, BatchSpanProcessor, SimpleSpanProcessor, type SpanExporter } from '@opentelemetry/sdk-trace-base'
import { OpenInferenceSpanKind, SemanticConventions as SC, SEMRESATTRS_PROJECT_NAME } from '@arizeai/openinference-semantic-conventions'
import { DEFAULT_POLICY, maskOutput, redactSecretValues, type GuardPolicy } from './guardrails'
import { log } from './logger'

const traceLog = log.child({ mod: 'tracing' })

/** Longest text kept on a span; agents read and write whole files. */
const MAX_TEXT = 16_000

export interface TraceContext {
  /** What kind of session: stage, task, workstream, subagent, assistant, suggestions. */
  kind: string
  orgId?: string | null
  projectId?: string | null
  runId?: string | null
  /** The stage now running (read when each prompt starts: a session spans stages). */
  stage?: () => string | undefined
  /** The organization's guardrail policy, applied to all text on the spans. */
  policy?: GuardPolicy
}

let provider: BasicTracerProvider | undefined
let tracer: Tracer | undefined

export function tracingEndpoint(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.PHOENIX_COLLECTOR_ENDPOINT?.trim().replace(/\/+$/, '') || undefined
}

/** Send spans to `exporter` as they end, whatever the environment says (tests). */
export function useTracingExporter(exporter: SpanExporter | undefined): void {
  provider = exporter ? new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }) : undefined
  tracer = provider?.getTracer('spaces-agents')
}

function getTracer(): Tracer | undefined {
  if (tracer) return tracer
  const endpoint = tracingEndpoint()
  if (!endpoint) return undefined
  const apiKey = process.env.PHOENIX_API_KEY?.trim()
  const exporter = new OTLPTraceExporter({
    url: endpoint.endsWith('/v1/traces') ? endpoint : `${endpoint}/v1/traces`,
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
  })
  provider = new BasicTracerProvider({
    resource: resourceFromAttributes({
      'service.name': `spaces-${process.env.SPACES_ROLE?.trim() || 'all'}`,
      [SEMRESATTRS_PROJECT_NAME]: process.env.PHOENIX_PROJECT_NAME?.trim() || 'spaces',
    }),
    spanProcessors: [new BatchSpanProcessor(exporter)],
  })
  tracer = provider.getTracer('spaces-agents')
  traceLog.info('agent tracing to Phoenix', { endpoint })
  return tracer
}

/** Send what is buffered (on shutdown, so the last spans of a stage are not lost). */
export async function flushTracing(reason = 'interrupted: the process stopped'): Promise<void> {
  // A turn cut off by the shutdown is sent as failed rather than lost.
  for (const close of openSessions) { try { close(reason) } catch { /* tracing never throws */ } }
  await provider?.forceFlush().catch(() => undefined)
}

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}… [${text.length - MAX_TEXT} more characters]` : text
}

function textOf(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map((part) => {
      if (typeof part === 'string') return part
      const p = part as { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown }
      if (p.type === 'text') return p.text ?? ''
      if (p.type === 'toolCall') return `[tool call ${p.name}] ${JSON.stringify(p.arguments ?? {})}`
      return ''
    }).filter(Boolean).join('\n')
  }
  try { return JSON.stringify(value) } catch { return String(value) }
}

interface AssistantLike {
  role?: string
  content?: unknown
  model?: string
  provider?: string
  stopReason?: string
  errorMessage?: string
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; reasoning?: number; totalTokens?: number; cost?: { input?: number; output?: number; total?: number } }
}

type Subscribable = { subscribe: (listener: (event: { type: string } & Record<string, unknown>) => void) => unknown }

/** Sessions with a turn open, ended (as interrupted) before a flush on shutdown. */
const openSessions = new Set<(reason: string) => void>()

/**
 * Trace one agent session. Returns nothing and never throws: a tracing fault
 * is logged once and the session carries on untraced.
 *
 * Each agent turn (one model response and the tool calls it makes) is its own
 * trace: a root AGENT span with the LLM span and TOOL spans as its children.
 * A stage runs for many minutes and a span is only sent when it ends, so one
 * span over the whole stage left every child without its parent (no trace in
 * Phoenix) until the stage finished, and for ever when a worker restarted.
 * Turns end within seconds, so traces appear while the agent works. The run
 * is the Phoenix session that groups them (a session without a run gets its
 * own id), and each turn carries its stage, prompt and turn number.
 */
export function traceAgentSession(session: Subscribable, ctx: TraceContext): void {
  const t = getTracer()
  if (!t) return
  const policy = ctx.policy ?? DEFAULT_POLICY
  // The organization's masking, and secrets always (even with guardrails off or warning).
  const scrub = (text: string) => redactSecretValues(maskOutput(text, policy))
  const safe = (value: unknown) => clip(scrub(textOf(value)))
  const sessionId = ctx.runId || `${ctx.kind}-${randomUUID()}`
  let turnSpan: Span | undefined
  let llmSpan: Span | undefined
  let lastInput = ''
  let prompt = 0
  let turn = 0
  const tools = new Map<string, Span>()
  let failed = false
  // What the open turn has used and how it went, for its root span.
  let usage = { costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, llmCalls: 0, toolCalls: 0, toolErrors: 0, model: '' }
  let turnError: string | undefined

  const metadata = (extra: Record<string, unknown> = {}) => JSON.stringify({ kind: ctx.kind, orgId: ctx.orgId ?? undefined, projectId: ctx.projectId ?? undefined, runId: ctx.runId ?? undefined, stage: ctx.stage?.(), prompt, turn, ...extra })
  const common = () => {
    const stage = ctx.stage?.()
    return {
      [SC.SESSION_ID]: sessionId,
      [SC.METADATA]: metadata(),
      [SC.TAG_TAGS]: JSON.stringify([ctx.kind, stage].filter(Boolean)),
    }
  }
  const openTurn = () => {
    turn++
    usage = { costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, llmCalls: 0, toolCalls: 0, toolErrors: 0, model: '' }
    turnError = undefined
    const stage = ctx.stage?.()
    openSessions.add(closer)
    turnSpan = t.startSpan(`${ctx.kind}${stage ? ` · ${stage}` : ''} · turn ${turn}`, {
      root: true,
      attributes: { [SC.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.AGENT, ...common(), ...(lastInput ? { [SC.INPUT_VALUE]: lastInput } : {}) },
    })
    return turnSpan
  }
  const child = (name: string, kind: OpenInferenceSpanKind, attributes: Record<string, string | number>) => {
    const parent = trace.setSpan(context.active(), turnSpan ?? openTurn())
    return t.startSpan(name, { attributes: { [SC.OPENINFERENCE_SPAN_KIND]: kind, ...common(), ...attributes } }, parent)
  }
  /** End whatever is open: children first, then the turn. */
  const closeTurn = (interrupted?: string) => {
    for (const span of [llmSpan, ...tools.values()]) {
      if (!span) continue
      if (interrupted) span.setStatus({ code: SpanStatusCode.ERROR, message: interrupted })
      span.end()
    }
    llmSpan = undefined
    tools.clear()
    if (turnSpan) {
      // The turn's status, cost and tokens on its root, so they show (and filter) per trace.
      const status = interrupted ? 'interrupted' : turnError ? 'error' : 'ok'
      turnSpan.setAttribute(SC.METADATA, metadata({ status, costUsd: Math.round(usage.costUsd * 1e6) / 1e6, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, llmCalls: usage.llmCalls, toolCalls: usage.toolCalls, toolErrors: usage.toolErrors, model: usage.model || undefined }))
      turnSpan.setAttribute(SC.TAG_TAGS, JSON.stringify([ctx.kind, ctx.stage?.(), status].filter(Boolean)))
      if (interrupted || turnError) turnSpan.setStatus({ code: SpanStatusCode.ERROR, message: interrupted ?? turnError })
      else turnSpan.setStatus({ code: SpanStatusCode.OK })
      turnSpan.end()
      turnSpan = undefined
    }
    openSessions.delete(closer)
  }
  const closer = (reason: string): void => closeTurn(reason)

  try {
    session.subscribe((event) => {
      if (failed) return
      try {
        switch (event.type) {
          case 'agent_start':
            prompt++
            turn = 0
            lastInput = ''
            break
          case 'turn_start':
            closeTurn()
            openTurn()
            break
          case 'message_start': {
            const message = event.message as AssistantLike
            if (message?.role === 'user' || message?.role === 'toolResult') {
              // Tool results are the next turn's input. A prompt arrives just
              // after its turn has started (Pi's order), so it is that turn's.
              lastInput = safe(message.content)
              if (message.role === 'user' && turnSpan && lastInput) turnSpan.setAttribute(SC.INPUT_VALUE, lastInput)
            } else if (message?.role === 'assistant') {
              llmSpan?.end()
              llmSpan = child('llm', OpenInferenceSpanKind.LLM, lastInput ? { [SC.INPUT_VALUE]: lastInput } : {})
            }
            break
          }
          case 'message_end': {
            const message = event.message as AssistantLike
            if (message?.role !== 'assistant') break
            const span = llmSpan ?? child('llm', OpenInferenceSpanKind.LLM, {})
            llmSpan = undefined
            const used = message.usage ?? {}
            usage.llmCalls++
            usage.inputTokens += used.input ?? 0
            usage.outputTokens += used.output ?? 0
            usage.cacheReadTokens += used.cacheRead ?? 0
            usage.costUsd += used.cost?.total ?? 0
            if (message.model) usage.model = message.model
            const attrs: Record<string, string | number> = {}
            if (message.model) attrs[SC.LLM_MODEL_NAME] = message.model
            if (message.provider) attrs[SC.LLM_PROVIDER] = message.provider
            if (used.input !== undefined) attrs[SC.LLM_TOKEN_COUNT_PROMPT] = used.input + (used.cacheRead ?? 0) + (used.cacheWrite ?? 0)
            if (used.output !== undefined) attrs[SC.LLM_TOKEN_COUNT_COMPLETION] = used.output
            if (used.totalTokens !== undefined) attrs[SC.LLM_TOKEN_COUNT_TOTAL] = used.totalTokens
            if (used.cacheRead) attrs[SC.LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_READ] = used.cacheRead
            if (used.cacheWrite) attrs[SC.LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_WRITE] = used.cacheWrite
            if (used.reasoning) attrs[SC.LLM_TOKEN_COUNT_COMPLETION_DETAILS_REASONING] = used.reasoning
            if (used.cost?.input !== undefined) attrs[SC.LLM_COST_PROMPT] = used.cost.input
            if (used.cost?.output !== undefined) attrs[SC.LLM_COST_COMPLETION] = used.cost.output
            if (used.cost?.total !== undefined) attrs[SC.LLM_COST_TOTAL] = used.cost.total
            const output = safe(message.content)
            if (output) attrs[SC.OUTPUT_VALUE] = output
            span.setAttributes(attrs)
            // The turn answers with what the model said.
            if (output) turnSpan?.setAttribute(SC.OUTPUT_VALUE, output)
            if (message.stopReason === 'error' || message.stopReason === 'aborted') {
              const failure = clip(scrub(message.errorMessage ?? message.stopReason))
              span.setStatus({ code: SpanStatusCode.ERROR, message: failure })
              turnError = failure
            } else {
              span.setStatus({ code: SpanStatusCode.OK })
            }
            span.end()
            break
          }
          case 'tool_execution_start': {
            const id = String(event.toolCallId ?? '')
            const name = String(event.toolName ?? 'tool')
            // Opening the span may open the turn (and reset its counts): count after.
            tools.set(id, child(`tool ${name}`, OpenInferenceSpanKind.TOOL, { [SC.TOOL_NAME]: name, [SC.INPUT_VALUE]: safe(event.args) }))
            usage.toolCalls++
            break
          }
          case 'tool_execution_end': {
            const id = String(event.toolCallId ?? '')
            const span = tools.get(id)
            if (!span) break
            tools.delete(id)
            const output = safe((event.result as { content?: unknown } | undefined)?.content ?? event.result)
            if (output) span.setAttribute(SC.OUTPUT_VALUE, output)
            if (event.isError) {
              usage.toolErrors++
              span.setStatus({ code: SpanStatusCode.ERROR, message: clip(output.split('\n')[0] ?? 'tool failed') })
            } else {
              span.setStatus({ code: SpanStatusCode.OK })
            }
            span.end()
            break
          }
          case 'turn_end':
          case 'agent_end':
            closeTurn()
            break
          default:
            break
        }
      } catch (error) {
        failed = true
        openSessions.delete(closer)
        traceLog.warn('agent tracing stopped for a session', { kind: ctx.kind, error: error instanceof Error ? error.message : String(error) })
      }
    })
  } catch (error) {
    openSessions.delete(closer)
    traceLog.warn('agent tracing could not attach', { kind: ctx.kind, error: error instanceof Error ? error.message : String(error) })
  }
}
