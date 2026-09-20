import { describe, expect, test } from 'bun:test'
import { formatBytes, diskUsage } from '../src/lib/disk-housekeeping'
import { tmpdir } from 'node:os'

/**
 * A full workspace volume kills runs mid-stage, so the numbers reported about
 * it have to be right and readable.
 */

describe('disk usage', () => {
  test('reads the filesystem the workspaces live on', async () => {
    const usage = await diskUsage(tmpdir())
    expect(usage).toBeDefined()
    expect(usage!.totalBytes).toBeGreaterThan(0)
    expect(usage!.freeRatio).toBeGreaterThanOrEqual(0)
    expect(usage!.freeRatio).toBeLessThanOrEqual(1)
  })

  test('an unreadable path reports nothing rather than throwing', async () => {
    expect(await diskUsage('/definitely/not/a/path/here')).toBeUndefined()
  })
})

describe('byte formatting', () => {
  test('scales to the unit a reader wants', () => {
    expect(formatBytes(512 * 1024)).toBe('512 KB')
    expect(formatBytes(200 * 1024 ** 2)).toBe('200 MB')
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB')
  })
})
