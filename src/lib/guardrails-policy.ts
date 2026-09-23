import { getDb } from './db'
import { AgentGuard, DEFAULT_POLICY, GUARD_MODES, type GuardMode, type GuardPolicy } from './guardrails'

/**
 * Each organization's AI data guardrails setting (organizations.ai_guardrails),
 * read with a short cache: every agent session and outgoing message asks.
 * Unset, or unreadable, means the default (mask) — the guardrails fail closed.
 */

const TTL_MS = 30_000
const cache = new Map<string, { policy: GuardPolicy; at: number }>()

export function normalizePolicy(input: unknown): GuardPolicy {
  const raw = (input && typeof input === 'object' ? input : {}) as { mode?: unknown; allow?: unknown }
  const mode = GUARD_MODES.includes(raw.mode as GuardMode) ? raw.mode as GuardMode : DEFAULT_POLICY.mode
  const allow = Array.isArray(raw.allow) ? raw.allow.filter((a): a is string => typeof a === 'string').map((a) => a.trim()).filter(Boolean).slice(0, 200) : []
  return { mode, allow }
}

export async function loadGuardPolicy(orgId: string | null | undefined): Promise<GuardPolicy> {
  if (!orgId) return DEFAULT_POLICY
  const hit = cache.get(orgId)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.policy
  const policy = await getDb()<Array<{ policy: unknown }>>`SELECT ai_guardrails AS policy FROM organizations WHERE org_id = ${orgId}`
    .then(([row]) => normalizePolicy(row?.policy))
    .catch(() => DEFAULT_POLICY)
  cache.set(orgId, { policy, at: Date.now() })
  return policy
}

export async function saveGuardPolicy(orgId: string, input: unknown): Promise<GuardPolicy> {
  const policy = normalizePolicy(input)
  await getDb()`UPDATE organizations SET ai_guardrails = ${getDb().json(policy as never)} WHERE org_id = ${orgId}`
  cache.set(orgId, { policy, at: Date.now() })
  return policy
}

/** A guard for one agent session, installed on it, under the organization's setting. */
export async function guardSession(session: { agent: unknown }, orgId: string | null | undefined): Promise<AgentGuard> {
  const guard = new AgentGuard(await loadGuardPolicy(orgId))
  guard.install(session)
  return guard
}
