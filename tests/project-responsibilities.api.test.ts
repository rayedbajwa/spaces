import { afterAll, describe, expect, test } from 'bun:test'
import { createResponsibilityApiFixture } from './helpers/responsibilities-api'

/**
 * HTTP contract tests for the responsibility API
 * (`specs/003-project-responsibilities/contracts/responsibilities-api.md`).
 *
 * Needs a running web server against the test database. The fixture starts one
 * on PORT 3100 unless `RESPONSIBILITY_BASE_URL` points at an already-running
 * server (CI supplies one).
 */
const fixture = await createResponsibilityApiFixture()
const { baseUrl, users, projectA, projectLegacy, projectLegacy2, projectTeamless, teamA } = fixture

const ownerCookie = await fixture.cookieFor(users.ownerA, teamA)
const adminCookie = await fixture.cookieFor(users.adminA, teamA)

interface ApiResult<T = any> {
  status: number
  body: T
}

async function api<T = any>(method: string, path: string, cookie?: string, body?: unknown): Promise<ApiResult<T>> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: unknown = undefined
  try {
    parsed = text ? JSON.parse(text) : undefined
  } catch {
    parsed = text
  }
  return { status: res.status, body: parsed as T }
}

function byKey(payload: { responsibilities: Array<{ standardKey?: string | null }> }, key: string) {
  return payload.responsibilities.find((item) => item.standardKey === key)!
}

afterAll(async () => {
  await fixture.stop()
})

