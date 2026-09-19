/**
 * A real browser for agents: open pages, click, type, read text, run
 * JavaScript and take screenshots, backed by Playwright. Implement and QA
 * stages use it to start the app (bash), drive it like a user, and prove a
 * change works before reporting it. Screenshots land under
 * `<repo>/.aidlc/qa/` (git-excluded) so they can be referenced from reports.
 *
 * Browser resolution, in order: SPACES_BROWSER_PATH or
 * PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, a system Chromium/Chrome at a known
 * path (the Docker image installs Alpine's chromium), then Playwright's
 * `chrome` channel (a desktop Chrome install).
 */

import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { log } from './logger'

const browserLog = log.child({ mod: 'browser-tools' })

type Playwright = typeof import('playwright-core')
type Browser = import('playwright-core').Browser
type Page = import('playwright-core').Page

const SYSTEM_BROWSERS = [
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
]

/** Where the browser binary comes from; undefined means "let Playwright find Chrome". */
export function resolveBrowserExecutable(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string | undefined {
  const configured = (env.SPACES_BROWSER_PATH ?? env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)?.trim()
  if (configured) return configured
  return SYSTEM_BROWSERS.find((p) => exists(p))
}

/** Only http(s); local addresses are the whole point (the app under test). */
export function isAllowedBrowserUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch { return false }
}

function textResult(text: string, details: unknown = {}) {
  return { content: [{ type: 'text' as const, text }], details }
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'shot'
}

interface PageState { page: Page; consoleErrors: string[]; failedRequests: string[] }

/** One browser per process, one page per tool set (a stage or workstream). */
class BrowserSession {
  private static browser: Promise<Browser> | undefined
  private state?: PageState

  constructor(private readonly cwd: string) {}

  private static async launch(): Promise<Browser> {
    if (!BrowserSession.browser) {
      BrowserSession.browser = (async () => {
        const pw: Playwright = await import('playwright-core')
        const executablePath = resolveBrowserExecutable()
        const args = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        try {
          const browser = executablePath
            ? await pw.chromium.launch({ headless: true, executablePath, args })
            : await pw.chromium.launch({ headless: true, channel: 'chrome', args })
          browserLog.info('browser launched', { executablePath: executablePath ?? 'chrome channel' })
          browser.on('disconnected', () => { BrowserSession.browser = undefined })
          return browser
        } catch (error) {
          BrowserSession.browser = undefined
          throw new Error(`No browser available: ${error instanceof Error ? error.message : String(error)}. Install Chrome/Chromium, or set SPACES_BROWSER_PATH to a Chromium binary (the Docker image ships one).`)
        }
      })()
    }
    return BrowserSession.browser
  }

  async page(): Promise<PageState> {
    if (this.state && !this.state.page.isClosed()) return this.state
    const browser = await BrowserSession.launch()
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true })
    const page = await context.newPage()
    const state: PageState = { page, consoleErrors: [], failedRequests: [] }
    page.on('console', (m) => { if (m.type() === 'error') state.consoleErrors.push(m.text().slice(0, 300)) })
    page.on('pageerror', (e) => state.consoleErrors.push(`pageerror: ${e.message.slice(0, 300)}`))
    page.on('requestfailed', (r) => state.failedRequests.push(`${r.method()} ${r.url()} — ${r.failure()?.errorText ?? 'failed'}`))
    page.on('response', (r) => { if (r.status() >= 500) state.failedRequests.push(`${r.request().method()} ${r.url()} — HTTP ${r.status()}`) })
    this.state = state
    return state
  }

  async close(): Promise<void> {
    const state = this.state
    this.state = undefined
    if (state && !state.page.isClosed()) await state.page.context().close().catch(() => undefined)
  }

  diagnostics(state: PageState): string {
    const parts: string[] = []
    if (state.consoleErrors.length) parts.push(`Console errors (${state.consoleErrors.length}):\n${state.consoleErrors.slice(-8).map((e) => `- ${e}`).join('\n')}`)
    if (state.failedRequests.length) parts.push(`Failed requests (${state.failedRequests.length}):\n${state.failedRequests.slice(-8).map((e) => `- ${e}`).join('\n')}`)
    return parts.join('\n\n')
  }

  screenshotDir(): string {
    return path.join(this.cwd, '.aidlc', 'qa')
  }
}

async function visibleText(page: Page, selector?: string, max = 4000): Promise<string> {
  const text = selector
    ? await page.locator(selector).first().innerText({ timeout: 5_000 }).catch(() => '')
    : await page.evaluate(() => document.body?.innerText ?? '')
  const compact = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return compact.length > max ? `${compact.slice(0, max)}\n…(${compact.length - max} more chars)` : compact
}

