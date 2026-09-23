/**
 * Which worker gives its slot to a project waiting at the worker cap.
 *
 * A worker whose project has no work left (it is only waiting out its idle
 * timeout) goes first, straight away: holding a slot for nothing is what kept
 * real projects waiting behind short-lived ones. After `starvationMs` of
 * waiting, a worker whose project has queued jobs but none running may go too
 * (once per `cooldownMs`). A worker running a job is never chosen. Oldest first.
 */
export interface SlotHolder { projectId: string; startedAt: number }
export interface ProjectWork { projectId: string; inFlight: number }

export function pickSlotToFree<T extends SlotHolder>(input: {
  holders: T[]
  work: ProjectWork[]
  waitedMs: number
  rotatedAt: Map<string, number>
  now?: number
  starvationMs?: number
  cooldownMs?: number
}): { holder: T; reason: 'no work left' | 'no job running' } | undefined {
  const now = input.now ?? Date.now()
  const starvationMs = input.starvationMs ?? 60_000
  const cooldownMs = input.cooldownMs ?? 5 * 60_000
  const workOf = (projectId: string) => input.work.find((p) => p.projectId === projectId)
  const oldest = (list: T[]) => [...list].sort((a, b) => a.startedAt - b.startedAt)[0]
  const workless = oldest(input.holders.filter((w) => !workOf(w.projectId)))
  if (workless) return { holder: workless, reason: 'no work left' }
  if (input.waitedMs < starvationMs) return undefined
  const stalled = oldest(input.holders
    .filter((w) => (workOf(w.projectId)?.inFlight ?? 0) === 0)
    .filter((w) => now - (input.rotatedAt.get(w.projectId) ?? 0) > cooldownMs))
  return stalled ? { holder: stalled, reason: 'no job running' } : undefined
}
