import { getAppIntegration } from './app-integrations'
import { getDb } from './db'
import { getIntegrationAccessToken } from './integration-token'
import { log } from './logger'
import { orgIdForProject } from './orgs'
import { SLACK_BOT_SCOPES } from './slack-scopes'

/**
 * Slack: a channel per project, and the run's news posted there.
 *
 * When the organization has Slack connected, every project gets its own public
 * channel (`#spaces-<code>`), created on demand — when the project is created,
 * when Slack is connected (for every existing project), or at the first post —
 * with the project's team members invited by email. Runs post there: started,
 * each stage finished with its summary, approval needed (with the summary to
 * decide on and a link), a question from the agent, finished, failed.
 *
 * Nothing here may fail a run or a request: every Slack error is logged, and a
 * missing permission is reported once per organization with what to do.
 *
 * Bot scopes: channels:manage (create, invite), channels:read, channels:join,
 * chat:write, users:read, users:read.email, and im:write (deliver approval DMs).
 */

const slackLog = log.child({ mod: 'slack' })

export { SLACK_BOT_SCOPES }

export class SlackApiError extends Error {
  constructor(readonly method: string, readonly code: string, readonly needed?: string) {
    super(`Slack ${method}: ${code}${needed ? ` (needs ${needed})` : ''}`)
  }
}

type SlackResponse = { ok: boolean; error?: string; needed?: string } & Record<string, unknown>

/**
 * Read methods ignore a JSON body: users.lookupByEmail answers invalid_arguments
 * and conversations.list drops its filters. They take form-encoded arguments.
 */
const FORM_METHODS = new Set(['users.lookupByEmail', 'conversations.list'])

/** Slack Web API calls must never hang a request; give every call a hard ceiling. */
const SLACK_API_TIMEOUT_MS = 5_000

async function slackApi<T extends SlackResponse>(token: string, method: string, body: Record<string, unknown>): Promise<T> {
  const form = FORM_METHODS.has(method)
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json; charset=utf-8',
    },
    body: form ? new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)])).toString() : JSON.stringify(body),
    signal: AbortSignal.timeout(SLACK_API_TIMEOUT_MS),
  })
  const data = (await response.json().catch(() => ({ ok: false, error: `http_${response.status}` }))) as T
  if (!data.ok) throw new SlackApiError(method, data.error ?? 'unknown_error', data.needed)
  return data
}

/** A channel name Slack accepts: lowercase letters, digits, hyphens and underscores, at most 80 characters. */
export function channelNameFor(project: { code?: string | null; slug: string }): string {
  const base = (project.code || project.slug).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return `spaces-${base}`.slice(0, 80)
}

interface ProjectForSlack {
  projectId: string
  slug: string
  name: string
  code: string | null
  description: string | null
  teamId: string | null
}

async function loadProject(projectId: string): Promise<ProjectForSlack | undefined> {
  const [row] = await getDb()<ProjectForSlack[]>`
    SELECT project_id AS "projectId", slug, name, code, description, team_id AS "teamId" FROM projects WHERE project_id = ${projectId}
  `
  return row
}

/** The organization's Slack bot token, or undefined when Slack is not connected. */
async function slackToken(orgId: string): Promise<string | undefined> {
  const integration = await getAppIntegration(orgId, 'slack').catch(() => undefined)
  if (integration?.status !== 'connected') return undefined
  return await getIntegrationAccessToken(orgId, 'slack').catch(() => undefined)
}

/**
 * The org's bot token, exposed for signature-authenticated inbound handlers that
 * must call Slack itself (opening a feedback modal). Returns undefined when
 * Slack is not connected.
 */
export async function slackBotToken(orgId: string): Promise<string | undefined> {
  return await slackToken(orgId)
}

const warnedMissingScope = new Set<string>()

