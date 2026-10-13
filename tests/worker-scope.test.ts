import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { reapIdleAgents } from '../src/lib/agent-pool'
import { getDb } from '../src/lib/db'
import { reapOrphanedRuns } from '../src/lib/dispatcher'
import { createApprovalFixture } from './helpers/approval-fixture'

/** 014-project-workers: a project's worker touches only its own project. */

const fixture = await createApprovalFixture({ withServer: false })
const { projectA, projectTeamB } = fixture
const sql = getDb()
const agentIds: string[] = []
afterAll(async () => {
  if (agentIds.length) await sql`DELETE FROM project_agents WHERE agent_id IN ${sql(agentIds)}`
  await fixture.stop()
})

describe('reapers on a per-project worker', () => {
  test("idle agents are reaped only for the worker's project", async () => {
    for (const projectId of [projectA.projectId, projectTeamB.projectId]) {
      const agentId = randomUUID()
      agentIds.push(agentId)
      await sql`INSERT INTO project_agents (agent_id, project_id, role, status, last_used_at) VALUES (${agentId}, ${projectId}, ${`scope-test-${agentId.slice(0, 8)}`}, 'idle', now() - interval '2 hours')`
    }
    await reapIdleAgents(60_000, projectA.projectId)
    const rows = await sql<Array<{ projectId: string; status: string }>>`SELECT project_id AS "projectId", status FROM project_agents WHERE agent_id IN ${sql(agentIds)}`
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.projectId === projectA.projectId)?.status).toBe('dead')
    expect(rows.find((r) => r.projectId === projectTeamB.projectId)?.status).toBe('idle')
  })

  test("orphaned runs are looked for only in the worker's project", async () => {
    const result = await reapOrphanedRuns(30_000, randomUUID())
    expect(result.runIds).toEqual([])
  })
})
