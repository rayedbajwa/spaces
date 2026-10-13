import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import { SemanticConventions as SC } from '@arizeai/openinference-semantic-conventions'
import { flushTracing, traceAgentSession, tracingEndpoint, useTracingExporter } from '../src/lib/tracing'
import { railwayWorkerVariables } from '../src/lib/worker-platform-railway'
import { sharedSecrets } from '../src/lib/worker-platform'

type Listener = (event: { type: string } & Record<string, unknown>) => void

function fakeSession() {
  const listeners: Listener[] = []
  return {
    subscribe: (listener: Listener) => { listeners.push(listener) },
    emit: (event: { type: string } & Record<string, unknown>) => { for (const l of listeners) l(event) },
  }
}

const assistant = (content: unknown, extra: Record<string, unknown> = {}) => ({ role: 'assistant', content, model: 'claude-sonnet-5-5', provider: 'anthropic', ...extra })

describe('agent tracing', () => {
  let exporter: InMemorySpanExporter

  beforeEach(() => {
    exporter = new InMemorySpanExporter()
    useTracingExporter(exporter)
  })
  afterEach(() => useTracingExporter(undefined))

  test('each turn is its own complete trace: an AGENT root with its LLM and TOOL spans, grouped by the run', () => {
    const session = fakeSession()
    let stage = 'specify'
    traceAgentSession(session, { kind: 'stage', orgId: 'org-1', projectId: 'proj-1', runId: 'run-1', stage: () => stage })

    // Pi's order: the turn starts, then the prompt arrives.
    session.emit({ type: 'agent_start' })
    session.emit({ type: 'turn_start' })
    session.emit({ type: 'message_start', message: { role: 'user', content: 'Write the spec' } })
    session.emit({ type: 'message_start', message: assistant([]) })
    session.emit({ type: 'message_end', message: assistant([{ type: 'text', text: 'Reading.' }, { type: 'toolCall', name: 'read', arguments: { path: 'a.md' } }], { usage: { input: 100, output: 20, cacheRead: 50, totalTokens: 170, cost: { total: 0.01 } } }) })
    session.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: { path: 'a.md' } })
    // The turn's root is not sent before the turn ends; its children wait with it.
    expect(exporter.getFinishedSpans().some((s) => s.name.includes('turn'))).toBe(false)
    session.emit({ type: 'tool_execution_end', toolCallId: 't1', result: { content: [{ type: 'text', text: 'file body' }] }, isError: false })
    session.emit({ type: 'message_start', message: { role: 'toolResult', content: [{ type: 'text', text: 'file body' }] } })
    session.emit({ type: 'turn_end' })
    session.emit({ type: 'turn_start' })
    session.emit({ type: 'message_start', message: assistant([]) })
    session.emit({ type: 'message_end', message: assistant([{ type: 'text', text: 'Done.' }]) })
    session.emit({ type: 'turn_end' })
    session.emit({ type: 'agent_end', messages: [] })

    const spans = exporter.getFinishedSpans()
    const turn1 = spans.find((s) => s.name === 'stage · specify · turn 1')!
    const turn2 = spans.find((s) => s.name === 'stage · specify · turn 2')!
    const [llm1] = spans.filter((s) => s.attributes[SC.OPENINFERENCE_SPAN_KIND] === 'LLM')
    const tool = spans.find((s) => s.name === 'tool read')!

    // Roots: no parent, a trace each, one session (the run).
    for (const root of [turn1, turn2]) {
      expect(root.attributes[SC.OPENINFERENCE_SPAN_KIND]).toBe('AGENT')
      expect(root.parentSpanContext).toBeUndefined()
      expect(root.attributes[SC.SESSION_ID]).toBe('run-1')
    }
    expect(turn1.spanContext().traceId).not.toBe(turn2.spanContext().traceId)
    // Children belong to their turn's trace, directly under its root.
    for (const childSpan of [llm1!, tool]) {
      expect(childSpan.spanContext().traceId).toBe(turn1.spanContext().traceId)
      expect(childSpan.parentSpanContext?.spanId).toBe(turn1.spanContext().spanId)
    }
    expect(turn1.attributes[SC.INPUT_VALUE]).toBe('Write the spec')
    expect(turn1.attributes[SC.OUTPUT_VALUE]).toContain('Reading.')
    expect(turn2.attributes[SC.INPUT_VALUE]).toBe('file body')
    expect(turn2.attributes[SC.OUTPUT_VALUE]).toBe('Done.')
    expect(JSON.parse(String(turn1.attributes[SC.METADATA]))).toEqual({ kind: 'stage', orgId: 'org-1', projectId: 'proj-1', runId: 'run-1', stage: 'specify', prompt: 1, turn: 1 })

    expect(llm1!.attributes[SC.LLM_MODEL_NAME]).toBe('claude-sonnet-5-5')
    expect(llm1!.attributes[SC.LLM_TOKEN_COUNT_PROMPT]).toBe(150)
    expect(llm1!.attributes[SC.LLM_TOKEN_COUNT_COMPLETION]).toBe(20)
    expect(llm1!.attributes[SC.LLM_COST_TOTAL]).toBe(0.01)
    expect(tool.attributes[SC.OUTPUT_VALUE]).toBe('file body')

    // The next prompt reads the stage again and numbers its turns afresh.
    stage = 'plan'
    session.emit({ type: 'agent_start' })
    session.emit({ type: 'turn_start' })
    session.emit({ type: 'turn_end' })
    session.emit({ type: 'agent_end', messages: [] })
    const next = exporter.getFinishedSpans().at(-1)!
    expect(next.name).toBe('stage · plan · turn 1')
    // No input carried over from the previous prompt's tool results.
    expect(next.attributes[SC.INPUT_VALUE]).toBeUndefined()
  })

  test('a turn cut off by shutdown is sent, marked interrupted, with its children', async () => {
    const session = fakeSession()
    traceAgentSession(session, { kind: 'stage', runId: 'run-2', stage: () => 'implement' })
    session.emit({ type: 'agent_start' })
    session.emit({ type: 'turn_start' })
    session.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'bun test' } })
    await flushTracing('interrupted: worker restart')
    const spans = exporter.getFinishedSpans()
    const root = spans.find((s) => s.name === 'stage · implement · turn 1')!
    expect(root.status).toEqual({ code: 2, message: 'interrupted: worker restart' })
    expect(spans.find((s) => s.name === 'tool bash')?.parentSpanContext?.spanId).toBe(root.spanContext().spanId)
  })

  test('without turn events a turn is opened for the first child, and a session without a run gets its own id', () => {
    const session = fakeSession()
    traceAgentSession(session, { kind: 'assistant' })
    session.emit({ type: 'agent_start' })
    session.emit({ type: 'message_start', message: assistant([]) })
    session.emit({ type: 'message_end', message: assistant([{ type: 'text', text: 'hi' }]) })
    session.emit({ type: 'agent_end', messages: [] })
    const spans = exporter.getFinishedSpans()
    const root = spans.find((s) => s.name === 'assistant · turn 1')!
    expect(spans.find((s) => s.name === 'llm')?.parentSpanContext?.spanId).toBe(root.spanContext().spanId)
    expect(String(root.attributes[SC.SESSION_ID])).toMatch(/^assistant-[0-9a-f-]{36}$/)
  })

  test('text sent to Phoenix is masked, and secrets are redacted even with guardrails off', () => {
    const session = fakeSession()
    traceAgentSession(session, { kind: 'task', policy: { mode: 'off', allow: [] } })
    session.emit({ type: 'agent_start' })
    session.emit({ type: 'turn_start' })
    session.emit({ type: 'message_start', message: { role: 'user', content: 'use GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789' } })
    session.emit({ type: 'turn_end' })
    session.emit({ type: 'agent_end', messages: [] })
    const [agent] = exporter.getFinishedSpans()
    expect(String(agent?.attributes[SC.INPUT_VALUE])).toStartWith('use GITHUB_TOKEN=')
    expect(String(agent?.attributes[SC.INPUT_VALUE])).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')

    const masked = fakeSession()
    traceAgentSession(masked, { kind: 'task' })
    masked.emit({ type: 'agent_start' })
    masked.emit({ type: 'turn_start' })
    masked.emit({ type: 'message_start', message: { role: 'user', content: 'mail jane@acme.io' } })
    masked.emit({ type: 'turn_end' })
    masked.emit({ type: 'agent_end', messages: [] })
    expect(exporter.getFinishedSpans().at(-1)?.attributes[SC.INPUT_VALUE]).toBe('mail [email]')
  })

  test('a failed tool call and a model error mark their spans as errors', () => {
    const session = fakeSession()
    traceAgentSession(session, { kind: 'subagent' })
    session.emit({ type: 'agent_start' })
    session.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'false' } })
    session.emit({ type: 'tool_execution_end', toolCallId: 't1', result: { content: [{ type: 'text', text: 'exit 1' }] }, isError: true })
    session.emit({ type: 'message_end', message: assistant([], { stopReason: 'error', errorMessage: 'overloaded' }) })
    session.emit({ type: 'agent_end', messages: [] })
    const spans = exporter.getFinishedSpans()
    expect(spans.find((s) => s.name === 'tool bash')?.status).toEqual({ code: 2, message: 'exit 1' })
    expect(spans.find((s) => s.name === 'llm')?.status).toEqual({ code: 2, message: 'overloaded' })
  })

  test('a malformed event stops tracing that session without throwing into the agent', () => {
    const session = fakeSession()
    traceAgentSession(session, { kind: 'stage' })
    session.emit({ type: 'agent_start' })
    expect(() => session.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { toJSON: () => { throw new Error('boom') } } })).not.toThrow()
    expect(() => session.emit({ type: 'agent_end', messages: [] })).not.toThrow()
  })
})

