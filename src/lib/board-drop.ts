/**
 * Board drag-and-drop eligibility rules — extracted from src/web/main.tsx so
 * they can be unit-tested without a DOM or React renderer.
 *
 * The board's lanes are DERIVED from artifact state on the server (see the
 * board response). Dropping a card onto a lane is shorthand for "run the
 * pipeline step that would produce the artifact for that lane."
 *
 * A drop is only accepted when the target lane matches the card's own
 * `recommendedAction.step` — the same signal the "Recommended next action"
 * banner uses inside the project modal. Keeping one source of truth means the
 * board can never let a user skip stages or trigger something out of order.
 */

export type BoardStatus =
  | 'backlog'
  | 'initialized'
  | 'specified'
  | 'planned'
  | 'tasked'
  | 'implementing'
  | 'releasing'
  | 'done'

/** Just enough of the board card shape to decide drop eligibility. */
export interface DropCandidateCard {
  recommendedAction?: { step: string; label: string; tab: string; reason: string }
}

/**
 * Map a target lane to the pipeline step that would move a card into it, or
 * null when the lane has no producing step (backlog is a resting lane).
 */
export function stepForColumn(lane: BoardStatus): string | null {
  switch (lane) {
    case 'initialized':  return 'init'
    case 'specified':    return 'specify'
    case 'planned':      return 'plan'
    case 'tasked':       return 'tasks'
    case 'implementing': return 'implement'
    case 'releasing':    return 'review'
    case 'done':         return 'deliver'
    case 'backlog':      return null
    default:             return null
  }
}

/**
 * Every step that moves a card into a lane.
 *
 * A lane is a phase, not a single step: getting a project into "Implementing"
 * can mean running the test plan or the workstream split before implement
 * itself. Dropping a card there runs whichever of those comes next, so a
 * project is never stuck because its next step has no lane of its own — while
 * a lane still refuses a card whose next step belongs to an earlier phase, so
 * nothing is skipped.
 */
export function stepsForColumn(lane: BoardStatus): string[] {
  switch (lane) {
    case 'initialized':  return ['init']
    case 'specified':    return ['specify']
    case 'planned':      return ['plan']
    case 'tasked':       return ['tasks']
    case 'implementing': return ['testplan', 'parallelize', 'implement', 'verify']
    // Deliver is what finishes a feature, so it is the drop onto Done; the card
    // sits in Releasing while it runs.
    case 'releasing':    return ['accept', 'review']
    case 'done':         return ['deliver']
    case 'backlog':      return []
    default:             return []
  }
}

/**
 * Card is eligible to drop into `targetLane` when the card's next step is one
 * of the steps that lead into that lane. Returns false when the card has no
 * recommended action (nothing to trigger).
 */
export function isEligibleDrop(card: DropCandidateCard | null, targetLane: BoardStatus): boolean {
  if (!card) return false
  const rec = card.recommendedAction
  if (!rec) return false
  return stepsForColumn(targetLane).includes(rec.step)
}

/** What the board knows about a project's artifacts when placing its card. */
export interface LaneEvidence {
  initialized: boolean
  specified: boolean
  planned: boolean
  tasked: boolean
  verificationStatus: 'pass' | 'partial' | 'fail' | 'missing'
  /** Documents the later stages leave behind: a review, a merge report, a verification report. */
  implementationArtifacts?: boolean
  /** Tasks ticked off in tasks.md. */
  tasksDone?: number
  /** The stage a run is on right now, when one is running or paused. */
  activeStage?: string | null
  /** A person accepted the feature as delivered even though verification did not pass. */
  accepted?: boolean
  /** From delivery-report.md; only MERGED finishes a feature. */
  deliveryStatus?: 'merged' | 'partial' | 'blocked'
}

const IMPLEMENTATION_STAGES = ['testplan', 'parallelize', 'implement', 'orchestrate', 'verify']

/**
 * The lane a project belongs in.
 *
 * Placement follows what the project has produced, never the status of a run
 * process. That matters because a finished run records no current stage: a
 * project that implemented and verified would otherwise fall back to the lane
 * its last artifact named — "Tasked" — and look stuck. Implementation counts
 * as started once any task is ticked off or any later document exists.
 *
 * A verified feature — or one a person accepted at partial — is releasing:
 * code review and delivery (merge, deploy, UAT) are separate steps still to
 * come. It is done only once delivery reports MERGED. A run on a particular
 * stage right now places the card by that stage. Review counts as releasing
 * only for a verified or accepted feature: the full pipeline reviews before it
 * verifies, and that review is still part of building.
 */
export function laneForProject(evidence: LaneEvidence): BoardStatus {
  if (evidence.deliveryStatus === 'merged') return 'done'
  const settled = evidence.verificationStatus === 'pass' || Boolean(evidence.accepted)
  if (evidence.activeStage === 'deliver' || (evidence.activeStage === 'review' && settled)) return 'releasing'
  const buildingNow = Boolean(evidence.activeStage && [...IMPLEMENTATION_STAGES, 'review'].includes(evidence.activeStage))
  if (!buildingNow && settled) return 'releasing'

  const implementing = Boolean(evidence.implementationArtifacts)
    || (evidence.tasksDone ?? 0) > 0
    || evidence.verificationStatus !== 'missing'
    || buildingNow
  if (evidence.tasked && implementing) return 'implementing'

  if (evidence.tasked) return 'tasked'
  if (evidence.planned) return 'planned'
  if (evidence.specified) return 'specified'
  if (evidence.initialized) return 'initialized'
  return 'backlog'
}
