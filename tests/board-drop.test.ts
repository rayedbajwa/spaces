import { test, expect, describe } from 'bun:test'
import { stepForColumn, isEligibleDrop, laneForProject, type BoardStatus, type DropCandidateCard } from '../src/lib/board-drop'

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
    { lane: 'releasing',    expected: 'review' },
    { lane: 'done',         expected: 'deliver' },
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
    expect(isEligibleDrop(card('review'), 'releasing')).toBe(true)
    expect(isEligibleDrop(card('deliver'), 'done')).toBe(true)
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
    const lanes: BoardStatus[] = ['backlog', 'initialized', 'specified', 'planned', 'tasked', 'implementing', 'releasing', 'done']
    const realSteps = ['init', 'specify', 'plan', 'tasks', 'implement', 'verify', 'accept', 'review', 'deliver']
    for (const step of realSteps) {
      const c = card(step)
      const acceptingLanes = lanes.filter((lane) => isEligibleDrop(c, lane))
      expect(acceptingLanes.length).toBe(1)
    }
  })
})

describe('laneForProject', () => {
  const base = { initialized: true, specified: true, planned: true, tasked: true, verificationStatus: 'missing' as const }

  test('a project that implemented and verified is not left in Tasked', () => {
    // The run finished, so it reports no current stage — the case that stranded cards.
    expect(laneForProject({ ...base, verificationStatus: 'fail', activeStage: null })).toBe('implementing')
    expect(laneForProject({ ...base, implementationArtifacts: true, activeStage: null })).toBe('implementing')
    expect(laneForProject({ ...base, tasksDone: 3, activeStage: null })).toBe('implementing')
  })

  test('tasks written but no work started stays in Tasked', () => {
    expect(laneForProject({ ...base, tasksDone: 0 })).toBe('tasked')
  })

  test('a verified feature is releasing until delivery merges it', () => {
    expect(laneForProject({ ...base, verificationStatus: 'partial' })).toBe('implementing')
    expect(laneForProject({ ...base, verificationStatus: 'pass' })).toBe('releasing')
    expect(laneForProject({ ...base, verificationStatus: 'pass', deliveryStatus: 'partial' })).toBe('releasing')
    expect(laneForProject({ ...base, verificationStatus: 'pass', deliveryStatus: 'merged' })).toBe('done')
  })

  test('a run in flight places the card by its stage', () => {
    expect(laneForProject({ ...base, activeStage: 'implement' })).toBe('implementing')
    expect(laneForProject({ ...base, activeStage: 'testplan' })).toBe('implementing')
    expect(laneForProject({ ...base, verificationStatus: 'pass', activeStage: 'review' })).toBe('releasing')
    expect(laneForProject({ ...base, accepted: true, verificationStatus: 'partial', activeStage: 'review' })).toBe('releasing')
    expect(laneForProject({ ...base, activeStage: 'deliver' })).toBe('releasing')
    // The full pipeline reviews before it verifies: that review is still building.
    expect(laneForProject({ ...base, activeStage: 'review' })).toBe('implementing')
    // Fixing review findings on a verified feature is building again.
    expect(laneForProject({ ...base, verificationStatus: 'pass', activeStage: 'implement' })).toBe('implementing')
    expect(laneForProject({ ...base, activeStage: 'plan' })).toBe('tasked')
  })

  test('earlier milestones still place their cards', () => {
    expect(laneForProject({ initialized: false, specified: false, planned: false, tasked: false, verificationStatus: 'missing' })).toBe('backlog')
    expect(laneForProject({ ...base, tasked: false, planned: false, specified: false })).toBe('initialized')
    expect(laneForProject({ ...base, tasked: false, planned: false })).toBe('specified')
    expect(laneForProject({ ...base, tasked: false })).toBe('planned')
  })
})

describe('a lane is a phase, not one step', () => {
  const card = (step: string): DropCandidateCard => ({ recommendedAction: { step, label: `Run ${step}`, tab: 'specs', reason: 'next' } })

  test('the steps that lead into Implementing all land there', () => {
    for (const step of ['testplan', 'parallelize', 'implement', 'verify']) {
      expect(isEligibleDrop(card(step), 'implementing')).toBe(true)
    }
  })

  test('accepting and review lead to Releasing; deliver leads to Done', () => {
    expect(isEligibleDrop(card('accept'), 'releasing')).toBe(true)
    expect(isEligibleDrop(card('review'), 'releasing')).toBe(true)
    expect(isEligibleDrop(card('deliver'), 'done')).toBe(true)
    expect(isEligibleDrop(card('verify'), 'done')).toBe(false)
  })

  test('a card whose next step is earlier still cannot skip ahead', () => {
    expect(isEligibleDrop(card('plan'), 'implementing')).toBe(false)
    expect(isEligibleDrop(card('implement'), 'done')).toBe(false)
    expect(isEligibleDrop(card('review'), 'done')).toBe(false)
    expect(isEligibleDrop(card('specify'), 'done')).toBe(false)
  })
})
