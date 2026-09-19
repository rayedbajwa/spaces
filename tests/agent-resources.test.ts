import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { bundledSkillPaths } from '../src/lib/agent-resources'

describe('bundled agent skills', () => {
  test('the pi-playwright skill directory is bundled', () => {
    const paths = bundledSkillPaths()
    expect(paths.length).toBe(1)
    expect(existsSync(path.join(paths[0]!, 'playwright-browser', 'SKILL.md'))).toBe(true)
  })
})
