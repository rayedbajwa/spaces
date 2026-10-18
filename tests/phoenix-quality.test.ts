import { describe, expect, test } from 'bun:test'
import { criteriaMet, handoffQuality, loopProgress, reportFormat } from '../src/lib/phoenix-quality'

describe('phoenix quality scores', () => {
  test('a clean compacted handoff scores 1', () => {
    const tail = `Implemented the badge. Verification Status: PARTIAL\nCommit abc1234 on PR #89.\n${'x'.repeat(1200)}`
    const a = handoffQuality({ stage: 'implement', stepIndex: 2, tail, summary: 'Badge done; Verification Status: PARTIAL; commit abc1234, PR #89.' })
    expect(a).toMatchObject({ name: 'handoff-quality', identifier: '2:implement', score: 1, label: 'pass' })
  })

  test('a raw tail passed on scores below 1 and names the check', () => {
    const a = handoffQuality({ stage: 'review', stepIndex: 3, tail: 'Reviewed everything thoroughly. '.repeat(60) })
    expect(a.score).toBeLessThan(1)
    expect(a.explanation).toContain('handoff-compacted')
  })

  test('report format: a titled verification report passes, a loose review fails', () => {
    expect(reportFormat('verify', 4, '# Verification Report\n\nVerification Status: PARTIAL\nAcceptance Criteria Met: 5/15\nCritical Issues Open: 0\n\n## Unsatisfied Test Cases\n- (none)\n')).toMatchObject({ name: 'report-format', label: 'pass', score: 1 })
    expect(reportFormat('review', 3, 'Looks fine to me.')?.label).toBe('fail')
    expect(reportFormat('implement', 2, 'anything')).toBeUndefined()
  })

  test('criteria met from the report or from the handoff text', () => {
    expect(criteriaMet('Verification Status: PARTIAL\nAcceptance Criteria Met: 5/15\nCritical Issues Open: 0')).toEqual({ met: 5, total: 15 })
    expect(criteriaMet('**Verify PARTIAL: 5/15, 0 critical.** Artifact …')).toEqual({ met: 5, total: 15 })
    expect(criteriaMet('No numbers here.')).toBeUndefined()
    expect(criteriaMet('PARTIAL, AC 5/15, critical 0.')).toEqual({ met: 5, total: 15 })
    expect(criteriaMet('PARTIAL: 5/15 AC, 0 critical.')).toEqual({ met: 5, total: 15 })
  })

  test('loop progress: same counts score 0, progress 1', () => {
    expect(loopProgress(4, { met: 5, total: 15 }, { met: 5, total: 15 })).toMatchObject({ name: 'loop-progress', label: 'same', score: 0 })
    expect(loopProgress(4, { met: 5, total: 15 }, { met: 7, total: 15 })).toMatchObject({ label: 'progressed', score: 1 })
    expect(loopProgress(4, undefined, { met: 5, total: 15 })).toMatchObject({ label: 'first', score: 1 })
  })
})
