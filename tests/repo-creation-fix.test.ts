import { afterEach, describe, expect, mock, test } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
let installationIds: number[] = [42]
const { encryptSecret } = await import('../src/lib/crypto-vault')
const pemEnc = encryptSecret(pem)
mock.module('../src/lib/oauth-apps', () => ({ getOAuthAppConfig: async () => ({ appId: 1, pemEnc, installationIds }) }))
const { describeRepoCreationFix } = await import('../src/lib/github-app-auth')

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch; installationIds = [42] })
function githubApp(body: Record<string, unknown>) {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch
}

describe('explaining a refused repository creation', () => {
  test('an app without Administration: write gets the exact permission and both settings pages', async () => {
    githubApp({ slug: 'spaces-prod', permissions: { contents: 'write', pull_requests: 'write' }, owner: { login: 'rayedbajwa', type: 'User' } })
    const fix = await describeRepoCreationFix('org-1')
    expect(fix?.message).toContain('Administration: write')
    expect(fix?.permissionsUrl).toBe('https://github.com/settings/apps/spaces-prod/permissions')
    expect(fix?.installationUrl).toBe('https://github.com/settings/installations/42')
  })

  test('an app owned by an organization links to the organization settings', async () => {
    githubApp({ slug: 'spaces-acme', permissions: {}, owner: { login: 'acme', type: 'Organization' } })
    const fix = await describeRepoCreationFix('org-2')
    expect(fix?.permissionsUrl).toBe('https://github.com/organizations/acme/settings/apps/spaces-acme/permissions')
    expect(fix?.installationUrl).toBe('https://github.com/organizations/acme/settings/installations/42')
  })

  test('with the permission already there, it points at the account or the pending acceptance instead', async () => {
    githubApp({ slug: 'spaces-prod', permissions: { administration: 'write' }, owner: { login: 'rayedbajwa', type: 'User' } })
    expect((await describeRepoCreationFix('org-3'))?.message).toContain('has Administration: write')
  })
})
