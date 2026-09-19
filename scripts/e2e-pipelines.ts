#!/usr/bin/env bun
/**
 * End-to-end pipeline test: for each pipeline template ("scope"), create a
 * throwaway fixture repo, register a project through the HTTP API, wait for
 * onboarding, switch the project to autonomous + fast mode, start a run with
 * that template and drive it to completion (auto-answering clarification
 * pauses), then record stages, artifacts and errors in a Markdown report.
 *
 * Requires a running server (bun run web) and workers (bun run supervisor).
 *
 *   bun run scripts/e2e-pipelines.ts                 # every template
 *   bun run scripts/e2e-pipelines.ts test-minimal aidlc-express
 *   E2E_CONCURRENCY=3 E2E_TIMEOUT_MIN=30 bun run scripts/e2e-pipelines.ts
 *
 * Against a deployed instance (sign-in on, no local fixture repos):
 *   E2E_BASE_URL=https://spaces.example.com E2E_COOKIE='spaces_session=…' \
 *   E2E_REPO=none E2E_MODEL=auto E2E_KEEP=1 bun run scripts/e2e-pipelines.ts test-minimal
 */
import { execFile } from 'node:child_process'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const CONCURRENCY = Math.max(1, Number(process.env.E2E_CONCURRENCY ?? '3') || 3)
const TIMEOUT_MS = Math.max(5, Number(process.env.E2E_TIMEOUT_MIN ?? '25') || 25) * 60_000
/** A model spec, or undefined for the organization's automatic routing (E2E_MODEL=auto). */
const MODEL = (() => { const m = process.env.E2E_MODEL ?? 'anthropic/claude-haiku-4-5'; return m === 'auto' || m === '' ? undefined : m })()
const KEEP = process.env.E2E_KEEP === '1'
/** Session cookie for instances with sign-in enabled, e.g. "spaces_session=…". */
const COOKIE = process.env.E2E_COOKIE
/**
 * "local" (default): a throwaway fixture repo on this machine; "none": governance
 * workspace only (remote servers); "github:owner/name": a real GitHub repository
 * (GitHub must be connected; branches and pull requests are created for real).
 */
const REPO_MODE = process.env.E2E_REPO ?? 'local'
const GITHUB_REPO = REPO_MODE.startsWith('github:') ? REPO_MODE.slice('github:'.length) : undefined
/** Override the feature and the run inputs (defaults describe the fixture greeting service). */
const FEATURE_OVERRIDE = process.env.E2E_FEATURE?.trim()
const CONSTITUTION = process.env.E2E_CONSTITUTION?.trim() || 'Keep the service tiny, typed and tested. Prefer clarity over cleverness.'
const PLAN_CONTEXT = process.env.E2E_PLAN_CONTEXT?.trim() || 'Single TypeScript module with bun tests; no external services.'
const PROJECT_NAME = process.env.E2E_PROJECT_NAME?.trim()
const ROOT = path.join(homedir(), '.aidlc', 'e2e')
const REPORT = process.env.E2E_REPORT ?? path.join(process.cwd(), 'e2e-report.md')

interface StageRecord { stage: string; status: 'completed' | 'error' | 'paused' | 'skipped' | 'unknown'; note?: string }
interface Result {
  template: string
  projectId?: string
  slug?: string
  runId?: string
  status: 'completed' | 'error' | 'timeout' | 'setup-failed'
  onboarding?: string
  stages: string[]
  stageRecords: StageRecord[]
  artifacts: string[]
  answers: number
  durationMs: number
  error?: string
}

