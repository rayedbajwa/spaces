import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createAgentResourceLoader } from '../src/lib/agent-resources'

/**
 * Instructions that hold for a whole session belong on the agent's system
 * prompt, the way Pi delivers them, not stapled to every stage prompt.
 */

describe('agent resource loader', () => {
  test('carries standing instructions to the session', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'resources-'))
    const loader = await createAgentResourceLoader(cwd, { appendSystemPrompt: ['## This machine\n\n- a database', '## Evidence rules\n\n- commit the probe'] })
    const appended = loader.getAppendSystemPrompt()
    expect(appended.some((text) => text.includes('This machine'))).toBe(true)
    expect(appended.some((text) => text.includes('Evidence rules'))).toBe(true)
  })

  test('adds nothing when there is nothing to add', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'resources-'))
    const loader = await createAgentResourceLoader(cwd, { appendSystemPrompt: ['', '   '] })
    expect(loader.getAppendSystemPrompt().some((text) => text.trim() === '')).toBe(false)
  })

  test('still bundles the browser skill', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'resources-'))
    const loader = await createAgentResourceLoader(cwd)
    expect(loader.getSkills().skills.some((skill) => skill.name.includes('playwright') || skill.name.includes('browser'))).toBe(true)
  })
})
