import { createHash, randomBytes, randomUUID } from 'node:crypto'
import process from 'node:process'
import { getDb } from './db'

/**
 * Authentication, teams ("spaces") and invites.
 *
 *  - Users sign in with email + password (argon2id via Bun.password) or GitHub.
 *  - A session is an HttpOnly cookie carrying a random token; only its SHA-256
 *    is stored. Sessions remember the active team.
 *  - A team owns projects and has its own memory and knowledge defaults; the
 *    organization (this installation) shares memory, knowledge and the
 *    repository catalog with every team.
 *  - Roles: owner > admin > member > viewer. Invites are token links (the
 *    inviter copies the link; no mail server needed), bound to an email.
 *  - The first user to register becomes owner of the default team and adopts
 *    every legacy project that has no team yet.
 */

export type TeamRole = 'owner' | 'admin' | 'member' | 'viewer'
export type InviteRole = Exclude<TeamRole, 'owner'>

export interface UserRow {
  userId: string
  email: string
  name: string
  githubLogin?: string | null
  avatarUrl?: string | null
  createdAt: string
  lastLoginAt?: string | null
}

export interface TeamRow {
  teamId: string
  name: string
  slug: string
  /** Prefix of this team's project codes (PLAT in PLAT-12); set on the first project. */
  codePrefix?: string | null
  createdBy?: string | null
  createdAt: string
  knowledgeJson?: Record<string, unknown>
}

export interface TeamMembership extends TeamRow {
  role: TeamRole
  memberCount: number
  projectCount: number
}

export interface TeamMemberRow {
  userId: string
  email: string
  name: string
  avatarUrl?: string | null
  role: TeamRole
  joinedAt: string
}

export interface InviteRow {
  inviteId: string
  teamId: string
  email: string
  role: InviteRole
  invitedBy?: string | null
  createdAt: string
  expiresAt: string
  acceptedAt?: string | null
}

export interface AuthContext {
  user: UserRow
  sessionId: string
  teams: TeamMembership[]
  activeTeam?: TeamMembership
}

export const SESSION_COOKIE = 'spaces_session'
const SESSION_DAYS = 30
const INVITE_DAYS = 14
const ROLE_RANK: Record<TeamRole, number> = { owner: 4, admin: 3, member: 2, viewer: 1 }

export function authDisabled(): boolean {
  return process.env.AUTH_DISABLED === '1'
}

export function roleAtLeast(role: TeamRole | undefined, needed: TeamRole): boolean {
  return Boolean(role) && ROLE_RANK[role!] >= ROLE_RANK[needed]
}

const USER_COLS = `
  user_id AS "userId", email, name, github_login AS "githubLogin", avatar_url AS "avatarUrl",
  created_at AS "createdAt", last_login_at AS "lastLoginAt"
`
const TEAM_COLS = `
  t.team_id AS "teamId", t.name, t.slug, t.code_prefix AS "codePrefix", t.created_by AS "createdBy", t.created_at AS "createdAt", t.knowledge_json AS "knowledgeJson"
`

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function slugifyName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'team'
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get('cookie')
  if (!header) return undefined
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k === name) return decodeURIComponent(rest.join('='))
  }
  return undefined
}

