import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { formatDeploymentEvidence, refreshDeliveryStatus } from '../src/lib/delivery'

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

  test('TC-DREP-004: refreshDeliveryStatus writes the deterministic deployment section into delivery-status.md', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'spaces-delivery-report-'))
    try {
      await refreshDeliveryStatus('00000000-0000-0000-0000-000000000000', dir, [], {
        state: 'success',
        serviceName: 'web',
        environmentName: 'production',
        railwayProjectName: 'Acme App',
        serviceUrl: 'https://acme-web.up.railway.app',
        deploymentUrl: 'https://railway.com/project/proj-1/service/svc-1',
        completedAt: '2026-10-02T12:00:00.000Z',
      })
      const markdown = await readFile(path.join(dir, 'delivery-status.md'), 'utf8')
      expect(markdown).toContain('## Deployment')
      expect(markdown).toContain('Target: web @ production (Railway project Acme App)')
      expect(markdown).toContain('Outcome: success')
      expect(markdown).toContain('https://acme-web.up.railway.app')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('TC-DREP-005: the deterministic deployment section is written into delivery-report.md too', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'spaces-delivery-report-'))
    try {
      await writeFile(path.join(dir, 'delivery-report.md'), ['Delivery Status: PARTIAL', '', '## Deployment', '- Target: stale', '## Next', '- keep me'].join('\n'))
      await refreshDeliveryStatus('00000000-0000-0000-0000-000000000000', dir, [], {
        state: 'success',
        serviceName: 'web',
        environmentName: 'production',
        railwayProjectName: 'Acme App',
        serviceUrl: 'https://acme-web.up.railway.app',
        deploymentUrl: 'https://railway.com/project/proj-1/service/svc-1',
        completedAt: '2026-10-02T12:00:00.000Z',
      })
      const report = await readFile(path.join(dir, 'delivery-report.md'), 'utf8')
      expect(report).toContain('## Deployment')
      expect(report).toContain('Target: web @ production (Railway project Acme App)')
      expect(report).toContain('Outcome: success')
      expect(report).toContain('## Next')
      expect(report).not.toContain('Target: stale')
      expect(report.match(/## Deployment/g)).toHaveLength(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
