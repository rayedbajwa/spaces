import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { getDb } from './db'

/**
 * Warm agent pool: one row per (project, role) in project_agents, session_file
 * points at the persisted Pi session on disk. Subsequent runs on the same
 * project rehydrate that session for continuity of memory across runs.
 *
 * Phase 5B scope: one session per (project, 'primary'). Full per-role
 * pooling (developer / quality / architect / …) requires per-step session
 * swaps inside AIDLCFlow — deferred until we hit real pain.
 */

export type AgentStatus = 'idle' | 'warming' | 'busy' | 'dead'

export interface AgentRow {
  agentId: string
  projectId: string
  role: string
  status: AgentStatus
  sessionFile?: string
  currentJobId?: string
  warmedAt?: string
  lastUsedAt?: string
  createdAt: string
}

const COLS = `
  agent_id       AS "agentId",
  project_id     AS "projectId",
  role           AS "role",
  status         AS "status",
  session_file   AS "sessionFile",
  current_job_id AS "currentJobId",
  warmed_at      AS "warmedAt",
  last_used_at   AS "lastUsedAt",
  created_at     AS "createdAt"
`

async function fileExists(path: string): Promise<boolean> {
  try { await access(path); return true } catch { return false }
}

export async function getAgent(projectId: string, role: string): Promise<AgentRow | undefined> {
  const sql = getDb()
  const [row] = await sql<AgentRow[]>`
    SELECT ${sql.unsafe(COLS)} FROM project_agents
     WHERE project_id = ${projectId} AND role = ${role}
  `
  return row
}

export async function markAgentBusy(agentId: string, jobId?: string): Promise<void> {
  const sql = getDb()
  await sql`UPDATE project_agents SET status='busy', current_job_id=${jobId ?? null}, last_used_at=now() WHERE agent_id=${agentId}`
}

export async function markAgentIdle(agentId: string, sessionFile?: string | null): Promise<void> {
  const sql = getDb()
  await sql`
    UPDATE project_agents
       SET status='idle',
           current_job_id=NULL,
           last_used_at=now(),
           session_file=COALESCE(${sessionFile ?? null}, session_file)
     WHERE agent_id=${agentId}
  `
}

export async function markAgentDead(agentId: string): Promise<void> {
  const sql = getDb()
  await sql`UPDATE project_agents SET status='dead' WHERE agent_id=${agentId}`
}

export async function createAgentRow(input: { projectId: string; role: string }): Promise<AgentRow> {
  const sql = getDb()
  const agentId = randomUUID()
  const [row] = await sql<AgentRow[]>`
    INSERT INTO project_agents (agent_id, project_id, role, status, warmed_at, last_used_at)
    VALUES (${agentId}, ${input.projectId}, ${input.role}, 'warming', now(), now())
    RETURNING ${sql.unsafe(COLS)}
  `
  return row
}

/**
 * Return a SessionManager for (projectId, role) — hydrate from disk if a warm
 * session file exists, else create a fresh persistent session. Also atomically
 * marks the agent row as busy so parallel jobs don't collide.
 *
 * Returns a `release()` you MUST call when done so the agent goes back to idle.
 */
export async function acquireWarmSession(input: {
  projectId: string
  role: string
  cwd: string
  jobId?: string
}): Promise<{ manager: SessionManager; release: (sessionFile?: string | null) => Promise<void>; agentId: string; wasWarm: boolean }> {
  let agent = await getAgent(input.projectId, input.role)

  // If an existing agent is busy, don't steal it — create a fresh disposable one.
  // (Phase 5B intentionally serializes per (project, role); full parallel per-role
  // agents can be added by permitting multiple rows per (project, role) later.)
  if (agent?.status === 'busy') {
    const manager = SessionManager.create(input.cwd)
    return {
      manager,
      agentId: '',
      wasWarm: false,
      release: async () => { /* no-op: transient session, not tracked */ },
    }
  }

  if (!agent) {
    agent = await createAgentRow({ projectId: input.projectId, role: input.role })
  }

  let manager: SessionManager
  let wasWarm = false

  if (agent.sessionFile && await fileExists(agent.sessionFile)) {
    manager = SessionManager.open(agent.sessionFile, undefined, input.cwd)
    wasWarm = true
  } else {
    manager = SessionManager.create(input.cwd)
  }

  await markAgentBusy(agent.agentId, input.jobId)

  const capturedId = agent.agentId
  return {
    manager,
    agentId: capturedId,
    wasWarm,
    release: async (sessionFile) => {
      try { await markAgentIdle(capturedId, sessionFile ?? null) } catch { /* ignore */ }
    },
  }
}

/** Reap agents idle for longer than `maxIdleMs`. */
export async function reapIdleAgents(maxIdleMs = 30 * 60 * 1000): Promise<number> {
  const sql = getDb()
  const cutoff = new Date(Date.now() - maxIdleMs).toISOString()
  const result = await sql`
    UPDATE project_agents
       SET status='dead'
     WHERE status='idle' AND last_used_at < ${cutoff}
  `
  return result.count ?? 0
}
