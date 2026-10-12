import { describe, expect, test } from 'bun:test'
import { suggestTargets } from '../src/lib/deployment'
import type { RailwayWorkspaceTargets } from '../src/lib/railway'

/** Which Railway service + environment Spaces suggests as a project's deployment target. */
const workspaces: RailwayWorkspaceTargets[] = [
  {
    id: 'ws-1',
    name: 'Acme',
    projects: [
      {
        id: 'proj-1',
        name: 'Acme App',
        services: [{ id: 'svc-web', name: 'web', repo: 'Acme/Web-App' }, { id: 'svc-db', name: 'postgres', repo: null }],
        environments: [{ id: 'env-stg', name: 'staging' }, { id: 'env-prod', name: 'production' }],
      },
      {
        id: 'proj-2',
        name: 'Acme Docs',
        services: [{ id: 'svc-docs', name: 'docs', repo: 'acme/docs' }],
        environments: [{ id: 'env-live', name: 'prod-eu' }, { id: 'env-dev', name: 'dev' }],
      },
    ],
  },
]

describe('suggestTargets', () => {
  test('matches the service deploying the project repository, case-insensitively, in production', () => {
    const [first, ...rest] = suggestTargets(workspaces, [{ githubRepo: 'acme/web-app', isPrimary: true }])
    expect(rest).toHaveLength(0)
    expect(first).toMatchObject({ workspaceId: 'ws-1', railwayProjectId: 'proj-1', serviceId: 'svc-web', environmentId: 'env-prod', environmentName: 'production', repo: 'Acme/Web-App' })
  })

  test('accepts GitHub URLs and falls back to a prod-like environment', () => {
    const [first] = suggestTargets(workspaces, [{ githubRepo: 'https://github.com/acme/docs.git' }])
    expect(first).toMatchObject({ serviceId: 'svc-docs', environmentId: 'env-live' })
  })

  test('puts the primary repository first when several services match', () => {
    const matches = suggestTargets(workspaces, [{ githubRepo: 'acme/docs', isPrimary: false }, { githubRepo: 'acme/web-app', isPrimary: true }])
    expect(matches.map((m) => m.serviceId)).toEqual(['svc-web', 'svc-docs'])
  })

  test('suggests nothing when no service deploys the project repositories', () => {
    expect(suggestTargets(workspaces, [{ githubRepo: 'acme/other' }, { githubRepo: null }])).toEqual([])
    expect(suggestTargets(workspaces, [])).toEqual([])
  })
})
