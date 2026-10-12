import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getDb } from '../src/lib/db'
import { addRepo, removeRepo } from '../src/lib/project-registry'
import { upsertAppIntegration } from '../src/lib/app-integrations'
import { pushIntakeSourceUpdate } from '../src/lib/intake-connectors'
import {
  convertIntakeItem,
  dismissIntakeItem,
  getIntakeItem,
  markSourceUpdate,
  mergeIntakeItems,
  restoreIntakeItem,
  upsertIntakeItem,
} from '../src/lib/intake-store'
import { createApprovalFixture } from './helpers/approval-fixture'

/**
 * Conversion, work-link, dismiss/restore/merge and non-blocking source updates
 * (US2: FR-006/007/008/009/026). DB-backed against the guarded test database.
 */
const fixture = await createApprovalFixture({ withServer: false })
const { orgA, users, projectA, projectTeamB } = fixture
const workspace = await mkdtemp(path.join(os.tmpdir(), 'intake-conversion-'))
const repo = await addRepo({ projectId: projectA.projectId, label: 'conversion-repo', kind: 'local', localPath: workspace, isPrimary: true })

afterAll(async () => {
  await removeRepo(repo.repoId).catch(() => undefined)
  await fixture.stop()
})

const realFetch = globalThis.fetch
function stubFetch(handler: (url: string, init?: RequestInit) => Response): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init)) as typeof fetch
}
afterEach(() => { globalThis.fetch = realFetch })

function input(overrides: Record<string, unknown> = {}) {
  return { orgId: orgA, source: 'jira' as const, externalRef: `OPS-${randomUUID().slice(0, 8)}`, title: 'Convert me', priority: 'high' as const, ...overrides } as never
}

async function cleanup(intakeIds: string[], runIds: string[] = []): Promise<void> {
  const sql = getDb()
  if (runIds.length) await sql`DELETE FROM project_jobs WHERE run_id IN ${sql(runIds)}`
  if (runIds.length) await sql`DELETE FROM pipeline_runs WHERE run_id IN ${sql(runIds)}`
  if (intakeIds.length) await sql`DELETE FROM intake_items WHERE intake_id IN ${sql(intakeIds)}`
}

describe('conversion to project work', () => {
  test('starts a specify run, records the work link and marks the item converted', async () => {
    const item = await upsertIntakeItem(input())
    const result = await convertIntakeItem({ orgId: orgA, intakeId: item.intakeId, projectId: projectA.projectId, workKind: 'feature', actorUserId: users.ownerA, actorSurface: 'app' })
    expect('error' in result).toBe(false)
    if ('error' in result) return
    try {
      expect(result.item.state).toBe('converted')
      expect(result.link.workKind).toBe('feature')
      expect(result.link.runId).toBeTruthy()
      const [run] = await getDb()<Array<{ pipelineName: string; status: string; feature: string | null }>>`
        SELECT pipeline_name AS "pipelineName", status, feature FROM pipeline_runs WHERE run_id = ${result.link.runId}
      `
      expect(run?.pipelineName).toBe('adhoc-specify')
      expect(run?.status).toBe('queued')
      expect(run?.feature).toContain('Convert me')
      const [link] = await getDb()<Array<{ state: string; sourceUpdateState: string; projectId: string }>>`
        SELECT i.state, w.source_update_state AS "sourceUpdateState", w.project_id AS "projectId"
          FROM intake_items i JOIN intake_work_links w ON w.intake_id = i.intake_id WHERE i.intake_id = ${item.intakeId}
      `
      expect(link?.state).toBe('converted')
      expect(link?.sourceUpdateState).toBe('pending')
      expect(link?.projectId).toBe(projectA.projectId)
    } finally {
      await cleanup([item.intakeId], [result.link.runId!])
    }
  })

  test('a foreign project is refused and the item stays new', async () => {
    const item = await upsertIntakeItem(input())
    try {
      const result = await convertIntakeItem({ orgId: orgA, intakeId: item.intakeId, projectId: projectTeamB.projectId, workKind: 'bugfix', actorUserId: users.ownerA })
      expect('error' in result).toBe(true)
      expect((await getIntakeItem(orgA, item.intakeId))?.state).toBe('new')
    } finally {
      await cleanup([item.intakeId])
    }
  })

  test('an already-converted item cannot be converted twice', async () => {
    const item = await upsertIntakeItem(input())
    const result = await convertIntakeItem({ orgId: orgA, intakeId: item.intakeId, projectId: projectA.projectId, workKind: 'feature', actorUserId: users.ownerA })
    if ('error' in result) return
    try {
      const again = await convertIntakeItem({ orgId: orgA, intakeId: item.intakeId, projectId: projectA.projectId, workKind: 'bugfix', actorUserId: users.ownerA })
      expect('error' in again).toBe(true)
    } finally {
      await cleanup([item.intakeId], [result.link.runId!])
    }
  })
})

