import { afterAll, describe, expect, test } from 'bun:test'
import { getDb } from '../src/lib/db'
import { createResponsibilityApiFixture } from './helpers/responsibilities-api'

/**
 * Authorization matrix for the responsibility API (FR-012, FR-013, FR-019).
 * Accountability must follow the owning team boundary and must never grant or
 * remove project access as a side effect of assignment.
 */
const fixture = await createResponsibilityApiFixture({ port: 3111 })
const { baseUrl, users, projectA, teamA, teamB, teamOtherOrg } = fixture

const cookies = {
  owner: await fixture.cookieFor(users.ownerA, teamA),
  admin: await fixture.cookieFor(users.adminA, teamA),
  member: await fixture.cookieFor(users.memberA, teamA),
  viewer: await fixture.cookieFor(users.viewerA, teamA),
  otherTeam: await fixture.cookieFor(users.teamBMember, teamB),
  outsider: await fixture.cookieFor(users.outsider),
  crossOrg: await fixture.cookieFor(users.otherOrgOwner, teamOtherOrg),
}

async function api(method: string, path: string, cookie?: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json().catch(() => undefined)) as any }
}

async function responsibilityIdFor(projectId: string, key: string, cookie: string): Promise<string> {
  const res = await api('GET', `/api/projects/${projectId}/responsibilities`, cookie)
  return res.body.responsibilities.find((item: any) => item.standardKey === key).responsibilityId
}

afterAll(async () => {
  await fixture.stop()
})

describe('responsibility authorization matrix', () => {
  const readPath = `/api/projects/${projectA.projectId}/responsibilities`

  test('team members can read; viewers, non-members and cross-tenant users cannot', async () => {
    expect((await api('GET', readPath, cookies.member)).status).toBe(200)
    expect((await api('GET', readPath, cookies.viewer)).status).toBe(403)
    expect((await api('GET', readPath, cookies.otherTeam)).status).toBe(403)
    expect((await api('GET', readPath, cookies.outsider)).status).toBe(403)
    expect((await api('GET', readPath, cookies.crossOrg)).status).toBe(403)
    expect((await api('GET', readPath)).status).toBe(401)
  })

  test('only owners and admins may mutate or repair', async () => {
    const qa = await responsibilityIdFor(projectA.projectId, 'qa', cookies.owner)
    const assignPath = `/api/projects/${projectA.projectId}/responsibilities/${qa}/assignments`
    const migratePath = `/api/projects/${projectA.projectId}/responsibilities/migrate`

    expect((await api('PUT', assignPath, cookies.owner, { userIds: [users.memberA] })).status).toBe(200)
    expect((await api('PUT', assignPath, cookies.admin, { userIds: [users.memberA] })).status).toBe(200)

    expect((await api('PUT', assignPath, cookies.member, { userIds: [users.memberA] })).status).toBe(403)
    expect((await api('PUT', assignPath, cookies.viewer, { userIds: [users.memberA] })).status).toBe(403)
    expect((await api('PUT', assignPath, cookies.otherTeam, { userIds: [users.memberA] })).status).toBe(403)
    expect((await api('PUT', assignPath, cookies.crossOrg, { userIds: [users.memberA] })).status).toBe(403)
    expect((await api('PUT', assignPath, undefined, { userIds: [users.memberA] })).status).toBe(401)

    expect((await api('POST', migratePath, cookies.member, {})).status).toBe(403)
    expect((await api('POST', migratePath, cookies.crossOrg, {})).status).toBe(403)
    expect((await api('POST', migratePath, cookies.owner, {})).status).toBe(200)
  })

  test('a denied mutation leaves responsibility state unchanged', async () => {
    const designer = await responsibilityIdFor(projectA.projectId, 'designer', cookies.owner)
    const before = await api('GET', readPath, cookies.owner)
    const beforeDesigner = before.body.responsibilities.find((item: any) => item.standardKey === 'designer')
    const denied = await api('PUT', `/api/projects/${projectA.projectId}/responsibilities/${designer}/assignments`, cookies.viewer, { userIds: [users.memberA] })
    expect(denied.status).toBe(403)
    const after = await api('GET', readPath, cookies.owner)
    const afterDesigner = after.body.responsibilities.find((item: any) => item.standardKey === 'designer')
    expect(afterDesigner.assignments).toEqual(beforeDesigner.assignments)
  })

  test('assignment never changes the assignee team role or project access (FR-013)', async () => {
    const sql = getDb()
    const qa = await responsibilityIdFor(projectA.projectId, 'qa', cookies.owner)
    // Assign the viewer: accountability is allowed for any active member, but
    // the viewer stays a viewer and still cannot mutate.
    expect((await api('PUT', `/api/projects/${projectA.projectId}/responsibilities/${qa}/assignments`, cookies.owner, { userIds: [users.viewerA] })).status).toBe(200)

    const [role] = await sql<Array<{ role: string }>>`SELECT role FROM team_members WHERE team_id = ${teamA} AND user_id = ${users.viewerA}`
    expect(role?.role).toBe('viewer')
    expect((await api('PUT', `/api/projects/${projectA.projectId}/responsibilities/${qa}/assignments`, cookies.viewer, { userIds: [users.viewerA] })).status).toBe(403)
    expect((await api('GET', readPath, cookies.viewer)).status).toBe(403)
  })

  test('tenant and team boundaries hold for writes as well as reads', async () => {
    const qa = await responsibilityIdFor(projectA.projectId, 'qa', cookies.owner)
    const path = `/api/projects/${projectA.projectId}/responsibilities/${qa}/assignments`
    const before = await api('GET', readPath, cookies.owner)
    for (const cookie of [cookies.otherTeam, cookies.outsider, cookies.crossOrg]) {
      expect((await api('PUT', path, cookie, { userIds: [users.memberA] })).status).toBe(403)
    }
    const after = await api('GET', readPath, cookies.owner)
    expect(after.body.responsibilities).toEqual(before.body.responsibilities)
  })
})

describe('agent context routes follow the owning team', () => {
  // The shared context carries project and team memory and imported sources.
  test('only the owning team can read the context or start agents with it', async () => {
    const slug = projectA.slug
    for (const cookie of [cookies.otherTeam, cookies.outsider, cookies.crossOrg]) {
      expect((await api('GET', `/api/projects/${slug}/context`, cookie)).status).toBe(403)
    }
    expect((await api('GET', `/api/projects/${slug}/context`, cookies.viewer)).status).not.toBe(403)
    const agentRoutes = [`/api/projects/${slug}/tasks/T001/run`, `/api/projects/${slug}/workstreams/run`, `/api/projects/${slug}/subagents/run`, `/api/projects/${slug}/subagents/retry`]
    for (const path of agentRoutes) {
      for (const cookie of [cookies.viewer, cookies.otherTeam, cookies.crossOrg]) {
        expect((await api('POST', path, cookie, {})).status).toBe(403)
      }
    }
  })
})
