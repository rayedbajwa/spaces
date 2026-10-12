import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { chromium, type Browser, type BrowserContext } from 'playwright'
import { createApprovalRequests, resolveGateRecipients } from '../src/lib/approval-store'
import { createApprovalFixture } from './helpers/approval-fixture'

if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync('/ms-playwright')) process.env.PLAYWRIGHT_BROWSERS_PATH = '/ms-playwright'

/**
 * Browser coverage for the approval link page (FR-007…FR-012/FR-022): sign in,
 * open the one-time link, submit a decision, and re-open a used link.
 */
const fixture = await createApprovalFixture({ port: 3127 })
const { baseUrl, projectA, users, teamA } = fixture

const resolved = await resolveGateRecipients(projectA.projectId, 'review')
const created = await createApprovalRequests({
  runId: fixture.runA, gateId: fixture.gateA, projectId: projectA.projectId, stage: 'review', kind: 'review',
  summary: 'Approved with 2 minor findings.\nTests pass.', recipients: resolved.recipients,
  responsibilityId: resolved.responsibilityId, responsibilityKey: resolved.responsibilityKey, fallback: resolved.fallback,
})
const token = created.find((item) => item.request.recipientUserId === users.productOwnerA)!.token

let browser: Browser
let signedIn: BrowserContext

async function contextWithToken(sessionToken: string): Promise<BrowserContext> {
  const context = await browser.newContext()
  await context.addCookies([{ name: 'spaces_session', value: sessionToken, url: baseUrl }])
  return context
}

afterAll(async () => {
  await browser?.close().catch(() => undefined)
  await fixture.stop()
})

describe('approval link page', () => {
  test('a signed-out visitor sees the inline sign-in instead of a bare error', async () => {
    browser = await chromium.launch()
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.goto(`${baseUrl}/approvals/${token}`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: /Sign in/ }).first().waitFor({ timeout: 30_000 })
    expect(await page.locator('form').count()).toBeGreaterThan(0)
    await context.close()
  })

  test('the valid link offers approve, approve with notes and request changes (FR-007)', async () => {
    const context = await contextWithToken(await fixture.sessionTokenFor(users.productOwnerA, teamA))
    const page = await context.newPage()
    await page.goto(`${baseUrl}/approvals/${token}`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Approve', exact: true }).waitFor({ timeout: 30_000 })
    expect(await page.getByRole('button', { name: 'Approve', exact: true }).count()).toBe(1)
    expect(await page.getByRole('button', { name: 'Approve with notes' }).count()).toBe(1)
    expect(await page.getByRole('button', { name: 'Request changes' }).count()).toBe(1)
    await context.close()
  })

  test('the recipient opens the link and submits a decision, and the used link shows the winner', async () => {
    signedIn = await contextWithToken(await fixture.sessionTokenFor(users.productOwnerA, teamA))
    const page = await signedIn.newPage()
    await page.goto(`${baseUrl}/approvals/${token}`, { waitUntil: 'domcontentloaded' })
    await page.locator('.approval-summary').waitFor({ timeout: 30_000 })
    expect(await page.locator('.approval-summary').innerText()).toContain('2 minor findings')

    await page.locator('.approval-feedback textarea').fill('Please add a rollback test.')
    await page.getByRole('button', { name: 'Request changes' }).click()
    await page.locator('.approval-outcome').waitFor({ timeout: 30_000 })
    expect(await page.locator('.approval-outcome').innerText()).toContain('Changes requested')

    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('.approval-outcome').waitFor({ timeout: 30_000 })
    expect(await page.locator('.approval-outcome').innerText()).toContain('Changes requested')
    expect(await page.locator('.approval-summary').innerText()).toContain('rollback test')
    await page.close()
  })
})
