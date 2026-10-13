import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { annotateRun, ANNOTATION_CONFIGS, ensureAnnotationConfigs, reportGateAnswer, reportRunStatus } from '../src/lib/phoenix-annotations'

const calls: Array<{ url: string; method: string; body?: any }> = []
let configs: Array<{ id: string; name: string }> = []
let projectConfigs: string[] = []
const fakeFetch = (async (url: string, init: RequestInit = {}) => {
  const body = init.body ? JSON.parse(String(init.body)) : undefined
  calls.push({ url: String(url), method: init.method ?? 'GET', body })
  const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200 })
  if (String(url).endsWith('/v1/annotation_configs?limit=100')) return json({ data: configs })
  if (String(url).endsWith('/v1/annotation_configs') && init.method === 'POST') { const id = `cfg-${body.name}`; configs.push({ id, name: body.name }); return json({ data: { id } }) }
  if (String(url).includes('/v1/projects/spaces/annotation_configs')) {
    if (init.method === 'PUT') projectConfigs = body.annotation_config_ids
    return json({ data: projectConfigs.map((id) => ({ id })) })
  }
  return json({ data: [] })
}) as unknown as typeof fetch

const saved = { ...process.env }
beforeAll(() => { process.env.PHOENIX_COLLECTOR_ENDPOINT = 'http://phoenix:6006'; process.env.PHOENIX_API_KEY = 'k' })
afterAll(() => { process.env = saved })

describe('Phoenix annotations', () => {
  test('a run annotation goes to the run\'s session, masked, with the key', async () => {
    calls.length = 0
    await annotateRun('run-1', [{ name: 'human-decision', kind: 'HUMAN', label: 'approve', explanation: 'ok, token ghp_abcdefghijklmnopqrstuvwxyz0123456789, mail jane@acme.io' }], fakeFetch)
    const [call] = calls
    expect(call!.url).toBe('http://phoenix:6006/v1/session_annotations')
    const [data] = call!.body.data
    expect(data).toMatchObject({ session_id: 'run-1', name: 'human-decision', annotator_kind: 'HUMAN', identifier: '', result: { label: 'approve' } })
    expect(data.result.explanation).not.toContain('ghp_')
    expect(data.result.explanation).not.toContain('jane@acme.io')
  })

  test('status changes are recorded with the stage and the error', async () => {
    calls.length = 0
    await reportRunStatus('run-2', { status: 'paused', pauseKind: 'review', stage: 'plan' }, fakeFetch)
    expect(calls[0]!.body.data[0]).toMatchObject({ name: 'run-status', result: { label: 'paused (review)', score: null, explanation: 'stage plan' }, metadata: { status: 'paused', pauseKind: 'review', stage: 'plan' } })
  })

  test('an approval typed in the app is read as the engine reads it', async () => {
    calls.length = 0
    await reportGateAnswer('run-3', { gateId: 'g1', stage: 'spec', pauseKind: 'review', text: 'approve', by: 'ray@acme.io' }, fakeFetch)
    await reportGateAnswer('run-3', { gateId: 'g2', stage: 'plan', pauseKind: 'review', text: 'Please split the API work into two workstreams.', by: 'ray@acme.io' }, fakeFetch)
    await reportGateAnswer('run-3', { gateId: 'g3', stage: 'clarify', pauseKind: 'clarification', text: 'CSV', by: 'ray@acme.io', via: 'slack' }, fakeFetch)
    const [a, b, c] = calls.map((x) => x.body.data[0])
    expect(a).toMatchObject({ annotator_kind: 'HUMAN', identifier: 'g1', result: { label: 'approve', score: 1 }, metadata: { stage: 'spec', gate: 'review', by: 'ray@acme.io', via: 'app' } })
    expect(b).toMatchObject({ identifier: 'g2', result: { label: 'request_changes', score: 0 } })
    expect(c).toMatchObject({ identifier: 'g3', result: { label: 'answered', explanation: 'CSV' }, metadata: { via: 'slack' } })
  })

  test('a decision from a link or Slack keeps its outcome', async () => {
    calls.length = 0
    await reportGateAnswer('run-4', { gateId: 'g9', stage: 'deliver', pauseKind: 'review', text: 'Ship it after the demo', outcome: 'approve_with_notes', by: 'ray@acme.io', via: 'link' }, fakeFetch)
    expect(calls[0]!.body.data[0]).toMatchObject({ result: { label: 'approve_with_notes', score: 1 }, metadata: { via: 'link' } })
  })

  test('annotation configs are created once and shown on the project', async () => {
    calls.length = 0
    configs = [{ id: 'cfg-existing', name: 'user_feedback' }]
    projectConfigs = ['cfg-existing']
    await ensureAnnotationConfigs('spaces', fakeFetch)
    expect(configs.map((c) => c.name).sort()).toEqual(['user_feedback', ...ANNOTATION_CONFIGS.map((c) => c.name)].sort())
    expect(new Set(projectConfigs)).toEqual(new Set(['cfg-existing', ...ANNOTATION_CONFIGS.map((c) => `cfg-${c.name}`)]))
    calls.length = 0
    await ensureAnnotationConfigs('spaces', fakeFetch)
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([])
  })

  test('nothing is sent without tracing', async () => {
    delete process.env.PHOENIX_COLLECTOR_ENDPOINT
    calls.length = 0
    await reportRunStatus('run-5', { status: 'running' }, fakeFetch)
    await ensureAnnotationConfigs('spaces', fakeFetch)
    expect(calls).toEqual([])
    process.env.PHOENIX_COLLECTOR_ENDPOINT = 'http://phoenix:6006'
  })
})