export function sessionCookie(token: string, req: Request, maxAgeSeconds = SESSION_DAYS * 86_400): string {
  const secure = new URL(req.url).protocol === 'https:' || (req.headers.get('x-forwarded-proto') ?? '').includes('https')
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export async function countUsers(): Promise<number> {
  const sql = getDb()
  const [row] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM users`
  return row?.n ?? 0
}

export async function getUserById(userId: string): Promise<UserRow | undefined> {
  const sql = getDb()
  const [row] = await sql<UserRow[]>`SELECT ${sql.unsafe(USER_COLS)} FROM users WHERE user_id = ${userId}`
  return row
}

export async function getUserByEmail(email: string): Promise<UserRow | undefined> {
  const sql = getDb()
  const [row] = await sql<UserRow[]>`SELECT ${sql.unsafe(USER_COLS)} FROM users WHERE email = ${normalizeEmail(email)}`
  return row
}

export async function createUser(input: { email: string; name: string; password?: string; githubLogin?: string; avatarUrl?: string }): Promise<UserRow> {
  const sql = getDb()
  const passwordHash = input.password ? await Bun.password.hash(input.password, { algorithm: 'argon2id' }) : null
  const [row] = await sql<UserRow[]>`
    INSERT INTO users (user_id, email, name, password_hash, github_login, avatar_url)
    VALUES (${randomUUID()}, ${normalizeEmail(input.email)}, ${input.name.trim() || input.email.split('@')[0]!}, ${passwordHash}, ${input.githubLogin ?? null}, ${input.avatarUrl ?? null})
    RETURNING ${sql.unsafe(USER_COLS)}
  `
  return row!
}

export async function verifyPassword(email: string, password: string): Promise<UserRow | undefined> {
  const sql = getDb()
  const [row] = await sql<Array<UserRow & { passwordHash: string | null }>>`
    SELECT ${sql.unsafe(USER_COLS)}, password_hash AS "passwordHash" FROM users WHERE email = ${normalizeEmail(email)}
  `
  if (!row?.passwordHash) return undefined
  const ok = await Bun.password.verify(password, row.passwordHash)
  if (!ok) return undefined
  const { passwordHash: _omit, ...user } = row
  return user
}

export async function setPassword(userId: string, password: string): Promise<void> {
  const sql = getDb()
  const hash = await Bun.password.hash(password, { algorithm: 'argon2id' })
  await sql`UPDATE users SET password_hash = ${hash} WHERE user_id = ${userId}`
}

export async function linkGitHub(userId: string, githubLogin: string, avatarUrl?: string): Promise<void> {
  const sql = getDb()
  await sql`UPDATE users SET github_login = ${githubLogin}, avatar_url = COALESCE(${avatarUrl ?? null}, avatar_url) WHERE user_id = ${userId}`
}

export async function getUserByGitHubLogin(login: string): Promise<UserRow | undefined> {
  const sql = getDb()
  const [row] = await sql<UserRow[]>`SELECT ${sql.unsafe(USER_COLS)} FROM users WHERE github_login = ${login}`
  return row
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export async function createSession(userId: string, req: Request, activeTeamId?: string): Promise<{ token: string; sessionId: string }> {
  const sql = getDb()
  const token = randomBytes(32).toString('base64url')
  const sessionId = randomUUID()
  await sql`
    INSERT INTO auth_sessions (session_id, user_id, token_hash, active_team_id, user_agent, expires_at)
    VALUES (${sessionId}, ${userId}, ${hashToken(token)}, ${activeTeamId ?? null}, ${(req.headers.get('user-agent') ?? '').slice(0, 300)}, now() + make_interval(days => ${SESSION_DAYS}))
  `
  await sql`UPDATE users SET last_login_at = now() WHERE user_id = ${userId}`
  return { token, sessionId }
}

export async function deleteSession(token: string): Promise<void> {
  const sql = getDb()
  await sql`DELETE FROM auth_sessions WHERE token_hash = ${hashToken(token)}`
}

export async function setActiveTeam(sessionId: string, teamId: string): Promise<void> {
  const sql = getDb()
  await sql`UPDATE auth_sessions SET active_team_id = ${teamId} WHERE session_id = ${sessionId}`
}

/** Resolve the request's session to a user with their teams; undefined when signed out. */
export async function authenticate(req: Request): Promise<AuthContext | undefined> {
  const token = readCookie(req, SESSION_COOKIE)
  if (!token) return undefined
  const sql = getDb()
  const [session] = await sql<Array<{ sessionId: string; userId: string; activeTeamId: string | null }>>`
    UPDATE auth_sessions SET last_seen_at = now()
     WHERE token_hash = ${hashToken(token)} AND expires_at > now()
     RETURNING session_id AS "sessionId", user_id AS "userId", active_team_id AS "activeTeamId"
  `
  if (!session) return undefined
  const user = await getUserById(session.userId)
  if (!user) return undefined
  const teams = await listTeamsForUser(user.userId)
  const activeTeam = teams.find((t) => t.teamId === session.activeTeamId) ?? teams[0]
  if (activeTeam && activeTeam.teamId !== session.activeTeamId) await setActiveTeam(session.sessionId, activeTeam.teamId)
  return { user, sessionId: session.sessionId, teams, activeTeam }
}

// ---------------------------------------------------------------------------
// Teams and members
// ---------------------------------------------------------------------------

export async function listTeamsForUser(userId: string): Promise<TeamMembership[]> {
  const sql = getDb()
  return await sql<TeamMembership[]>`
    SELECT ${sql.unsafe(TEAM_COLS)}, m.role,
           (SELECT count(*)::int FROM team_members x WHERE x.team_id = t.team_id) AS "memberCount",
           (SELECT count(*)::int FROM projects p WHERE p.team_id = t.team_id) AS "projectCount"
      FROM team_members m JOIN teams t ON t.team_id = m.team_id
     WHERE m.user_id = ${userId}
     ORDER BY t.created_at ASC
  `
}

export async function getTeam(teamId: string): Promise<TeamRow | undefined> {
  const sql = getDb()
  const [row] = await sql<TeamRow[]>`SELECT ${sql.unsafe(TEAM_COLS)} FROM teams t WHERE t.team_id = ${teamId}`
  return row
}

export async function getMembership(teamId: string, userId: string): Promise<TeamRole | undefined> {
  const sql = getDb()
  const [row] = await sql<Array<{ role: TeamRole }>>`SELECT role FROM team_members WHERE team_id = ${teamId} AND user_id = ${userId}`
  return row?.role
}

export async function createTeam(input: { name: string; createdBy: string }): Promise<TeamRow> {
  const sql = getDb()
  const base = slugifyName(input.name)
  let slug = base
  for (let i = 2; i < 50; i += 1) {
    const [exists] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM teams WHERE slug = ${slug}`
    if (!exists?.n) break
    slug = `${base}-${i}`
  }
  const teamId = randomUUID()
  await sql.begin(async (tx) => {
    await tx`INSERT INTO teams (team_id, name, slug, created_by) VALUES (${teamId}, ${input.name.trim()}, ${slug}, ${input.createdBy})`
    await tx`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}, ${input.createdBy}, 'owner')`
    await tx`INSERT INTO team_memory (team_id) VALUES (${teamId}) ON CONFLICT DO NOTHING`
  })
  return (await getTeam(teamId))!
}

