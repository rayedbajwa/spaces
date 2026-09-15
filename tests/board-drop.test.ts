import { test, expect, describe } from 'bun:test'
import { stepForColumn, isEligibleDrop, type BoardStatus, type DropCandidateCard } from '../src/lib/board-drop'

/**
 * Unit tests for the board's drag-and-drop eligibility rules. These are pure
 * functions extracted from src/web/main.tsx specifically so we can exercise
 * them without a DOM. The invariants under test:
 *
 *  1. Every lane maps to at most one step (no ambiguity).
 *  2. `backlog` is a resting lane — no drop ever lands you there.
 *  3. A drop is accepted iff the target lane's step matches the card's
 *     recommendedAction.step. Nothing else can override this.
 *  4. Cards with no recommendedAction are never a valid drop source.
 */

describe('stepForColumn', () => {
  const cases: Array<{ lane: BoardStatus; expected: string | null }> = [
    { lane: 'initialized',  expected: 'init' },
    { lane: 'specified',    expected: 'specify' },
    { lane: 'planned',      expected: 'plan' },
    { lane: 'tasked',       expected: 'tasks' },
    { lane: 'implementing', expected: 'implement' },
    { lane: 'done',         expected: 'verify' },
    { lane: 'backlog',      expected: null },
  ]

  for (const c of cases) {
    test(`${c.lane} → ${c.expected ?? '(null — no producing step)'}`, () => {
      expect(stepForColumn(c.lane)).toBe(c.expected)
    })
  }

  test('every non-null mapping produces a unique step (no lane collisions)', () => {
    const steps = cases
      .map((c) => c.expected)
      .filter((s): s is string => s !== null)
    expect(new Set(steps).size).toBe(steps.length)
  })
})

// Helper for building a card fixture with a recommendedAction.
function card(step: string, label = `Run ${step}`): DropCandidateCard {
  return { recommendedAction: { step, label, tab: 'overview', reason: 'test' } }
}

describe('isEligibleDrop', () => {
  test('exact match → true', () => {
    expect(isEligibleDrop(card('specify'), 'specified')).toBe(true)
    expect(isEligibleDrop(card('plan'), 'planned')).toBe(true)
    expect(isEligibleDrop(card('implement'), 'implementing')).toBe(true)
    expect(isEligibleDrop(card('verify'), 'done')).toBe(true)
  })

  test('mismatch → false (no lane-skipping)', () => {
    // Card ready for `specify` should NOT drop into `planned` or beyond.
    expect(isEligibleDrop(card('specify'), 'planned')).toBe(false)
    expect(isEligibleDrop(card('specify'), 'tasked')).toBe(false)
    expect(isEligibleDrop(card('specify'), 'implementing')).toBe(false)
    expect(isEligibleDrop(card('specify'), 'done')).toBe(false)
    // And should not go backward into initialized either.
    expect(isEligibleDrop(card('specify'), 'initialized')).toBe(false)
    // backlog is never a drop target.
    expect(isEligibleDrop(card('specify'), 'backlog')).toBe(false)
  })

  test('null card → false', () => {
    expect(isEligibleDrop(null, 'specified')).toBe(false)
  })

  test('card with no recommendedAction → false (nothing to trigger)', () => {
    expect(isEligibleDrop({}, 'specified')).toBe(false)
    expect(isEligibleDrop({ recommendedAction: undefined }, 'specified')).toBe(false)
  })

  test('lane-with-no-producing-step (backlog) is never eligible even for matching step', () => {
    // Even if some hypothetical card had recommendedAction.step === 'anything',
    // dropping into `backlog` returns false because backlog maps to null.
    expect(isEligibleDrop(card('init'), 'backlog')).toBe(false)
  })

  test('cross-check: for every card recommendation, exactly one lane accepts it', () => {
    // Given a card recommending each real step, walk every lane and confirm
    // exactly one lane returns true. This is the single-source-of-truth
    // guarantee — no ambiguous drop targets.
    const lanes: BoardStatus[] = ['backlog', 'initialized', 'specified', 'planned', 'tasked', 'implementing', 'done']
    const realSteps = ['init', 'specify', 'plan', 'tasks', 'implement', 'verify']
    for (const step of realSteps) {
      const c = card(step)
      const acceptingLanes = lanes.filter((lane) => isEligibleDrop(c, lane))
      expect(acceptingLanes.length).toBe(1)
    }
  })
})
