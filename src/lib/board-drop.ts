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
    case 'done':         return 'verify'
    case 'backlog':      return null
    default:             return null
  }
}

/**
 * Card is eligible to drop into `targetLane` iff the lane's producing step
 * matches the card's recommendedAction. Returns false when the card has no
 * recommended action (nothing to trigger).
 */
export function isEligibleDrop(card: DropCandidateCard | null, targetLane: BoardStatus): boolean {
  if (!card) return false
  const rec = card.recommendedAction
  if (!rec) return false
  return stepForColumn(targetLane) === rec.step
}
