import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getDb } from '../src/lib/db'
import { addRepo, removeRepo } from '../src/lib/project-registry'
import { convertIntakeItem, dismissIntakeItem, getIntakeItem, listIntake, markSourceUpdate, mergeIntakeItems, restoreIntakeItem, setIntakePriority, upsertIntakeItem } from '../src/lib/intake-store'
import { createApprovalFixture } from './helpers/approval-fixture'

/**
 * Intake ingestion/idempotency/queue (US1: FR-001/002/003/004/005/024/029;
 * US2: FR-006/007/008/009/026). DB-backed against the guarded test database.
 */
const fixture = await createApprovalFixture({ withServer: false })
const { orgA, orgB, users, projectA, projectTeamB } = fixture
afterAll(async () => { await fixture.stop() })

function itemInput(overrides: Record<string, unknown> = {}) {
  return {
    orgId: orgA,
    source: 'jira' as const,
    externalRef: `OPS-${randomUUID().slice(0, 8)}`,
    externalUrl: 'https://example.test/browse/OPS-1',
    title: 'Disk almost full on web-1',
    summary: 'Volume /var is at 92%.',
    priority: 'high' as const,
    ...overrides,
  } as never
}

describe('ingestion and deduplication', () => {
  test('a first delivery inserts one item and records an arrived transition', async () => {
    const input = itemInput()
    const item = await upsertIntakeItem(input)
    expect(item.state).toBe('new')
    expect(item.repeatCount).toBe(1)
    const [transition] = await getDb()<Array<{ action: string }>>`
      SELECT action FROM intake_transitions WHERE intake_id = ${item.intakeId} ORDER BY created_at ASC LIMIT 1
    `
    expect(transition?.action).toBe('arrived')
    await getDb()`DELETE FROM intake_items WHERE intake_id = ${item.intakeId}`
  })

  test('re-delivering the same source item updates the row and never duplicates', async () => {
    const externalRef = `OPS-${randomUUID().slice(0, 8)}`
    const first = await upsertIntakeItem(itemInput({ externalRef, title: 'First title' }))
    const second = await upsertIntakeItem(itemInput({ externalRef, title: 'Updated title' }))
    expect(second.intakeId).toBe(first.intakeId)
    expect(second.title).toBe('Updated title')
    expect(second.repeatCount).toBe(2)
    const [count] = await getDb()<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM intake_items WHERE org_id = ${orgA} AND source = 'jira' AND external_ref = ${externalRef}
    `
    expect(count?.n).toBe(1)
    await getDb()`DELETE FROM intake_items WHERE intake_id = ${first.intakeId}`
  })
})

describe('queue ordering, priorities and states', () => {
  test('items order by priority rank then first arrival', async () => {
    const low = await upsertIntakeItem(itemInput({ priority: 'low', title: 'Low one' }))
    const urgent = await upsertIntakeItem(itemInput({ priority: 'urgent', title: 'Urgent one' }))
    const normal = await upsertIntakeItem(itemInput({ priority: 'normal', title: 'Normal one' }))
    const { items } = await listIntake(orgA, { limit: 200 })
    const ids = items.map((i) => i.intakeId)
    expect(ids.indexOf(urgent.intakeId)).toBeLessThan(ids.indexOf(normal.intakeId))
    expect(ids.indexOf(normal.intakeId)).toBeLessThan(ids.indexOf(low.intakeId))
    await getDb()`DELETE FROM intake_items WHERE intake_id IN (${low.intakeId}, ${urgent.intakeId}, ${normal.intakeId})`
  })

  test('changing priority records a transition and reorders the queue', async () => {
    const item = await upsertIntakeItem(itemInput({ priority: 'low' }))
    const updated = await setIntakePriority({ orgId: orgA, intakeId: item.intakeId, priority: 'urgent', actorUserId: users.ownerA, actorSurface: 'app' })
    expect(updated?.priority).toBe('urgent')
    const [transition] = await getDb()<Array<{ action: string; metadata: { from: string; to: string } }>>`
      SELECT action, metadata_json AS metadata FROM intake_transitions
       WHERE intake_id = ${item.intakeId} AND action = 'priority_changed' ORDER BY created_at DESC LIMIT 1
    `
    expect(transition?.metadata).toEqual({ from: 'low', to: 'urgent' })
    await getDb()`DELETE FROM intake_items WHERE intake_id = ${item.intakeId}`
  })

  test('dismiss and restore move through recorded transitions', async () => {
    const item = await upsertIntakeItem(itemInput())
    await dismissIntakeItem({ orgId: orgA, intakeId: item.intakeId, reason: 'duplicate of another report', actorUserId: users.ownerA })
    expect((await getIntakeItem(orgA, item.intakeId))?.state).toBe('dismissed')
    await restoreIntakeItem({ orgId: orgA, intakeId: item.intakeId, actorUserId: users.ownerA })
    expect((await getIntakeItem(orgA, item.intakeId))?.state).toBe('new')
    await getDb()`DELETE FROM intake_items WHERE intake_id = ${item.intakeId}`
  })

  test('merge keeps both originals linked and records the survivor', async () => {
    const survivor = await upsertIntakeItem(itemInput({ title: 'Survivor' }))
    const duplicate = await upsertIntakeItem(itemInput({ title: 'Duplicate' }))
    await mergeIntakeItems({ orgId: orgA, intakeId: duplicate.intakeId, intoId: survivor.intakeId, reason: 'same alert', actorUserId: users.ownerA })
    const merged = await getIntakeItem(orgA, duplicate.intakeId)
    expect(merged?.state).toBe('merged')
    expect(merged?.mergedIntoId).toBe(survivor.intakeId)
    expect((await getIntakeItem(orgA, survivor.intakeId))?.state).toBe('new')
    await getDb()`DELETE FROM intake_items WHERE intake_id IN (${survivor.intakeId}, ${duplicate.intakeId})`
  })
})

describe('tenant isolation', () => {
  test('another org never sees or changes an item', async () => {
    const item = await upsertIntakeItem(itemInput())
    const otherList = await listIntake(orgB, { limit: 200 })
    expect(otherList.items.some((i) => i.intakeId === item.intakeId)).toBe(false)
    expect(await getIntakeItem(orgB, item.intakeId)).toBeUndefined()
    expect(await dismissIntakeItem({ orgId: orgB, intakeId: item.intakeId, reason: 'not mine' })).toBeUndefined()
    await getDb()`DELETE FROM intake_items WHERE intake_id = ${item.intakeId}`
  })
})

describe('conversion', () => {
  test('a converted item links to project work and the source update does not roll it back', async () => {
    // Conversion starts the existing specify stage, which needs a runnable repo.
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'intake-convert-'))
    const repo = await addRepo({ projectId: projectA.projectId, label: 'convert-repo', kind: 'local', localPath: workspace, isPrimary: true })
    const item = await upsertIntakeItem(itemInput({ priority: 'high' }))
    try {
      const result = await convertIntakeItem({ orgId: orgA, intakeId: item.intakeId, projectId: projectA.projectId, workKind: 'bugfix', actorUserId: users.ownerA, actorSurface: 'app' })
      expect('error' in result).toBe(false)
      if ('error' in result) return
      expect(result.item.state).toBe('converted')
      expect(result.link.workKind).toBe('bugfix')
      expect(result.link.runId).toBeTruthy()
      // A failed source-ticket update is recorded and never undoes the conversion.
      await markSourceUpdate({ intakeId: item.intakeId, state: 'failed', error: 'source unreachable' })
      const still = await getIntakeItem(orgA, item.intakeId)
      expect(still?.state).toBe('converted')
      const [link] = await getDb()<Array<{ sourceUpdateState: string }>>`
        SELECT source_update_state AS "sourceUpdateState" FROM intake_work_links WHERE intake_id = ${item.intakeId}
      `
      expect(link?.sourceUpdateState).toBe('failed')
      await getDb()`DELETE FROM pipeline_runs WHERE run_id = ${result.link.runId}`
    } finally {
      await getDb()`DELETE FROM intake_items WHERE intake_id = ${item.intakeId}`
      await removeRepo(repo.repoId)
    }
  })

  test('a foreign project is refused without changing the item', async () => {
    const item = await upsertIntakeItem(itemInput())
    const result = await convertIntakeItem({ orgId: orgA, intakeId: item.intakeId, projectId: projectTeamB.projectId, workKind: 'feature', actorUserId: users.ownerA })
    expect('error' in result).toBe(true)
    expect((await getIntakeItem(orgA, item.intakeId))?.state).toBe('new')
    await getDb()`DELETE FROM intake_items WHERE intake_id = ${item.intakeId}`
  })
})

describe('guardrails at the inbound boundary', () => {
  test('sensitive content is masked before an item is stored', async () => {
    // Built at runtime so no literal secret is committed; the value still
    // matches the guardrail secret detector.
    const fakeToken = ['s', 'k'].join('') + '-ant-' + 'a'.repeat(24)
    const email = 'jane.doe@example.test'
    const item = await upsertIntakeItem(itemInput({
      title: `Contact ${email} about the outage`,
      summary: `Credentials leaked: ${fakeToken}`,
      raw: { reporter: email, notes: fakeToken },
    }))
    try {
      const stored = await getIntakeItem(orgA, item.intakeId)
      expect(stored?.title).not.toContain(email)
      expect(stored?.title).toContain('[email]')
      expect(stored?.summary ?? '').not.toContain(fakeToken)
      expect(stored?.summary ?? '').toContain('[redacted')
      expect(JSON.stringify(stored?.raw ?? {})).not.toContain(fakeToken)
    } finally {
      await getDb()`DELETE FROM intake_items WHERE intake_id = ${item.intakeId}`
    }
  })
})
