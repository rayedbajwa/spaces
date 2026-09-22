import { describe, expect, test } from 'bun:test'
import { acceptanceRecommended, describeSummary, summarizeVerification } from '../src/lib/verification-summary'
import { isEligibleDrop } from '../src/lib/board-drop'

/**
 * A verification that came close — more than 95% of criteria met, nothing
 * critical left — should point the person at "Accept and finish" rather than
 * another verify run.
 */

function table(statuses: string[]): string {
  return [
    '## 2. Requirement-by-Requirement Verification',
    '',
    '| Requirement | Test ID(s) | Status | Evidence |',
    '|---|---|---|---|',
    ...statuses.map((status, i) => `| FR-${i + 1} | T-${i + 1} | ${status} | evidence |`),
    '',
  ].join('\n')
}

describe('summarizeVerification', () => {
  test('reads the explicit summary lines verify writes', () => {
    const report = 'Verification Status: PARTIAL\nAcceptance Criteria Met: 48/50\nCritical Issues Open: 0\n\n# Report'
    expect(summarizeVerification(report)).toEqual({ met: 48, total: 50, criticalOpen: 0 })
  })

  test('tolerates bold markdown around the labels', () => {
    const report = 'Verification Status: PARTIAL\n**Acceptance Criteria Met:** 19 of 20\n**Critical Issues Open:** 2\n'
    expect(summarizeVerification(report)).toEqual({ met: 19, total: 20, criticalOpen: 2 })
  })

  test('falls back to the traceability table for older reports', () => {
    const statuses = [...Array(24).fill('PASS'), 'PARTIAL']
    const report = `Verification Status: PARTIAL\n\n${table(statuses)}\n## Unsatisfied Test Cases\n\n- [T-25] browser flow — cannot run headless here\n`
    expect(summarizeVerification(report)).toEqual({ met: 24, total: 25, criticalOpen: 0 })
  })

  test('counts failing rows and critical unsatisfied cases as critical in the fallback', () => {
    const statuses = [...Array(30).fill('PASS'), 'FAIL']
    const report = `Verification Status: FAIL\n\n${table(statuses)}\n## Unsatisfied Test Cases\n\n- [T-40] login — critical: session lost on refresh\n- [T-41] tooltip copy — minor\n`
    expect(summarizeVerification(report)).toEqual({ met: 30, total: 31, criticalOpen: 2 })
  })

  test('returns undefined when the report gives no numbers at all', () => {
    expect(summarizeVerification('Verification Status: PARTIAL\n\nSome prose, no table.')).toBeUndefined()
  })
})

describe('acceptanceRecommended', () => {
  test('recommends accepting above 95% with nothing critical', () => {
    expect(acceptanceRecommended('partial', { met: 48, total: 50, criticalOpen: 0 })).toBe(true)
    expect(acceptanceRecommended('fail', { met: 97, total: 100, criticalOpen: 0 })).toBe(true)
  })

  test('exactly 95% is not more than 95%', () => {
    expect(acceptanceRecommended('partial', { met: 19, total: 20, criticalOpen: 0 })).toBe(false)
  })

  test('anything critical open keeps verify as the next step', () => {
    expect(acceptanceRecommended('partial', { met: 99, total: 100, criticalOpen: 1 })).toBe(false)
  })

  test('only applies to reports that did not pass', () => {
    expect(acceptanceRecommended('pass', { met: 50, total: 50, criticalOpen: 0 })).toBe(false)
    expect(acceptanceRecommended('missing', { met: 50, total: 50, criticalOpen: 0 })).toBe(false)
    expect(acceptanceRecommended('partial', undefined)).toBe(false)
  })

  test('describes the numbers for the next-step banner', () => {
    expect(describeSummary({ met: 48, total: 50, criticalOpen: 0 })).toBe('48/50 criteria met (96%), nothing critical open')
  })

  test('the Releasing lane takes a card whose next step is accept', () => {
    expect(isEligibleDrop({ recommendedAction: { step: 'accept', label: 'Accept and finish', tab: 'qa', reason: '' } }, 'releasing')).toBe(true)
  })
})
