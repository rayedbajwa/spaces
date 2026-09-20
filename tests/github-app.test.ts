import { describe, expect, test } from 'bun:test'
import { buildGitHubAppManifest, consumeManifestState, githubAppInstallUrl, githubAppManifestPage, slackManifestUrl } from '../src/lib/github-app'
import { explainPushFailure } from '../src/lib/pull-requests'

describe('GitHub App manifest', () => {
  test('points every URL at the deployment origin and asks for what runs need', () => {
    const m = buildGitHubAppManifest('https://spaces.example.com') as Record<string, any>
    expect(m.name).toBe('Spaces (spaces.example.com)')
    expect(m.redirect_url).toBe('https://spaces.example.com/api/oauth-apps/github/manifest/callback')
    expect(m.callback_urls).toEqual(['https://spaces.example.com/api/oauth/github/callback'])
    expect(m.setup_url).toBe('https://spaces.example.com/api/oauth-apps/github/installed')
    // setup_url and request_oauth_on_install are mutually exclusive on GitHub; we use setup_url.
    expect(m.request_oauth_on_install).toBe(false)
    expect(m.default_permissions).toEqual({ contents: 'write', pull_requests: 'write', issues: 'write', metadata: 'read', checks: 'read', actions: 'read', workflows: 'write' })
    expect(m.hook_attributes).toBeUndefined()
    expect(m.public).toBe(false)
    expect(m.name.length).toBeLessThanOrEqual(34)
  })

  test('the page posts the manifest to GitHub with a one-time state', () => {
    const { html, state } = githubAppManifestPage('http://localhost:3000', { orgId: 'org-test' })
    expect(html).toContain(`action="https://github.com/settings/apps/new?state=${state}"`)
    expect(html).toContain('name="manifest"')
    expect(consumeManifestState(state)?.orgId).toBe('org-test')
    expect(consumeManifestState(state)).toBeUndefined()
    expect(consumeManifestState('nope')).toBeUndefined()
  })

  test('organization apps are created under the organization', () => {
    const { html } = githubAppManifestPage('http://localhost:3000', { organization: 'acme-inc', orgId: 'org-test' })
    expect(html).toContain('https://github.com/organizations/acme-inc/settings/apps/new?state=')
  })

  test('install url and Slack manifest link', () => {
    expect(githubAppInstallUrl('spaces-local')).toBe('https://github.com/apps/spaces-local/installations/new')
    const url = new URL(slackManifestUrl('http://localhost:3000'))
    expect(url.origin + url.pathname).toBe('https://api.slack.com/apps')
    const manifest = JSON.parse(url.searchParams.get('manifest_json')!)
    expect(manifest.oauth_config.redirect_urls).toEqual(['http://localhost:3000/api/oauth/slack/callback'])
    expect(manifest.oauth_config.scopes.bot).toContain('chat:write')
  })
})

describe('push refusals', () => {
  test('explains the missing Workflows permission', () => {
    const git = "remote: error: GH006: Protected branch update failed.\nremote: refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission"
    const explained = explainPushFailure(git)
    expect(explained).toContain('Workflows permission')
    expect(explained).toContain('Read and write')
    expect(explained).not.toBe(git)
  })

  test('leaves any other failure exactly as it was', () => {
    const other = 'fatal: could not read Username for https://github.com: No such device or address'
    expect(explainPushFailure(other)).toBe(other)
  })
})
