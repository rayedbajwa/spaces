import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { chromium, type Browser, type Page } from 'playwright'
import { getDb } from '../src/lib/db'
import { addRepo, createProject } from '../src/lib/project-registry'
import { SESSION_COOKIE } from '../src/lib/auth'
import { createGuardrailsPageFixture } from './helpers/guardrails-page'

setDefaultTimeout(60_000)

if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync('/ms-playwright')) process.env.PLAYWRIGHT_BROWSERS_PATH = '/ms-playwright'

/**
 * Browser regression for the agent bar after a project switch: a slow
 * latest-run answer for the project just left, and its live log still
 * streaming, must not replace the open project's run. The bar used to show
 * "no run" until the 10 s latest-run poll put the right run back.
 */
interface SeededProject { projectId: string; slug: string; code: string; runId: string }
interface SeededLogRun extends SeededProject { sentinel: string }

let fixture: Awaited<ReturnType<typeof createGuardrailsPageFixture>>
let browser: Browser
let page: Page
let workDir: string
let projectA: SeededProject
let projectB: SeededProject
/** Runs seeded for the log-dock open-at-bottom regression (specs/013). */
const dockRuns: SeededLogRun[] = []

async function seedProject(label: string, status: 'running' | 'completed', stage: string): Promise<SeededProject> {
  const sql = getDb()
  const suffix = randomUUID().slice(0, 8)
  const project = await createProject({ name: `Agent bar ${label} ${suffix}`, slug: `agent-bar-${label.toLowerCase()}-${suffix}`, teamId: fixture.teamId, createdBy: fixture.users.owner })
  const localPath = path.join(workDir, label)
  await addRepo({ projectId: project.projectId, label: 'app', kind: 'local', localPath, isPrimary: true })
  const runId = randomUUID()
  const template = { name: 'aidlc-feature', steps: [{ stage: 'specify' }, { stage: 'plan' }, { stage: 'implement' }] }
  await sql`INSERT INTO pipeline_runs (run_id, project_id, project_namespace, project_label, project_path, pipeline_name, status, current_stage, options_json, template_json)
    VALUES (${runId}, ${project.projectId}, ${project.slug}, ${project.name}, ${localPath}, 'aidlc-feature', ${status}, ${stage}, ${sql.json({} as never)}, ${sql.json(template as never)})`
  if (!project.code) throw new Error(`project ${project.slug} got no readable code`)
  return { projectId: project.projectId, slug: project.slug, code: project.code, runId }
}

async function dockStatus(): Promise<string> {
  return ((await page.locator('section.agent-dock .dock-mini-status').textContent()) ?? '').trim()
}

/**
 * Seed a run with pre-existing streamed output: a project/repo, one
 * `pipeline_runs` row and `lines` `pipeline_events` rows of `kind='log'` ending
 * in a unique sentinel line. `snapshotFromRow` joins those events into
 * `currentRun.log`. `lines=0` seeds an empty ("warming up") buffer.
 */
async function seedRunWithLog(
  label: string,
  status: 'running' | 'paused' | 'completed' | 'error' | 'queued' | 'cancelled',
  stage: string,
  lines = 60,
  options: { pauseKind?: string } = {},
): Promise<SeededLogRun> {
  const sql = getDb()
  const suffix = randomUUID().slice(0, 8)
  const project = await createProject({
    name: `Log dock ${label} ${suffix}`,
    slug: `log-dock-${label.toLowerCase()}-${suffix}`,
    teamId: fixture.teamId,
    createdBy: fixture.users.owner,
  })
  const localPath = path.join(workDir, `log-dock-${label.toLowerCase()}-${suffix}`)
  await addRepo({ projectId: project.projectId, label: 'app', kind: 'local', localPath, isPrimary: true })
  if (!project.code) throw new Error(`project ${project.slug} got no readable code`)

  const runId = randomUUID()
  const template = { name: 'aidlc-feature', steps: [{ stage: 'specify' }, { stage: 'plan' }, { stage: 'implement' }] }
  await sql`INSERT INTO pipeline_runs (run_id, project_id, project_namespace, project_label, project_path, pipeline_name, status, pause_kind, current_stage, options_json, template_json)
    VALUES (${runId}, ${project.projectId}, ${project.slug}, ${project.name}, ${localPath}, 'aidlc-feature', ${status}, ${options.pauseKind ?? null}, ${stage}, ${sql.json({} as never)}, ${sql.json(template as never)})`

  if (lines > 0) {
    const chunks: string[] = []
    for (let i = 0; i < lines; i += 1) {
      chunks.push(`[00:00:${String(i % 60).padStart(2, '0')}Z ${stage}] line ${i}\n`)
    }
    // One INSERT keeps the seed fast on a remote test database; the sentinel
    // goes in a second statement so its event_id is the largest and the joined
    // log ends with it.
    await sql`INSERT INTO pipeline_events (run_id, kind, payload)
      SELECT ${runId}, 'log', jsonb_build_object('chunk', chunk) FROM unnest(${chunks}::text[]) AS chunk`
  }
  const sentinel = lines > 0 ? `${label.toUpperCase()}-SENTINEL-${suffix}` : ''
  if (sentinel) {
    await sql`INSERT INTO pipeline_events (run_id, kind, payload)
      VALUES (${runId}, 'log', ${sql.json({ chunk: `[00:00:59Z ${stage}] ${sentinel}\n` } as never)})`
  }

  const seeded: SeededLogRun = { projectId: project.projectId, slug: project.slug, code: project.code, runId, sentinel }
  dockRuns.push(seeded)
  return seeded
}

