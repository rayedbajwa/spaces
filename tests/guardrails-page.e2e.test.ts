import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { createGuardrailsPageFixture } from './helpers/guardrails-page'

setDefaultTimeout(30_000)

// Prefer the machine's bundled Chromium when present; on CI the browser is
// installed into Playwright's default cache by `bun run setup:browsers`.
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync('/ms-playwright')) process.env.PLAYWRIGHT_BROWSERS_PATH = '/ms-playwright'

/**
 * Browser regression for Organization → Data guardrails (spec 008, FR-001…FR-009):
 * the mode options and section content share one aligned column with no
 * horizontal overflow at desktop and mobile widths, the select/edit/save
 * round-trip still works, a member sees a readable disabled view, the
 * accessibility associations are preserved, and layout edge cases do not break.
 */
let fixture: Awaited<ReturnType<typeof createGuardrailsPageFixture>>
let baseUrl: string
let users: { owner: string; member: string }
let teamId: string
let guardrailsUrl: string
let memoryUrl: string

let browser: Browser
let ownerContext: BrowserContext
let memberContext: BrowserContext

interface Metrics {
  contentLeft: number
  contentRight: number
  headingLeft: number | null
  modesLeft: number
  textarea: { left: number; right: number; scrollWidth: number; clientWidth: number } | null
  buttonLeft: number | null
  radios: Array<{ left: number; width: number }>
  textLefts: number[]
  docOverflow: boolean
  sectionOverflow: boolean
  modeCount: number
}

async function collect(page: Page): Promise<Metrics> {
  return page.evaluate(() => {
    const section = document.querySelector('section.guardrails-section') as HTMLElement
    const cs = getComputedStyle(section)
    const srect = section.getBoundingClientRect()
    const borderLeft = parseFloat(cs.borderLeftWidth) || 0
    const borderRight = parseFloat(cs.borderRightWidth) || 0
    const contentLeft = srect.left + borderLeft + parseFloat(cs.paddingLeft)
    const contentRight = srect.right - borderRight - parseFloat(cs.paddingRight)
    const rect = (el: Element | null) => (el ? (el as HTMLElement).getBoundingClientRect() : null)
    const heading = rect(section.querySelector('.team-section-head h3'))
    const modes = rect(section.querySelector('.guardrail-modes'))!
    const textarea = section.querySelector('textarea') as HTMLTextAreaElement | null
    const trect = rect(textarea)
    const button = rect(section.querySelector('.button-row button'))
    const labels = Array.from(section.querySelectorAll('label.guardrail-mode'))
    const radios = labels.map((l) => {
      const r = rect(l.querySelector('input[type=radio]'))!
      return { left: r.left, width: r.width }
    })
    const textLefts = labels.map((l) => rect(l.querySelector(':scope > span'))!.left)
    const docEl = document.documentElement
    return {
      contentLeft,
      contentRight,
      headingLeft: heading ? heading.left : null,
      modesLeft: modes.left,
      textarea:
        trect && textarea
          ? { left: trect.left, right: trect.right, scrollWidth: textarea.scrollWidth, clientWidth: textarea.clientWidth }
          : null,
      buttonLeft: button ? button.left : null,
      radios,
      textLefts,
      docOverflow: docEl.scrollWidth > docEl.clientWidth + 1,
      sectionOverflow: section.scrollWidth > section.clientWidth + 1,
      modeCount: labels.length,
    }
  })
}

function spread(values: Array<number | null>): number {
  const present = values.filter((v): v is number => v !== null)
  return Math.max(...present) - Math.min(...present)
}

function expectAligned(m: Metrics): void {
  expect(m.modeCount).toBe(4)
  // Every radio shares one left edge and one width; every text column one left edge.
  expect(spread(m.radios.map((r) => r.left))).toBeLessThanOrEqual(1)
  expect(spread(m.radios.map((r) => r.width))).toBeLessThanOrEqual(1)
  expect(spread(m.textLefts)).toBeLessThanOrEqual(1)
  // Heading, mode list, never-mask field and save action share the section content edge.
  for (const left of [m.headingLeft, m.modesLeft, m.textarea?.left ?? null, m.buttonLeft]) {
    expect(Math.abs((left as number) - m.contentLeft)).toBeLessThanOrEqual(1)
  }
  // No horizontal overflow.
  expect(m.docOverflow).toBe(false)
  expect(m.sectionOverflow).toBe(false)
  if (m.textarea) {
    expect(m.textarea.right).toBeLessThanOrEqual(m.contentRight + 1)
    expect(m.textarea.scrollWidth).toBeLessThanOrEqual(m.textarea.clientWidth + 1)
  }
}

