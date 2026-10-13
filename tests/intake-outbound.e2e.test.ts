import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { chromium, type Browser, type BrowserContext } from 'playwright'
import { getDb } from '../src/lib/db'
import { upsertIntakeItem } from '../src/lib/intake-store'
import { upsertSubscription } from '../src/lib/outbound-store'
import { linkSlackIdentity } from '../src/lib/slack-identity'
import { createApprovalFixture } from './helpers/approval-fixture'

// Prefer the machine's bundled Chromium when present; on CI `bun run setup:browsers`
// installs it into Playwright's default cache.
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync('/ms-playwright')) process.env.PLAYWRIGHT_BROWSERS_PATH = '/ms-playwright'

setDefaultTimeout(60_000)

/**
 * Browser coverage for the 012 surfaces that have UI tasks (US1/US2 Intake
 * queue, US4 outbound configuration, US3 Slack identity confirmation). External
 * HTTP (Slack, Datadog, issue trackers) is never called; the fixture starts the
 * real server on its own port and seeds the data through the store APIs.
 *
 * `bun run build:web` must have run so `public/` carries these routes (CI builds
 * before tests; the quickstart runs it in step 1).
 */
const fixture = await createApprovalFixture({ port: 3371 })
const { baseUrl, orgA, users, teamA } = fixture

const suffix = randomUUID().slice(0, 8)
const item = await upsertIntakeItem({
  orgId: orgA,
  source: 'datadog',
  externalRef: `alert-${suffix}`,
  title: `E2E CPU saturation ${suffix}`,
  summary: 'CPU above 95% for 10 minutes',
  priority: 'urgent',
})
const subscription = await upsertSubscription({
  orgId: orgA,
  eventKind: 'run_failed',
  targetKind: 'slack',
  action: 'post_message',
  targetConfig: { channel: '#spaces-e2e' },
})
const pending = await linkSlackIdentity({ orgId: orgA, slackTeamId: `T-${suffix}`, slackUserId: `U-${suffix}`, email: null })
const slackToken = pending.token!

let browser: Browser
let context: BrowserContext

beforeAll(async () => {
  browser = await chromium.launch()
  context = await browser.newContext()
  await context.addCookies([{ name: 'spaces_session', value: await fixture.sessionTokenFor(users.ownerA, teamA), url: baseUrl }])
})

afterAll(async () => {
  await browser?.close().catch(() => undefined)
  await getDb()`DELETE FROM intake_items WHERE intake_id = ${item.intakeId}`.catch(() => undefined)
  await getDb()`DELETE FROM outbound_subscriptions WHERE subscription_id = ${subscription.subscriptionId}`.catch(() => undefined)
  await getDb()`DELETE FROM slack_identity_links WHERE link_id = ${pending.link.linkId}`.catch(() => undefined)
  await fixture.stop()
})

describe('intake queue', () => {
  test('renders the prioritized item with its source health and triage controls', async () => {
    const page = await context.newPage()
    await page.goto(`${baseUrl}/intake`, { waitUntil: 'domcontentloaded' })
    await page.getByText(`E2E CPU saturation ${suffix}`).first().waitFor({ timeout: 60_000 })
    expect(await page.locator('.intake-sources').count()).toBe(1)
    expect(await page.locator('.intake-item.priority-urgent').count()).toBeGreaterThanOrEqual(1)
    // The triage controls for the queued item (US2) are present.
    expect(await page.getByRole('button', { name: 'Dismiss' }).count()).toBeGreaterThanOrEqual(1)
    expect(await page.getByLabel('Convert to').count()).toBeGreaterThanOrEqual(1)
    await page.close()
  })
})

describe('outbound configuration', () => {
  test('shows the saved subscription and exposes the add form', async () => {
    const page = await context.newPage()
    await page.goto(`${baseUrl}/outbound`, { waitUntil: 'domcontentloaded' })
    await page.getByText('#spaces-e2e').first().waitFor({ timeout: 60_000 })
    expect(await page.locator('.outbound-row').count()).toBeGreaterThanOrEqual(1)
    expect(await page.getByRole('button', { name: 'Save' }).count()).toBe(1)
    await page.close()
  })
})

describe('workflow surfaces live under Integrations', () => {
  test('Integrations guides setup and links Work inbox and Outbound updates', async () => {
    const page = await context.newPage()
    await page.goto(`${baseUrl}/organization?section=integrations`, { waitUntil: 'domcontentloaded' })
    const surfaces = page.locator('.work-surfaces')
    await surfaces.waitFor({ timeout: 60_000 })
    expect(await surfaces.getByRole('heading', { name: 'Work inbox' }).count()).toBe(1)
    expect(await surfaces.getByRole('heading', { name: 'Outbound updates' }).count()).toBe(1)
    expect(await surfaces.getByText(/Connect a source under Project Management/).count()).toBe(1)
    await surfaces.getByRole('button', { name: 'Open work inbox' }).click()
    await page.locator('.intake-sources').waitFor({ timeout: 60_000 })
    expect(new URL(page.url()).pathname).toBe('/intake')
    await page.close()
  })
})

describe('datadog connection panel', () => {
  test('the monitoring category exposes a Datadog connect dialog', async () => {
    const page = await context.newPage()
    await page.goto(`${baseUrl}/organization?section=integrations`, { waitUntil: 'domcontentloaded' })
    const card = page.locator('.integration', { hasText: 'Datadog' }).first()
    await card.waitFor({ timeout: 60_000 })
    await card.getByRole('button', { name: 'Connect' }).click()
    await page.getByRole('heading', { name: 'Connect Datadog' }).waitFor({ timeout: 60_000 })
    expect(await page.getByPlaceholder('Datadog API key').count()).toBe(1)
    expect(await page.getByPlaceholder('Datadog application key').count()).toBe(1)
    await page.close()
  })
})

describe('slack identity confirmation', () => {
  test('a signed-in member confirms a pending link once', async () => {
    const page = await context.newPage()
    await page.goto(`${baseUrl}/slack-link/${encodeURIComponent(slackToken)}`, { waitUntil: 'domcontentloaded' })
    const verify = page.getByRole('button', { name: 'Verify my identity' })
    await verify.waitFor({ timeout: 60_000 })
    await verify.click()
    await page.getByText(/Your Slack identity is verified/).waitFor({ timeout: 60_000 })
    const [row] = await getDb()<Array<{ state: string; userId: string | null }>>`
      SELECT state, user_id AS "userId" FROM slack_identity_links WHERE link_id = ${pending.link.linkId}
    `
    expect(row?.state).toBe('verified')
    expect(row?.userId).toBe(users.ownerA)
    await page.close()
  })
})
