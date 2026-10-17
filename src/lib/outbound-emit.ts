/**
 * Outbound event emission from run paths (012-inbound-outbound-slack, US4).
 *
 * Extracted from `worker.ts` so the run/gate emitters can be exercised directly:
 * every payload carries the project name and a navigable link (FR-019) and a
 * delivery can never block or change a run. Both helpers resolve the org from
 * the run's project and swallow every error.
 */
import { spacesProjectUrl } from './artifact-links'
import { orgIdForProject } from './orgs'
import { getRun } from './run-store'
import { emitOutboundEventQuietly, type OutboundEventKind } from './outbound-store'

/** The run fields the emitters need; a run without a project cannot emit. */
export interface OutboundRunRef {
  projectId?: string | null
  projectLabel?: string
  projectNamespace?: string
  runId?: string
}

const spacesLink = spacesProjectUrl

/** Fire-and-forget outbound emission from a run path (never blocks or changes the run). */
export async function emitRunOutbound(
  run: OutboundRunRef,
  eventKind: OutboundEventKind,
  eventKey: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const projectId = run.projectId
  if (!projectId) return
  const link = spacesLink(run.projectNamespace)
  const enriched = { projectName: run.projectLabel, ...payload, ...(link ? { link } : {}) }
  const orgId = await orgIdForProject(projectId).catch(() => undefined)
  if (!orgId) return
  emitOutboundEventQuietly({ orgId, projectId, eventKind, eventKey, payload: enriched })
}

/** Fire-and-forget gate-opened emission, resolved through the run's project org. */
export async function emitGateOutbound(runId: string, gateId: string, stage: string | undefined, kind: string): Promise<void> {
  const run = await getRun(runId).catch(() => undefined)
  if (!run?.projectId) return
  const orgId = await orgIdForProject(run.projectId).catch(() => undefined)
  if (!orgId) return
  emitOutboundEventQuietly({
    orgId,
    projectId: run.projectId,
    eventKind: 'gate_opened',
    eventKey: `gate:${gateId}:opened`,
    payload: { projectName: run.projectLabel, stage, kind, gateId, runId, ...(spacesLink(run.projectNamespace) ? { link: spacesLink(run.projectNamespace) } : {}) },
  })
}