/**
 * Browser tools for one agent session. `cwd` is the checkout the agent works
 * in; screenshots are saved under its `.aidlc/qa/`.
 */
export function buildBrowserTools(cwd: string): ToolDefinition[] {
  const session = new BrowserSession(cwd)
  const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required }) as unknown as ToolDefinition['parameters']

  const open: ToolDefinition = {
    name: 'browser_open',
    label: 'Open a page in the browser',
    description: 'Open a URL in a headless browser (Chromium) and return the title, final URL, HTTP status, the visible text and any console errors or failed requests. Start the app first with bash (in the background, e.g. `bun run dev &` or `npm start &`) and wait for its port. Use localhost URLs for the app under test.',
    promptSnippet: 'browser_open(url): load a page in a real browser and read it',
    promptGuidelines: [
      'For anything a user sees (pages, forms, flows), do not stop at unit tests: run the app, then verify with browser_open / browser_act / browser_read and take a browser_screenshot as evidence; cite the screenshot paths in your report.',
    ],
    parameters: schema({ url: { type: 'string', description: 'http(s) URL, typically http://localhost:<port>/…' }, waitFor: { type: 'string', description: 'Optional CSS selector or text to wait for before reading (e.g. "text=Welcome" or "#app").' }, timeoutMs: { type: 'integer', minimum: 1000, maximum: 60000 } }, ['url']),
    executionMode: 'sequential',
    async execute(_id, params) {
      const p = params as { url: string; waitFor?: string; timeoutMs?: number }
      if (!isAllowedBrowserUrl(p.url)) return textResult(`browser_open refused: only http(s) URLs are allowed (got ${p.url}).`, { error: true })
      try {
        const state = await session.page()
        state.consoleErrors.length = 0; state.failedRequests.length = 0
        const response = await state.page.goto(p.url, { waitUntil: 'load', timeout: p.timeoutMs ?? 30_000 })
        if (p.waitFor) await state.page.locator(p.waitFor.startsWith('text=') ? `text=${p.waitFor.slice(5)}` : p.waitFor).first().waitFor({ timeout: p.timeoutMs ?? 15_000 })
        await state.page.waitForTimeout(300)
        const text = await visibleText(state.page)
        const diag = session.diagnostics(state)
        return textResult(`# ${await state.page.title()}\nURL: ${state.page.url()} (HTTP ${response?.status() ?? 'n/a'})\n\n${text}${diag ? `\n\n${diag}` : ''}`, { url: state.page.url(), status: response?.status() ?? null, consoleErrors: state.consoleErrors.length, failedRequests: state.failedRequests.length })
      } catch (error) {
        return textResult(`browser_open failed: ${error instanceof Error ? error.message : String(error)}`, { error: true })
      }
    },
  }

  const act: ToolDefinition = {
    name: 'browser_act',
    label: 'Interact with the page',
    description: 'Interact with the current page: click a selector or text, type into a field, press a key, select an option, or wait for a selector/text. Selectors are Playwright locators (CSS, "text=Sign in", role selectors). Returns the visible text afterwards.',
    promptSnippet: 'browser_act(action, selector, value?): click / type / press / select / wait on the open page',
    parameters: schema({ action: { type: 'string', enum: ['click', 'type', 'press', 'select', 'wait', 'hover'] }, selector: { type: 'string', description: 'Locator: CSS, "text=…", "role=button[name=…]".' }, value: { type: 'string', description: 'Text to type, key to press (e.g. Enter), option to select.' }, submit: { type: 'boolean', description: 'After typing, press Enter.' }, timeoutMs: { type: 'integer', minimum: 500, maximum: 60000 } }, ['action', 'selector']),
    executionMode: 'sequential',
    async execute(_id, params) {
      const p = params as { action: string; selector: string; value?: string; submit?: boolean; timeoutMs?: number }
      try {
        const state = await session.page()
        const timeout = p.timeoutMs ?? 10_000
        const locator = state.page.locator(p.selector).first()
        switch (p.action) {
          case 'click': await locator.click({ timeout }); break
          case 'hover': await locator.hover({ timeout }); break
          case 'type': await locator.fill(p.value ?? '', { timeout }); if (p.submit) await locator.press('Enter'); break
          case 'press': await locator.press(p.value ?? 'Enter', { timeout }); break
          case 'select': await locator.selectOption(p.value ?? '', { timeout }); break
          case 'wait': await locator.waitFor({ timeout }); break
          default: return textResult(`browser_act: unknown action ${p.action}`, { error: true })
        }
        await state.page.waitForLoadState('load', { timeout: 10_000 }).catch(() => undefined)
        await state.page.waitForTimeout(250)
        const diag = session.diagnostics(state)
        return textResult(`${p.action} ${p.selector} ok\nURL: ${state.page.url()}\n\n${await visibleText(state.page, undefined, 3000)}${diag ? `\n\n${diag}` : ''}`, { url: state.page.url() })
      } catch (error) {
        return textResult(`browser_act failed: ${error instanceof Error ? error.message : String(error)}`, { error: true })
      }
    },
  }

  const read: ToolDefinition = {
    name: 'browser_read',
    label: 'Read from the page',
    description: 'Read the current page: visible text (optionally of one selector), the HTML of a selector, the title and URL, or the result of a JavaScript expression evaluated in the page (for assertions, e.g. `document.querySelectorAll(".row").length`). Also reports console errors and failed requests seen since the page was opened.',
    promptSnippet: 'browser_read(what, selector?|script?): text, html, url, or eval a script on the open page',
    parameters: schema({ what: { type: 'string', enum: ['text', 'html', 'url', 'eval', 'diagnostics'] }, selector: { type: 'string' }, script: { type: 'string', description: 'JavaScript expression for what=eval.' } }, ['what']),
    executionMode: 'sequential',
    async execute(_id, params) {
      const p = params as { what: string; selector?: string; script?: string }
      try {
        const state = await session.page()
        const diag = session.diagnostics(state)
        switch (p.what) {
          case 'text': return textResult(`${await visibleText(state.page, p.selector)}${diag ? `\n\n${diag}` : ''}`)
          case 'html': {
            const html = p.selector ? await state.page.locator(p.selector).first().innerHTML({ timeout: 5_000 }) : await state.page.content()
            return textResult(html.length > 6000 ? `${html.slice(0, 6000)}\n…(${html.length - 6000} more chars)` : html)
          }
          case 'url': return textResult(`${await state.page.title()}\n${state.page.url()}`, { url: state.page.url() })
          case 'eval': {
            const value = await state.page.evaluate(p.script ?? 'null')
            return textResult(typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? 'undefined', { value })
          }
          case 'diagnostics': return textResult(diag || 'No console errors or failed requests.', { consoleErrors: state.consoleErrors, failedRequests: state.failedRequests })
          default: return textResult(`browser_read: unknown what ${p.what}`, { error: true })
        }
      } catch (error) {
        return textResult(`browser_read failed: ${error instanceof Error ? error.message : String(error)}`, { error: true })
      }
    },
  }

  const screenshot: ToolDefinition = {
    name: 'browser_screenshot',
    label: 'Screenshot the page',
    description: 'Save a PNG screenshot of the current page (full page by default, or one selector) under .aidlc/qa/ in the working directory and return its path. Reference the path in verification and QA reports as evidence.',
    promptSnippet: 'browser_screenshot(name?, selector?): save a PNG under .aidlc/qa/ as evidence',
    parameters: schema({ name: { type: 'string', description: 'File name without extension, e.g. "login-success".' }, selector: { type: 'string' }, fullPage: { type: 'boolean' } }),
    executionMode: 'sequential',
    async execute(_id, params) {
      const p = params as { name?: string; selector?: string; fullPage?: boolean }
      try {
        const state = await session.page()
        const dir = session.screenshotDir()
        await mkdir(dir, { recursive: true })
        const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${slug(p.name ?? state.page.url().replace(/^https?:\/\//, ''))}.png`)
        if (p.selector) await state.page.locator(p.selector).first().screenshot({ path: file, timeout: 10_000 })
        else await state.page.screenshot({ path: file, fullPage: p.fullPage ?? true })
        return textResult(`Screenshot saved: ${file}`, { path: file })
      } catch (error) {
        return textResult(`browser_screenshot failed: ${error instanceof Error ? error.message : String(error)}`, { error: true })
      }
    },
  }

  const close: ToolDefinition = {
    name: 'browser_close',
    label: 'Close the browser page',
    description: 'Close the current browser page and forget its state. Use when you are done verifying, or to start over with a clean session (cookies, storage).',
    promptSnippet: 'browser_close(): close the page and start fresh next time',
    parameters: schema({}),
    executionMode: 'sequential',
    async execute() {
      await session.close()
      return textResult('Browser page closed.')
    },
  }

  return [open, act, read, screenshot, close]
}
