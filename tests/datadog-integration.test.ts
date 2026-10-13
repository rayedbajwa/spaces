import { afterEach, describe, expect, test } from 'bun:test'
import { datadogApiBase, listDatadogEvents, severityToPriority, verifyDatadog } from '../src/lib/datadog'

/**
 * Datadog token client (US1/R2): credential verification, event normalization
 * and severity-to-priority mapping. HTTP is stubbed at the fetch boundary.
 */
const realFetch = globalThis.fetch
const API_KEY = 'demo-api-key'
const APP_KEY = 'demo-app-key'

function stubFetch(handler: (url: string, init?: RequestInit) => Response): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init)) as typeof fetch
}
afterEach(() => { globalThis.fetch = realFetch })

describe('datadog site handling', () => {
  test('accepts a bare region, a region host and a full URL', () => {
    expect(datadogApiBase('datadoghq.com')).toBe('https://api.datadoghq.com')
    expect(datadogApiBase('api.datadoghq.eu')).toBe('https://api.datadoghq.eu')
    expect(datadogApiBase('https://api.us5.datadoghq.com')).toBe('https://api.us5.datadoghq.com')
    expect(datadogApiBase(undefined)).toBe('https://api.datadoghq.com')
  })
})

describe('verifyDatadog', () => {
  test('requires both keys', async () => {
    expect((await verifyDatadog({ apiKey: '', appKey: APP_KEY, site: 'datadoghq.com' })).ok).toBe(false)
    expect((await verifyDatadog({ apiKey: API_KEY, appKey: '', site: 'datadoghq.com' })).ok).toBe(false)
  })

  test('succeeds when Datadog reports the credentials valid', async () => {
    let sawUrl = ''
    let sawApiKey = ''
    stubFetch((url, init) => {
      sawUrl = url
      sawApiKey = String((init?.headers as Record<string, string>)?.['DD-API-KEY'] ?? '')
      return new Response(JSON.stringify({ valid: true }), { status: 200 })
    })
    const result = await verifyDatadog({ apiKey: API_KEY, appKey: APP_KEY, site: 'datadoghq.eu' })
    expect(result.ok).toBe(true)
    expect(sawUrl).toBe('https://api.datadoghq.eu/api/v1/validate')
    expect(sawApiKey).toBe(API_KEY)
  })

  test('reports a refusal without throwing', async () => {
    stubFetch(() => new Response('forbidden', { status: 403 }))
    const result = await verifyDatadog({ apiKey: API_KEY, appKey: APP_KEY, site: 'datadoghq.com' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('403')
  })
})

describe('severity mapping', () => {
  test('maps Datadog severities to intake priorities', () => {
    expect(severityToPriority('critical')).toBe('urgent')
    expect(severityToPriority('error')).toBe('high')
    expect(severityToPriority('warning')).toBe('normal')
    expect(severityToPriority('info')).toBe('low')
    expect(severityToPriority(undefined)).toBe('low')
  })
})

describe('listDatadogEvents', () => {
  test('normalizes and deduplicates events, and filters by severity', async () => {
    stubFetch(() => new Response(JSON.stringify({
      events: [
        { id: 1, title: 'A', text: 'a', alert_type: 'error', tags: ['service:api'], date_happened: 100 },
        { id: 1, title: 'A duplicate', text: 'a', alert_type: 'error', tags: [], date_happened: 100 },
        { id: 2, title: 'B', text: 'b', alert_type: 'warning', tags: [], date_happened: 200 },
      ],
    }), { status: 200 }))
    const events = await listDatadogEvents({ credentials: { apiKey: API_KEY, appKey: APP_KEY, site: 'datadoghq.com' } })
    expect(events.map((e) => e.externalRef)).toEqual(['1', '2'])
    expect(events[0]!.priority).toBe('high')
    expect(events[0]!.service).toBe('api')
  })

  test('a failing events call throws a descriptive error', async () => {
    stubFetch(() => new Response('boom', { status: 500 }))
    await expect(listDatadogEvents({ credentials: { apiKey: API_KEY, appKey: APP_KEY, site: 'datadoghq.com' } })).rejects.toThrow('Datadog events API 500')
  })
})
