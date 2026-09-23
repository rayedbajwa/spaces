import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setActiveFeature } from '../src/lib/active-feature'
import { getDatabaseUrl, getDb } from '../src/lib/db'
import { documentKind, getIntentDocument, getIntentDocuments, listIntents, listIntentSummaries, markIntentDeleted, summarizeIntent, syncProjectIntents } from '../src/lib/intent-store'
import { createProject } from '../src/lib/project-registry'

describe('summarizeIntent', () => {
  test('reads title, statuses, verification summary, acceptance and task progress from the documents', () => {
    const docs = new Map([
      ['spec.md', '# Feature Specification: Login with SSO\n'],
      ['tasks.md', '## Build\n- [x] T001 a\n- [x] T002 b\n## Delivery\n- [ ] T010 merge\n'],
      ['code-review.md', 'Code Review Status: APPROVED\n'],
      ['verification-report.md', 'Verification Status: PARTIAL\nAcceptance Criteria Met: 49/50\nCritical Issues Open: 0\n'],
      ['acceptance.md', '# Acceptance\n\n- Verification status: partial\n- Accepted by: Sam\n- Accepted at: 2026-09-22T10:00:00.000Z\n'],
    ])
    const s = summarizeIntent('001-login', docs)
    expect(s).toMatchObject({ title: 'Login with SSO', number: 1, status: 'accepted', codeReviewStatus: 'approved', verificationStatus: 'partial', acceptedBy: 'Sam', tasksDone: 2, tasksTotal: 3, implementationDone: 2, implementationTotal: 2 })
    expect(s.verificationSummary).toMatchObject({ met: 49, total: 50, criticalOpen: 0 })
  })

  test('document kinds', () => {
    expect(documentKind('verification-report.md')).toBe('verification')
    expect(documentKind('subagents/ws-1.md')).toBe('subagent-report')
    expect(documentKind('notes.md')).toBe('other')
  })
})

async function isDbReachable(): Promise<boolean> {
  try { await getDb()`SELECT 1 FROM intents LIMIT 0`; return true } catch { return false }
}
const dbAvailable = await isDbReachable()
const dbSuite = dbAvailable ? describe : describe.skip
if (!dbAvailable) test.skip(`intent store DB tests skipped: DATABASE_URL not reachable or schema not applied (${getDatabaseUrl()})`, () => {})

