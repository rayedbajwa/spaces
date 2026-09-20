import { describe, expect, test } from 'bun:test'
import { parseApprovalAnswer, parseCodeReviewStatus } from '../src/lib/aidlc'

describe('approval answers', () => {
  test('plain approvals', () => {
    for (const a of ['approve', 'Approved', 'ok', 'yes', 'LGTM', 'continue']) expect(parseApprovalAnswer(a)).toEqual({ approved: true })
  })
  test('approvals with notes keep the note', () => {
    expect(parseApprovalAnswer('approve: rename the flag to --strict')).toEqual({ approved: true, note: 'rename the flag to --strict' })
    expect(parseApprovalAnswer('ok — but add a test for empty input')).toEqual({ approved: true, note: 'but add a test for empty input' })
    expect(parseApprovalAnswer('Approved.\nPlease tighten the error copy.')).toEqual({ approved: true, note: 'Please tighten the error copy.' })
  })
  test('change requests are not approvals', () => {
    expect(parseApprovalAnswer('Please split the endpoint into two handlers').approved).toBe(false)
    expect(parseApprovalAnswer('okay-ish but no').approved).toBe(false)
  })
})

describe('code review verdicts', () => {
  test('recognises a review that asks for changes', () => {
    expect(parseCodeReviewStatus('# Review\n\nCode Review Status: CHANGES_REQUESTED\n')).toBe('CHANGES_REQUESTED')
    expect(parseCodeReviewStatus('Code Review Status: **CHANGES_REQUESTED**')).toBe('CHANGES_REQUESTED')
    expect(parseCodeReviewStatus('code review status: changes requested')).toBe('CHANGES_REQUESTED')
  })

  test('recognises an approval', () => {
    expect(parseCodeReviewStatus('Code Review Status: APPROVED')).toBe('APPROVED')
  })

  test('says nothing when the review recorded no verdict', () => {
    expect(parseCodeReviewStatus('The code looks reasonable to me.')).toBeUndefined()
  })
})