function reportSlackError(orgId: string, what: string, error: unknown): void {
  if (error instanceof SlackApiError && error.code === 'missing_scope') {
    if (warnedMissingScope.has(orgId)) return
    warnedMissingScope.add(orgId)
    slackLog.warn(`Slack cannot ${what}: the app lacks ${error.needed ?? 'a scope'}. Update the Slack app's bot scopes (${SLACK_BOT_SCOPES.join(', ')}) and reconnect Slack under Organization → Integrations.`, { orgId })
    return
  }
  slackLog.warn(`Slack: ${what} failed`, { orgId, error: error instanceof Error ? error.message : String(error) })
}

async function storedChannel(projectId: string): Promise<{ channelId: string; channelName: string; teamId: string | null } | undefined> {
  const [row] = await getDb()<Array<{ channelId: string; channelName: string; teamId: string | null }>>`
    SELECT channel_id AS "channelId", channel_name AS "channelName", team_id AS "teamId" FROM project_slack_channels WHERE project_id = ${projectId}
  `
  return row
}

const workspaceByToken = new Map<string, { teamId: string; at: number }>()

/** The Slack workspace the token belongs to (auth.test), cached for a few minutes. */
async function currentWorkspace(token: string): Promise<string> {
  const cached = workspaceByToken.get(token)
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.teamId
  const data = await slackApi<SlackResponse & { team_id: string }>(token, 'auth.test', {})
  workspaceByToken.set(token, { teamId: data.team_id, at: Date.now() })
  return data.team_id
}

/** The Slack workspace connected to an org, or undefined when Slack is not connected. */
export async function slackWorkspaceTeamId(orgId: string): Promise<string | undefined> {
  const token = await slackToken(orgId)
  if (!token) return undefined
  try {
    return await currentWorkspace(token)
  } catch {
    return undefined
  }
}

/** Find a public channel by name (the project's channel may already exist from an earlier connection). */
async function findChannel(token: string, name: string): Promise<{ id: string; isMember: boolean } | undefined> {
  let cursor: string | undefined
  for (let page = 0; page < 20; page += 1) {
    const data = await slackApi<SlackResponse & { channels: Array<{ id: string; name: string; is_member: boolean }>; response_metadata?: { next_cursor?: string } }>(
      token, 'conversations.list', { types: 'public_channel', exclude_archived: true, limit: 1000, ...(cursor ? { cursor } : {}) })
    const hit = data.channels.find((c) => c.name === name)
    if (hit) return { id: hit.id, isMember: hit.is_member }
    cursor = data.response_metadata?.next_cursor || undefined
    if (!cursor) break
  }
  return undefined
}

/** Invite the project's team members who have a Slack account with the same email. */
async function inviteTeam(token: string, channelId: string, project: ProjectForSlack): Promise<number> {
  if (!project.teamId) return 0
  const members = await getDb()<Array<{ email: string }>>`
    SELECT u.email FROM team_members m JOIN users u ON u.user_id = m.user_id WHERE m.team_id = ${project.teamId}
  `
  const slackIds: string[] = []
  for (const { email } of members) {
    try {
      const found = await slackApi<SlackResponse & { user: { id: string } }>(token, 'users.lookupByEmail', { email })
      slackIds.push(found.user.id)
    } catch (error) {
      // Not in this Slack workspace: nothing to invite. Anything else (a missing
      // scope, a rate limit, the network) is a real failure and is reported.
      if (!(error instanceof SlackApiError && error.code === 'users_not_found')) throw error
    }
  }
  if (slackIds.length === 0) return 0
  try {
    await slackApi(token, 'conversations.invite', { channel: channelId, users: slackIds.join(','), force: true })
  } catch (error) {
    if (!(error instanceof SlackApiError && error.code === 'already_in_channel')) throw error
  }
  return slackIds.length
}

/**
 * The project's channel, created (or found, and joined) when it has none yet.
 * Undefined when Slack is not connected or the channel cannot be made.
 */
