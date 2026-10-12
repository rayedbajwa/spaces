/**
 * Verified Slack identity links (012-inbound-outbound-slack, US3/R4).
 *
 * A Slack user is linked to a Spaces member by the profile email Slack returns.
 * A unique active member of the owning organization verifies immediately; zero
 * or ambiguous matches leave the link pending, so no Slack action is authorized
 * until a signed-in person confirms through a one-time link. A link grants no
 * role: authorization is re-derived per action. Tokens are hashed at rest.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { getDb } from './db'
import { log } from './logger'

const identityLog = log.child({ mod: 'slack-identity' })

export interface SlackIdentityLink {
  linkId: string
  orgId: string
  slackTeamId: string
  slackUserId: string
  email: string | null
  userId: string | null
  state: 'pending' | 'verified' | 'revoked'
  verifiedAt: string | null
}

export function hashIdentityToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function identityVerifyUrl(token: string): string {
  const base = process.env.PUBLIC_URL?.trim().replace(/\/+$/, '')
  return base ? `${base}/slack-link/${token}` : `/slack-link/${token}`
}

async function candidatesForEmail(orgId: string, email: string): Promise<Array<{ userId: string; email: string; name: string }>> {
  return await getDb()<Array<{ userId: string; email: string; name: string }>>`
    SELECT DISTINCT u.user_id AS "userId", u.email, u.name
      FROM users u
      JOIN team_members tm ON tm.user_id = u.user_id
      JOIN teams t ON t.team_id = tm.team_id
     WHERE t.org_id = ${orgId} AND lower(u.email) = lower(${email})
  `
}

/**
 * Resolve a Slack identity to a Spaces member. A unique active member is
 * verified; anything else is pending (no Slack action) until confirmed inline.
 * Returns a one-time link when a mapped member can confirm it.
 */
export async function linkSlackIdentity(input: {
  orgId: string
  slackTeamId: string
  slackUserId: string
  email?: string | null
}): Promise<{ link: SlackIdentityLink; token?: string; candidates: number }> {
  const sql = getDb()
  const email = input.email?.trim().toLowerCase() || null
  const candidates = email ? await candidatesForEmail(input.orgId, email) : []
  const unique = candidates.length === 1 ? candidates[0]! : undefined
  const state: SlackIdentityLink['state'] = unique ? 'verified' : 'pending'
  const token = unique ? undefined : randomBytes(24).toString('base64url')
  const [row] = await sql<SlackIdentityLink[]>`
    INSERT INTO slack_identity_links (link_id, org_id, slack_team_id, slack_user_id, email, user_id, state, token_hash, verified_at)
    VALUES (${randomUUID()}, ${input.orgId}, ${input.slackTeamId}, ${input.slackUserId}, ${email}, ${unique?.userId ?? null}, ${state},
            ${token ? hashIdentityToken(token) : null}, ${unique ? new Date() : null})
    ON CONFLICT (org_id, slack_team_id, slack_user_id) DO UPDATE SET
      email = EXCLUDED.email,
      user_id = COALESCE(EXCLUDED.user_id, slack_identity_links.user_id),
      state = CASE WHEN slack_identity_links.state = 'revoked' THEN 'revoked' ELSE EXCLUDED.state END,
      token_hash = COALESCE(EXCLUDED.token_hash, slack_identity_links.token_hash),
      verified_at = COALESCE(EXCLUDED.verified_at, slack_identity_links.verified_at),
      updated_at = now()
    RETURNING link_id AS "linkId", org_id AS "orgId", slack_team_id AS "slackTeamId", slack_user_id AS "slackUserId",
              email, user_id AS "userId", state, verified_at AS "verifiedAt"
  `
  identityLog.info('slack identity resolved', { orgId: input.orgId, slackUserId: input.slackUserId, state, candidates: candidates.length })
  return { link: row!, token, candidates: candidates.length }
}

/** Send the one-time verification prompt to a pending Slack user. Never throws. */
export async function sendIdentityVerification(input: { orgId: string; slackUserId: string; token: string }): Promise<boolean> {
  try {
    const { sendDirectMessage } = await import('./slack')
    const url = identityVerifyUrl(input.token)
    const result = await sendDirectMessage({
      orgId: input.orgId,
      email: input.slackUserId,
      text: `Confirm your Slack identity with Spaces: ${url}`,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `Confirm your Slack identity with Spaces so you can file and decide from Slack: <${url}|Open Spaces>` } }],
    })
    return result.ok
  } catch {
    return false
  }
}

/** The active member a verified Slack identity maps to, or undefined. */
export async function verifiedSlackUserId(orgId: string, slackTeamId: string, slackUserId: string): Promise<string | undefined> {
  const [row] = await getDb()<Array<{ userId: string | null }>>`
    SELECT user_id AS "userId" FROM slack_identity_links
     WHERE org_id = ${orgId} AND slack_team_id = ${slackTeamId} AND slack_user_id = ${slackUserId} AND state = 'verified'
  `
  return row?.userId ?? undefined
}

export interface IdentityTokenVerdict {
  verdict: 'valid' | 'invalid' | 'consumed' | 'wrong_recipient' | 'revoked'
  link?: SlackIdentityLink
}

export async function verifySlackIdentityToken(token: string): Promise<IdentityTokenVerdict> {
  if (!token) return { verdict: 'invalid' }
  const [row] = await getDb()<SlackIdentityLink[]>`
    SELECT link_id AS "linkId", org_id AS "orgId", slack_team_id AS "slackTeamId", slack_user_id AS "slackUserId",
           email, user_id AS "userId", state, verified_at AS "verifiedAt"
      FROM slack_identity_links WHERE token_hash = ${hashIdentityToken(token)}
  `
  if (!row) return { verdict: 'invalid' }
  if (row.state === 'revoked') return { verdict: 'revoked', link: row }
  if (row.state === 'verified') return { verdict: 'consumed', link: row }
  return { verdict: 'valid', link: row }
}

/** Confirm a pending link as the mapped member; wrong recipient or consumed token changes nothing. */
export async function confirmSlackIdentity(token: string, actorUserId: string): Promise<{ ok: boolean; reason?: string; link?: SlackIdentityLink }> {
  const verified = await verifySlackIdentityToken(token)
  if (verified.verdict !== 'valid' || !verified.link) return { ok: false, reason: verified.verdict }
  if (verified.link.userId && verified.link.userId !== actorUserId) return { ok: false, reason: 'wrong_recipient' }
  const sql = getDb()
  await sql`
    UPDATE slack_identity_links SET
      user_id = ${actorUserId}, state = 'verified', verified_at = now(), token_hash = NULL, updated_at = now()
     WHERE link_id = ${verified.link.linkId} AND state = 'pending'
  `
  return { ok: true, link: { ...verified.link, userId: actorUserId, state: 'verified' } }
}

export async function revokeSlackIdentity(orgId: string, linkId: string): Promise<boolean> {
  const rows = await getDb()`UPDATE slack_identity_links SET state = 'revoked', updated_at = now() WHERE org_id = ${orgId} AND link_id = ${linkId} RETURNING link_id`
  return rows.length > 0
}
