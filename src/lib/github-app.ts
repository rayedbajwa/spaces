/**
 * One-click GitHub App setup through the App Manifest flow.
 *
 * Spaces posts a manifest (name, callback URLs, permissions) to GitHub; the
 * user confirms on github.com; GitHub redirects back with a temporary code
 * that we convert into the app's credentials (client id/secret, app id, slug,
 * private key, webhook secret). Those are stored like any OAuth app, so the
 * existing connect flow works unchanged. The user then installs the app on
 * their account or organization, which grants repository access.
 */

import { randomBytes } from 'node:crypto'

export interface GitHubAppManifestResult {
  id: number
  slug: string
  name: string
  html_url: string
  client_id: string
  client_secret: string
  webhook_secret: string | null
  pem: string
  owner?: { login: string; type?: string }
}

const pendingStates = new Map<string, { at: number; orgId: string }>()
const STATE_TTL_MS = 15 * 60_000

function pruneStates(): void {
  const now = Date.now()
  for (const [state, entry] of pendingStates) if (now - entry.at > STATE_TTL_MS) pendingStates.delete(state)
}

/** The manifest GitHub creates the app from. Permissions match what runs need. */
export function buildGitHubAppManifest(origin: string, options: { name?: string } = {}): Record<string, unknown> {
  const host = new URL(origin).hostname.replace(/^www\./, '')
  return {
    name: (options.name ?? `Spaces (${host})`).slice(0, 34),
    url: origin,
    description: 'Spaces — agent-driven SDLC orchestrator. Reads and writes repositories, opens pull requests, reviews code and signs users in.',
    public: false,
    redirect_url: `${origin}/api/oauth-apps/github/manifest/callback`,
    callback_urls: [`${origin}/api/oauth/github/callback`],
    // After installing, GitHub sends the user to setup_url; Spaces then starts the
    // normal authorize flow (with CSRF state) to obtain the user token.
    setup_url: `${origin}/api/oauth-apps/github/installed`,
    setup_on_update: false,
    request_oauth_on_install: false,
    // No webhook: Spaces polls, and GitHub refuses hook URLs that are not on
    // the public internet (localhost), so the block is left out entirely.
    // Repository permissions only — GitHub's manifest validator rejects the
    // account/organization ones ("resource is not included in the list").
    // `workflows: write` matters: without it GitHub refuses any push that
    // touches .github/workflows, so an agent asked to wire its tests into CI
    // cannot deliver the change at all.
    default_permissions: {
      contents: 'write',
      pull_requests: 'write',
      issues: 'write',
      metadata: 'read',
      checks: 'read',
      actions: 'read',
      workflows: 'write',
      // Creating a repository from Spaces (a project's proposed repository) needs it.
      administration: 'write',
    },
    default_events: [],
  }
}

/** HTML page that auto-submits the manifest to GitHub (the flow requires a browser POST). */
export function githubAppManifestPage(origin: string, options: { organization?: string; name?: string; orgId: string }): { html: string; state: string } {
  pruneStates()
  const state = randomBytes(16).toString('hex')
  pendingStates.set(state, { at: Date.now(), orgId: options.orgId })
  const manifest = JSON.stringify(buildGitHubAppManifest(origin, { name: options.name }))
  const target = options.organization
    ? `https://github.com/organizations/${encodeURIComponent(options.organization)}/settings/apps/new?state=${state}`
    : `https://github.com/settings/apps/new?state=${state}`
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Creating the Spaces GitHub App…</title>
<style>body{font-family:system-ui;background:#0a0a0b;color:#e6e6e8;display:grid;place-items:center;height:100vh;margin:0}main{text-align:center;max-width:520px;padding:32px}h1{font-size:20px}p{color:#8a8a94}button{margin-top:12px;padding:10px 18px;border-radius:8px;border:0;background:#5e6ad2;color:#fff;font-size:14px}</style></head>
<body><main><h1>Taking you to GitHub…</h1><p>GitHub will show the app Spaces is about to create — name, callback URL and repository permissions. Confirm it there; you will be brought straight back.</p>
<form id="f" method="post" action="${target}"><input type="hidden" name="manifest" value='${manifest.replace(/'/g, '&#39;')}'><button type="submit">Continue to GitHub</button></form>
<script>document.getElementById('f').submit()</script></main></body></html>`
  return { html, state }
}

/** The organization that started this manifest flow, or undefined when the state is unknown or expired. */
export function consumeManifestState(state: string | null): { orgId: string } | undefined {
  pruneStates()
  const entry = state ? pendingStates.get(state) : undefined
  if (!entry) return undefined
  pendingStates.delete(state!)
  return { orgId: entry.orgId }
}

/** Exchange the temporary code GitHub returns for the new app's credentials. */
export async function convertGitHubAppManifest(code: string): Promise<GitHubAppManifestResult> {
  const response = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: 'POST',
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'spaces' },
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`GitHub did not return the app credentials (${response.status}): ${text.slice(0, 300)}`)
  }
  return (await response.json()) as GitHubAppManifestResult
}

export function githubAppInstallUrl(slug: string): string {
  return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`
}

/** Slack's "create app from manifest" page, prefilled for this deployment. */
export function slackManifestUrl(origin: string): string {
  const manifest = {
    display_information: { name: 'Spaces', description: 'Agent-driven SDLC orchestrator notifications', background_color: '#5e6ad2' },
    features: { bot_user: { display_name: 'Spaces', always_online: false } },
    oauth_config: {
      redirect_urls: [`${origin}/api/oauth/slack/callback`],
      scopes: { bot: ['channels:manage', 'channels:read', 'channels:join', 'chat:write', 'users:read', 'users:read.email'] },
    },
    settings: { org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false },
  }
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`
}
