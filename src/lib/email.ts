/**
 * Email delivery for owner approval links, through the Resend REST API.
 *
 * The organization's connected `kind='email'` integration is preferred; the
 * deployment-level RESEND_API_KEY/APPROVAL_EMAIL_FROM pair is a fallback for
 * installs with no per-organization connection. The API key is read from the
 * sealed app_integrations row (or the environment) and never logged or returned
 * by any API. Every function here is best-effort and never throws.
 */

import { getAppIntegration, getAppIntegrationCredentials } from './app-integrations'
import { platformEmailFrom, platformResendApiKey, RESEND_ONBOARDING_FROM } from './env'
import { log } from './logger'

const emailLog = log.child({ mod: 'email' })

/** Overridable for self-hosted mocks and tests; points at Resend by default. */
function apiBase(): string {
  return (process.env.RESEND_API_URL?.trim() || 'https://api.resend.com').replace(/\/+$/, '')
}

/** The organization's sealed Resend key, or undefined when not connected. */
async function orgResendKey(orgId: string): Promise<string | undefined> {
  const integration = await getAppIntegration(orgId, 'email').catch(() => undefined)
  if (integration?.status !== 'connected') return undefined
  const creds = await getAppIntegrationCredentials(orgId, 'email').catch(() => undefined)
  return typeof creds?.api_key === 'string' && creds.api_key ? creds.api_key : undefined
}

/** True when the organization has an email connection or the platform fallback is set. */
export async function emailConfigured(orgId: string): Promise<boolean> {
  return Boolean((await orgResendKey(orgId)) ?? platformResendApiKey())
}

/** Sender identity: the organization's configured address, else the platform fallback. */
export async function emailSender(orgId: string): Promise<{ from: string }> {
  const integration = await getAppIntegration(orgId, 'email').catch(() => undefined)
  const config = integration?.configJson as { fromAddress?: unknown; fromName?: unknown } | undefined
  const fromAddress = typeof config?.fromAddress === 'string' ? config.fromAddress.trim() : ''
  if (fromAddress) {
    const fromName = typeof config?.fromName === 'string' ? config.fromName.trim() : ''
    return { from: fromName ? `${fromName} <${fromAddress}>` : fromAddress }
  }
  return { from: platformEmailFrom() }
}

/** Probe a Resend key against GET /domains; used at connect time and never persisted here. */
export async function verifyEmailCredential(apiKey: string): Promise<{ ok: true; domains: string[] } | { ok: false; message: string }> {
  const key = apiKey?.trim()
  if (!key) return { ok: false, message: 'An API key is required.' }
  try {
    const response = await fetch(`${apiBase()}/domains`, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      if (response.status === 401 || response.status === 403) return { ok: false, message: 'Resend rejected that API key. Check it and try again.' }
      return { ok: false, message: `Resend returned ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}` }
    }
    const data = (await response.json().catch(() => ({}))) as { data?: Array<{ name?: string; status?: string }> }
    const domains = (data.data ?? []).map((d) => d.name ?? '').filter(Boolean)
    return { ok: true, domains }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** True when `address`'s domain appears in the account's verified domain list. */
export function domainVerified(address: string, domains: string[]): boolean {
  const domain = address.split('@')[1]?.toLowerCase().trim()
  if (!domain) return false
  return domains.some((d) => d.toLowerCase().trim() === domain)
}

/** Send one message through Resend; returns the parsed id or the failure detail. */
async function postEmail(
  apiKey: string,
  from: string,
  input: { to: string; subject: string; text: string; html?: string },
): Promise<{ ok: true; id?: string } | { ok: false; status?: number; detail: string }> {
  try {
    const response = await fetch(`${apiBase()}/emails`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [input.to], subject: input.subject, text: input.text, ...(input.html ? { html: input.html } : {}) }),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      return { ok: false, status: response.status, detail }
    }
    const data = (await response.json().catch(() => ({}))) as { id?: string }
    return { ok: true, id: data.id }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

/** True when Resend rejected the message because the `from` domain is not verified. */
function isUnverifiedDomainError(status: number | undefined, detail: string): boolean {
  return status === 403 && /not verified|validation_error/i.test(detail)
}

/**
 * Send one email through Resend. Never throws and never logs the key.
 *
 * The sender domain is optional: when the configured `from` domain is not
 * verified in the Resend account, the send retries from Resend's shared
 * onboarding sender instead of failing the request outright.
 */
export async function sendEmail(input: {
  orgId: string
  to: string
  subject: string
  text: string
  html?: string
}): Promise<{ ok: true; id?: string } | { ok: false; reason: 'not_configured' | 'send_failed'; message?: string }> {
  const apiKey = (await orgResendKey(input.orgId)) ?? platformResendApiKey()
  if (!apiKey) return { ok: false, reason: 'not_configured' }
  const { from } = await emailSender(input.orgId)
  const attempt = await postEmail(apiKey, from, input)
  if (attempt.ok) return { ok: true, id: attempt.id }
  if (isUnverifiedDomainError(attempt.status, attempt.detail) && !from.includes('onboarding@resend.dev')) {
    emailLog.warn('Resend rejected the sender domain; retrying from the shared onboarding sender', { status: attempt.status })
    const retry = await postEmail(apiKey, RESEND_ONBOARDING_FROM, input)
    if (retry.ok) return { ok: true, id: retry.id }
    return { ok: false, reason: 'send_failed', message: retry.status ? `Resend returned ${retry.status}` : retry.detail }
  }
  if (attempt.status) emailLog.warn('Resend rejected an approval email', { status: attempt.status, detail: attempt.detail.slice(0, 200) })
  else emailLog.warn('Resend request failed', { error: attempt.detail })
  return { ok: false, reason: 'send_failed', message: attempt.status ? `Resend returned ${attempt.status}` : attempt.detail }
}
