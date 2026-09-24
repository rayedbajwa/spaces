import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resolveSpeckitRoot } from '../src/lib/aidlc'
import { installLeanTemplates, LEAN_SPECKIT_DIR, skillPathFor } from '../src/lib/speckit-assets'
import { listFeatureFiles, renderStageFiles, stageContextFor, STAGE_REPLY_RULE } from '../src/lib/stage-context'

const speckitRoot = resolveSpeckitRoot()
const leanSkills = path.join(LEAN_SPECKIT_DIR, 'skills')
const read = (file: string) => readFile(file, 'utf8')

describe('Spaces\' shorter Spec Kit skills', () => {
  test('every stage skill has a shorter version, at least 40% smaller than the package\'s', async () => {
    const skills = await readdir(leanSkills)
    expect(skills.sort()).toEqual(['speckit-analyze', 'speckit-checklist', 'speckit-clarify', 'speckit-constitution', 'speckit-implement', 'speckit-init', 'speckit-plan', 'speckit-specify', 'speckit-tasks', 'speckit-taskstoissues'])
    let lean = 0
    let original = 0
    for (const skill of skills) {
      const a = (await read(path.join(leanSkills, skill, 'SKILL.md'))).length
      const b = (await read(path.join(speckitRoot, 'skills', skill, 'SKILL.md'))).length
      expect(a).toBeLessThan(b * 0.6)
      lean += a
      original += b
    }
    expect(lean).toBeLessThan(original * 0.4)
  })

  test('they keep what Spaces and the scripts depend on', async () => {
    const skill = (name: string) => read(path.join(leanSkills, name, 'SKILL.md'))
    const specify = await skill('speckit-specify')
    // The pause detector (QUESTION_PATTERN) and the feature script.
    expect(specify).toContain('## Question 1:')
    expect(specify).toContain('[NEEDS CLARIFICATION:')
    expect(specify).toContain('create-new-feature.sh --json --short-name')
    expect(specify).toContain('checklists/requirements.md')
    expect(specify).toContain('$ARGUMENTS')
    expect(await skill('speckit-clarify')).toContain('## Question N:')
    expect(await skill('speckit-clarify')).toContain('### Session YYYY-MM-DD')
    // Task progress is parsed from "- [ ] T001 …" lines (run-resume.ts).
    expect(await skill('speckit-tasks')).toContain('`- [ ] T001 [P] [US1] <action> in <exact/file/path>`')
    expect(await skill('speckit-implement')).toContain('- [x] T012')
    expect(await skill('speckit-plan')).toContain('update-agent-context.sh generic')
    expect(await skill('speckit-analyze')).toContain('Read-only')
    expect(await skill('speckit-taskstoissues')).toContain('Continue only if it is a GitHub URL')
    expect(await skill('speckit-init')).toContain('SPECKIT_ROOT/specify-templates/.')
    // None carries the package's host-specific hook checks.
    for (const name of await readdir(leanSkills)) expect(await skill(name)).not.toContain('extensions.yml')
  })

  test('a stage uses the shorter skill, and falls back to the package\'s when there is none', async () => {
    expect(skillPathFor(speckitRoot, 'speckit-specify')).toBe(path.join(leanSkills, 'speckit-specify', 'SKILL.md'))
    expect(skillPathFor(speckitRoot, 'speckit-unknown')).toBe(path.join(speckitRoot, 'skills', 'speckit-unknown', 'SKILL.md'))
  })

  test('the templates keep the headings and fields that are read back', async () => {
    const template = (name: string) => read(path.join(LEAN_SPECKIT_DIR, 'templates', name))
    expect(await template('spec-template.md')).toStartWith('# Feature Specification: [FEATURE NAME]')
    const plan = await template('plan-template.md')
    // update-agent-context.sh reads these fields from plan.md.
    for (const field of ['**Language/Version**:', '**Primary Dependencies**:', '**Storage**:', '**Project Type**:']) expect(plan).toContain(field)
    expect(await template('tasks-template.md')).toContain('- [ ] T001')
    expect(await template('checklist-template.md')).toContain('- [ ] CHK001')
  })
})