export async function ensureProjectChannel(projectId: string): Promise<{ channelId: string; channelName: string } | undefined> {
  const project = await loadProject(projectId)
  if (!project) return undefined
  const orgId = await orgIdForProject(projectId)
  const token = await slackToken(orgId)
  if (!token) return undefined

  const name = channelNameFor(project)
  try {
    // A channel belongs to one workspace: after reconnecting Slack to another
    // workspace, the stored channel is gone for this token and is made again.
    const workspace = await currentWorkspace(token)
    const existing = await storedChannel(projectId)
    if (existing && existing.teamId === workspace) return existing
    if (existing) await getDb()`DELETE FROM project_slack_channels WHERE project_id = ${projectId}`

    let channelId: string
    try {
      const created = await slackApi<SlackResponse & { channel: { id: string } }>(token, 'conversations.create', { name, is_private: false })
      channelId = created.channel.id
    } catch (error) {
      if (!(error instanceof SlackApiError && error.code === 'name_taken')) throw error
      // Already there (an earlier connection, or made by hand): use it.
      const found = await findChannel(token, name)
      if (!found) throw error
      channelId = found.id
      if (!found.isMember) await slackApi(token, 'conversations.join', { channel: channelId })
    }
    await slackApi(token, 'conversations.setPurpose', {
      channel: channelId,
      purpose: `Spaces updates for ${project.name}${project.code ? ` (${project.code})` : ''}: runs, stage summaries and approvals.`.slice(0, 250),
    }).catch(() => undefined)
    await getDb()`
      INSERT INTO project_slack_channels (project_id, org_id, channel_id, channel_name, team_id)
      VALUES (${projectId}, ${orgId}, ${channelId}, ${name}, ${workspace})
      ON CONFLICT (project_id) DO NOTHING
    `
    const invited = await inviteTeam(token, channelId, project).catch((error) => { reportSlackError(orgId, 'invite the team', error); return 0 })
    slackLog.info('project channel ready', { project: project.slug, channel: name, invited })
    return (await storedChannel(projectId)) ?? { channelId, channelName: name }
  } catch (error) {
    reportSlackError(orgId, `create #${name}`, error)
    return undefined
  }
}

