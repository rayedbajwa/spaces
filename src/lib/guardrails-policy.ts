import { decryptSecret, encryptSecret } from './crypto-vault'
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function guardSession(session: { agent: unknown; prompt?: (text: string, options?: any) => Promise<unknown> }, orgId: string | null | undefined): Promise<AgentGuard> {
  const guard = new AgentGuard(await loadGuardPolicy(orgId))
  guard.install(session)
  return guard
}

export interface GuardVaultStore {
  load: () => Promise<Record<string, string> | undefined>
  save: (vault: Record<string, string>) => Promise<void>
}

/** Where a run keeps its token vault: sealed in run_guard_vaults, never in the clear. */
export function runGuardVault(runId: string): GuardVaultStore {
  return {
    load: async () => {
      const [row] = await getDb()<Array<{ sealed: string }>>`SELECT sealed FROM run_guard_vaults WHERE run_id = ${runId}`
      return row ? JSON.parse(decryptSecret(row.sealed)) as Record<string, string> : undefined
    },
    save: async (vault) => {
      const sealed = encryptSecret(JSON.stringify(vault))
      await getDb()`
        INSERT INTO run_guard_vaults (run_id, sealed) VALUES (${runId}, ${sealed})
        ON CONFLICT (run_id) DO UPDATE SET sealed = EXCLUDED.sealed, updated_at = now()
      `
    },
  }
}

/**
 * Writes a run's vault one save at a time, always the latest: a save started
 * while another runs waits and then writes the vault as it is by then, so an
 * older snapshot can never land after a newer one. `flush` resolves once
 * everything up to now is stored.
 */
export function createVaultWriter(store: GuardVaultStore, snapshot: () => Record<string, string>, onError: (error: unknown) => void = () => undefined) {
  let dirty = false
  let running: Promise<void> | undefined
  const loop = async () => {
    while (dirty) {
      dirty = false
      await store.save(snapshot()).catch(onError)
    }
    running = undefined
  }
  return {
    /** A new token exists: store the vault soon. */
    schedule(): void {
      dirty = true
      running ??= loop()
    },
    /** Everything so far is stored (before a stage ends, a pause, an error). */
    async flush(): Promise<void> {
      if (running) await running
      if (dirty) { running ??= loop(); await running }
    },
  }
}