async function gotoGuardrails(page: Page): Promise<void> {
  await page.goto(guardrailsUrl, { waitUntil: 'domcontentloaded' })
  await page.locator('.guardrails-section .guardrail-modes').waitFor({ timeout: 30_000 })
  await page.locator('section.guardrails-section textarea').waitFor({ timeout: 30_000 })
  // The radios render from the fetched policy; wait for a checked one.
  await page.locator('section.guardrails-section input[type=radio]:checked').waitFor({ timeout: 30_000 })
}

beforeAll(async () => {
  fixture = await createGuardrailsPageFixture()
  baseUrl = fixture.baseUrl
  users = fixture.users
  teamId = fixture.teamId
  guardrailsUrl = `${baseUrl}/organization?section=guardrails`
  memoryUrl = `${baseUrl}/organization?section=memory`
  const ownerToken = await fixture.sessionTokenFor(users.owner, teamId)
  const memberToken = await fixture.sessionTokenFor(users.member, teamId)

  browser = await chromium.launch()
  ownerContext = await browser.newContext()
  await ownerContext.addCookies([{ name: 'spaces_session', value: ownerToken, url: baseUrl }])
  memberContext = await browser.newContext()
  await memberContext.addCookies([{ name: 'spaces_session', value: memberToken, url: baseUrl }])
}, 60_000)

afterAll(async () => {
  await browser?.close().catch(() => undefined)
  await fixture.stop()
})

