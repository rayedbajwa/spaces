import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { getDb } from './db'

/**
 * The waitlist: people who asked for access from the landing page while
 * registration is by invitation. It belongs to the deployment, not to an
 * organization; the default organization's owners and admins work through it.
 *
 * Inviting someone from it issues a join link for their email only. Registering
 * through that link starts their own organization, as an open registration
 * would; a team invite, by contrast, adds someone to an existing team.
 */

export const TEAM_SIZES = ['1', '2-10', '11-50', '51-200', '200+'] as const
export type TeamSize = (typeof TEAM_SIZES)[number]
export type WaitlistStatus = 'waiting' | 'invited' | 'joined'

export interface WaitlistInput { email: string; name?: string; company?: string; teamSize?: TeamSize; note?: string }

export interface WaitlistEntry {
  entryId: string
  email: string
  name: string | null
  company: string | null
  teamSize: string | null
  note: string | null
  status: WaitlistStatus
  invitedAt: string | null
  expiresAt: string | null
  joinedAt: string | null
  createdAt: string
}

const JOIN_LINK_DAYS = 14

const COLS = `entry_id AS "entryId", email, name, company, team_size AS "teamSize", note, status,
  invited_at AS "invitedAt", expires_at AS "expiresAt", joined_at AS "joinedAt", created_at AS "createdAt"`

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Check and tidy what the landing form sent. Returns the problem to show, or the input to store. */
export function parseWaitlistInput(body: Record<string, unknown>): { ok: true; input: WaitlistInput } | { ok: false; error: string } {
  const text = (value: unknown, max: number): string | undefined => {
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim().replace(/\s+/g, ' ')
    return trimmed ? trimmed.slice(0, max) : undefined
  }
  const email = text(body.email, 254)?.toLowerCase()
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'Enter a valid email address.' }
  const teamSize = typeof body.teamSize === 'string' && (TEAM_SIZES as readonly string[]).includes(body.teamSize) ? (body.teamSize as TeamSize) : undefined
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 1000) || undefined : undefined
  return { ok: true, input: { email, name: text(body.name, 120), company: text(body.company, 120), teamSize, note } }
}

/** Add someone to the waitlist. Signing up twice changes nothing; `created` says whether this was new. */
export async function joinWaitlist(input: WaitlistInput): Promise<{ created: boolean; entry: WaitlistEntry }> {
  const sql = getDb()
  const [inserted] = await sql<WaitlistEntry[]>`
    INSERT INTO waitlist (entry_id, email, name, company, team_size, note)
    VALUES (${randomUUID()}, ${input.email}, ${input.name ?? null}, ${input.company ?? null}, ${input.teamSize ?? null}, ${input.note ?? null})
    ON CONFLICT (email) DO NOTHING
    RETURNING ${sql.unsafe(COLS)}
  `
  if (inserted) return { created: true, entry: inserted }
  const [existing] = await sql<WaitlistEntry[]>`SELECT ${sql.unsafe(COLS)} FROM waitlist WHERE email = ${input.email}`
  return { created: false, entry: existing! }
}

export async function listWaitlist(): Promise<WaitlistEntry[]> {
  const sql = getDb()
  return await sql<WaitlistEntry[]>`SELECT ${sql.unsafe(COLS)} FROM waitlist ORDER BY created_at DESC`
}

/** Issue a join link for an entry; a new link replaces any earlier one. */
export async function inviteFromWaitlist(entryId: string, invitedBy: string | null): Promise<{ entry: WaitlistEntry; token: string } | undefined> {
  const sql = getDb()
  const token = randomBytes(24).toString('base64url')
  const [entry] = await sql<WaitlistEntry[]>`
    UPDATE waitlist
       SET status = 'invited', token_hash = ${hashToken(token)}, invited_by = ${invitedBy},
           invited_at = now(), expires_at = now() + make_interval(days => ${JOIN_LINK_DAYS})
     WHERE entry_id = ${entryId} AND status <> 'joined'
     RETURNING ${sql.unsafe(COLS)}
  `
  return entry ? { entry, token } : undefined
}

/** The entry a join link belongs to, while it is unused and unexpired. */
export async function getWaitlistInvite(token: string): Promise<WaitlistEntry | undefined> {
  const sql = getDb()
  const [entry] = await sql<WaitlistEntry[]>`
    SELECT ${sql.unsafe(COLS)} FROM waitlist
     WHERE token_hash = ${hashToken(token)} AND status = 'invited' AND expires_at > now()
  `
  return entry
}

export async function markWaitlistJoined(entryId: string): Promise<void> {
  const sql = getDb()
  await sql`UPDATE waitlist SET status = 'joined', joined_at = now(), token_hash = NULL WHERE entry_id = ${entryId}`
}

export async function removeFromWaitlist(entryId: string): Promise<boolean> {
  const sql = getDb()
  const rows = await sql`DELETE FROM waitlist WHERE entry_id = ${entryId}`
  return rows.count > 0
}

/** At most `limit` signups per key (an IP address) in `windowMs`. In memory: one server process. */
export function createSignupLimiter(limit = 5, windowMs = 10 * 60_000) {
  const hits = new Map<string, number[]>()
  return (key: string, now = Date.now()): boolean => {
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs)
    if (recent.length >= limit) { hits.set(key, recent); return false }
    recent.push(now)
    hits.set(key, recent)
    if (hits.size > 10_000) for (const [k, times] of hits) if (times.every((t) => now - t >= windowMs)) hits.delete(k)
    return true
  }
}
