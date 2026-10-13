import { afterEach, describe, expect, test } from 'bun:test'
import { forwardTarget } from '../src/lib/project-forward'
import { hasInternalToken, INTERNAL_TOKEN_HEADER, roleConfigProblem, spacesRole } from '../src/lib/role'

/** 014-project-workers: what the web role forwards, and the role settings. */

const saved = { role: process.env.SPACES_ROLE, token: process.env.SPACES_INTERNAL_TOKEN, project: process.env.WORKER_PROJECT_ID }
afterEach(() => {
  for (const [key, value] of [['SPACES_ROLE', saved.role], ['SPACES_INTERNAL_TOKEN', saved.token], ['WORKER_PROJECT_ID', saved.project]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value
  }
})

describe('forwardTarget', () => {
  const id = '00000000-0000-4000-8000-000000000001'
  test('workspace routes go to the project worker', () => {
    for (const [method, path] of [
      ['GET', `/api/projects/${id}/qa`], ['POST', `/api/projects/${id}/accept`], ['GET', '/api/projects/acme/artifact'],
      ['POST', `/api/projects/${id}/chat`], ['POST', `/api/projects/${id}/repos`], ['DELETE', `/api/projects/${id}`],
      ['GET', `/api/projects/${id}/onboarding`], ['GET', '/api/projects/acme/task-tracker'], ['POST', '/api/projects/acme/execute-step'],
    ] as const) expect(forwardTarget(method, path)).toEqual({ kind: 'project', idOrSlug: path.split('/')[3]! })
  })

  test('database-only project routes stay on the web service', () => {
    for (const [method, path] of [
      ['GET', `/api/projects/${id}`], ['PATCH', `/api/projects/${id}`], ['GET', `/api/projects/${id}/responsibilities`],
      ['POST', `/api/projects/${id}/archive`], ['GET', '/api/projects/acme/usage'], ['GET', '/api/projects/acme/deployment/suggestion'],
      ['GET', '/api/projects/by-code/DEFA-1'], ['GET', '/api/projects'], ['POST', '/api/projects'], ['GET', '/api/board'],
    ] as const) expect(forwardTarget(method, path)).toBeUndefined()
  })

  test('runs go to their project worker', () => {
    expect(forwardTarget('GET', '/api/runs/r1/events')).toEqual({ kind: 'run', runId: 'r1' })
    expect(forwardTarget('POST', '/api/runs/r1/answer')).toEqual({ kind: 'run', runId: 'r1' })
    expect(forwardTarget('POST', '/api/runs')).toEqual({ kind: 'run-create' })
  })
})

describe('roles', () => {
  test('all is the default and needs nothing', () => {
    delete process.env.SPACES_ROLE
    expect(spacesRole()).toBe('all')
    expect(roleConfigProblem()).toBeUndefined()
  })

  test('web and project need the internal token; project needs its project', () => {
    process.env.SPACES_ROLE = 'project'
    delete process.env.SPACES_INTERNAL_TOKEN
    expect(roleConfigProblem()).toContain('SPACES_INTERNAL_TOKEN')
    process.env.SPACES_INTERNAL_TOKEN = 'secret'
    delete process.env.WORKER_PROJECT_ID
    expect(roleConfigProblem()).toContain('WORKER_PROJECT_ID')
  })

  test('the internal token must match exactly', () => {
    process.env.SPACES_INTERNAL_TOKEN = 'secret-token'
    const req = (value?: string) => new Request('http://x/', { headers: value ? { [INTERNAL_TOKEN_HEADER]: value } : {} })
    expect(hasInternalToken(req('secret-token'))).toBe(true)
    expect(hasInternalToken(req('secret-tokeN'))).toBe(false)
    expect(hasInternalToken(req())).toBe(false)
  })
})