describe('guardrails page layout', () => {
  test('T004 desktop and mobile: mode options and section content share one aligned column with no overflow', async () => {
    for (const width of [1440, 390]) {
      const page = await ownerContext.newPage()
      await page.setViewportSize({ width, height: 900 })
      await gotoGuardrails(page)

      const m = await collect(page)
      expectAligned(m)

      // The selected mode is visually distinguishable.
      expect(await page.locator('label.guardrail-mode.selected').count()).toBe(1)
      expect(await page.locator('label.guardrail-mode.selected input[type=radio]').isChecked()).toBe(true)

      await page.close()
    }
  })

  test('T004 the guardrails content column matches a sibling Organization section at both widths', async () => {
    for (const width of [1440, 390]) {
      const page = await ownerContext.newPage()
      await page.setViewportSize({ width, height: 900 })
      await page.goto(memoryUrl, { waitUntil: 'domcontentloaded' })
      await page.locator('section.team-section').first().waitFor({ timeout: 30_000 })
      const sibling = await page.evaluate(() => {
        const s = document.querySelector('section.team-section') as HTMLElement
        const cs = getComputedStyle(s)
        const r = s.getBoundingClientRect()
        return {
          left: r.left + (parseFloat(cs.borderLeftWidth) || 0) + parseFloat(cs.paddingLeft),
          right: r.right - (parseFloat(cs.borderRightWidth) || 0) - parseFloat(cs.paddingRight),
        }
      })
      await page.close()

      const gpage = await ownerContext.newPage()
      await gpage.setViewportSize({ width, height: 900 })
      await gotoGuardrails(gpage)
      const m = await collect(gpage)
      expect(Math.abs(m.contentLeft - sibling.left)).toBeLessThanOrEqual(1)
      expect(Math.abs(m.contentRight - sibling.right)).toBeLessThanOrEqual(1)
      await gpage.close()
    }
  })

  test('T007 the radiogroup and never-mask field keep their accessibility associations', async () => {
    const page = await ownerContext.newPage()
    await page.setViewportSize({ width: 1440, height: 900 })
    await gotoGuardrails(page)

    expect(await page.getByRole('radiogroup', { name: 'Guardrail mode' }).count()).toBe(1)
    for (const name of [/Mask \(recommended\)/, /Strict/, /Warn only/, /Off/]) {
      expect(await page.getByRole('radio', { name }).count()).toBe(1)
    }
    expect(await page.getByLabel(/Never mask/).count()).toBe(1)

    const described = await page.locator('section.guardrails-section textarea').getAttribute('aria-describedby')
    expect(described).toBeTruthy()
    const hintId = described!.trim().split(/\s+/)[0]!
    expect(await page.locator(`#${hintId}`).count()).toBe(1)

    await page.close()
  })

  test('T006 a member sees the aligned section read-only with disabled controls and the explanatory message', async () => {
    const page = await memberContext.newPage()
    await page.setViewportSize({ width: 1440, height: 900 })
    await gotoGuardrails(page)

    const m = await collect(page)
    // No save action for a member: align the heading, modes and textarea instead.
    for (const left of [m.headingLeft, m.modesLeft, m.textarea?.left ?? null]) {
      expect(Math.abs((left as number) - m.contentLeft)).toBeLessThanOrEqual(1)
    }
    expect(spread(m.radios.map((r) => r.left))).toBeLessThanOrEqual(1)
    expect(spread(m.textLefts)).toBeLessThanOrEqual(1)
    expect(m.docOverflow).toBe(false)
    expect(m.sectionOverflow).toBe(false)

    expect(await page.locator('.guardrail-mode input[type=radio]').first().isDisabled()).toBe(true)
    expect(await page.locator('section.guardrails-section textarea').isDisabled()).toBe(true)
    expect(await page.locator('section.guardrails-section .button-row button').count()).toBe(0)
    expect(await page.locator('.guardrails-section').getByText('Only team owners or admins can change the guardrails.').count()).toBe(1)

    await page.close()
  })

  test('T008 edge cases keep the layout aligned: empty list, long entry, in-flight save, success and error messages', async () => {
    const page = await ownerContext.newPage()
    await page.setViewportSize({ width: 390, height: 844 })
    await gotoGuardrails(page)

    const textarea = page.locator('section.guardrails-section textarea')
    const saveButton = page.locator('section.guardrails-section .button-row button')

    // A very long single-line allow entry must not overflow or blow out a column.
    await textarea.fill(`/${'a'.repeat(400)}/`)
    const longEntry = await collect(page)
    expectAligned(longEntry)
    expect(await saveButton.isEnabled()).toBe(true)

    // An empty/cleared list keeps the field and button aligned with the correct state.
    await textarea.fill('')
    // Change the mode so an empty list is still a change worth saving.
    await page.getByRole('radio', { name: /Warn only/ }).check()
    const empty = await collect(page)
    expectAligned(empty)
    expect(await saveButton.isEnabled()).toBe(true)

    // In-flight disabled state does not shift layout.
    await page.route('**/api/org/guardrails', async (route) => {
      if (route.request().method() === 'PUT') await new Promise((resolve) => setTimeout(resolve, 900))
      await route.continue()
    })
    await textarea.fill('support@acme.io')
    await page.getByRole('button', { name: 'Save guardrails' }).click()
    await page.getByRole('button', { name: 'Saving…' }).waitFor({ timeout: 5_000 })
    const inFlight = await collect(page)
    expectAligned(inFlight)
    expect(await page.locator('.guardrail-mode input[type=radio]').first().isDisabled()).toBe(true)
    await page.getByRole('button', { name: 'Saved' }).waitFor({ timeout: 15_000 })

    // A success message does not break alignment.
    await page.locator('.team-flash-ok').filter({ hasText: 'Guardrails saved' }).waitFor({ timeout: 5_000 })
    const success = await collect(page)
    expectAligned(success)
    await page.unroute('**/api/org/guardrails')

    // An error message does not break alignment either.
    await page.route('**/api/org/guardrails', async (route) => {
      if (route.request().method() === 'PUT') {
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'test failure' }) })
        return
      }
      await route.continue()
    })
    await textarea.fill('jane.doe@acme.io')
    await page.getByRole('button', { name: 'Save guardrails' }).click()
    await page.locator('.guardrails-section .error-text').waitFor({ timeout: 5_000 })
    const errored = await collect(page)
    expectAligned(errored)
    await page.unroute('**/api/org/guardrails')

    await page.close()
  })

  test('T005 an owner selects a mode, edits the never-mask list and saves; it survives a reload and the API reflects it', async () => {
    const page = await ownerContext.newPage()
    await page.setViewportSize({ width: 1440, height: 900 })
    await gotoGuardrails(page)

    await page.getByRole('radio', { name: /Strict/ }).check()
    await page.locator('section.guardrails-section textarea').fill('support@acme.io\n/@example\\.test$/')
    await page.getByRole('button', { name: 'Save guardrails' }).click()
    await page.locator('.team-flash-ok').filter({ hasText: 'Guardrails saved' }).waitFor({ timeout: 15_000 })

    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('.guardrails-section .guardrail-modes').waitFor({ timeout: 30_000 })
    await page.locator('section.guardrails-section input[type=radio]:checked').waitFor({ timeout: 30_000 })
    expect(await page.getByRole('radio', { name: /Strict/ }).isChecked()).toBe(true)
    const value = await page.locator('section.guardrails-section textarea').inputValue()
    expect(value).toContain('support@acme.io')

    const res = await fetch(`${baseUrl}/api/org/guardrails`, {
      headers: { cookie: await fixture.cookieFor(users.owner, teamId) },
    })
    expect(res.ok).toBe(true)
    const body = (await res.json()) as { policy: { mode: string; allow: string[] } }
    expect(body.policy.mode).toBe('strict')
    expect(body.policy.allow).toContain('support@acme.io')

    await page.close()
  })
})
