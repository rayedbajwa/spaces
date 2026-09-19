import { describe, expect, test } from 'bun:test'
import { newRepoUrl, normalizeProposal, proposeRepository, sanitizeRepoName } from '../src/lib/repo-proposal'

describe('repository proposals', () => {
  test('names are GitHub-safe', () => {
    expect(sanitizeRepoName('Customer Portal (v2)!')).toBe('customer-portal-v2')
    expect(sanitizeRepoName('  ---Weird___name.. ')).toBe('weird___name')
    expect(sanitizeRepoName('***')).toBe('')
    expect(sanitizeRepoName('a'.repeat(140)).length).toBeLessThanOrEqual(100)
  })

  test('default proposal is named after the project and private', () => {
    const p = proposeRepository({ name: 'Billing Service', slug: 'billing-service-1a2b', code: 'FIN-3', description: 'Invoices and payments for the platform.' }, 'acme')
    expect(p).toMatchObject({ name: 'billing-service', owner: 'acme', visibility: 'private', description: 'Invoices and payments for the platform.' })
    expect(proposeRepository({ name: '!!!', slug: 'x-9f', code: null }).name).toBe('x-9f')
  })

  test('the manual link prefills GitHub\'s new-repository page', () => {
    const url = new URL(newRepoUrl({ name: 'billing-service', owner: 'acme', description: 'Invoices', visibility: 'private' }))
    expect(url.origin + url.pathname).toBe('https://github.com/new')
    expect(url.searchParams.get('owner')).toBe('acme')
    expect(url.searchParams.get('name')).toBe('billing-service')
    expect(url.searchParams.get('visibility')).toBe('private')
  })

  test('model output is validated and normalized', () => {
    expect(normalizeProposal({ name: 'My Repo', description: 'x', visibility: 'internal' }, 'me')).toMatchObject({ name: 'my-repo', owner: 'me', visibility: 'private' })
    expect(normalizeProposal({ name: 'ok', owner: 'bad owner!' }, 'me')?.owner).toBe('me')
    expect(normalizeProposal({ description: 'no name' })).toBeUndefined()
    expect(normalizeProposal('nope')).toBeUndefined()
  })
})
