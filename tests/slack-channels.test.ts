import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { upsertAppIntegration } from '../src/lib/app-integrations'
import { getDatabaseUrl, getDb } from '../src/lib/db'
import { ensureChannelsForOrg, ensureProjectChannel, notifyProject } from '../src/lib/slack'

async function isDbReachable(): Promise<boolean> {
  try { await getDb()`SELECT 1 FROM project_slack_channels LIMIT 0`; return true } catch { return false }
}
const dbAvailable = await isDbReachable()
const dbSuite = dbAvailable ? describe : describe.skip
if (!dbAvailable) test.skip(`slack channel DB tests skipped: DATABASE_URL not reachable or schema not applied (${getDatabaseUrl()})`, () => {})

/** A fake Slack Web API: records calls, answers like Slack. */
function fakeSlack(options: { taken?: string[]; team?: string; lookupError?: string } = {}) {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = []
  const channels = new Map<string, string>((options.taken ?? []).map((name) => [name, `C_OLD_${name}`]))
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (!url.startsWith('https://slack.com/api/')) return realFetch(input, init)
    const method = url.slice('https://slack.com/api/'.length)
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    calls.push({ method, body })
    const reply = (data: Record<string, unknown>) => new Response(JSON.stringify(data), { status: 200 })
    switch (method) {
      case 'auth.test':
        return reply({ ok: true, team_id: options.team ?? 'T_ONE' })
      case 'conversations.create': {
        const name = String(body.name)
        if (channels.has(name)) return reply({ ok: false, error: 'name_taken' })
        const id = `C_${name}`
        channels.set(name, id)
        return reply({ ok: true, channel: { id, name } })
      }
      case 'conversations.list':
        return reply({ ok: true, channels: [...channels].map(([name, id]) => ({ id, name, is_member: false })) })
      case 'users.lookupByEmail':
        if (options.lookupError) return reply({ ok: false, error: options.lookupError })
        return String(body.email).endsWith('@slack-user.test') ? reply({ ok: true, user: { id: `U_${body.email}` } }) : reply({ ok: false, error: 'users_not_found' })
      case 'chat.postMessage':
        return String(body.channel).startsWith('C_GONE') ? reply({ ok: false, error: 'channel_not_found' }) : reply({ ok: true, ts: '1.2' })
      default:
        return reply({ ok: true })
    }
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = realFetch } }
}

