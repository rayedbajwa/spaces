import { afterEach, describe, expect, mock, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

mock.module('../src/lib/github-app-auth', () => ({ getGitHubActorToken: async () => 'test-token' }))
const { findOpenPullRequests } = await import('../src/lib/delivery')

const realFetch = globalThis.fetch
let dir = ''
afterEach(async () => {
  globalThis.fetch = realFetch
  if (dir) await rm(dir, { recursive: true, force: true })
})

describe('findOpenPullRequests', () => {
  test("looks up open PRs for the checkout's branch and the branches reports name, once each", async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'open-prs-'))
    execFileSync('git', ['init', '-q', '-b', 'feat/001-login'], { cwd: dir })
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir })
    const featureDir = path.join(dir, 'specs', '001-login')
    await mkdir(featureDir, { recursive: true })
    await writeFile(path.join(featureDir, 'parallel-workstreams.md'), 'Workstream branch: feat/001-login/ws-1-api.\n')

    const asked: string[] = []
    globalThis.fetch = (async (url: string) => {
      const head = decodeURIComponent(new URL(url).searchParams.get('head') ?? '')
      asked.push(head)
      const body = head === 'acme:feat/001-login'
        ? [{ number: 12, html_url: 'https://github.com/acme/app/pull/12', title: 'feat: login', draft: false }]
        : head === 'acme:feat/001-login/ws-1-api'
          ? [{ number: 13, html_url: 'https://github.com/acme/app/pull/13', title: 'feat: login api', draft: true }]
          : []
      return new Response(JSON.stringify(body), { status: 200 })
    }) as typeof fetch

    const prs = await findOpenPullRequests('org', featureDir, [{ githubRepo: 'acme/app', localPath: dir }, { githubRepo: null, localPath: null }])
    expect(prs).toEqual([
      { githubRepo: 'acme/app', number: 12, url: 'https://github.com/acme/app/pull/12', title: 'feat: login', draft: false },
      { githubRepo: 'acme/app', number: 13, url: 'https://github.com/acme/app/pull/13', title: 'feat: login api', draft: true },
    ])
    expect(asked.sort()).toEqual(['acme:feat/001-login', 'acme:feat/001-login/ws-1-api'])
  })

  test('a GitHub error means no link, not a failure', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'open-prs-'))
    execFileSync('git', ['init', '-q', '-b', 'feat/002-x'], { cwd: dir })
    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as typeof fetch
    expect(await findOpenPullRequests('org', dir, [{ githubRepo: 'acme/app', localPath: dir }])).toEqual([])
  })
})