/** Insert one more streamed log line, as a live worker would. */
async function appendLogLine(runId: string, chunk: string): Promise<void> {
  const sql = getDb()
  await sql`INSERT INTO pipeline_events (run_id, kind, payload) VALUES (${runId}, 'log', ${sql.json({ chunk } as never)})`
}

/** Navigate to the project and open the dock (it auto-opens for active runs). */
async function gotoProjectAndOpen(run: SeededLogRun): Promise<void> {
  await page.goto(`${fixture.baseUrl}/spaces/${run.code}`, { waitUntil: 'domcontentloaded' })
  await page.locator('section.agent-dock').waitFor({ timeout: 30_000 })
  // Wait until the dock actually reflects this run: the log is rendered (open),
  // or the collapsed mini names a status instead of "no run".
  await page.waitForFunction(
    () => {
      const dock = document.querySelector('section.agent-dock')
      if (!dock) return false
      if (dock.querySelector('pre.run-log')) return true
      const status = dock.querySelector('.dock-mini-status')?.textContent ?? ''
      return status.trim().length > 0 && !/no run/.test(status)
    },
    undefined,
    { timeout: 20_000 },
  )
  const mini = page.locator('section.agent-dock .dock-mini')
  if (await mini.isVisible().catch(() => false)) await mini.click()
  await page.locator('section.agent-dock pre.run-log').waitFor({ state: 'visible', timeout: 15_000 })
}

type LogGeometry = { scrollTop: number; clientHeight: number; scrollHeight: number }

async function logGeometry(): Promise<LogGeometry> {
  return await page.locator('section.agent-dock pre.run-log').evaluate((el) => ({
    scrollTop: el.scrollTop,
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
  }))
}

async function logIsAtBottom(): Promise<boolean> {
  const g = await logGeometry()
  return g.scrollHeight <= g.clientHeight + 2 || g.scrollTop + g.clientHeight >= g.scrollHeight - 2
}

/** The sentinel line is the last rendered line and sits inside the visible pane. */
async function sentinelIsVisible(sentinel: string): Promise<boolean> {
  return await page.locator('section.agent-dock pre.run-log').evaluate((el, s) => {
    const lines = el.querySelectorAll('.log-line')
    const last = lines[lines.length - 1] as HTMLElement | undefined
    if (!last || !(last.textContent ?? '').includes(s)) return false
    const line = last.getBoundingClientRect()
    const pane = el.getBoundingClientRect()
    return line.top >= pane.top - 2 && line.bottom <= pane.bottom + 2
  }, sentinel)
}

async function waitForSentinel(run: SeededLogRun, timeout = 15_000): Promise<void> {
  await page.waitForFunction(
    (s) => (document.querySelector('section.agent-dock pre.run-log')?.textContent ?? '').includes(s),
    run.sentinel,
    { timeout },
  )
}

/** Let layout effects and the paint settle before reading scroll geometry. */
async function settleLayout(): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

beforeAll(async () => {
  fixture = await createGuardrailsPageFixture({ port: 3373 })
  workDir = mkdtempSync(path.join(tmpdir(), 'agent-bar-e2e-'))
  projectA = await seedProject('A', 'running', 'implement')
  projectB = await seedProject('B', 'completed', 'plan')

  browser = await chromium.launch()
  const context = await browser.newContext()
  const token = await fixture.sessionTokenFor(fixture.users.owner, fixture.teamId)
  await context.addCookies([{ name: SESSION_COOKIE, value: token, url: fixture.baseUrl }])
  page = await context.newPage()
  await page.setViewportSize({ width: 1440, height: 900 })
})

