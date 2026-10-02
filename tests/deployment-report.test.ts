import { describe, expect, test } from 'bun:test'
import { formatDeploymentEvidence } from '../src/lib/delivery'

describe('delivery-report deployment evidence (010-railway-deployment)', () => {
  test('TC-DREP-001: an unlinked project says explicitly that no deployment was performed', () => {
    const section = formatDeploymentEvidence(undefined)
    expect(section).toContain('## Deployment')
    expect(section).toContain('No deployment performed')
  })

  test('TC-DREP-002: a confirmed release carries target, outcome, completion time and link', () => {
    const section = formatDeploymentEvidence({
      state: 'success',
      serviceName: 'web',
      environmentName: 'production',
      railwayProjectName: 'Acme App',
      serviceUrl: 'https://acme-web.up.railway.app',
      deploymentUrl: 'https://railway.com/project/proj-1/service/svc-1',
      completedAt: '2026-10-02T12:00:00.000Z',
    })
    expect(section).toContain('Target: web @ production (Railway project Acme App)')
    expect(section).toContain('Outcome: success')
    expect(section).toContain('Completed: 2026-10-02T12:00:00.000Z')
    expect(section).toContain('https://acme-web.up.railway.app')
    expect(section).toContain('https://railway.com/project/proj-1/service/svc-1')
  })

  test('TC-DREP-003: a failed or unconfirmed release surfaces its actionable reason', () => {
    const failed = formatDeploymentEvidence({ state: 'failed', serviceName: 'api', environmentName: 'staging', error: 'Railway reported the deployment failed.' })
    expect(failed).toContain('Outcome: failed')
    expect(failed).toContain('Error: Railway reported the deployment failed.')
  })
})