/** Create channels for every project of an organization (right after Slack is connected). */
export async function ensureChannelsForOrg(orgId: string): Promise<number> {
  const projects = await getDb()<Array<{ projectId: string }>>`
    SELECT p.project_id AS "projectId" FROM projects p JOIN teams t ON t.team_id = p.team_id
     WHERE t.org_id = ${orgId} AND p.archived_at IS NULL
  `
  let ready = 0
  for (const { projectId } of projects) if (await ensureProjectChannel(projectId)) ready += 1
  return ready
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type ProjectNotice =
  | { kind: 'run_started'; pipeline: string; stages: string[] }
  | { kind: 'stage_finished'; stage: string; summary?: string }
  | { kind: 'approval_needed'; stage: string; summary?: string }
  | { kind: 'question'; stage: string; question?: string }
  | { kind: 'run_finished' }
  | { kind: 'run_failed'; stage?: string; message: string }

/** Slack mrkdwn needs &, < and > escaped; long text is cut to what a block can hold. */
export function slackText(value: string, max = 2800): string {
  const escaped = value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').trim()
  return escaped.length > max ? `${escaped.slice(0, max - 1)}…` : escaped
}

function projectLink(project: { code: string | null; slug: string }): string | undefined {
  const base = process.env.PUBLIC_URL?.trim().replace(/\/+$/, '')
  return base ? `${base}/spaces/${encodeURIComponent(project.code || project.slug)}` : undefined
}

/** The Block Kit message for a notice (exported for tests). */
export function renderNotice(project: { name: string; code: string | null; slug: string }, notice: ProjectNotice): { text: string; blocks: unknown[] } {
  const label = `${project.code ? `${project.code} · ` : ''}${project.name}`
  // The top-level text is also Slack mrkdwn (it drives the notification): escape
  // what projects, pipelines and stages are called, as in the blocks.
  const safeLabel = slackText(label, 300)
  const esc = (value: string) => slackText(value, 200)
  const link = projectLink(project)
  const open = link ? { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open in Spaces' }, url: link, ...(notice.kind === 'approval_needed' || notice.kind === 'question' ? { style: 'primary' } : {}) }] } : undefined
  const section = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text } })
  const quote = (text?: string) => (text?.trim() ? section(`>${slackText(text, 2600).replace(/\n/g, '\n>')}`) : undefined)
  let text: string
  let body: Array<unknown | undefined>
  switch (notice.kind) {
    case 'run_started':
      text = `▶️ ${safeLabel}: run started (${esc(notice.pipeline)})`
      body = [section(`▶️ *Run started* — ${slackText(notice.stages.join(' → '), 500)}`)]
      break
    case 'stage_finished':
      text = `✅ ${safeLabel}: ${esc(notice.stage)} finished`
      body = [section(`✅ *${slackText(notice.stage)}* finished`), quote(notice.summary)]
      break
    case 'approval_needed':
      text = `🟡 ${safeLabel}: approval needed on ${esc(notice.stage)}`
      body = [section(`<!here> 🟡 *Approval needed* on *${slackText(notice.stage)}*. Review the summary, then approve or request changes in Spaces.`), quote(notice.summary), open]
      break
    case 'question':
      text = `❓ ${safeLabel}: the agent has a question on ${esc(notice.stage)}`
      body = [section(`<!here> ❓ *The agent has a question* on *${slackText(notice.stage)}*. Answer it in Spaces to continue.`), quote(notice.question), open]
      break
    case 'run_finished':
      text = `🏁 ${safeLabel}: run finished`
      body = [section('🏁 *Run finished.*'), open]
      break
    case 'run_failed':
      text = `🔴 ${safeLabel}: run failed${notice.stage ? ` at ${esc(notice.stage)}` : ''}`
      body = [section(`🔴 *Run failed*${notice.stage ? ` at *${slackText(notice.stage)}*` : ''}`), quote(notice.message), open]
      break
  }
  return { text, blocks: [{ type: 'context', elements: [{ type: 'mrkdwn', text: safeLabel }] }, ...body.filter(Boolean)] }
}

/** Post a notice to the project's channel. Best effort: never throws. */
export async function notifyProject(projectId: string | null | undefined, notice: ProjectNotice): Promise<void> {
  if (!projectId) return
  let orgId = ''
  try {
    orgId = await orgIdForProject(projectId)
    const token = await slackToken(orgId)
    if (!token) return
    const channel = await ensureProjectChannel(projectId)
    const project = await loadProject(projectId)
    if (!channel || !project) return
    // AI data guardrails: summaries written by agents are posted without secrets or personal data.
    const { loadGuardPolicy } = await import('./guardrails-policy')
    const { maskOutputDeep } = await import('./guardrails')
    const message = maskOutputDeep(renderNotice(project, notice), await loadGuardPolicy(orgId))
    await slackApi(token, 'chat.postMessage', { channel: channel.channelId, text: message.text, blocks: message.blocks, unfurl_links: false })
  } catch (error) {
    if (error instanceof SlackApiError && ['channel_not_found', 'is_archived'].includes(error.code)) {
      // The channel was deleted or archived in Slack: forget it so the next post makes a new one.
      await getDb()`DELETE FROM project_slack_channels WHERE project_id = ${projectId}`.catch(() => undefined)
    }
    reportSlackError(orgId, `post ${notice.kind.replace('_', ' ')}`, error)
  }
}

let waitlistChannel: { orgId: string; channelId: string } | undefined

/**
 * A new waitlist signup, posted to #spaces-waitlist in the default
 * organization's Slack (created or joined on first use). The email is left out:
 * Slack is outside the guardrails, and the waitlist page has it.
 */
