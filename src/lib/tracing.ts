/**
 * Agent traces for Arize Phoenix (OpenInference over OTLP).
 *
 * Every agent session — a pipeline stage, a task or workstream run, a
 * sub-agent, the project assistant — is traced from its Pi events: an AGENT
 * span per prompt, an LLM span per model response (model, provider, tokens,
 * cost, output) and a TOOL span per tool call. Spans carry the organization,
 * project, run and stage so Phoenix can be filtered by them, and the run is the
 * Phoenix session.
 *
 * Off unless PHOENIX_COLLECTOR_ENDPOINT is set (e.g.
 * http://phoenix.railway.internal:6006). Text sent to Phoenix goes through the
 * organization's data guardrails first, on top of the session's own guard;
 * secrets are redacted whatever the guardrail mode, and text is cut to a
 * bounded size. Tracing never throws into an agent.
 */

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
export async function flushTracing(): Promise<void> {
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

/**
 * Trace one agent session. Returns nothing and never throws: a tracing fault
 * is logged once and the session carries on untraced.
 */
export function traceAgentSession(session: Subscribable, ctx: TraceContext): void {
  const t = getTracer()
  if (!t) return
  const policy = ctx.policy ?? DEFAULT_POLICY
  // The organization's masking, and secrets always (even with guardrails off or warning).
  const scrub = (text: string) => redactSecretValues(maskOutput(text, policy))
  const safe = (value: unknown) => clip(scrub(textOf(value)))
  let agentSpan: Span | undefined
  let llmSpan: Span | undefined
  let lastInput = ''
  const tools = new Map<string, Span>()
  let failed = false

  const child = (name: string, kind: OpenInferenceSpanKind, attributes: Record<string, string | number>) => {
    const parent = agentSpan ? trace.setSpan(context.active(), agentSpan) : context.active()
    return t.startSpan(name, { attributes: { [SC.OPENINFERENCE_SPAN_KIND]: kind, ...common(), ...attributes } }, parent)
  }
  const common = () => {
    const attrs: Record<string, string> = {}
    if (ctx.runId) attrs[SC.SESSION_ID] = ctx.runId
    attrs[SC.METADATA] = JSON.stringify({ kind: ctx.kind, orgId: ctx.orgId ?? undefined, projectId: ctx.projectId ?? undefined, runId: ctx.runId ?? undefined, stage: ctx.stage?.() })
    return attrs
  }

  try {
    session.subscribe((event) => {
      if (failed) return
      try {
        switch (event.type) {
          case 'agent_start': {
            const stage = ctx.stage?.()
            agentSpan = t.startSpan(`${ctx.kind}${stage ? ` · ${stage}` : ''}`, {
              attributes: { [SC.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.AGENT, ...common(), [SC.TAG_TAGS]: JSON.stringify([ctx.kind, stage].filter(Boolean)) },
            })
            break
          }
          case 'message_start': {
            const message = event.message as AssistantLike
            if (message?.role === 'user') {
              lastInput = safe(message.content)
              if (agentSpan && lastInput) agentSpan.setAttribute(SC.INPUT_VALUE, lastInput)
            } else if (message?.role === 'toolResult') {
              lastInput = safe(message.content)
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
            const usage = message.usage ?? {}
            const attrs: Record<string, string | number> = {}
            if (message.model) attrs[SC.LLM_MODEL_NAME] = message.model
            if (message.provider) attrs[SC.LLM_PROVIDER] = message.provider
            if (usage.input !== undefined) attrs[SC.LLM_TOKEN_COUNT_PROMPT] = usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
            if (usage.output !== undefined) attrs[SC.LLM_TOKEN_COUNT_COMPLETION] = usage.output
            if (usage.totalTokens !== undefined) attrs[SC.LLM_TOKEN_COUNT_TOTAL] = usage.totalTokens
            if (usage.cacheRead) attrs[SC.LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_READ] = usage.cacheRead
            if (usage.cacheWrite) attrs[SC.LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_WRITE] = usage.cacheWrite
            if (usage.reasoning) attrs[SC.LLM_TOKEN_COUNT_COMPLETION_DETAILS_REASONING] = usage.reasoning
            if (usage.cost?.input !== undefined) attrs[SC.LLM_COST_PROMPT] = usage.cost.input
            if (usage.cost?.output !== undefined) attrs[SC.LLM_COST_COMPLETION] = usage.cost.output
            if (usage.cost?.total !== undefined) attrs[SC.LLM_COST_TOTAL] = usage.cost.total
            const output = safe(message.content)
            if (output) attrs[SC.OUTPUT_VALUE] = output
            span.setAttributes(attrs)
            if (message.stopReason === 'error' || message.stopReason === 'aborted') {
              span.setStatus({ code: SpanStatusCode.ERROR, message: clip(scrub(message.errorMessage ?? message.stopReason)) })
            }
            span.end()
            break
          }
          case 'tool_execution_start': {
            const id = String(event.toolCallId ?? '')
            const name = String(event.toolName ?? 'tool')
            tools.set(id, child(`tool ${name}`, OpenInferenceSpanKind.TOOL, { [SC.TOOL_NAME]: name, [SC.INPUT_VALUE]: safe(event.args) }))
            break
          }
          case 'tool_execution_end': {
            const id = String(event.toolCallId ?? '')
            const span = tools.get(id)
            if (!span) break
            tools.delete(id)
            const output = safe((event.result as { content?: unknown } | undefined)?.content ?? event.result)
            if (output) span.setAttribute(SC.OUTPUT_VALUE, output)
            if (event.isError) span.setStatus({ code: SpanStatusCode.ERROR, message: clip(output.split('\n')[0] ?? 'tool failed') })
            span.end()
            break
          }
          case 'agent_end': {
            llmSpan?.end()
            llmSpan = undefined
            for (const span of tools.values()) span.end()
            tools.clear()
            if (agentSpan) {
              const messages = (event.messages as AssistantLike[] | undefined) ?? []
              const final = [...messages].reverse().find((m) => m.role === 'assistant')
              const output = final ? safe(final.content) : ''
              if (output) agentSpan.setAttribute(SC.OUTPUT_VALUE, output)
              if (final?.stopReason === 'error') agentSpan.setStatus({ code: SpanStatusCode.ERROR, message: clip(scrub(final.errorMessage ?? 'error')) })
              agentSpan.end()
              agentSpan = undefined
            }
            break
          }
          default:
            break
        }
      } catch (error) {
        failed = true
        traceLog.warn('agent tracing stopped for a session', { kind: ctx.kind, error: error instanceof Error ? error.message : String(error) })
      }
    })
  } catch (error) {
    traceLog.warn('agent tracing could not attach', { kind: ctx.kind, error: error instanceof Error ? error.message : String(error) })
  }
}
