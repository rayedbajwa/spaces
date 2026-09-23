import { describe, expect, test } from 'bun:test'
import { jobLooksStuck } from '../src/lib/job-stuck'

const now = Date.parse('2026-09-23T06:30:00Z')
const ago = (min: number) => new Date(now - min * 60_000).toISOString()

describe('offering a force kill', () => {
  test('running with no activity for over 10 minutes, or a worker no longer heartbeating', () => {
    expect(jobLooksStuck({ displayStatus: 'running', createdAt: ago(60), lastActivityAt: ago(11), workerHeartbeatAt: ago(0) }, now)).toBe(true)
    expect(jobLooksStuck({ displayStatus: 'running', createdAt: ago(60), lastActivityAt: ago(1), workerHeartbeatAt: ago(3) }, now)).toBe(true)
    expect(jobLooksStuck({ displayStatus: 'running', createdAt: ago(60), lastActivityAt: ago(1), workerHeartbeatAt: ago(0) }, now)).toBe(false)
  })
  test('paused or queued for over 10 minutes; finished jobs never', () => {
    expect(jobLooksStuck({ displayStatus: 'paused', createdAt: ago(60), lastActivityAt: ago(15) }, now)).toBe(true)
    expect(jobLooksStuck({ displayStatus: 'queued', createdAt: ago(12) }, now)).toBe(true)
    expect(jobLooksStuck({ displayStatus: 'queued', createdAt: ago(2) }, now)).toBe(false)
    expect(jobLooksStuck({ displayStatus: 'completed', createdAt: ago(600) }, now)).toBe(false)
  })
})
