/**
 * Organizations are the tenant boundary. Every team belongs to exactly one
 * organization, and everything "organization-level" — memory, model policy,
 * provider keys, integrations, OAuth apps, knowledge sources, promotions, the
 * repository catalog — is scoped by org_id. Two accounts in different
 * organizations share nothing.
 *
 * Deployments that predate tenancy are migrated onto one default organization
 * by the schema; `getDefaultOrgId()` is what the process falls back to when
 * sign-in is disabled.
 */

import { randomUUID } from 'node:crypto'
import { getDb } from './db'

export interface OrganizationRow {
  orgId: string
  name: string
  slug: string
  createdBy?: string | null
  createdAt: string
}

const ORG_COLS = `o.org_id AS "orgId", o.name, o.slug, o.created_by AS "createdBy", o.created_at AS "createdAt"`

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'org'
}

export async function getOrganization(orgId: string): Promise<OrganizationRow | undefined> {
  const [row] = await getDb()<OrganizationRow[]>`SELECT ${getDb().unsafe(ORG_COLS)} FROM organizations o WHERE o.org_id = ${orgId}`
  return row
}

export async function listOrganizations(): Promise<OrganizationRow[]> {
  return getDb()<OrganizationRow[]>`SELECT ${getDb().unsafe(ORG_COLS)} FROM organizations o ORDER BY o.created_at ASC`
}

export async function createOrganization(input: { name: string; createdBy?: string | null }): Promise<OrganizationRow> {
  const sql = getDb()
  const base = slugify(input.name)
  let slug = base
  for (let i = 2; i < 100; i += 1) {
    const [exists] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM organizations WHERE slug = ${slug}`
    if (!exists?.n) break
    slug = `${base}-${i}`
  }
  const orgId = randomUUID()
  await sql`INSERT INTO organizations (org_id, name, slug, created_by) VALUES (${orgId}, ${input.name.trim()}, ${slug}, ${input.createdBy ?? null})`
  await sql`INSERT INTO org_memory (org_id, name) VALUES (${orgId}, ${input.name.trim()}) ON CONFLICT (org_id) DO NOTHING`
  return (await getOrganization(orgId))!
}

export async function renameOrganization(orgId: string, name: string): Promise<void> {
  const sql = getDb()
  await sql`UPDATE organizations SET name = ${name.trim()} WHERE org_id = ${orgId}`
  await sql`UPDATE org_memory SET name = ${name.trim()}, updated_at = now() WHERE org_id = ${orgId}`
}

let defaultOrgCache: { orgId: string; at: number } | undefined

/**
 * The organization used when sign-in is disabled (single-user local mode):
 * the migrated default one, else the oldest, created on demand when none exists.
 */
export async function getDefaultOrgId(): Promise<string> {
  if (defaultOrgCache && Date.now() - defaultOrgCache.at < 60_000) return defaultOrgCache.orgId
  const sql = getDb()
  const [row] = await sql<Array<{ orgId: string }>>`SELECT org_id AS "orgId" FROM organizations ORDER BY (slug = 'default') DESC, created_at ASC LIMIT 1`
  const orgId = row?.orgId ?? (await createOrganization({ name: process.env.DEFAULT_ORG_NAME?.trim() || 'Organization' })).orgId
  defaultOrgCache = { orgId, at: Date.now() }
  return orgId
}

export async function orgIdForTeam(teamId: string): Promise<string | undefined> {
  const [row] = await getDb()<Array<{ orgId: string | null }>>`SELECT org_id AS "orgId" FROM teams WHERE team_id = ${teamId}`
  return row?.orgId ?? undefined
}

/** Organization of a project through its team; legacy team-less projects belong to the default org. */
export async function orgIdForProject(projectId: string): Promise<string> {
  const [row] = await getDb()<Array<{ orgId: string | null }>>`
    SELECT t.org_id AS "orgId" FROM projects p LEFT JOIN teams t ON t.team_id = p.team_id WHERE p.project_id = ${projectId}
  `
  return row?.orgId ?? (await getDefaultOrgId())
}

export async function orgIdForProjectSlug(slug: string): Promise<string> {
  const [row] = await getDb()<Array<{ orgId: string | null }>>`
    SELECT t.org_id AS "orgId" FROM projects p LEFT JOIN teams t ON t.team_id = p.team_id WHERE p.slug = ${slug}
  `
  return row?.orgId ?? (await getDefaultOrgId())
}

/** Team ids of an organization (for knowledge scopes and usage roll-ups). */
export async function teamIdsForOrg(orgId: string): Promise<string[]> {
  const rows = await getDb()<Array<{ teamId: string }>>`SELECT team_id AS "teamId" FROM teams WHERE org_id = ${orgId}`
  return rows.map((r) => r.teamId)
}
