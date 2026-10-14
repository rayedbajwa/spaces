/**
 * The delivery gate's release step, shared by every surface that resolves the
 * gate: an answer in the app, a Slack decision and an approval link. For a
 * linked project, resolving the gate releases (or records a rejection) through
 * deterministic code, never the agent, and says what happened in the run's log:
 * the run itself only reports that its flow is complete.
 */

import { decideRelease, getDeploymentTarget, type DecideReleaseResult } from './deployment'
import { appendEvent } from './run-store'
import { createLineStamper } from './agent-activity'

export async function releaseAtDeliverGate(input: {
  runId: string
  projectId: string
  /** The gate that was answered (from answerPausedRun). */
  stage: string | null
  pauseKind: 'review' | 'clarification'
  approved: boolean
  /** The person's feedback when they did not approve. */
  reason?: string
  actorUserId: string | null
}): Promise<DecideReleaseResult | undefined> {
  if (input.stage !== 'deliver' || input.pauseKind !== 'review') return undefined
  // An unlinked project has nothing to release.
  if (!(await getDeploymentTarget(input.projectId).catch(() => undefined))) return undefined
  const outcome = await decideRelease({
    runId: input.runId,
    projectId: input.projectId,
    decision: input.approved ? 'approved' : 'rejected',
    reason: input.approved ? undefined : input.reason,
    actorUserId: input.actorUserId,
  }).catch((error): DecideReleaseResult => ({ ok: false, decision: input.approved ? 'approved' : 'rejected', status: 'blocked', error: error instanceof Error ? error.message : String(error) }))
  const message = describeOutcome(outcome)
  await appendEvent({
    runId: input.runId,
    kind: 'deployment_outcome',
    payload: {
      decision: outcome.decision,
      status: outcome.status,
      message,
      ...(outcome.record ? { deploymentId: outcome.record.deploymentId, targetId: outcome.record.targetId } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
      ...(outcome.code ? { code: outcome.code } : {}),
    },
  }).catch(() => undefined)
  await appendEvent({ runId: input.runId, kind: 'log', payload: { stream: 'stdout', chunk: createLineStamper({ label: () => 'spaces' }).stamp(`${message}\n`) } }).catch(() => undefined)
  return outcome
}

export function describeOutcome(outcome: DecideReleaseResult): string {
  if (outcome.decision === 'rejected') {
    return outcome.ok ? 'Release not approved: nothing was deployed.' : `The rejection was not recorded: ${outcome.error ?? 'unknown error'}`
  }
  if (outcome.alreadyLive) {
    return `Release recorded: the deployment target already runs ${outcome.alreadyLive.commitHash.slice(0, 7)}, the tip of ${outcome.alreadyLive.branch ?? 'its branch'}. Nothing to redeploy.`
  }
  if (!outcome.ok) return `The release was not started, so the intent stays in Releasing: ${outcome.error ?? 'unknown error'}`
  if (outcome.status === 'success') return 'Release recorded: the deployment is live.'
  return 'Release started on Railway. The intent is Done once Railway reports the deployment live.'
}
