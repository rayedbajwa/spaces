import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { featureStatus, featureTitle, listFeatures, renameFeature } from '../src/lib/features'
import { readFile } from 'node:fs/promises'
import { featureDescriptionProblem } from '../src/lib/feature-description'

const roots: string[] = []
afterAll(async () => { for (const r of roots) await rm(r, { recursive: true, force: true }) })

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'features-'))
  roots.push(root)
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true })
    await writeFile(path.join(root, rel), content)
  }
  return root
}

describe('features', () => {
  test('titles come from the spec heading, else the directory name', () => {
    expect(featureTitle('# Feature Specification: Login with SSO\n', '001-login')).toBe('Login with SSO')
    expect(featureTitle(undefined, '002-billing-portal')).toBe('billing portal')
  })

  test('status is the furthest milestone the documents show', () => {
    expect(featureStatus({ spec: 's', hasImplementation: false }).status).toBe('specified')
    expect(featureStatus({ spec: 's', plan: 'p', tasks: 't', hasImplementation: false }).status).toBe('tasked')
    expect(featureStatus({ tasks: 't', hasImplementation: true }).status).toBe('implementing')
    expect(featureStatus({ verification: 'Verification Status: PASS', hasImplementation: true })).toEqual({ status: 'verified', verification: 'pass' })
    expect(featureStatus({ verification: 'Verification Status: PARTIAL', acceptance: 'accepted', hasImplementation: true }).status).toBe('accepted')
    expect(featureStatus({ delivery: 'Delivery Status: MERGED', hasImplementation: true })).toEqual({ status: 'delivered', delivery: 'merged' })
  })

  test('lists every feature newest first, the newest current, with its documents', async () => {
    const root = await project({
      'specs/001-login/spec.md': '# Feature Specification: Login\n',
      'specs/001-login/verification-report.md': 'Verification Status: PASS\n',
      'specs/001-login/code-review.md': 'Code Review Status: APPROVED\n',
      'specs/001-login/delivery-report.md': 'Delivery Status: MERGED\n',
      'specs/002-billing/spec.md': '# Billing\n',
      'specs/002-billing/plan.md': '# Plan\n',
    })
    const features = await listFeatures(root)
    expect(features.map((f) => [f.id, f.current, f.status])).toEqual([['002-billing', true, 'planned'], ['001-login', false, 'delivered']])
    expect(features[1]!.codeReview).toBe('approved')
    expect(features[1]!.documents.map((d) => d.label)).toEqual(['Spec', 'Code review', 'Verification report', 'Delivery report'])
    expect(features[1]!.documents[0]!.path).toBe('specs/001-login/spec.md')
    expect(await listFeatures(path.join(root, 'nowhere'))).toEqual([])
  })

  test('renaming rewrites the spec title, keeping the Spec Kit prefix; the directory stays', async () => {
    const root = await project({ 'specs/001-login/spec.md': '# Feature Specification: Login\n\nBody\n', 'specs/002-x/spec.md': '# Plain title\n' })
    await renameFeature(root, '001-login', '  Login with SSO  ')
    expect(await readFile(path.join(root, 'specs/001-login/spec.md'), 'utf8')).toBe('# Feature Specification: Login with SSO\n\nBody\n')
    await renameFeature(root, '002-x', 'Billing')
    expect((await listFeatures(root)).map((f) => f.title)).toEqual(['Billing', 'Login with SSO'])
    await expect(renameFeature(root, '001-login', '   ')).rejects.toThrow('title is required')
    await expect(renameFeature(root, '404-none', 'x')).rejects.toThrow('does not exist')
  })

  test('renaming refuses an id that points outside specs/', async () => {
    const root = await project({ 'specs/001-login/spec.md': '# Login\n', 'spec.md': '# Outside\n' })
    for (const id of ['..', '../', '../..', '.hidden', '001-login/../..']) {
      await expect(renameFeature(path.join(root), id, 'Pwned')).rejects.toThrow('does not exist')
    }
    expect(await readFile(path.join(root, 'spec.md'), 'utf8')).toBe('# Outside\n')
  })
})

describe('feature description', () => {
  test('specify needs a sentence, not a word', () => {
    expect(featureDescriptionProblem(undefined)).toContain('requires an intent description')
    expect(featureDescriptionProblem('  ')).toContain('requires an intent description')
    expect(featureDescriptionProblem('tst')).toContain('too short')
    expect(featureDescriptionProblem('Users can reset passwords')).toBeUndefined()
  })
})