describe('best-effort source update never blocks the conversion', () => {
  test('a successful Jira comment reports updated; a failure reports failed and the item stays converted', async () => {
    await upsertAppIntegration({ orgId: orgA, kind: 'jira', status: 'connected', config: { cloudId: 'cloud-1', siteUrl: 'https://acme.atlassian.net' }, credentials: { access_token: '<SECRET_77>' } })
    const item = await upsertIntakeItem(input())
    const result = await convertIntakeItem({ orgId: orgA, intakeId: item.intakeId, projectId: projectA.projectId, workKind: 'bugfix', actorUserId: users.ownerA })
    if ('error' in result) return
    try {
      stubFetch(() => new Response(JSON.stringify({ id: 'c1' }), { status: 201 }))
      const ok = await pushIntakeSourceUpdate({ intakeId: item.intakeId, workKind: 'bugfix' }, result.item)
      expect(ok.state).toBe('updated')
      await markSourceUpdate({ intakeId: item.intakeId, state: ok.state })
      const [after] = await getDb()<Array<{ sourceUpdateState: string; state: string }>>`
        SELECT w.source_update_state AS "sourceUpdateState", i.state
          FROM intake_items i JOIN intake_work_links w ON w.intake_id = i.intake_id WHERE i.intake_id = ${item.intakeId}
      `
      expect(after?.sourceUpdateState).toBe('updated')

      stubFetch(() => new Response('boom', { status: 500 }))
      const failed = await pushIntakeSourceUpdate({ intakeId: item.intakeId, workKind: 'bugfix' }, result.item)
      expect(failed.state).toBe('failed')
      await markSourceUpdate({ intakeId: item.intakeId, state: failed.state, error: failed.error })
      expect((await getIntakeItem(orgA, item.intakeId))?.state).toBe('converted')
      const [final] = await getDb()<Array<{ sourceUpdateState: string }>>`SELECT source_update_state AS "sourceUpdateState" FROM intake_work_links WHERE intake_id = ${item.intakeId}`
      expect(final?.sourceUpdateState).toBe('failed')
    } finally {
      await cleanup([item.intakeId], [result.link.runId!])
    }
  })

  test('a Slack item has no writable source ticket', async () => {
    const item = await upsertIntakeItem(input({ source: 'slack', title: 'From Slack' }))
    try {
      const result = await pushIntakeSourceUpdate({ intakeId: item.intakeId, workKind: 'feature' }, item)
      expect(result.state).toBe('unsupported')
    } finally {
      await cleanup([item.intakeId])
    }
  })
})

describe('dismiss, restore and merge', () => {
  test('dismiss records a reason, restore returns to the queue, merge links originals', async () => {
    const survivor = await upsertIntakeItem(input({ title: 'Survivor' }))
    const duplicate = await upsertIntakeItem(input({ title: 'Duplicate' }))
    try {
      await dismissIntakeItem({ orgId: orgA, intakeId: duplicate.intakeId, reason: 'duplicate of a report', actorUserId: users.ownerA })
      expect((await getIntakeItem(orgA, duplicate.intakeId))?.state).toBe('dismissed')
      const [dismissed] = await getDb()<Array<{ reason: string }>>`
        SELECT reason FROM intake_transitions WHERE intake_id = ${duplicate.intakeId} AND action = 'dismissed' ORDER BY created_at DESC LIMIT 1
      `
      expect(dismissed?.reason).toBe('duplicate of a report')

      await restoreIntakeItem({ orgId: orgA, intakeId: duplicate.intakeId, actorUserId: users.ownerA })
      expect((await getIntakeItem(orgA, duplicate.intakeId))?.state).toBe('new')

      await mergeIntakeItems({ orgId: orgA, intakeId: duplicate.intakeId, intoId: survivor.intakeId, reason: 'same alert', actorUserId: users.ownerA })
      const merged = await getIntakeItem(orgA, duplicate.intakeId)
      expect(merged?.state).toBe('merged')
      expect(merged?.mergedIntoId).toBe(survivor.intakeId)
      expect((await getIntakeItem(orgA, survivor.intakeId))?.state).toBe('new')
    } finally {
      await cleanup([survivor.intakeId, duplicate.intakeId])
    }
  })
})