describe('tracing configuration', () => {
  test('off without an endpoint; the endpoint is normalised', () => {
    expect(tracingEndpoint({})).toBeUndefined()
    expect(tracingEndpoint({ PHOENIX_COLLECTOR_ENDPOINT: '  ' })).toBeUndefined()
    expect(tracingEndpoint({ PHOENIX_COLLECTOR_ENDPOINT: 'http://phoenix:6006/' })).toBe('http://phoenix:6006')
  })

  test('project workers trace where the web service does', () => {
    const config = { webServiceName: 'spaces', postgresServiceName: 'Postgres' } as Parameters<typeof railwayWorkerVariables>[0]
    const spec = { env: {} } as Parameters<typeof railwayWorkerVariables>[1]
    expect(railwayWorkerVariables(config, spec, { PHOENIX_COLLECTOR_ENDPOINT: 'http://phoenix:6006', PHOENIX_API_KEY: 'k' })).toMatchObject({
      PHOENIX_COLLECTOR_ENDPOINT: '${{spaces.PHOENIX_COLLECTOR_ENDPOINT}}',
      PHOENIX_API_KEY: '${{spaces.PHOENIX_API_KEY}}',
    })
    expect(railwayWorkerVariables(config, spec, {})).not.toHaveProperty('PHOENIX_COLLECTOR_ENDPOINT')
    expect(sharedSecrets({ PHOENIX_COLLECTOR_ENDPOINT: 'http://phoenix:6006' }).PHOENIX_COLLECTOR_ENDPOINT).toBe('http://phoenix:6006')
  })
})