export async function notifyWaitlistSignup(entry: { name: string | null; company: string | null; teamSize: string | null }): Promise<void> {
  let orgId = ''
  try {
    const { getDefaultOrgId } = await import('./orgs')
    orgId = await getDefaultOrgId()
    const token = await slackToken(orgId)
    if (!token) return
    if (waitlistChannel?.orgId !== orgId) {
      const name = 'spaces-waitlist'
      let channelId: string
      try {
        channelId = (await slackApi<SlackResponse & { channel: { id: string } }>(token, 'conversations.create', { name, is_private: false })).channel.id
      } catch (error) {
        if (!(error instanceof SlackApiError && error.code === 'name_taken')) throw error
        const found = await findChannel(token, name)
        if (!found) throw error
        channelId = found.id
        if (!found.isMember) await slackApi(token, 'conversations.join', { channel: channelId })
      }
      waitlistChannel = { orgId, channelId }
    }
    const who = [entry.name, entry.company].filter(Boolean).map((v) => slackText(v!, 120)).join(' · ') || 'Someone'
    const size = entry.teamSize ? ` (team of ${slackText(entry.teamSize, 20)})` : ''
    const base = process.env.PUBLIC_URL?.trim().replace(/\/+$/, '')
    const blocks: unknown[] = [{ type: 'section', text: { type: 'mrkdwn', text: `📝 *New waitlist signup:* ${who}${size}` } }]
    if (base) blocks.push({ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open the waitlist' }, url: `${base}/organization?section=waitlist` }] })
    await slackApi(token, 'chat.postMessage', { channel: waitlistChannel.channelId, text: `New waitlist signup: ${who}${size}`, blocks, unfurl_links: false })
  } catch (error) {
    if (error instanceof SlackApiError && ['channel_not_found', 'is_archived'].includes(error.code)) waitlistChannel = undefined
    reportSlackError(orgId, 'post waitlist signup', error)
  }
}

// ---------------------------------------------------------------------------
// Direct approval messages (011-owner-approval-link)
// ---------------------------------------------------------------------------

/**
 * Interactive approval prompt for a gate: the summary plus the three decisions
 * the in-app gate accepts. Button values carry only the gate id; the handler
 * resolves the org from the signature/team mapping and re-checks authority.
 */
export function renderGateActions(input: {
  gateId: string
  project: { name: string; code: string | null; slug: string }
  stage: string
  kind: 'review' | 'clarification'
  summary?: string | null
  /** The recipient's single-use in-app link, when one was minted. */
  link?: string | null
}): { text: string; blocks: unknown[] } {
  const label = `${input.project.code ? `${input.project.code} · ` : ''}${input.project.name}`
  const safeLabel = slackText(label, 300)
  const stage = slackText(input.stage, 200)
  const headline = input.kind === 'review' ? 'Approval needed' : 'Clarification needed'
  const text = `${headline}: ${safeLabel} · ${stage}`
  const blocks: unknown[] = [
    { type: 'context', elements: [{ type: 'mrkdwn', text: safeLabel }] },
    { type: 'section', text: { type: 'mrkdwn', text: `🟡 *${headline}* on *${stage}*.` } },
  ]
  const summary = input.summary?.trim()
  if (summary) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `>${slackText(summary, 2600).replace(/\n/g, '\n>')}` } })
  blocks.push({
    type: 'actions',
    elements: [
      { type: 'button', action_id: 'approve', text: { type: 'plain_text', text: 'Approve' }, style: 'primary', value: input.gateId },
      { type: 'button', action_id: 'approve_with_notes', text: { type: 'plain_text', text: 'Approve with notes' }, value: input.gateId },
      { type: 'button', action_id: 'request_changes', text: { type: 'plain_text', text: 'Request changes' }, style: 'danger', value: input.gateId },
      ...(input.link ? [{ type: 'button', text: { type: 'plain_text', text: 'Review in Spaces' }, url: input.link }] : []),
    ],
  })
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: 'Your Slack identity must be verified and you must be an accountable recipient of this gate.' }] })
  return { text, blocks }
}