describe('responsibility API contract', () => {
  test('GET returns all six standard responsibilities with the eligible creator as explicit Owner', async () => {
    const res = await api<{ projectId: string; repairNeeded: boolean; responsibilities: any[] }>(
      'GET',
      `/api/projects/${projectA.projectId}/responsibilities`,
      ownerCookie,
    )
    expect(res.status).toBe(200)
    expect(res.body.projectId).toBe(projectA.projectId)
    expect(res.body.repairNeeded).toBe(false)
    expect(res.body.responsibilities.map((item) => item.standardKey)).toEqual([
      'owner', 'product-owner', 'lead-engineer', 'designer', 'qa', 'release-manager',
    ])
    const owner = byKey(res.body, 'owner')
    expect(owner.resolution.status).toBe('explicit')
    expect(owner.resolution.repairNeeded).toBe(false)
    expect(owner.resolution.assignees).toEqual([
      { userId: users.ownerA, name: 'Owner A', email: expect.stringContaining('owner-a-'), primary: true },
    ])
  })

  test('PUT replaces ordered assignees, keeps order on reload, and marks the first as primary', async () => {
    const before = await api<{ responsibilities: any[] }>('GET', `/api/projects/${projectA.projectId}/responsibilities`, ownerCookie)
    const productOwner = byKey(before.body, 'product-owner')

    const res = await api<{ resolution: any }>(
      'PUT',
      `/api/projects/${projectA.projectId}/responsibilities/${productOwner.responsibilityId}/assignments`,
      ownerCookie,
      { userIds: [users.memberA, users.ownerA] },
    )
    expect(res.status).toBe(200)
    expect(res.body.resolution.status).toBe('explicit')
    expect(res.body.resolution.assignees.map((item: any) => [item.userId, item.primary])).toEqual([
      [users.memberA, true],
      [users.ownerA, false],
    ])

    const reloaded = await api<{ responsibilities: any[] }>('GET', `/api/projects/${projectA.projectId}/responsibilities`, ownerCookie)
    expect(byKey(reloaded.body, 'product-owner').resolution.assignees.map((item: any) => item.userId)).toEqual([users.memberA, users.ownerA])
  })

  test('an admin (not just the owner) may mutate assignments', async () => {
    const before = await api<{ responsibilities: any[] }>('GET', `/api/projects/${projectA.projectId}/responsibilities`, adminCookie)
    const lead = byKey(before.body, 'lead-engineer')
    const res = await api<{ resolution: any }>(
      'PUT',
      `/api/projects/${projectA.projectId}/responsibilities/${lead.responsibilityId}/assignments`,
      adminCookie,
      { userIds: [users.memberA] },
    )
    expect(res.status).toBe(200)
    expect(res.body.resolution.assignees[0].userId).toBe(users.memberA)
  })

  test('clearing a non-Owner responsibility yields a labelled Owner fallback', async () => {
    const before = await api<{ responsibilities: any[] }>('GET', `/api/projects/${projectA.projectId}/responsibilities`, ownerCookie)
    const productOwner = byKey(before.body, 'product-owner')
    const res = await api<{ resolution: any }>(
      'PUT',
      `/api/projects/${projectA.projectId}/responsibilities/${productOwner.responsibilityId}/assignments`,
      ownerCookie,
      { userIds: [] },
    )
    expect(res.status).toBe(200)
    expect(res.body.resolution.status).toBe('owner-fallback')
    expect(res.body.resolution.repairNeeded).toBe(false)
    expect(res.body.resolution.assignees[0].userId).toBe(users.ownerA)
  })

  test('removing the final Owner is rejected with 409 and leaves the Owner in place', async () => {
    const before = await api<{ responsibilities: any[] }>('GET', `/api/projects/${projectA.projectId}/responsibilities`, ownerCookie)
    const owner = byKey(before.body, 'owner')
    const res = await api('PUT', `/api/projects/${projectA.projectId}/responsibilities/${owner.responsibilityId}/assignments`, ownerCookie, { userIds: [] })
    expect(res.status).toBe(409)
    const after = await api<{ responsibilities: any[] }>('GET', `/api/projects/${projectA.projectId}/responsibilities`, ownerCookie)
    expect(byKey(after.body, 'owner').resolution.assignees[0].userId).toBe(users.ownerA)
  })

  test('invalid assignees, malformed bodies, duplicates and bad IDs are 400 with no write', async () => {
    const before = await api<{ responsibilities: any[] }>('GET', `/api/projects/${projectA.projectId}/responsibilities`, ownerCookie)
    const qa = byKey(before.body, 'qa')
    const url = `/api/projects/${projectA.projectId}/responsibilities/${qa.responsibilityId}/assignments`

    const ineligible = await api('PUT', url, ownerCookie, { userIds: [users.outsider] })
    expect(ineligible.status).toBe(400)
    expect(ineligible.body.code).toBe('ineligible')

    const malformed = await api('PUT', url, ownerCookie, { userIds: 'not-an-array' })
    expect(malformed.status).toBe(400)

    const nonUuid = await api('PUT', url, ownerCookie, { userIds: ['nope'] })
    expect(nonUuid.status).toBe(400)

    const duplicate = await api('PUT', url, ownerCookie, { userIds: [users.memberA, users.memberA] })
    expect(duplicate.status).toBe(400)

    const badId = await api('PUT', `/api/projects/${projectA.projectId}/responsibilities/not-a-uuid/assignments`, ownerCookie, { userIds: [] })
    expect(badId.status).toBe(400)

    const after = await api<{ responsibilities: any[] }>('GET', `/api/projects/${projectA.projectId}/responsibilities`, ownerCookie)
    const qaAfter = byKey(after.body, 'qa')
    // No explicit assignment survived any of the rejected writes: it still
    // resolves to the Owner fallback, never to the ineligible user.
    expect(qaAfter.resolution.status).toBe('owner-fallback')
    expect(qaAfter.resolution.assignees.map((item: any) => item.userId)).toEqual([users.ownerA])
  })

  test('POST migrate seeds a legacy project exactly once', async () => {
    const first = await api<{ projectId: string; repairNeeded: boolean; responsibilities: any[] }>(
      'POST',
      `/api/projects/${projectLegacy.projectId}/responsibilities/migrate`,
      ownerCookie,
      {},
    )
    expect(first.status).toBe(200)
    expect(first.body.responsibilities).toHaveLength(6)
    expect(first.body.repairNeeded).toBe(false)
    const ids = first.body.responsibilities.map((item) => item.responsibilityId)

    const second = await api<{ responsibilities: any[] }>('POST', `/api/projects/${projectLegacy.projectId}/responsibilities/migrate`, ownerCookie, {})
    expect(second.status).toBe(200)
    expect(second.body.responsibilities.map((item) => item.responsibilityId)).toEqual(ids)
  })

  test('a plain GET on a legacy project repairs it on access (FR-002)', async () => {
    const before = await api<{ responsibilities: any[] }>('GET', `/api/projects/${projectLegacy2.projectId}/responsibilities`, ownerCookie)
    expect(before.status).toBe(200)
    expect(before.body.responsibilities.map((item: any) => item.standardKey)).toEqual([
      'owner', 'product-owner', 'lead-engineer', 'designer', 'qa', 'release-manager',
    ])
    expect(before.body.repairNeeded).toBe(false)
    expect(byKey(before.body, 'owner').resolution.status).toBe('explicit')

    // A second access is a no-op: the same definitions, no duplicate repair.
    const after = await api<{ responsibilities: any[] }>('GET', `/api/projects/${projectLegacy2.projectId}/responsibilities`, ownerCookie)
    expect(after.body.responsibilities.map((item: any) => item.responsibilityId))
      .toEqual(before.body.responsibilities.map((item: any) => item.responsibilityId))
  })

  test('unknown project and unknown responsibility endpoints are 404', async () => {
    const missing = await api('GET', '/api/projects/00000000-0000-4000-8000-000000000000/responsibilities', ownerCookie)
    expect(missing.status).toBe(404)
    const unknown = await api('GET', `/api/projects/${projectA.projectId}/responsibilities/nope/extra`, ownerCookie)
    expect(unknown.status).toBe(404)
  })

  test('a project with no owning team is refused rather than exposed', async () => {
    const res = await api('GET', `/api/projects/${projectTeamless.projectId}/responsibilities`, ownerCookie)
    expect(res.status).toBe(403)
    const migrate = await api('POST', `/api/projects/${projectTeamless.projectId}/responsibilities/migrate`, ownerCookie, {})
    expect(migrate.status).toBe(403)
  })
})
