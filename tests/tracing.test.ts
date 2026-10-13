import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import { SemanticConventions as SC } from '@arizeai/openinference-semantic-conventions'
import { traceAgentSession, tracingEndpoint, useTracingExporter } from '../src/lib/tracing'
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

  test('a prompt becomes an AGENT span with LLM and TOOL children, labelled with its run and stage', () => {
    const session = fakeSession()
    let stage = 'specify'
    traceAgentSession(session, { kind: 'stage', orgId: 'org-1', projectId: 'proj-1', runId: 'run-1', stage: () => stage })

    session.emit({ type: 'agent_start' })
    session.emit({ type: 'message_start', message: { role: 'user', content: 'Write the spec' } })
    session.emit({ type: 'message_start', message: assistant([]) })
    session.emit({ type: 'message_end', message: assistant([{ type: 'text', text: 'Reading.' }, { type: 'toolCall', name: 'read', arguments: { path: 'a.md' } }], { usage: { input: 100, output: 20, cacheRead: 50, totalTokens: 170, cost: { total: 0.01 } } }) })
    session.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: { path: 'a.md' } })
    session.emit({ type: 'tool_execution_end', toolCallId: 't1', result: { content: [{ type: 'text', text: 'file body' }] }, isError: false })
    session.emit({ type: 'agent_end', messages: [assistant([{ type: 'text', text: 'Done.' }])] })

    const spans = exporter.getFinishedSpans()
    const byKind = (kind: string) => spans.filter((s) => s.attributes[SC.OPENINFERENCE_SPAN_KIND] === kind)
    const [agent] = byKind('AGENT')
    const [llm] = byKind('LLM')
    const [tool] = byKind('TOOL')
    expect(agent?.name).toBe('stage · specify')
    expect(agent?.attributes[SC.INPUT_VALUE]).toBe('Write the spec')
    expect(agent?.attributes[SC.OUTPUT_VALUE]).toBe('Done.')
    expect(agent?.attributes[SC.SESSION_ID]).toBe('run-1')
    expect(JSON.parse(String(agent?.attributes[SC.METADATA]))).toEqual({ kind: 'stage', orgId: 'org-1', projectId: 'proj-1', runId: 'run-1', stage: 'specify' })

    expect(llm?.attributes[SC.LLM_MODEL_NAME]).toBe('claude-sonnet-5-5')
    expect(llm?.attributes[SC.LLM_TOKEN_COUNT_PROMPT]).toBe(150)
    expect(llm?.attributes[SC.LLM_TOKEN_COUNT_COMPLETION]).toBe(20)
    expect(llm?.attributes[SC.LLM_COST_TOTAL]).toBe(0.01)
    expect(llm?.parentSpanContext?.spanId).toBe(agent?.spanContext().spanId)

    expect(tool?.name).toBe('tool read')
    expect(tool?.attributes[SC.OUTPUT_VALUE]).toBe('file body')
    expect(tool?.parentSpanContext?.spanId).toBe(agent?.spanContext().spanId)

    // The next prompt reads the stage again: one session spans several stages.
    stage = 'plan'
    session.emit({ type: 'agent_start' })
    session.emit({ type: 'agent_end', messages: [] })
    expect(exporter.getFinishedSpans().at(-1)?.name).toBe('stage · plan')
  })

  test('text sent to Phoenix is masked, and secrets are redacted even with guardrails off', () => {
    const session = fakeSession()
    traceAgentSession(session, { kind: 'task', policy: { mode: 'off', allow: [] } })
    session.emit({ type: 'agent_start' })
    session.emit({ type: 'message_start', message: { role: 'user', content: 'use GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789' } })
    session.emit({ type: 'agent_end', messages: [] })
    const [agent] = exporter.getFinishedSpans()
    expect(String(agent?.attributes[SC.INPUT_VALUE])).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')

    const masked = fakeSession()
    traceAgentSession(masked, { kind: 'task' })
    masked.emit({ type: 'agent_start' })
    masked.emit({ type: 'message_start', message: { role: 'user', content: 'mail jane@acme.io' } })
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