afterAll(async () => {
  await browser?.close().catch(() => undefined)
  const sql = getDb()
  for (const p of [projectA, projectB, ...dockRuns]) {
    if (!p) continue
    await sql`DELETE FROM pipeline_events WHERE run_id = ${p.runId}`.catch(() => undefined)
    await sql`DELETE FROM pipeline_runs WHERE project_id = ${p.projectId}`.catch(() => undefined)
    await sql`DELETE FROM project_repos WHERE project_id = ${p.projectId}`.catch(() => undefined)
    await sql`DELETE FROM projects WHERE project_id = ${p.projectId}`.catch(() => undefined)
  }
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  await fixture?.stop()
})

describe('agent bar across a project switch', () => {
  test("the bar keeps the open project's run when the previous project's late answer and live log arrive", async () => {
    // Hold A's latest-run answer until B's has been shown, so it lands after the switch.
    let bAnswered!: () => void
    const bAnsweredPromise = new Promise<void>((resolve) => { bAnswered = resolve })
    let aRequested!: () => void
    const aRequestedPromise = new Promise<void>((resolve) => { aRequested = resolve })
    let aDelivered!: () => void
    const aDeliveredPromise = new Promise<void>((resolve) => { aDelivered = resolve })
    let aSnapshot = ''
    let holdA = true

    page.on('response', (res) => {
      if (res.url().endsWith(`/api/projects/${projectB.slug}/latest-run`)) bAnswered()
    })
    await page.route(`**/api/projects/${projectA.slug}/latest-run`, async (route) => {
      const response = await route.fetch()
      const body = await response.text()
      aSnapshot = body
      if (holdA) {
        holdA = false
        aRequested()
        await Promise.race([bAnsweredPromise, new Promise((resolve) => setTimeout(resolve, 8_000))])
        await new Promise((resolve) => setTimeout(resolve, 300))
        await route.fulfill({ response, body }).catch(() => undefined)
        aDelivered()
        return
      }
      await route.fulfill({ response, body }).catch(() => undefined)
    })
    // A's live log: a stream that keeps sending A's (running) run.
    let aStreamRequests = 0
    await page.route(`**/api/runs/${projectA.runId}/events`, async (route) => {
      aStreamRequests += 1
      const line = `data: ${aSnapshot}\n\n`
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }, body: line.repeat(3) }).catch(() => undefined)
    })

    // Open A (its latest-run answer is held).
    await page.goto(`${fixture.baseUrl}/spaces/${projectA.code}`, { waitUntil: 'domcontentloaded' })
    await page.locator('section.agent-dock').waitFor({ timeout: 30_000 })
    await aRequestedPromise
    expect(JSON.parse(aSnapshot).projectNamespace).toBe(projectA.slug)

    // Switch to B in-app (no reload): the URL changes and popstate opens B by code.
    await page.evaluate((code) => {
      window.history.pushState({}, '', `/spaces/${code}`)
      window.dispatchEvent(new PopStateEvent('popstate', { state: {} }))
    }, projectB.code)

    // B's run shows up.
    await page.waitForFunction(() => /^completed/.test(document.querySelector('section.agent-dock .dock-mini-status')?.textContent?.trim() ?? ''), undefined, { timeout: 15_000 })

    // A's late answer lands now; give it (and any live log it opens) time to act.
    await aDeliveredPromise
    const samples: string[] = []
    const until = Date.now() + 3_000
    while (Date.now() < until) {
      samples.push(await dockStatus())
      await page.waitForTimeout(100)
    }
    expect(new URL(page.url()).pathname).toBe(`/spaces/${projectB.code}`)
    expect(samples.filter((s) => !/^completed/.test(s))).toEqual([])
    expect(await dockStatus()).toMatch(/^completed · plan/)
    // Logged for diagnosis: with the fix, A's stream is never opened after the switch.
    if (aStreamRequests > 0) console.log(`A's live log was requested ${aStreamRequests} time(s) after the switch`)
  })
})

/**
 * Regression for specs/013-fix-log-open-bottom (test-plan.md cases B1-B10):
 * opening the agent-output dock pins the buffer to its newest line in every run
 * state, a re-open discards a previously left position, a run switch shows the
 * new run's newest line, while streaming follow, the reader's scroll-up and the
 * panel controls are unchanged.
 */
