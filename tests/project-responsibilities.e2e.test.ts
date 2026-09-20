import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { createResponsibilityApiFixture } from './helpers/responsibilities-api'

// Prefer the machine's bundled Chromium when present; on CI the browser is
// installed into Playwright's default cache by `bun run setup:browsers`.
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync('/ms-playwright')) process.env.PLAYWRIGHT_BROWSERS_PATH = '/ms-playwright'

/**
 * Browser coverage for the project Responsibilities panel (T026, SC-005):
 * an owner sees and edits assignments, an ordinary member sees a read-only
 * view, and a saved order survives a reload.
 */
const fixture = await createResponsibilityApiFixture({ port: 3122 })
const { baseUrl, users, projectA, teamA } = fixture
const projectUrl = `${baseUrl}/spaces/${encodeURIComponent(projectA.code ?? projectA.slug)}`

let browser: Browser
let ownerContext: BrowserContext
let memberContext: BrowserContext

async function contextWithToken(token: string): Promise<BrowserContext> {
  const context = await browser.newContext()
  await context.addCookies([{ name: 'spaces_session', value: token, url: baseUrl }])
  return context
}

function panel(page: Page) {
  return page.locator('h3', { hasText: 'Responsibilities' }).locator('xpath=ancestor::section[1]')
}

function row(page: Page, name: string) {
  return panel(page).locator('.repo-row').filter({ has: page.locator('strong', { hasText: new RegExp(`^${name}$`) }) })
}

async function gotoProject(page: Page): Promise<void> {
  await page.goto(projectUrl, { waitUntil: 'domcontentloaded' })
  await page.locator('h3', { hasText: 'Responsibilities' }).waitFor({ timeout: 30_000 })
  // The panel renders before its data arrives; wait for the first role row.
  await panel(page).locator('.repo-row').first().waitFor({ timeout: 30_000 })
}

afterAll(async () => {
  await browser?.close().catch(() => undefined)
  await fixture.stop()
})

describe('responsibility management UI', () => {
  test('the owner sees all six roles, status badges and edit controls', async () => {
    browser = await chromium.launch()
    ownerContext = await contextWithToken(await fixture.sessionTokenFor(users.ownerA, teamA))
    const page = await ownerContext.newPage()
    await gotoProject(page)

    for (const name of ['Owner', 'Product Owner', 'Lead Engineer', 'Designer', 'QA', 'Release Manager']) {
      expect(await row(page, name).count()).toBe(1)
    }
    expect(await row(page, 'Owner').locator('text=primary').count()).toBe(1)
    expect(await row(page, 'QA').locator('button', { hasText: 'Edit' }).count()).toBe(1)

    await page.screenshot({ path: 'test-results/responsibilities-owner.png', fullPage: true })
  })

  test('an owner assigns an ordered member and the order survives a reload', async () => {
    const page = await ownerContext.newPage()
    await gotoProject(page)

    await row(page, 'QA').locator('button', { hasText: 'Edit' }).click()
    const editor = page.locator('.responsibility-editor')
    await editor.waitFor({ timeout: 10_000 })
    const memberCheckbox = editor.locator('label', { hasText: 'Member A' }).locator('input[type=checkbox]')
    await memberCheckbox.waitFor({ timeout: 10_000 })
    await memberCheckbox.check()
    await page.getByRole('button', { name: 'Save assignments' }).click()
    await editor.waitFor({ state: 'detached', timeout: 10_000 })

    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('h3', { hasText: 'Responsibilities' }).waitFor({ timeout: 30_000 })
    await panel(page).locator('.repo-row').first().waitFor({ timeout: 30_000 })
    const qaRow = row(page, 'QA')
    expect(await qaRow.locator('text=Member A').count()).toBe(1)
    expect(await qaRow.locator('text=primary').count()).toBe(1)

    await page.screenshot({ path: 'test-results/responsibilities-saved.png', fullPage: true })
    await page.close()
  })

  test('an ordinary member sees the statuses but no edit controls', async () => {
    memberContext = await contextWithToken(await fixture.sessionTokenFor(users.memberA, teamA))
    const page = await memberContext.newPage()
    await gotoProject(page)

    expect(await row(page, 'Owner').count()).toBe(1)
    expect(await panel(page).locator('button', { hasText: 'Edit' }).count()).toBe(0)
    expect(await page.locator('.responsibility-editor').count()).toBe(0)
    await page.close()
  })
})