dbSuite('syncing intents into the database', () => {
  const cleanup: string[] = []
  const projects: string[] = []
  afterAll(async () => {
    if (projects.length) await getDb()`DELETE FROM projects WHERE project_id = ANY(${projects}::uuid[])`
    for (const dir of cleanup) await rm(dir, { recursive: true, force: true })
  })

  async function setup() {
    const root = await mkdtemp(path.join(tmpdir(), 'intents-'))
    cleanup.push(root)
    const write = async (rel: string, content: string) => { await mkdir(path.dirname(path.join(root, rel)), { recursive: true }); await writeFile(path.join(root, rel), content) }
    await write('specs/001-login/spec.md', '# Login\n')
    await write('specs/001-login/verification-report.md', 'Verification Status: PARTIAL\n')
    await write('specs/002-billing/spec.md', '# Billing\n')
    await write('specs/002-billing/plan.md', '# Plan\n')
    const suffix = randomUUID().slice(0, 8)
    const project = await createProject({ name: `Intents ${suffix}`, slug: `intents-${suffix}` })
    projects.push(project.projectId)
    return { root, write, projectId: project.projectId }
  }

  test('first sync imports every intent and its documents; the newest is active', async () => {
    const { root, projectId } = await setup()
    const result = await syncProjectIntents(projectId, root, 'import')
    expect(result.intents).toBe(2)
    const intents = await listIntents(projectId)
    expect(intents.map((i) => [i.dirId, i.status, i.active])).toEqual([['002-billing', 'planned', true], ['001-login', 'implementing', false]])
    expect((await getIntentDocuments(intents[1]!.intentId)).map((d) => [d.path, d.kind, d.updatedBy])).toEqual([['spec.md', 'spec', 'import'], ['verification-report.md', 'verification', 'import']])
  })

  test('re-sync stores only changed documents and records status changes with who made them', async () => {
    const { root, write, projectId } = await setup()
    await syncProjectIntents(projectId, root, 'import')
    const again = await syncProjectIntents(projectId, root, 'agent')
    expect(again.documentsChanged).toBe(0)
    expect(again.statusChanges).toBe(0)
    await write('specs/001-login/verification-report.md', 'Verification Status: PASS\n')
    const changed = await syncProjectIntents(projectId, root, 'agent')
    expect(changed.documentsChanged).toBe(1)
    const login = (await listIntents(projectId)).find((i) => i.dirId === '001-login')!
    expect([login.status, login.verificationStatus]).toEqual(['verified', 'pass'])
    const events = await getDb()<Array<{ field: string; from: string; to: string; by: string }>>`SELECT field, from_value AS "from", to_value AS "to", by FROM intent_status_events WHERE intent_id = ${login.intentId} AND by = 'agent' ORDER BY event_id`
    expect(events).toEqual([{ field: 'status', from: 'implementing', to: 'verified', by: 'agent' }, { field: 'verification_status', from: 'partial', to: 'pass', by: 'agent' }])
  })

  test('the active flag follows the chosen intent; a deleted intent is never brought back by a sync', async () => {
    const { root, projectId } = await setup()
    await syncProjectIntents(projectId, root, 'import')
    await setActiveFeature(root, '001-login')
    await syncProjectIntents(projectId, root, 'person:Sam')
    expect((await listIntents(projectId)).filter((i) => i.active).map((i) => i.dirId)).toEqual(['001-login'])
    await markIntentDeleted(projectId, '002-billing', 'person:Sam')
    await syncProjectIntents(projectId, root, 'agent') // the directory is still on disk
    expect((await listIntents(projectId)).map((i) => i.dirId)).toEqual(['001-login'])
  })

  test('deleting an intent no sync has recorded yet still keeps it deleted', async () => {
    const { root, write, projectId } = await setup()
    await syncProjectIntents(projectId, root, 'import')
    await write('specs/003-reports/spec.md', '# Reports\n')
    await markIntentDeleted(projectId, '003-reports', 'person:Sam', 'Reports')
    await syncProjectIntents(projectId, root, 'agent') // a copy is still on disk
    expect((await listIntents(projectId)).map((i) => i.dirId)).toEqual(['002-billing', '001-login'])
    const events = await getDb()<Array<{ field: string }>>`SELECT e.field FROM intent_status_events e JOIN intents i USING (intent_id) WHERE i.project_id = ${projectId} AND i.dir_id = '003-reports'`
    expect(events.map((e) => e.field)).toEqual(['deleted'])
  })

  test('a symlink named like a document is not copied into the record', async () => {
    const { root, write, projectId } = await setup()
    await write('outside/secret.md', 'do not copy\n')
    await symlink(path.join(root, 'outside/secret.md'), path.join(root, 'specs/001-login/notes.md'))
    await syncProjectIntents(projectId, root, 'import')
    const login = (await listIntents(projectId)).find((i) => i.dirId === '001-login')!
    const docs = await getIntentDocuments(login.intentId)
    expect(docs.map((d: { path: string }) => d.path)).not.toContain('notes.md')
  })

  test('reads come from the database: the list with its documents, and a document even after its file is gone', async () => {
    const { root, projectId } = await setup()
    // First read imports the project.
    const summaries = await listIntentSummaries(projectId, root)
    expect(summaries.map((f) => [f.id, f.current, f.status])).toEqual([['002-billing', true, 'planned'], ['001-login', false, 'implementing']])
    expect(summaries[1]!.documents).toEqual([{ label: 'Spec', path: 'specs/001-login/spec.md' }, { label: 'Verification report', path: 'specs/001-login/verification-report.md' }])
    await rm(path.join(root, 'specs', '001-login'), { recursive: true })
    expect((await getIntentDocument(projectId, '001-login', 'spec.md'))?.content).toBe('# Login\n')
    expect((await listIntentSummaries(projectId, root)).map((f) => f.id)).toEqual(['002-billing', '001-login'])
  })
})
