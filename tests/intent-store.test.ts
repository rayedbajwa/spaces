import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { activeFeatureId, setActiveFeature } from '../src/lib/active-feature'
import { retitleSpec } from '../src/lib/features'
import { getDatabaseUrl, getDb } from '../src/lib/db'
import { changeIntentDocuments, currentIntentDirId, documentKind, getIntentDocument, getIntentDocuments, listIntents, listIntentSummaries, markIntentDeleted, readIntentDocument, restoreIntentFiles, setActiveIntent, summarizeIntent, syncProjectIntents } from '../src/lib/intent-store'
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
    await setActiveIntent(projectId, root, '001-login', 'person:Sam')
    expect((await listIntents(projectId)).filter((i) => i.active).map((i) => i.dirId)).toEqual(['001-login'])
    // The working copy follows the database.
    expect(activeFeatureId(root)).toBe('001-login')
    // ...and a stray pointer file does not override the database's choice.
    await setActiveFeature(root, null)
    await syncProjectIntents(projectId, root, 'agent')
    expect((await listIntents(projectId)).filter((i) => i.active).map((i) => i.dirId)).toEqual(['001-login'])
    const [event] = await getDb()`SELECT e.from_value, e.to_value, e.by FROM intent_status_events e JOIN intents i USING (intent_id) WHERE i.project_id = ${projectId} AND e.field = 'active'`
    expect(event).toMatchObject({ from_value: '002-billing', to_value: '001-login', by: 'person:Sam' })
    await markIntentDeleted(projectId, '002-billing', 'person:Sam')
    await syncProjectIntents(projectId, root, 'agent') // the directory is still on disk
    expect((await listIntents(projectId)).map((i) => i.dirId)).toEqual(['001-login'])
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

  test('a new intent the agent starts becomes active', async () => {
    const { root, write, projectId } = await setup()
    await syncProjectIntents(projectId, root, 'import')
    await setActiveIntent(projectId, root, '001-login', 'person:Sam')
    await setActiveFeature(root, null) // what starting a new intent does
    await write('specs/003-search/spec.md', '# Search\n')
    await syncProjectIntents(projectId, root, 'agent')
    expect((await listIntents(projectId)).filter((i) => i.active).map((i) => i.dirId)).toEqual(['003-search'])
  })

  test('person changes write the database first, then the working file', async () => {
    const { root, projectId } = await setup()
    await syncProjectIntents(projectId, root, 'import')
    const accepted = await changeIntentDocuments({
      projectId, projectRoot: root, dirId: '001-login', by: 'person:Sam',
      changes: new Map([['acceptance.md', '# Acceptance\n\n- Verification status: partial\n- Accepted by: Sam\n- Accepted at: 2026-09-22T10:00:00.000Z\n']]),
    })
    expect(accepted).toMatchObject({ status: 'accepted', acceptedBy: 'Sam' })
    expect(await readFile(path.join(root, 'specs/001-login/acceptance.md'), 'utf8')).toContain('Accepted by: Sam')
    const [event] = await getDb()`SELECT e.to_value, e.by FROM intent_status_events e JOIN intents i USING (intent_id) WHERE i.project_id = ${projectId} AND e.field = 'status' AND i.dir_id = '001-login' AND e.by <> 'import' ORDER BY e.at LIMIT 1`
    expect(event).toMatchObject({ to_value: 'accepted', by: 'person:Sam' })

    const withdrawn = await changeIntentDocuments({ projectId, projectRoot: root, dirId: '001-login', by: 'person:Sam', changes: new Map([['acceptance.md', null]]) })
    expect(withdrawn).toMatchObject({ status: 'implementing', acceptedBy: null })
    expect(await getIntentDocument(projectId, '001-login', 'acceptance.md')).toBeUndefined()

    // Rename from the stored spec even when the working file is gone; the file comes back.
    await rm(path.join(root, 'specs/002-billing/spec.md'))
    const spec = await readIntentDocument(projectId, root, '002-billing', 'spec.md')
    const renamed = await changeIntentDocuments({ projectId, projectRoot: root, dirId: '002-billing', by: 'person:Sam', changes: new Map([['spec.md', retitleSpec(spec!, 'Invoices')]]) })
    expect(renamed.title).toBe('Invoices')
    expect(await readFile(path.join(root, 'specs/002-billing/spec.md'), 'utf8')).toBe('# Invoices\n')
    await expect(changeIntentDocuments({ projectId, projectRoot: root, dirId: '002-billing', by: 'x', changes: new Map([['../escape.md', 'no']]) })).rejects.toThrow('Invalid document path')
  })

  test('the current intent: the active one, else the newest', async () => {
    const { root, projectId } = await setup()
    expect(await currentIntentDirId(projectId, root)).toBe('002-billing')
    await setActiveIntent(projectId, root, '001-login', 'person:Sam')
    expect(await currentIntentDirId(projectId, root)).toBe('001-login')
  })

  test('before a stage, the current intent\'s missing files come back from the database; existing files are kept', async () => {
    const { root, write, projectId } = await setup()
    await syncProjectIntents(projectId, root, 'import')
    await setActiveIntent(projectId, root, '001-login', 'person:Sam')
    // A fresh working copy: the current intent's directory is gone, the pointer too.
    await rm(path.join(root, 'specs'), { recursive: true })
    await write('specs/001-login/spec.md', '# Login, edited since\n')
    expect(await restoreIntentFiles(projectId, root)).toBe(1)
    expect(await readFile(path.join(root, 'specs/001-login/verification-report.md'), 'utf8')).toBe('Verification Status: PARTIAL\n')
    expect(await readFile(path.join(root, 'specs/001-login/spec.md'), 'utf8')).toBe('# Login, edited since\n')
    // Another intent's directory belongs to its own branch: not restored.
    expect(await readFile(path.join(root, 'specs/002-billing/spec.md'), 'utf8').catch(() => null)).toBeNull()
    expect(activeFeatureId(root)).toBe('001-login')
    expect(await restoreIntentFiles(projectId, root)).toBe(0)
  })
})
