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

let fixture: Awaited<ReturnType<typeof createGuardrailsPageFixture>>
let browser: Browser
let page: Page
let workDir: string
let projectA: SeededProject
let projectB: SeededProject

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
  for (const p of [projectA, projectB]) {
    if (!p) continue
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