export async function renameTeam(teamId: string, name: string): Promise<void> {
  const sql = getDb()
  await sql`UPDATE teams SET name = ${name.trim()} WHERE team_id = ${teamId}`
}

export async function listMembers(teamId: string): Promise<TeamMemberRow[]> {
  const sql = getDb()
  return await sql<TeamMemberRow[]>`
    SELECT u.user_id AS "userId", u.email, u.name, u.avatar_url AS "avatarUrl", m.role, m.joined_at AS "joinedAt"
      FROM team_members m JOIN users u ON u.user_id = m.user_id
     WHERE m.team_id = ${teamId}
     ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END, u.name
  `
}

export async function setMemberRole(teamId: string, userId: string, role: TeamRole): Promise<void> {
  const sql = getDb()
  if (role !== 'owner') {
    // Never leave a team without an owner.
    const [owners] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM team_members WHERE team_id = ${teamId} AND role = 'owner' AND user_id <> ${userId}`
    const current = await getMembership(teamId, userId)
    if (current === 'owner' && !owners?.n) throw new Error('A team needs at least one owner; promote someone else first.')
  }
  await sql`UPDATE team_members SET role = ${role} WHERE team_id = ${teamId} AND user_id = ${userId}`
}

export async function removeMember(teamId: string, userId: string): Promise<void> {
  const sql = getDb()
  const current = await getMembership(teamId, userId)
  if (current === 'owner') {
    const [owners] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM team_members WHERE team_id = ${teamId} AND role = 'owner' AND user_id <> ${userId}`
    if (!owners?.n) throw new Error('A team needs at least one owner; transfer ownership first.')
  }
  await sql`DELETE FROM team_members WHERE team_id = ${teamId} AND user_id = ${userId}`
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

export async function createInvite(input: { teamId: string; email: string; role: InviteRole; invitedBy: string }): Promise<{ invite: InviteRow; token: string }> {
  const sql = getDb()
  const token = randomBytes(24).toString('base64url')
  const [invite] = await sql<InviteRow[]>`
    INSERT INTO team_invites (invite_id, team_id, email, role, token_hash, invited_by, expires_at)
    VALUES (${randomUUID()}, ${input.teamId}, ${normalizeEmail(input.email)}, ${input.role}, ${hashToken(token)}, ${input.invitedBy}, now() + make_interval(days => ${INVITE_DAYS}))
    RETURNING invite_id AS "inviteId", team_id AS "teamId", email, role, invited_by AS "invitedBy", created_at AS "createdAt", expires_at AS "expiresAt", accepted_at AS "acceptedAt"
  `
  return { invite: invite!, token }
}

export async function listInvites(teamId: string): Promise<Array<InviteRow & { invitedByName?: string | null }>> {
  const sql = getDb()
  return await sql<Array<InviteRow & { invitedByName?: string | null }>>`
    SELECT i.invite_id AS "inviteId", i.team_id AS "teamId", i.email, i.role, i.invited_by AS "invitedBy", i.created_at AS "createdAt",
           i.expires_at AS "expiresAt", i.accepted_at AS "acceptedAt", u.name AS "invitedByName"
      FROM team_invites i LEFT JOIN users u ON u.user_id = i.invited_by
     WHERE i.team_id = ${teamId} AND i.accepted_at IS NULL AND i.expires_at > now()
     ORDER BY i.created_at DESC
  `
}

export async function revokeInvite(teamId: string, inviteId: string): Promise<void> {
  const sql = getDb()
  await sql`DELETE FROM team_invites WHERE team_id = ${teamId} AND invite_id = ${inviteId}`
}

/** Look up a pending invite by its token (for the accept page). */
export async function getInviteByToken(token: string): Promise<(InviteRow & { teamName: string; teamSlug: string }) | undefined> {
  const sql = getDb()
  const [row] = await sql<Array<InviteRow & { teamName: string; teamSlug: string }>>`
    SELECT i.invite_id AS "inviteId", i.team_id AS "teamId", i.email, i.role, i.invited_by AS "invitedBy", i.created_at AS "createdAt",
           i.expires_at AS "expiresAt", i.accepted_at AS "acceptedAt", t.name AS "teamName", t.slug AS "teamSlug"
      FROM team_invites i JOIN teams t ON t.team_id = i.team_id
     WHERE i.token_hash = ${hashToken(token)} AND i.accepted_at IS NULL AND i.expires_at > now()
  `
  return row
}

/** Accept an invite for a signed-in user whose email matches; adds the membership. */
export async function acceptInvite(token: string, user: UserRow): Promise<TeamRow> {
  const invite = await getInviteByToken(token)
  if (!invite) throw new Error('This invite link is invalid, expired or already used.')
  if (normalizeEmail(invite.email) !== normalizeEmail(user.email)) {
    throw new Error(`This invite was issued to ${invite.email}; sign in with that address to accept it.`)
  }
  const sql = getDb()
  // An existing member keeps the higher of their current role and the invited one.
  const current = await getMembership(invite.teamId, user.userId)
  const role: TeamRole = current && ROLE_RANK[current] >= ROLE_RANK[invite.role] ? current : invite.role
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO team_members (team_id, user_id, role) VALUES (${invite.teamId}, ${user.userId}, ${role})
      ON CONFLICT (team_id, user_id) DO UPDATE SET role = ${role}
    `
    await tx`UPDATE team_invites SET accepted_at = now(), accepted_by = ${user.userId} WHERE invite_id = ${invite.inviteId}`
  })
  return (await getTeam(invite.teamId))!
}

// ---------------------------------------------------------------------------
// Bootstrap: first user → owner of the default team → adopts legacy projects
// ---------------------------------------------------------------------------

export async function bootstrapFirstUser(user: UserRow): Promise<TeamRow> {
  const sql = getDb()
  const team = await createTeam({ name: process.env.DEFAULT_TEAM_NAME?.trim() || 'Default team', createdBy: user.userId })
  await sql`UPDATE projects SET team_id = ${team.teamId} WHERE team_id IS NULL`
  await sql`UPDATE project_source_snapshots SET team_id = ${team.teamId} WHERE team_id IS NULL AND project_id IS NULL`
  return team
}

// ---------------------------------------------------------------------------
// Org / team memory (shared context layers)
// ---------------------------------------------------------------------------

export async function getOrgMemory(): Promise<{ name: string; manualText: string; updatedAt: string }> {
  const sql = getDb()
  const [row] = await sql<Array<{ name: string; manualText: string; updatedAt: string }>>`
    SELECT name, manual_text AS "manualText", updated_at AS "updatedAt" FROM org_memory WHERE singleton
  `
  return row ?? { name: 'Organization', manualText: '', updatedAt: new Date().toISOString() }
}

export async function updateOrgMemory(patch: { name?: string; manualText?: string }): Promise<void> {
  const sql = getDb()
  await sql`
    INSERT INTO org_memory (singleton, name, manual_text) VALUES (true, ${patch.name ?? 'Organization'}, ${patch.manualText ?? ''})
    ON CONFLICT (singleton) DO UPDATE SET
      name = COALESCE(${patch.name ?? null}, org_memory.name),
      manual_text = COALESCE(${patch.manualText ?? null}, org_memory.manual_text),
      updated_at = now()
  `
}

export async function getTeamMemory(teamId: string): Promise<{ manualText: string; updatedAt: string }> {
  const sql = getDb()
  const [row] = await sql<Array<{ manualText: string; updatedAt: string }>>`
    SELECT manual_text AS "manualText", updated_at AS "updatedAt" FROM team_memory WHERE team_id = ${teamId}
  `
  return row ?? { manualText: '', updatedAt: new Date().toISOString() }
}

export async function updateTeamMemory(teamId: string, manualText: string): Promise<void> {
  const sql = getDb()
  await sql`
    INSERT INTO team_memory (team_id, manual_text) VALUES (${teamId}, ${manualText})
    ON CONFLICT (team_id) DO UPDATE SET manual_text = EXCLUDED.manual_text, updated_at = now()
  `
}

export async function updateTeamKnowledge(teamId: string, config: Record<string, unknown>): Promise<void> {
  const sql = getDb()
  await sql`UPDATE teams SET knowledge_json = ${sql.json(config as never)} WHERE team_id = ${teamId}`
}
