import { describe, expect, test } from 'bun:test'
import { buildBrowserTools, isAllowedBrowserUrl, resolveBrowserExecutable } from '../src/lib/browser-tools'

describe('browser tools', () => {
  test('only http(s) urls are opened', () => {
    expect(isAllowedBrowserUrl('http://localhost:3000/')).toBe(true)
    expect(isAllowedBrowserUrl('https://example.com/x')).toBe(true)
    expect(isAllowedBrowserUrl('file:///etc/passwd')).toBe(false)
    expect(isAllowedBrowserUrl('javascript:alert(1)')).toBe(false)
    expect(isAllowedBrowserUrl('not a url')).toBe(false)
  })
  test('browser binary resolution prefers configuration, then system paths, then Chrome', () => {
    expect(resolveBrowserExecutable({ SPACES_BROWSER_PATH: '/opt/chromium' }, () => false)).toBe('/opt/chromium')
    expect(resolveBrowserExecutable({}, (p) => p === '/usr/bin/chromium')).toBe('/usr/bin/chromium')
    expect(resolveBrowserExecutable({}, () => false)).toBeUndefined()
  })
  test('the tool set exposes open, act, read, screenshot and close', () => {
    const names = buildBrowserTools('/tmp').map((t) => t.name)
    expect(names).toEqual(['browser_open', 'browser_act', 'browser_read', 'browser_screenshot', 'browser_close'])
  })
})
