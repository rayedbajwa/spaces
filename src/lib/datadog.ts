/**
 * Datadog token client (012-inbound-outbound-slack, US1/R2).
 *
 * Datadog authenticates with an API key plus an application key. `verifyDatadog`
 * probes `/api/v1/validate`; `listDatadogEvents` reads alerts by severity and
 * tags since a cursor and normalizes them for the Intake queue. Responses are
 * stubbed at the `fetch` boundary in tests — no live credential is required.
 */

import type { IntakePriority } from './intake-types'

export interface DatadogCredentials {
  apiKey: string
  appKey: string
  site?: string | null
}

export interface DatadogVerifyResult {
  ok: boolean
  account?: string
  error?: string
}

export interface DatadogEvent {
  externalRef: string
  title: string
  summary: string
  link: string | null
  severity: string
  priority: IntakePriority
  service: string | null
  timestamp: number
}

/** Accept a bare site, a region host or a full URL and return the API base. */
export function datadogApiBase(site?: string | null): string {
  const value = (site ?? '').trim()
  if (value.startsWith('http://') || value.startsWith('https://')) return value.replace(/\/+$/, '')
  if (value) return `https://api.${value.replace(/^api\./, '').replace(/\/+$/, '')}`
  return 'https://api.datadoghq.com'
}

function headers(creds: DatadogCredentials): Record<string, string> {
  return { 'DD-API-KEY': creds.apiKey, 'DD-APPLICATION-KEY': creds.appKey, Accept: 'application/json' }
}

export async function verifyDatadog(creds: DatadogCredentials): Promise<DatadogVerifyResult> {
  if (!creds.apiKey?.trim() || !creds.appKey?.trim()) return { ok: false, error: 'Both the API key and the application key are required.' }
  try {
    const response = await fetch(`${datadogApiBase(creds.site)}/api/v1/validate`, { headers: headers(creds) })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      return { ok: false, error: `Datadog refused the credentials (${response.status}): ${text.slice(0, 300)}` }
    }
    const body = (await response.json().catch(() => ({}))) as { valid?: boolean }
    if (body.valid === false) return { ok: false, error: 'Datadog reported the credentials as invalid.' }
    return { ok: true, account: (creds.site ?? 'datadoghq.com').trim() || 'datadoghq.com' }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function severityToPriority(severity: string | undefined): IntakePriority {
  switch ((severity ?? '').toLowerCase()) {
    case 'critical': case 'alert': return 'urgent'
    case 'error': return 'high'
    case 'warning': case 'warn': return 'normal'
    default: return 'low'
  }
}

/** Read events in a window, normalized and deduplicated by event id. */
export async function listDatadogEvents(input: {
  credentials: DatadogCredentials
  since?: number
  tags?: string[]
  severity?: string
  limit?: number
}): Promise<DatadogEvent[]> {
  const base = datadogApiBase(input.credentials.site)
  const end = Math.floor(Date.now() / 1000)
  const start = input.since && input.since > 0 ? input.since : end - 24 * 3600
  const params = new URLSearchParams({ start: String(start), end: String(end) })
  for (const tag of input.tags ?? []) if (tag.trim()) params.append('tags', tag.trim())
  params.set('page_size', String(Math.min(input.limit ?? 50, 100)))
  if (input.severity) params.set('sources', 'alert')

  const response = await fetch(`${base}/api/v1/events?${params.toString()}`, { headers: headers(input.credentials) })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Datadog events API ${response.status}: ${text.slice(0, 300)}`)
  }
  const body = (await response.json()) as { events?: Array<Record<string, unknown>> }
  const events = (body.events ?? []).filter((e) => {
    if (!input.severity) return true
    return String(e.alert_type ?? e.severity ?? '').toLowerCase() === input.severity.toLowerCase()
  })
  const seen = new Set<string>()
  const out: DatadogEvent[] = []
  for (const event of events) {
    const id = String(event.id ?? event.id_str ?? '')
    if (!id || seen.has(id)) continue
    seen.add(id)
    const title = String(event.title ?? event.alert_name ?? 'Datadog alert')
    const text = String(event.text ?? '').replace(/\s+/g, ' ').trim()
    const tags = Array.isArray(event.tags) ? (event.tags as string[]) : []
    const serviceTag = tags.find((t) => t.startsWith('service:'))
    const linkTag = tags.find((t) => t.startsWith('link:')) ?? tags.find((t) => t.startsWith('url:'))
    const severity = String(event.alert_type ?? event.severity ?? '')
    out.push({
      externalRef: id,
      title,
      summary: text || title,
      link: linkTag ? linkTag.slice(linkTag.indexOf(':') + 1) : (typeof event.url === 'string' ? event.url : null),
      severity: severity || 'info',
      priority: severityToPriority(severity),
      service: serviceTag ? serviceTag.slice('service:'.length) : null,
      timestamp: Number(event.date_happened ?? event.date ?? end),
    })
  }
  return out
}
