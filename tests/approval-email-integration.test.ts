import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { getAppIntegration, getAppIntegrationCredentials, listAppIntegrations } from '../src/lib/app-integrations'
import { createApprovalFixture } from './helpers/approval-fixture'

/**
 * Email as an organization integration (FR-003/004/016): verify, connect,
 * sealed-key storage, unverified-domain rejection, disconnect and org-admin
 * gating. Resend is a local mock via RESEND_API_URL; no live key is used.
 */
const MOCK_PORT = 3125
const mock = Bun.serve({
  port: MOCK_PORT,
  fetch: async (req) => {
    const url = new URL(req.url)
    const auth = req.headers.get('authorization') ?? ''
    if (!auth.startsWith('Bearer ')) return Response.json({ message: 'missing key' }, { status: 401 })
    if (url.pathname === '/domains') return Response.json({ data: [{ name: 'verified.example', status: 'verified' }] })
    if (url.pathname === '/emails') return Response.json({ id: 'mock-email-1' })
    return Response.json({ message: 'not found' }, { status: 404 })
  },
})
const previousResendApiUrl = process.env.RESEND_API_URL
process.env.RESEND_API_URL = `http://127.0.0.1:${MOCK_PORT}`

const fixture = await createApprovalFixture({ port: 3124 })
const { baseUrl, orgA, users, teamA } = fixture

const adminCookie = await fixture.cookieFor(users.ownerA, teamA)
const memberCookie = await fixture.cookieFor(users.memberA, teamA)

async function api<T = any>(method: string, path: string, cookie: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: unknown
  try { parsed = text ? JSON.parse(text) : undefined } catch { parsed = text }
  return { status: res.status, body: parsed as T }
}

afterAll(async () => {
  await fixture.stop()
  mock.stop(true)
  // Do not leak the mock Resend endpoint to later test files in the same process.
  if (previousResendApiUrl === undefined) delete process.env.RESEND_API_URL
  else process.env.RESEND_API_URL = previousResendApiUrl
})

describe('email integration', () => {
  test('an org admin verifies a Resend key against the verified domains', async () => {
    const res = await api<{ ok: boolean; domains: string[] }>('POST', '/api/integrations/email/verify', adminCookie, { apiKey: 're_test_key' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.domains).toContain('verified.example')
  })

  test('a plain member cannot verify or connect email (org-admin gating)', async () => {
    const verify = await api('POST', '/api/integrations/email/verify', memberCookie, { apiKey: 're_test_key' })
    expect(verify.status).toBe(403)
    const token = await api('POST', '/api/integrations/email/token', memberCookie, { apiKey: 're_test_key', fromAddress: 'noreply@verified.example' })
    expect(token.status).toBe(403)
  })

  test('a from address on an unverified domain is rejected and nothing is stored', async () => {
    const res = await api<{ error: string }>('POST', '/api/integrations/email/token', adminCookie, { apiKey: 're_test_key', fromAddress: 'noreply@other.example' })
    expect(res.status).toBe(400)
    expect(String(res.body.error)).toContain('not verified')
    expect(await getAppIntegration(orgA, 'email')).toBeUndefined()
  })

  test('connecting stores the key sealed and never returns it', async () => {
    const res = await api<{ ok: boolean; integration: { kind: string; status: string } }>('POST', '/api/integrations/email/token', adminCookie, { apiKey: 're_test_key', fromAddress: 'noreply@verified.example', fromName: 'Acme Approvals' })
    expect(res.status).toBe(200)
    expect(res.body.integration).toMatchObject({ kind: 'email', status: 'connected' })

    const creds = await getAppIntegrationCredentials(orgA, 'email')
    expect(creds?.api_key).toBe('re_test_key')

    const listed = await listAppIntegrations(orgA)
    const email = listed.find((row) => row.kind === 'email')!
    expect(email.credentialsOk).toBe(true)
    expect(JSON.stringify(listed)).not.toContain('re_test_key')

    const apiList = await api<unknown[]>('GET', '/api/integrations', adminCookie)
    expect(JSON.stringify(apiList.body)).not.toContain('re_test_key')
  })

  test('disconnect clears the credential and the connection', async () => {
    const res = await api('DELETE', '/api/integrations/email', adminCookie)
    expect(res.status).toBe(200)
    const row = await getAppIntegration(orgA, 'email')
    expect(row?.status).toBe('not_connected')
    expect(await getAppIntegrationCredentials(orgA, 'email')).toBeUndefined()
  })
})
