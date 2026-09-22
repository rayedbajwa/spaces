import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { overallDecision, readHumanReview, recordHumanDecision, renderHumanReview, withDecision, type RecordedDecision } from '../src/lib/pr-review'

function decision(overrides: Partial<RecordedDecision>): RecordedDecision {
  return {
    githubRepo: 'acme/app',
    number: 1,
    decision: 'approved',
    reviewer: 'Sam',
    at: '2026-09-22T10:00:00.000Z',
    headSha: 'aaaaaaa1111',
    summary: '',
    comments: [],
    ...overrides,
  }
}

const prA = { githubRepo: 'acme/app', number: 1, headSha: 'aaaaaaa1111' }
const prB = { githubRepo: 'acme/api', number: 7, headSha: 'bbbbbbb2222' }

describe('overallDecision', () => {
  test('every open PR approved at its current commit approves the feature', () => {
    const state = { decisions: [decision({}), decision({ githubRepo: 'acme/api', number: 7, headSha: prB.headSha })] }
    expect(overallDecision(state, [prA, prB])).toBe('approved')
  })

  test('one PR still undecided leaves the feature undecided', () => {
    expect(overallDecision({ decisions: [decision({})] }, [prA, prB])).toBeUndefined()
  })

  test('changes requested on any PR decides it', () => {
    const state = { decisions: [decision({ githubRepo: 'acme/api', number: 7, headSha: prB.headSha, decision: 'changes_requested' })] }
    expect(overallDecision(state, [prA, prB])).toBe('changes_requested')
  })

  test('a decision made on an earlier commit no longer counts', () => {
    expect(overallDecision({ decisions: [decision({ headSha: 'old' })] }, [prA])).toBeUndefined()
    expect(overallDecision({ decisions: [decision({ headSha: 'old', decision: 'changes_requested' })] }, [prA])).toBeUndefined()
  })

  test('no open PR, nothing to decide', () => {
    expect(overallDecision({ decisions: [decision({})] }, [])).toBeUndefined()
  })
})

describe('withDecision', () => {
  test('keeps only the latest decision per pull request', () => {
    const state = withDecision({ decisions: [decision({ decision: 'changes_requested' })] }, decision({ decision: 'approved' }))
    expect(state.decisions).toHaveLength(1)
    expect(state.decisions[0]!.decision).toBe('approved')
  })
})

describe('renderHumanReview', () => {
  test('writes the status line the pipeline reads, with findings from the comments', () => {
    const state = { decisions: [decision({ decision: 'changes_requested', summary: 'Needs tests.', comments: [{ path: 'src/a.ts', line: 12, side: 'RIGHT', body: 'Handle null.' }] })] }
    const text = renderHumanReview('changes_requested', state, [prA], '')
    expect(text.split('\n')[0]).toBe('Code Review Status: CHANGES_REQUESTED')
    expect(text).toContain('Needs tests.')
    expect(text).toContain('- `src/a.ts:12` — Handle null.')
  })

  test('keeps an automated review below, with its status line renamed', () => {
    const automated = 'Code Review Status: APPROVED\n\nLooks fine.'
    const text = renderHumanReview('changes_requested', { decisions: [decision({ decision: 'changes_requested', summary: 'No.' })] }, [prA], automated)
    expect(text.match(/Code Review Status:/g)).toHaveLength(1)
    expect(text).toContain('## Earlier automated review')
    expect(text).toContain('Automated review status: APPROVED')
  })

  test('replaces an earlier Spaces review instead of nesting it', () => {
    const first = renderHumanReview('changes_requested', { decisions: [decision({ decision: 'changes_requested', summary: 'First pass.' })] }, [prA], 'Code Review Status: APPROVED\n\nBot says ok.')
    const second = renderHumanReview('approved', { decisions: [decision({})] }, [prA], first)
    expect(second.split('\n')[0]).toBe('Code Review Status: APPROVED')
    expect(second).not.toContain('First pass.')
    expect(second).toContain('Bot says ok.')
    expect(second.match(/## Earlier automated review/g)).toHaveLength(1)
  })
})

describe('recordHumanDecision', () => {
  let dir = ''
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })

  test('rewrites code-review.md only once the decision settles the feature', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pr-review-'))
    await writeFile(path.join(dir, 'code-review.md'), 'Code Review Status: CHANGES_REQUESTED\n\nBot findings.')

    expect(await recordHumanDecision(dir, decision({}), [prA, prB])).toBeUndefined()
    expect(await readFile(path.join(dir, 'code-review.md'), 'utf8')).toStartWith('Code Review Status: CHANGES_REQUESTED\n\nBot')

    expect(await recordHumanDecision(dir, decision({ githubRepo: 'acme/api', number: 7, headSha: prB.headSha }), [prA, prB])).toBe('approved')
    expect(await readFile(path.join(dir, 'code-review.md'), 'utf8')).toStartWith('Code Review Status: APPROVED')
    expect((await readHumanReview(dir)).decisions).toHaveLength(2)
  })
})
