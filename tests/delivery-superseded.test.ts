import { describe, expect, test } from 'bun:test'
import { deliveryStatusFor, type TrackedPullRequest } from '../src/lib/delivery'

function pr(number: number, overrides: Partial<TrackedPullRequest> = {}): TrackedPullRequest {
  return {
    githubRepo: 'acme/app', number, url: `https://github.com/acme/app/pull/${number}`, title: `PR ${number}`,
    head: `feature-${number}`, base: 'main', state: 'closed', merged: false, draft: false,
    review: 'approved', checks: 'success', deployments: [], source: 'delivery-report.md', ...overrides,
  }
}

describe('delivery status with closed duplicate pull requests', () => {
  test('a closed duplicate of a merged PR in the same repository does not block delivery', () => {
    const merged = pr(12, { merged: true, mergedAt: '2026-10-12T16:00:00Z' })
    const duplicate = pr(11)
    const { status, supersededBy } = deliveryStatusFor([duplicate, merged])
    expect(status).toBe('MERGED')
    expect(supersededBy.get(duplicate)).toBe(merged)
  })

  test('a closed PR with no merged PR in its repository still blocks', () => {
    const merged = pr(12, { githubRepo: 'acme/api', merged: true, mergedAt: '2026-10-12T16:00:00Z' })
    const closed = pr(11)
    const { status, supersededBy } = deliveryStatusFor([closed, merged])
    expect(status).toBe('BLOCKED')
    expect(supersededBy.size).toBe(0)
  })

  test('an open PR still keeps delivery partial', () => {
    const { status } = deliveryStatusFor([pr(11), pr(12, { merged: true }), pr(13, { state: 'open', review: 'none', checks: 'pending' })])
    expect(status).toBe('PARTIAL')
  })
})