dbSuite('slack project channels', () => {
  const sql = getDb()
  const orgId = randomUUID()
  const teamId = randomUUID()
  const users = [randomUUID(), randomUUID()]
  const projects = [randomUUID(), randomUUID()]
  let slack: ReturnType<typeof fakeSlack> | undefined

  beforeAll(async () => {
    await sql`INSERT INTO organizations (org_id, name, slug) VALUES (${orgId}, 'slack test org', ${`slack-test-${orgId.slice(0, 8)}`})`
    await sql`INSERT INTO teams (team_id, name, slug, org_id) VALUES (${teamId}, 'slack team', ${`slack-team-${teamId.slice(0, 8)}`}, ${orgId})`
    await sql`INSERT INTO users (user_id, email, name) VALUES (${users[0]!}, ${`a-${users[0]!.slice(0, 6)}@slack-user.test`}, 'A'), (${users[1]!}, ${`b-${users[1]!.slice(0, 6)}@elsewhere.test`}, 'B')`
    await sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}, ${users[0]!}, 'owner'), (${teamId}, ${users[1]!}, 'member')`
    await sql`INSERT INTO projects (project_id, name, slug, team_id, code) VALUES (${projects[0]!}, 'Alpha', ${`alpha-${projects[0]!.slice(0, 6)}`}, ${teamId}, ${`ALP${projects[0]!.slice(0, 4)}`}), (${projects[1]!}, 'Beta', ${`beta-${projects[1]!.slice(0, 6)}`}, ${teamId}, ${`BET${projects[1]!.slice(0, 4)}`})`
    await upsertAppIntegration({ orgId, kind: 'slack', status: 'connected', credentials: { access_token: 'xoxb-test' } })
  })
  afterEach(() => slack?.restore())
  afterAll(async () => {
    await sql`DELETE FROM projects WHERE team_id = ${teamId}`
    await sql`DELETE FROM app_integrations WHERE org_id = ${orgId}`
    await sql`DELETE FROM teams WHERE team_id = ${teamId}`
    await sql`DELETE FROM users WHERE user_id = ANY(${users}::uuid[])`
    await sql`DELETE FROM organizations WHERE org_id = ${orgId}`
  })

  test('connecting Slack makes a channel per project and invites team members found by email', async () => {
    slack = fakeSlack()
    expect(await ensureChannelsForOrg(orgId)).toBe(2)
    const created = slack.calls.filter((c) => c.method === 'conversations.create').map((c) => c.body.name)
    expect(created.sort()).toEqual([`spaces-alp${projects[0]!.slice(0, 4)}`, `spaces-bet${projects[1]!.slice(0, 4)}`].sort())
    const invites = slack.calls.filter((c) => c.method === 'conversations.invite')
    expect(invites).toHaveLength(2)
    expect(String(invites[0]!.body.users)).toContain('@slack-user.test') // only the member Slack knows
    expect(String(invites[0]!.body.users)).not.toContain('@elsewhere.test')
    // Stored: a second call does not touch Slack.
    const before = slack.calls.length
    await ensureProjectChannel(projects[0]!)
    expect(slack.calls.length).toBe(before)
  })

  test('an existing channel with the same name is joined, not duplicated', async () => {
    await sql`DELETE FROM project_slack_channels WHERE project_id = ${projects[0]!}`
    const name = `spaces-alp${projects[0]!.slice(0, 4)}`
    slack = fakeSlack({ taken: [name] })
    const channel = await ensureProjectChannel(projects[0]!)
    expect(channel?.channelId).toBe(`C_OLD_${name}`)
    expect(slack.calls.some((c) => c.method === 'conversations.join')).toBe(true)
  })

  test('notices are posted to the project channel; a channel deleted in Slack is replaced next time', async () => {
    slack = fakeSlack()
    await notifyProject(projects[1]!, { kind: 'approval_needed', stage: 'review', summary: 'All good.' })
    const post = slack.calls.find((c) => c.method === 'chat.postMessage')
    expect(post?.body.channel).toBe(`C_spaces-bet${projects[1]!.slice(0, 4)}`)
    expect(JSON.stringify(post?.body.blocks)).toContain('All good.')

    await sql`UPDATE project_slack_channels SET channel_id = 'C_GONE' WHERE project_id = ${projects[1]!}`
    await notifyProject(projects[1]!, { kind: 'run_finished' })
    const [row] = await sql`SELECT 1 FROM project_slack_channels WHERE project_id = ${projects[1]!}`
    expect(row).toBeUndefined() // forgotten, so the next notice creates a fresh channel
  })

  test('reconnecting Slack to another workspace makes the channel there', async () => {
    // Reconnecting issues a new token for the other workspace.
    await upsertAppIntegration({ orgId, kind: 'slack', status: 'connected', credentials: { access_token: 'xoxb-other-workspace' } })
    slack = fakeSlack({ team: 'T_TWO' })
    const channel = await ensureProjectChannel(projects[0]!)
    expect(slack.calls.some((c) => c.method === 'conversations.create')).toBe(true)
    const [row] = await sql<Array<{ teamId: string }>>`SELECT team_id AS "teamId" FROM project_slack_channels WHERE project_id = ${projects[0]!}`
    expect(row!.teamId).toBe('T_TWO')
    expect(channel).toBeDefined()
  })

  test('a lookup failure other than "not found" does not pass silently, and the channel still works', async () => {
    await sql`DELETE FROM project_slack_channels WHERE project_id = ${projects[1]!}`
    slack = fakeSlack({ lookupError: 'ratelimited' })
    expect(await ensureProjectChannel(projects[1]!)).toBeDefined()
    // No invite was sent with a partial member list.
    expect(slack.calls.some((c) => c.method === 'conversations.invite')).toBe(false)
  })

  test('without Slack connected nothing is called', async () => {
    await sql`UPDATE app_integrations SET status = 'not_connected' WHERE org_id = ${orgId} AND kind = 'slack'`
    slack = fakeSlack()
    await notifyProject(projects[0]!, { kind: 'run_finished' })
    expect(slack.calls).toHaveLength(0)
    await sql`UPDATE app_integrations SET status = 'connected' WHERE org_id = ${orgId} AND kind = 'slack'`
  })
})