describe('installLeanTemplates', () => {
  test('replaces the package\'s original templates, leaves edited ones, and is idempotent', async () => {
    const specify = await mkdtemp(path.join(tmpdir(), 'lean-templates-'))
    await mkdir(path.join(specify, 'templates'))
    const original = (name: string) => read(path.join(speckitRoot, 'specify-templates', 'templates', name))
    await writeFile(path.join(specify, 'templates', 'spec-template.md'), await original('spec-template.md'))
    await writeFile(path.join(specify, 'templates', 'plan-template.md'), '# Our own plan template\n')
    await writeFile(path.join(specify, 'templates', 'tasks-template.md'), await original('tasks-template.md'))

    const replaced = await installLeanTemplates(specify, speckitRoot)
    expect(replaced).toEqual(['checklist-template.md', 'spec-template.md', 'tasks-template.md'])
    expect(await read(path.join(specify, 'templates', 'spec-template.md'))).toBe(await read(path.join(LEAN_SPECKIT_DIR, 'templates', 'spec-template.md')))
    expect(await read(path.join(specify, 'templates', 'plan-template.md'))).toBe('# Our own plan template\n')
    expect(await installLeanTemplates(specify, speckitRoot)).toEqual([])
  })

  test('does nothing without a .specify/templates directory', async () => {
    expect(await installLeanTemplates(path.join(tmpdir(), 'no-such-specify'), speckitRoot)).toEqual([])
  })
})

describe('stage files', () => {
  async function featureDir(): Promise<{ root: string; dir: string }> {
    const root = await mkdtemp(path.join(tmpdir(), 'stage-files-'))
    const dir = path.join(root, 'specs', '003-search')
    await mkdir(path.join(dir, 'contracts'), { recursive: true })
    await writeFile(path.join(dir, 'spec.md'), '# Spec\n'.repeat(300))
    await writeFile(path.join(dir, 'plan.md'), '# Plan\n')
    await writeFile(path.join(dir, 'research.md'), '# Research\n')
    await writeFile(path.join(dir, 'tasks.md'), '')
    await writeFile(path.join(dir, 'contracts', 'api.yaml'), 'openapi: 3.1.0\n')
    return { root, dir }
  }

  test('lists the intent\'s non-empty files with their sizes', async () => {
    const { dir } = await featureDir()
    expect((await listFeatureFiles(dir)).map((f) => f.name)).toEqual(['spec.md', 'plan.md', 'research.md', 'contracts/api.yaml'])
  })

  test('tells a stage what to read first and names the rest, by path only', async () => {
    const { dir } = await featureDir()
    const guide = renderStageFiles('tasks', 'specs/003-search', await listFeatureFiles(dir))
    expect(guide).toContain('The intent\'s files are in `specs/003-search/`')
    expect(guide).toContain('- Read first: `spec.md` (2.1 KB), `plan.md` (7 B)')
    expect(guide).toContain('- Also there (read one only when this stage needs it): `research.md` (11 B), `contracts/api.yaml` (15 B)')
    expect(guide).not.toContain('# Spec')
  })

  test('says nothing about files before there is an intent, and always asks for a short final message', async () => {
    const { root, dir } = await featureDir()
    expect(renderStageFiles('specify', 'specs/003-search', await listFeatureFiles(dir))).toBe('')
    expect(await stageContextFor('specify', root, undefined)).toBe(STAGE_REPLY_RULE)
    expect(await stageContextFor('init', root, undefined)).toBe('')
    const verify = await stageContextFor('verify', root, dir)
    expect(verify).toContain('- Read first: `spec.md`')
    expect(verify).toContain('`Verification Status: …`')
  })
})

describe('cross-stage memory', () => {
  test('goes to a stage in a new session, not to one continuing the session that did the earlier stages', async () => {
    const { implementLoopTemplate } = await import('../src/lib/implement-loop')
    const { PipelineEngine } = await import('../src/lib/pipeline-engine')
    const engine = new PipelineEngine(implementLoopTemplate(), {
      cwd: tmpdir(),
      model: 'test/model',
      priorHandoffs: [{ stepId: 'plan', stage: 'plan', text: 'Planned a search endpoint.' }],
    } as never, {})
    const preamble = (engine as unknown as { buildStagePreambleLoader: () => (ctx: { stageIndex: number; stage: string; freshSession: boolean }) => Promise<string> }).buildStagePreambleLoader()
    expect(await preamble({ stageIndex: 0, stage: 'implement', freshSession: true })).toContain('Planned a search endpoint.')
    expect(await preamble({ stageIndex: 0, stage: 'implement', freshSession: false })).not.toContain('Cross-stage memory')
  })
})
