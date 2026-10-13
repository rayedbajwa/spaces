/**
 * Shared vocabulary for inbound work intake (012-inbound-outbound-slack).
 * Kept in its own module so the store, connectors, routing and server can share
 * the unions without importing each other.
 */

export const INTAKE_SOURCES = ['jira', 'linear', 'slack', 'datadog'] as const
export type IntakeSource = (typeof INTAKE_SOURCES)[number]

export const INTAKE_PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const
export type IntakePriority = (typeof INTAKE_PRIORITIES)[number]

export const INTAKE_STATES = ['new', 'converted', 'dismissed', 'merged'] as const
export type IntakeState = (typeof INTAKE_STATES)[number]

export const ACTOR_SURFACES = ['app', 'slack', 'system'] as const
export type ActorSurface = (typeof ACTOR_SURFACES)[number]

export const WORK_KINDS = ['feature', 'bugfix'] as const
export type WorkKind = (typeof WORK_KINDS)[number]

export const SOURCE_UPDATE_STATES = ['pending', 'updated', 'failed', 'unsupported'] as const
export type SourceUpdateState = (typeof SOURCE_UPDATE_STATES)[number]

export interface IntakeItemInput {
  orgId: string
  source: IntakeSource
  externalRef: string
  externalUrl?: string | null
  sourceScope?: string | null
  title: string
  summary?: string | null
  requesterName?: string | null
  requesterEmail?: string | null
  priority?: IntakePriority
  raw?: Record<string, unknown>
}
