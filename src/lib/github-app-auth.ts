/**
 * Acting as the GitHub App itself (installation token) instead of as the user.
 *
 * With the app created through the manifest flow we hold its private key and
 * installation id. Branches pushed and pull requests opened with an
 * installation token are authored by `<app>[bot]`, so a human can approve
 * them and branch protection ("one approval, checks green") applies to the
 * agent while the repository owner keeps the final say. Falls back to the
 * connected user's token when no app key or installation is stored.
 */

import { createSign } from 'node:crypto'
import { decryptSecret } from './crypto-vault'
import { getGitHubToken } from './github'
import { log } from './logger'
import { getOAuthAppConfig } from './oauth-apps'

const authLog = log.child({ mod: 'github-app-auth' })

interface InstallationToken { token: string; expiresAt: number; slug: string; installationId: number }

const cached = new Map<string, InstallationToken>()
const inflight = new Map<string, Promise<InstallationToken | undefined>>()

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}

/** Short-lived JWT that authenticates as the app (RS256, 9 minutes). */
export function signAppJwt(appId: number, privateKeyPem: string, now = Math.floor(Date.now() / 1000)): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: String(appId) }))
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${payload}`)
  return `${header}.${payload}.${base64url(signer.sign(privateKeyPem))}`
}

/** Installation token for the stored GitHub App, or undefined when the app is not set up that way. */
export async function getInstallationToken(orgId: string): Promise<InstallationToken | undefined> {
  const have = cached.get(orgId)
  if (have && have.expiresAt - Date.now() > 5 * 60_000) return have
  const pending = inflight.get(orgId)
  if (pending) return pending
  const task = (async () => {
    const config = await getOAuthAppConfig(orgId, 'github')
    const installationId = config.installationIds?.[0]
    if (!config.appId || !config.pemEnc || !installationId) return undefined
    let pem: string
    try { pem = decryptSecret(config.pemEnc) } catch { authLog.warn('GitHub App private key cannot be decrypted; acting as the user instead'); return undefined }
    const response = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${signAppJwt(config.appId, pem)}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'spaces' },
    })
    if (!response.ok) {
      authLog.warn('installation token request failed; acting as the user instead', { status: response.status, body: (await response.text().catch(() => '')).slice(0, 160) })
      return undefined
    }
    const data = (await response.json()) as { token: string; expires_at: string }
    const issued: InstallationToken = { token: data.token, expiresAt: Date.parse(data.expires_at), slug: config.appSlug ?? 'github-app', installationId }
    cached.set(orgId, issued)
    authLog.info('GitHub App installation token issued', { orgId, app: issued.slug, installationId })
    return issued
  })().finally(() => { inflight.delete(orgId) })
  inflight.set(orgId, task)
  return task
}

/**
 * Token for writes that should carry the app's identity (pushes, pull
 * requests, comments, merges): the installation token when available,
 * otherwise the user token.
 */
export async function getGitHubActorToken(orgId: string): Promise<string> {
  const installation = await getInstallationToken(orgId).catch(() => undefined)
  return installation?.token ?? (await getGitHubToken(orgId))
}

/** Who pushes and opens pull requests: the app bot or the connected user. */
export async function describeGitHubActor(orgId: string): Promise<{ kind: 'app' | 'user'; name: string }> {
  const installation = await getInstallationToken(orgId).catch(() => undefined)
  if (installation) return { kind: 'app', name: `${installation.slug}[bot]` }
  const { getGitHubLogin } = await import('./github')
  return { kind: 'user', name: await getGitHubLogin(orgId).catch(() => 'connected user') }
}

/**
 * Environment for agent shells so `git push` and `gh` act as the same actor:
 * git reads the auth header from GIT_CONFIG_* (nothing written to disk) and
 * gh reads GH_TOKEN.
 */
export async function gitHubActorEnv(orgId: string): Promise<Record<string, string>> {
  const token = await getGitHubActorToken(orgId)
  const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
  return {
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: header,
    GIT_TERMINAL_PROMPT: '0',
  }
}