async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {}
  if (body) headers['content-type'] = 'application/json'
  if (COOKIE) headers.cookie = COOKIE
  const response = await fetch(`${BASE}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
  const text = await response.text()
  let data: unknown = null
  try { data = JSON.parse(text) } catch { /* not json */ }
  if (!response.ok) throw new Error(`${method} ${url} → ${response.status} ${(data as { error?: string } | null)?.error ?? text.slice(0, 200)}`)
  return data as T
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function listTemplates(): Promise<string[]> {
  const files = await readdir(path.join(process.cwd(), 'data', 'pipelines'))
  return files.filter((f) => f.endsWith('.yml')).map((f) => f.replace(/\.yml$/, '')).sort()
}

/** A tiny but real project: bun test passes, README documents install/test. */
async function makeFixtureRepo(template: string): Promise<string> {
  const dir = path.join(ROOT, `${template}-${Date.now().toString(36)}`)
  await mkdir(path.join(dir, 'src'), { recursive: true })
  await mkdir(path.join(dir, 'tests'), { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({
    name: `e2e-${template}`,
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts: { test: 'bun test', typecheck: 'bun x tsc --noEmit -p tsconfig.json', start: 'bun run src/index.ts' },
    devDependencies: { typescript: '^5.6.0' },
  }, null, 2))
  await writeFile(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, noEmit: true, types: ['bun-types'] }, include: ['src', 'tests'] }, null, 2))
  await writeFile(path.join(dir, 'src', 'index.ts'), `/** Greeting service used by the e2e fixture. */
export function greet(name: string): string {
  if (!name.trim()) throw new Error('name is required')
  return \`Hello, \${name.trim()}!\`
}

if (import.meta.main) {
  console.log(greet(process.argv[2] ?? 'world'))
}
`)
  await writeFile(path.join(dir, 'tests', 'index.test.ts'), `import { expect, test } from 'bun:test'
import { greet } from '../src/index'

test('greets by name', () => {
  expect(greet('Ada')).toBe('Hello, Ada!')
})

test('rejects empty names', () => {
  expect(() => greet('  ')).toThrow('name is required')
})
`)
  await writeFile(path.join(dir, 'README.md'), `# e2e-${template}

Tiny TypeScript service used to exercise the \`${template}\` pipeline end to end.

## Development

- Install: \`bun install\`
- Test: \`bun test\`
- Typecheck: \`bun run typecheck\`
- Run: \`bun run src/index.ts <name>\`

No environment variables or external services are required.
`)
  await writeFile(path.join(dir, '.gitignore'), 'node_modules/\n.aidlc/\n')
  const git = (args: string[]) => execFileAsync('git', args, { cwd: dir, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  await git(['init', '-q', '-b', 'main'])
  await git(['add', '-A'])
  await git(['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', 'commit', '-q', '-m', 'chore: fixture project'])
  return dir
}

/** Deleting takes friction: archive first, then confirm with "delete <code>". */
async function deleteProject(projectId: string): Promise<void> {
  const detail = await api<{ code?: string | null; slug: string }>('GET', `/api/projects/${projectId}`)
  await api('POST', `/api/projects/${projectId}/archive`)
  await api('DELETE', `/api/projects/${projectId}`, { confirm: `delete ${(detail.code ?? detail.slug).toLowerCase()}` })
}

const FEATURE = FEATURE_OVERRIDE || 'Add a farewell(name) function next to greet() that returns "Goodbye, <name>!" and rejects empty names, with unit tests and a README example.'

async function runTemplate(template: string): Promise<Result> {
  const started = Date.now()
  const result: Result = { template, status: 'setup-failed', stages: [], stageRecords: [], artifacts: [], answers: 0, durationMs: 0 }
  try {
    const repoPath = REPO_MODE === 'none' || GITHUB_REPO ? undefined : await makeFixtureRepo(template)
    const repos = GITHUB_REPO
      ? [{ label: GITHUB_REPO.split('/')[1]!, kind: 'github', githubRepo: GITHUB_REPO, isPrimary: true }]
      : repoPath ? [{ label: 'app', kind: 'local', localPath: repoPath, isPrimary: false }] : []
    const project = await api<{ projectId: string; slug: string; name: string }>('POST', '/api/projects', {
      name: PROJECT_NAME ?? `E2E ${template}`,
      description: GITHUB_REPO ? `End-to-end run of the ${template} pipeline against github.com/${GITHUB_REPO}.` : `End-to-end test project for the ${template} pipeline. Small TypeScript greeting service with bun tests.`,
      repos,
      model: MODEL,
      feature: FEATURE,
    })
    result.projectId = project.projectId
    result.slug = project.slug

    // Onboarding (clone/init/sync/learn/memory/suggest/setup) — wait, cap 12 min.
    const onboardingDeadline = Date.now() + Math.max(1, Number(process.env.E2E_ONBOARDING_MIN ?? '12') || 12) * 60_000
    let onboarding = await api<{ status: string; steps: Array<{ id: string; status: string; detail?: string }>; error?: string }>('GET', `/api/projects/${project.projectId}/onboarding`)
    while ((onboarding.status === 'running' || onboarding.status === 'idle') && Date.now() < onboardingDeadline) {
      await sleep(5_000)
      onboarding = await api('GET', `/api/projects/${project.projectId}/onboarding`)
    }
    result.onboarding = `${onboarding.status}: ${onboarding.steps.map((s) => `${s.id}=${s.status}`).join(' ')}${onboarding.error ? ` — ${onboarding.error.slice(0, 160)}` : ''}`

    await api('PATCH', `/api/projects/${project.slug}/orchestrator`, { autonomousMode: true, speedMode: 'fast', maxConcurrent: 1 })

    const run = await api<{ runId: string; stages?: string[]; error?: string }>('POST', '/api/runs', {
      projectId: project.projectId,
      pipeline: template,
      feature: FEATURE,
      constitution: CONSTITUTION,
      planContext: PLAN_CONTEXT,
      checklistDomain: 'api',
      model: MODEL,
      thinking: 'low',
      persistSession: true,
    })
    if (!run.runId) throw new Error(`run not created: ${run.error ?? 'unknown'}`)
    result.runId = run.runId
    result.stages = run.stages ?? []

    // Drive the run: autonomous mode auto-approves review gates; clarification
    // pauses (the agent asked something) are answered with "continue".
    const deadline = started + TIMEOUT_MS
    let snapshot = await api<{ status: string; stage?: string; pauseKind?: string; error?: string; stages: string[]; timeline: Array<{ kind: string; stage?: string; title: string; status?: string }> }>('GET', `/api/runs/${run.runId}`)
    let lastPausedAt = 0
    while (Date.now() < deadline) {
      if (snapshot.status === 'completed' || snapshot.status === 'error') break
      if (snapshot.status === 'paused' && Date.now() - lastPausedAt > 20_000) {
        lastPausedAt = Date.now()
        result.answers += 1
        const answer = snapshot.pauseKind === 'review' ? 'approve' : 'continue — proceed with sensible defaults; this is an automated e2e run.'
        await api('POST', `/api/runs/${run.runId}/answer`, { answer }).catch(() => undefined)
      }
      await sleep(15_000)
      snapshot = await api('GET', `/api/runs/${run.runId}`)
    }
    result.stages = snapshot.stages
    result.status = snapshot.status === 'completed' ? 'completed' : snapshot.status === 'error' ? 'error' : 'timeout'
    result.error = snapshot.error
    const seen = new Map<string, StageRecord>()
    for (const e of snapshot.timeline) {
      if (!e.stage) continue
      const status: StageRecord['status'] = /error|failed/i.test(e.title) ? 'error' : /paused/i.test(e.title) ? 'paused' : 'completed'
      seen.set(e.stage, { stage: e.stage, status, note: e.title })
    }
    result.stageRecords = [...seen.values()]

    // Artifacts on disk (from the board card for this project).
    const board = await api<{ columns: Array<{ cards: Array<{ projectNamespace: string; artifactLinks: Array<{ stepLabel: string; relativePath: string }> }> }> }>('GET', '/api/board')
    const card = board.columns.flatMap((c) => c.cards).find((c) => c.projectNamespace === project.slug)
    result.artifacts = card?.artifactLinks.map((a) => `${a.stepLabel}: ${a.relativePath}`) ?? []
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
    if (result.runId) result.status = 'error'
  } finally {
    result.durationMs = Date.now() - started
    if (!KEEP && result.projectId && result.status === 'completed') {
      await deleteProject(result.projectId).catch((error) => console.error(`cleanup failed for ${result.slug}: ${error instanceof Error ? error.message : String(error)}`))
    }
  }
  return result
}

async function main(): Promise<void> {
  const requested = process.argv.slice(2)
  const all = await listTemplates()
  const templates = requested.length ? requested.filter((t) => all.includes(t)) : all
  const unknown = requested.filter((t) => !all.includes(t))
  if (unknown.length) console.error(`Unknown templates ignored: ${unknown.join(', ')}`)
  console.log(`E2E: ${templates.length} template(s), concurrency ${CONCURRENCY}, timeout ${TIMEOUT_MS / 60_000} min each, model ${MODEL ?? 'auto (organization routing)'}, repos ${REPO_MODE}, server ${BASE}${COOKIE ? ' (signed in)' : ''}`)

  const queue = [...templates]
  const results: Result[] = []
  const workerLoop = async () => {
    while (queue.length) {
      const template = queue.shift()!
      console.log(`▶ ${template}`)
      const r = await runTemplate(template)
      results.push(r)
      console.log(`■ ${template}: ${r.status} in ${Math.round(r.durationMs / 1000)}s${r.error ? ` — ${r.error.slice(0, 140)}` : ''}`)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, templates.length) }, workerLoop))

  results.sort((a, b) => a.template.localeCompare(b.template))
  const lines = [
    `# Pipeline e2e report — ${new Date().toISOString()}`,
    '',
    `Server: ${BASE} · model: ${MODEL ?? 'auto (organization routing)'} · repos: ${REPO_MODE} · timeout: ${TIMEOUT_MS / 60_000} min/template`,
    '',
    '| Template | Result | Duration | Stages | Gates answered | Onboarding | Artifacts | Error |',
    '|---|---|---|---|---|---|---|---|',
    ...results.map((r) => `| ${r.template} | **${r.status}** | ${Math.round(r.durationMs / 60_000)}m ${Math.round((r.durationMs % 60_000) / 1000)}s | ${r.stages.join(' → ') || '—'} | ${r.answers} | ${(r.onboarding ?? '—').replace(/\|/g, '/').slice(0, 120)} | ${r.artifacts.length} | ${(r.error ?? '').replace(/\|/g, '/').slice(0, 160)} |`),
    '',
    ...results.flatMap((r) => [
      `## ${r.template} — ${r.status}`,
      r.slug ? `Project \`${r.slug}\`${r.runId ? ` · run \`${r.runId}\`` : ''}${r.projectId && !KEEP && r.status === 'completed' ? ' (deleted after success)' : ''}` : '',
      r.stageRecords.length ? `Stage events: ${r.stageRecords.map((s) => `${s.stage}=${s.status}`).join(', ')}` : '',
      r.artifacts.length ? `Artifacts:\n${r.artifacts.map((a) => `- ${a}`).join('\n')}` : 'Artifacts: none recorded',
      r.error ? `Error: ${r.error}` : '',
      '',
    ]),
  ].filter((l) => l !== '')
  await writeFile(REPORT, `${lines.join('\n')}\n`)
  const ok = results.filter((r) => r.status === 'completed').length
  console.log(`\n${ok}/${results.length} templates completed. Report: ${REPORT}`)
  process.exitCode = ok === results.length ? 0 : 1
}

await main()