describe('log dock opens at the bottom', () => {
  test('B1 a completed run with pre-existing output opens at the newest line', async () => {
    const run = await seedRunWithLog('b1-completed', 'completed', 'implement')
    await gotoProjectAndOpen(run)
    await waitForSentinel(run)
    await settleLayout()
    expect(await logIsAtBottom()).toBe(true)
    expect(await sentinelIsVisible(run.sentinel)).toBe(true)
  })

  test('B2 a failed run with pre-existing output opens at the newest line', async () => {
    const run = await seedRunWithLog('b2-failed', 'error', 'implement')
    await gotoProjectAndOpen(run)
    await waitForSentinel(run)
    await settleLayout()
    expect(await logIsAtBottom()).toBe(true)
    expect(await sentinelIsVisible(run.sentinel)).toBe(true)
  })

  test('B3 paused runs (user and gate) open at the newest line', async () => {
    const userPaused = await seedRunWithLog('b3-paused-user', 'paused', 'implement', 60, { pauseKind: 'user' })
    await gotoProjectAndOpen(userPaused)
    await waitForSentinel(userPaused)
    await settleLayout()
    expect(await logIsAtBottom()).toBe(true)
    expect(await sentinelIsVisible(userPaused.sentinel)).toBe(true)

    const gatePaused = await seedRunWithLog('b3-paused-gate', 'paused', 'review', 60, { pauseKind: 'review' })
    await gotoProjectAndOpen(gatePaused)
    await waitForSentinel(gatePaused)
    await settleLayout()
    expect(await logIsAtBottom()).toBe(true)
    expect(await sentinelIsVisible(gatePaused.sentinel)).toBe(true)
  })

  test('B4 a running run opens at the newest line', async () => {
    const run = await seedRunWithLog('b4-running', 'running', 'implement')
    await gotoProjectAndOpen(run)
    await waitForSentinel(run)
    await settleLayout()
    expect(await logIsAtBottom()).toBe(true)
    expect(await sentinelIsVisible(run.sentinel)).toBe(true)
  })

  test('B5 re-open after a manual scroll-up discards the stale position', async () => {
    const run = await seedRunWithLog('b5-reopen', 'completed', 'implement')
    await gotoProjectAndOpen(run)
    await waitForSentinel(run)
    await settleLayout()
    // Scroll away from the bottom, collapse, then re-open.
    await page.locator('section.agent-dock [aria-label="Scroll to top"]').click()
    await page.waitForFunction(() => (document.querySelector('section.agent-dock pre.run-log')?.scrollTop ?? 1) < 2)
    await page.locator('section.agent-dock [aria-label="Collapse"]').click()
    await page.locator('section.agent-dock .dock-mini').waitFor({ state: 'visible' })
    await page.locator('section.agent-dock .dock-mini').click()
    await page.locator('section.agent-dock pre.run-log').waitFor({ state: 'visible' })
    await settleLayout()
    expect(await logIsAtBottom()).toBe(true)
    expect(await sentinelIsVisible(run.sentinel)).toBe(true)
  })

  test('B6 switching runs while open shows the new run at the bottom', async () => {
    const runA = await seedRunWithLog('b6-run-a', 'completed', 'plan')
    const runB = await seedRunWithLog('b6-run-b', 'completed', 'implement')
    await gotoProjectAndOpen(runA)
    await waitForSentinel(runA)
    // Switch project (and therefore run) in-app, without a reload, so the dock
    // stays open with its previous manual scroll choice.
    await page.evaluate((code) => {
      window.history.pushState({}, '', `/spaces/${code}`)
      window.dispatchEvent(new PopStateEvent('popstate', { state: {} }))
    }, runB.code)
    await waitForSentinel(runB)
    await settleLayout()
    expect(await logIsAtBottom()).toBe(true)
    expect(await sentinelIsVisible(runB.sentinel)).toBe(true)
  })

  test('B7 a streaming run stays pinned as new output arrives', async () => {
    const run = await seedRunWithLog('b7-stream', 'running', 'implement')
    await gotoProjectAndOpen(run)
    await waitForSentinel(run)
    await settleLayout()
    expect(await logIsAtBottom()).toBe(true)

    const extra = `STREAMED-${randomUUID().slice(0, 8)}`
    await appendLogLine(run.runId, `[00:01:00Z implement] ${extra}\n`)
    await page.waitForFunction(
      (s) => (document.querySelector('section.agent-dock pre.run-log')?.textContent ?? '').includes(s),
      extra,
      { timeout: 15_000 },
    )
    // The streaming follow is a passive effect; let it flush after the append.
    await page.waitForFunction(() => {
      const el = document.querySelector('section.agent-dock pre.run-log')
      return !!el && (el.scrollHeight <= el.clientHeight + 2 || el.scrollTop + el.clientHeight >= el.scrollHeight - 2)
    }, undefined, { timeout: 5_000 })
    expect(await logIsAtBottom()).toBe(true)
  })

  test('B8 a reader who scrolls up is not yanked back down', async () => {
    const run = await seedRunWithLog('b8-scrollup', 'running', 'implement')
    await gotoProjectAndOpen(run)
    await waitForSentinel(run)
    await settleLayout()
    await page.locator('section.agent-dock pre.run-log').evaluate((el) => {
      el.scrollTop = 0
      el.dispatchEvent(new Event('scroll'))
    })
    await page.locator('section.agent-dock .dock-new-output').waitFor({ state: 'visible', timeout: 5_000 })

    const extra = `HELD-${randomUUID().slice(0, 8)}`
    await appendLogLine(run.runId, `[00:01:01Z implement] ${extra}\n`)
    await page.waitForFunction(
      (s) => (document.querySelector('section.agent-dock pre.run-log')?.textContent ?? '').includes(s),
      extra,
      { timeout: 15_000 },
    )
    await settleLayout()
    // Not yanked to the bottom: the reader stays well clear of the newest line
    // (small scroll-anchoring drift from appending is acceptable).
    const g = await logGeometry()
    expect(g.scrollTop + g.clientHeight).toBeLessThan(g.scrollHeight - 100)
    expect(await page.locator('section.agent-dock .dock-new-output').isVisible()).toBe(true)
  })

  test('B9 an empty or short buffer does not error or jump', async () => {
    const empty = await seedRunWithLog('b9-empty', 'running', 'implement', 0)
    await gotoProjectAndOpen(empty)
    await settleLayout()
    const emptyGeometry = await logGeometry()
    expect((await page.locator('section.agent-dock pre.run-log').textContent()) ?? '').toContain('Warming up')
    expect(emptyGeometry.scrollTop).toBe(0)
    expect(emptyGeometry.scrollHeight <= emptyGeometry.clientHeight + 2).toBe(true)

    const short = await seedRunWithLog('b9-short', 'completed', 'implement', 2)
    await gotoProjectAndOpen(short)
    await waitForSentinel(short)
    await settleLayout()
    const shortGeometry = await logGeometry()
    expect(shortGeometry.scrollTop).toBe(0)
  })

  test('B10 collapse/expand, scroll controls and run controls still work', async () => {
    // Scroll controls and collapse/expand on a non-active run, where the
    // existing streaming-follow effect cannot fight the smooth scroll.
    const run = await seedRunWithLog('b10-controls', 'completed', 'implement')
    await gotoProjectAndOpen(run)
    await waitForSentinel(run)
    await settleLayout()

    await page.locator('section.agent-dock [aria-label="Scroll to top"]').click()
    await page.waitForFunction(() => (document.querySelector('section.agent-dock pre.run-log')?.scrollTop ?? 1) < 2)
    await page.locator('section.agent-dock [aria-label="Scroll to bottom"]').click()
    await page.waitForFunction(() => {
      const el = document.querySelector('section.agent-dock pre.run-log')
      return !!el && el.scrollTop + el.clientHeight >= el.scrollHeight - 2
    })

    await page.locator('section.agent-dock [aria-label="Collapse"]').click()
    await page.locator('section.agent-dock .dock-mini').waitFor({ state: 'visible' })
    await page.locator('section.agent-dock .dock-mini').click()
    await page.locator('section.agent-dock pre.run-log').waitFor({ state: 'visible' })
    await waitForSentinel(run)

    // Run controls are unchanged for a running run.
    const running = await seedRunWithLog('b10-run-controls', 'running', 'implement')
    await gotoProjectAndOpen(running)
    await waitForSentinel(running)
    expect(await page.locator('section.agent-dock button', { hasText: 'Pause' }).isVisible()).toBe(true)
    expect(await page.locator('section.agent-dock button', { hasText: 'Cancel' }).isVisible()).toBe(true)
  })
})
