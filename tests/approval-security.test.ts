import { afterAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { getDb } from '../src/lib/db'
import { getAppIntegration, getAppIntegrationCredentials, upsertAppIntegration } from '../src/lib/app-integrations'
import { createApprovalRequests, hashApprovalToken, resolveGateRecipients, verifyApprovalLink } from '../src/lib/approval-store'
import { createApprovalFixture } from './helpers/approval-fixture'

/**
 * Security boundaries (FR-006/015/017/020): the link token is stored only as a
 * hash, refused attempts are recorded, and the email credential is sealed and
 * never exposed.
 */
const fixture = await createApprovalFixture({ withServer: false })
const { projectA, users } = fixture

afterAll(async () => { await fixture.stop() })

describe('approval security', () => {
  test('the raw link token is never stored; only its SHA-256 hash is', async () => {
    const resolved = await resolveGateRecipients(projectA.projectId, 'review')
    const created = await createApprovalRequests({
      runId: fixture.runA, gateId: fixture.gateA, projectId: projectA.projectId, stage: 'review', kind: 'review',
      summary: 'secret-free summary', recipients: resolved.recipients,
    })
    const raw = created[0]!.token
    const [link] = await getDb()<Array<{ tokenHash: string }>>`SELECT token_hash AS "tokenHash" FROM approval_links WHERE request_id = ${created[0]!.request.requestId}`
    expect(link?.tokenHash).toBe(createHash('sha256').update(raw).digest('hex'))
    expect(link?.tokenHash).toBe(hashApprovalToken(raw))
    const [row] = await getDb()<Array<Record<string, unknown>>>`SELECT * FROM approval_requests WHERE request_id = ${created[0]!.request.requestId}`
    expect(JSON.stringify(row)).not.toContain(raw)
  })

  test('a refused wrong-recipient open is recorded as an attempt', async () => {
    const resolved = await resolveGateRecipients(projectA.projectId, 'review')
    const { openGate } = await import('../src/lib/run-store')
    const gateId = await openGate({ runId: fixture.runA, stepIndex: 0, kind: 'review', prompt: 'review' })
    await getDb()`UPDATE pipeline_runs SET status = 'paused', pause_kind = 'review', current_stage = 'review' WHERE run_id = ${fixture.runA}`
    const created = await createApprovalRequests({ runId: fixture.runA, gateId, projectId: projectA.projectId, stage: 'review', kind: 'review', summary: 's', recipients: resolved.recipients })
    await verifyApprovalLink(created[0]!.token, users.memberA)
    const [attempt] = await getDb()<Array<{ outcome: string }>>`
      SELECT outcome FROM approval_link_attempts WHERE request_id = ${created[0]!.request.requestId} ORDER BY created_at DESC LIMIT 1
    `
    expect(attempt?.outcome).toBe('wrong_recipient')
  })

  test('the email API key is sealed at rest and never returned by the integration readers', async () => {
    await upsertAppIntegration({ orgId: fixture.orgA, kind: 'email', status: 'connected', displayName: 'Resend', config: { fromAddress: 'noreply@verified.example' }, credentials: { api_key: 're_super_secret_key' } })
    const [stored] = await getDb()<Array<{ credentialsJson: unknown }>>`SELECT credentials_json AS "credentialsJson" FROM app_integrations WHERE org_id = ${fixture.orgA} AND kind = 'email'`
    expect(JSON.stringify(stored?.credentialsJson)).not.toContain('re_super_secret_key')
    const row = await getAppIntegration(fixture.orgA, 'email')
    expect(JSON.stringify(row)).not.toContain('re_super_secret_key')
    // The reader can unseal it only for the send path; the API row type carries no credentials.
    expect((await getAppIntegrationCredentials(fixture.orgA, 'email'))?.api_key).toBe('re_super_secret_key')
  })
})