/**
 * Clarification question prompt for a Slack thread: the agent's question, no
 * decision buttons (a clarification is answered in the app or by reply), and a
 * link to the in-app gate. Kept as a thread reply so it does not ping the room.
 */
export function renderQuestionThread(input: {
  project: { name: string; code: string | null; slug: string }
  stage: string
  question?: string | null
  link?: string | null
}): { text: string; blocks: unknown[] } {
  const label = `${input.project.code ? `${input.project.code} · ` : ''}${input.project.name}`
  const safeLabel = slackText(label, 300)
  const stage = slackText(input.stage, 200)
  const text = `Question on ${safeLabel} · ${stage}`
  const blocks: unknown[] = [
    { type: 'context', elements: [{ type: 'mrkdwn', text: safeLabel }] },
    { type: 'section', text: { type: 'mrkdwn', text: `❓ *Clarification needed* on *${stage}*.` } },
  ]
  const question = input.question?.trim()
  if (question) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `>${slackText(question, 2600).replace(/\n/g, '\n>')}` } })
  if (input.link) blocks.push({ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Answer in Spaces' }, url: input.link }] })
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: 'Reply in this thread to answer verbatim; the in-app gate stays available.' }] })
  return { text, blocks }
}

/** Mark an already-posted Slack prompt as decided by a later/wider action. */
export async function updateSlackMessage(input: { orgId: string; channel: string; ts: string; text: string; blocks?: unknown[] }): Promise<boolean> {
  const token = await slackToken(input.orgId)
  if (!token) return false
  try {
    await slackApi(token, 'chat.update', { channel: input.channel, ts: input.ts, text: input.text, ...(input.blocks ? { blocks: input.blocks } : {}) })
    return true
  } catch (error) {
    reportSlackError(input.orgId, 'update a Slack prompt', error)
    return false
  }
}

/**
 * Post blocks to a person's DM, resolved by email or by Slack user id, and
 * return the message coordinates. Never throws: `users_not_found` means "fall
 * back to email", not an error.
 */
export async function postDirectMessage(input: {
  orgId: string
  email?: string | null
  slackUserId?: string | null
  text: string
  blocks: unknown[]
}): Promise<{ ok: true; slackUserId: string; channelId: string; ts: string } | { ok: false; reason: 'no_slack' | 'users_not_found' | 'slack_error'; message?: string }> {
  const token = await slackToken(input.orgId)
  if (!token) return { ok: false, reason: 'no_slack' }
  try {
    let slackUserId = input.slackUserId ?? ''
    if (!slackUserId) {
      try {
        const found = await slackApi<SlackResponse & { user: { id: string } }>(token, 'users.lookupByEmail', { email: input.email ?? '' })
        slackUserId = found.user.id
      } catch (error) {
        if (error instanceof SlackApiError && error.code === 'users_not_found') return { ok: false, reason: 'users_not_found' }
        throw error
      }
    }
    const opened = await slackApi<SlackResponse & { channel: { id: string } }>(token, 'conversations.open', { users: slackUserId })
    const posted = await slackApi<SlackResponse & { ts: string }>(token, 'chat.postMessage', { channel: opened.channel.id, text: input.text, blocks: input.blocks, unfurl_links: false })
    return { ok: true, slackUserId, channelId: opened.channel.id, ts: posted.ts }
  } catch (error) {
    reportSlackError(input.orgId, 'send a direct message', error)
    return { ok: false, reason: 'slack_error', message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Send an approval request as a Slack DM. Never throws: `users_not_found` means
 * "fall back to email", not an error. Returns the matched Slack user on success.
 */
export async function sendDirectMessage(input: {
  orgId: string
  email: string
  text: string
  blocks: unknown[]
}): Promise<{ ok: true; slackUserId: string } | { ok: false; reason: 'no_slack' | 'users_not_found' | 'slack_error'; message?: string }> {
  const result = await postDirectMessage({ orgId: input.orgId, email: input.email, text: input.text, blocks: input.blocks })
  return result.ok ? { ok: true, slackUserId: result.slackUserId } : result
}
