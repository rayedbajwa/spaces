import { afterEach, describe, expect, mock, test } from 'bun:test'

mock.module('../src/lib/github-app-auth', () => ({ getGitHubActorToken: async () => 'test-token' }))
const { postPullRequestReview } = await import('../src/lib/pr-review')

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

function stubGitHub(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ event: string; body: string; comments: unknown[] }> = []
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body))
    calls.push({ event: payload.event, body: payload.body, comments: payload.comments })
    const next = responses.shift()!
    return new Response(JSON.stringify(next.body), { status: next.status })
  }) as typeof fetch
  return calls
}

const input = {
  githubRepo: 'acme/app',
  number: 3,
  headSha: 'abc',
  reviewer: 'Sam',
  summary: 'Ship it.',
  comments: [{ path: 'a.ts', line: 4, side: 'RIGHT' as const, body: 'nit' }],
}

describe('postPullRequestReview', () => {
  test('posts the decision with inline comments', async () => {
    const calls = stubGitHub([{ status: 200, body: { html_url: 'https://github.com/acme/app/pull/3#r1' } }])
    expect(await postPullRequestReview('org', { ...input, event: 'APPROVE' })).toEqual({ postedAs: 'APPROVE', url: 'https://github.com/acme/app/pull/3#r1' })
    expect(calls[0]!.event).toBe('APPROVE')
    expect(calls[0]!.body).toBe('**Approved** by Sam in Spaces\n\nShip it.')
    expect(calls[0]!.comments).toEqual([{ path: 'a.ts', line: 4, side: 'RIGHT', body: 'nit' }])
  })

  test("falls back to a comment naming the decision when GitHub refuses the author's own approval", async () => {
    const calls = stubGitHub([
      { status: 422, body: { message: 'Can not approve your own pull request' } },
      { status: 200, body: { html_url: 'u' } },
    ])
    expect((await postPullRequestReview('org', { ...input, event: 'REQUEST_CHANGES' })).postedAs).toBe('COMMENT')
    expect(calls.map((c) => c.event)).toEqual(['REQUEST_CHANGES', 'COMMENT'])
    expect(calls[1]!.body).toStartWith('**Changes requested** by Sam in Spaces')
  })

  test('other failures are not retried', async () => {
    const calls = stubGitHub([{ status: 403, body: { message: 'Resource not accessible by integration' } }])
    await expect(postPullRequestReview('org', { ...input, event: 'APPROVE' })).rejects.toThrow('GitHub API 403')
    expect(calls).toHaveLength(1)
  })
})
