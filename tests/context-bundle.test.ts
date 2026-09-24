import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPromptBundle, loadProjectConstitution } from '../src/lib/context-builder'

async function projectWithConstitution(text: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'context-bundle-'))
  await mkdir(join(dir, '.specify', 'memory'), { recursive: true })
  await writeFile(join(dir, '.specify', 'memory', 'constitution.md'), text)
  return dir
}

const base = { projectSlug: 'demo', projectPath: '/work/demo', featureArtifacts: [], sourceSnapshots: [] }

describe('shared context bundle', () => {
  test("loads the project's constitution once it is filled in, not the template", async () => {
    expect(await loadProjectConstitution(await projectWithConstitution('# Demo Constitution\n\n## I. Tests first\n'))).toContain('Tests first')
    expect(await loadProjectConstitution(await projectWithConstitution('# [PROJECT_NAME] Constitution\n\n## [PRINCIPLE_1_NAME]\n'))).toBe('')
    expect(await loadProjectConstitution(await mkdtemp(join(tmpdir(), 'context-bundle-')))).toBe('')
  })

  test('memory and both constitutions survive the budget; other org standards are dropped first', () => {
    const bundle = buildPromptBundle({
      ...base,
      org: { constitution: 'Org rule: human in the loop.', principles: 'P'.repeat(40_000) },
      projectConstitution: 'Project rule: tests first.',
      orgMemory: 'Org memory note.',
      teamMemory: 'Team memory note.',
      projectMemory: 'Project memory note.',
    })
    expect(bundle).toContain('## Project Constitution')
    expect(bundle).toContain('Project rule: tests first.')
    expect(bundle).toContain('Org rule: human in the loop.')
    expect(bundle).toContain('Org memory note.')
    expect(bundle).toContain('Team memory note.')
    expect(bundle).toContain('Project memory note.')
    expect(bundle).not.toContain('P'.repeat(100))
    expect(bundle).toMatch(/omitted .*org-principles/)
  })
})
