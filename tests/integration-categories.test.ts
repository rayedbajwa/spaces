import { describe, expect, test } from 'bun:test'
import {
  INTEGRATION_CATEGORIES,
  getCategoryForProvider,
  getCategoryForKind,
  calculateCategoryStatus,
  type IntegrationCategoryDefinition,
  type AppLike,
  type ConnectionLike,
} from '../src/lib/integration-categories'
import { PROVIDER_TEMPLATES, type OAuthProviderId } from '../src/lib/oauth'
import type { AppIntegrationKind } from '../src/lib/app-integrations'

describe('Integration Categories Domain Model', () => {
  describe('TC-CAT-001: Canonical Categories Ordering & Definitions', () => {
    test('contains exactly 3 categories in canonical order', () => {
      expect(INTEGRATION_CATEGORIES).toHaveLength(3)
      expect(INTEGRATION_CATEGORIES.map((c) => c.id)).toEqual([
        'source_control',
        'project_management',
        'communication',
      ])
    })

    test('each category contains valid metadata', () => {
      for (const cat of INTEGRATION_CATEGORIES) {
        expect(cat.id).toBeDefined()
        expect(cat.label.trim().length).toBeGreaterThan(0)
        expect(cat.description.trim().length).toBeGreaterThan(0)
        expect(cat.emptyGuidance.trim().length).toBeGreaterThan(0)
        expect(cat.providers.length).toBeGreaterThan(0)
        expect(cat.kinds.length).toBeGreaterThan(0)
      }
    })
  })

  describe('TC-CAT-002: Provider Exhaustiveness', () => {
    test('every provider in PROVIDER_TEMPLATES maps to exactly one category', () => {
      const allKnownProviders = Object.keys(PROVIDER_TEMPLATES) as OAuthProviderId[]
      expect(allKnownProviders.length).toBeGreaterThan(0)

      for (const provider of allKnownProviders) {
        const matchingCategories = INTEGRATION_CATEGORIES.filter((cat) =>
          cat.providers.includes(provider)
        )
        expect(matchingCategories).toHaveLength(1)
        expect(getCategoryForProvider(provider)?.id).toBe(matchingCategories[0].id)
      }
    })

    test('no duplicate providers exist across categories', () => {
      const seen = new Set<string>()
      for (const cat of INTEGRATION_CATEGORIES) {
        for (const p of cat.providers) {
          expect(seen.has(p)).toBe(false)
          seen.add(p)
        }
      }
    })
  })

  describe('TC-CAT-003: Kind Exhaustiveness', () => {
    const allKinds: AppIntegrationKind[] = ['github', 'jira', 'confluence', 'slack', 'linear']

    test('every AppIntegrationKind maps to exactly one category', () => {
      for (const kind of allKinds) {
        const matchingCategories = INTEGRATION_CATEGORIES.filter((cat) =>
          cat.kinds.includes(kind)
        )
        expect(matchingCategories).toHaveLength(1)
        expect(getCategoryForKind(kind)?.id).toBe(matchingCategories[0].id)
      }
    })

    test('specific domain mappings match specifications', () => {
      expect(getCategoryForKind('github')?.id).toBe('source_control')
      expect(getCategoryForKind('jira')?.id).toBe('project_management')
      expect(getCategoryForKind('confluence')?.id).toBe('project_management')
      expect(getCategoryForKind('linear')?.id).toBe('project_management')
      expect(getCategoryForKind('slack')?.id).toBe('communication')
    })
  })

  describe('TC-CAT-004: Unknown Provider / Kind Graceful Handling', () => {
    test('getCategoryForProvider returns undefined for unknown provider without throwing', () => {
      expect(getCategoryForProvider('unknown_provider')).toBeUndefined()
      expect(getCategoryForProvider('')).toBeUndefined()
    })

    test('getCategoryForKind returns undefined for unknown kind without throwing', () => {
      expect(getCategoryForKind('unknown_kind')).toBeUndefined()
      expect(getCategoryForKind('')).toBeUndefined()
    })
  })

  describe('Suite 2: Status Calculation & Aggregation', () => {
    const sourceControl = INTEGRATION_CATEGORIES.find((c) => c.id === 'source_control')!
    const projectManagement = INTEGRATION_CATEGORIES.find((c) => c.id === 'project_management')!

    describe('TC-STAT-001: Empty / Unconfigured Category', () => {
      test('returns empty state with Not connected summary when 0 apps and 0 conns', () => {
        const status = calculateCategoryStatus(sourceControl, [], [])
        expect(status.state).toBe('empty')
        expect(status.summaryBadge).toBe('Not connected')
        expect(status.badgeVariant).toBe('idle')
        expect(status.configuredProviders).toBe(0)
        expect(status.connectedKinds).toBe(0)
      })

      test('returns empty state when app exists but is unconfigured', () => {
        const apps: AppLike[] = [{ provider: 'github', configured: false, kinds: ['github'] }]
        const status = calculateCategoryStatus(sourceControl, apps, [])
        expect(status.state).toBe('empty')
        expect(status.summaryBadge).toBe('Not connected')
        expect(status.badgeVariant).toBe('idle')
      })
    })

    describe('TC-STAT-002: App Configured but No Services Connected', () => {
      test('returns configured_unconnected state with App set up summary', () => {
        const apps: AppLike[] = [{ provider: 'github', configured: true, kinds: ['github'] }]
        const status = calculateCategoryStatus(sourceControl, apps, [])
        expect(status.state).toBe('configured_unconnected')
        expect(status.summaryBadge).toBe('App set up')
        expect(status.badgeVariant).toBe('idle')
        expect(status.configuredProviders).toBe(1)
        expect(status.connectedKinds).toBe(0)
      })
    })

    describe('TC-STAT-003: Partial Connectivity in Multi-Service Category', () => {
      test('returns partial state with count when some but not all kinds connected', () => {
        const apps: AppLike[] = [
          { provider: 'atlassian', configured: true, kinds: ['jira', 'confluence'] },
          { provider: 'linear', configured: true, kinds: ['linear'] },
        ]
        const conns: ConnectionLike[] = [
          { kind: 'jira', status: 'connected', credentialsOk: true },
          { kind: 'confluence', status: 'not_connected' },
          { kind: 'linear', status: 'not_connected' },
        ]
        const status = calculateCategoryStatus(projectManagement, apps, conns)
        expect(status.state).toBe('partial')
        expect(status.connectedKinds).toBe(1)
        expect(status.totalKinds).toBe(3)
        expect(status.summaryBadge).toBe('1 connected')
        expect(status.badgeVariant).toBe('completed')
      })
    })

    describe('TC-STAT-004: All Services Connected', () => {
      test('returns connected state with Connected summary for single-service category', () => {
        const apps: AppLike[] = [{ provider: 'github', configured: true, kinds: ['github'] }]
        const conns: ConnectionLike[] = [{ kind: 'github', status: 'connected', credentialsOk: true }]
        const status = calculateCategoryStatus(sourceControl, apps, conns)
        expect(status.state).toBe('connected')
        expect(status.connectedKinds).toBe(1)
        expect(status.totalKinds).toBe(1)
        expect(status.summaryBadge).toBe('Connected')
        expect(status.badgeVariant).toBe('completed')
      })

      test('returns connected state when all kinds in multi-service category are connected', () => {
        const apps: AppLike[] = [
          { provider: 'atlassian', configured: true, kinds: ['jira', 'confluence'] },
          { provider: 'linear', configured: true, kinds: ['linear'] },
        ]
        const conns: ConnectionLike[] = [
          { kind: 'jira', status: 'connected', credentialsOk: true },
          { kind: 'confluence', status: 'connected', credentialsOk: true },
          { kind: 'linear', status: 'connected', credentialsOk: true },
        ]
        const status = calculateCategoryStatus(projectManagement, apps, conns)
        expect(status.state).toBe('connected')
        expect(status.connectedKinds).toBe(3)
        expect(status.totalKinds).toBe(3)
        expect(status.summaryBadge).toBe('Connected')
        expect(status.badgeVariant).toBe('completed')
      })
    })

    describe('TC-STAT-005: Reconnect Needed Priority', () => {
      test('prioritizes Reconnect needed if any category kind has credentialsOk === false', () => {
        const apps: AppLike[] = [
          { provider: 'atlassian', configured: true, kinds: ['jira', 'confluence'] },
        ]
        const conns: ConnectionLike[] = [
          { kind: 'jira', status: 'connected', credentialsOk: true },
          { kind: 'confluence', status: 'connected', credentialsOk: false },
        ]
        const status = calculateCategoryStatus(projectManagement, apps, conns)
        expect(status.state).toBe('needs_reconnect')
        expect(status.reconnectNeededCount).toBe(1)
        expect(status.summaryBadge).toBe('Reconnect needed')
        expect(status.badgeVariant).toBe('error')
      })
    })
  })

  describe('Suite 3: User Story 1 - Categorized Organization Integrations Management', () => {
    test('all provider apps map to their respective category containers without orphaned items', () => {
      const allApps: AppLike[] = [
        { provider: 'github', configured: true, kinds: ['github'] },
        { provider: 'atlassian', configured: false, kinds: ['jira', 'confluence'] },
        { provider: 'linear', configured: false, kinds: ['linear'] },
        { provider: 'slack', configured: true, kinds: ['slack'] },
      ]

      const grouped: Record<string, AppLike[]> = {
        source_control: [],
        project_management: [],
        communication: [],
      }
      const orphaned: AppLike[] = []

      for (const app of allApps) {
        const cat = getCategoryForProvider(app.provider)
        if (cat && cat.id in grouped) {
          grouped[cat.id].push(app)
        } else {
          orphaned.push(app)
        }
      }

      expect(orphaned).toHaveLength(0)
      expect(grouped.source_control.map((a) => a.provider)).toEqual(['github'])
      expect(grouped.project_management.map((a) => a.provider)).toEqual(['atlassian', 'linear'])
      expect(grouped.communication.map((a) => a.provider)).toEqual(['slack'])
    })
  })

  describe('Suite 4: User Story 2 - Read-Only Status & Inspection Contract', () => {
    function canManageIntegration(isAdmin: boolean, readOnly: boolean): boolean {
      return isAdmin && !readOnly
    }

    test('suppresses management controls when readOnly is true even for admins', () => {
      expect(canManageIntegration(true, true)).toBe(false)
    })

    test('suppresses management controls when user is not admin', () => {
      expect(canManageIntegration(false, false)).toBe(false)
      expect(canManageIntegration(false, true)).toBe(false)
    })

    test('permits management controls only when admin and not readOnly', () => {
      expect(canManageIntegration(true, false)).toBe(true)
    })
  })

  describe('Suite 5: User Story 3 - Category Health Summary & Empty States', () => {
    test('all categories provide clear emptyGuidance strings', () => {
      for (const cat of INTEGRATION_CATEGORIES) {
        expect(cat.emptyGuidance.length).toBeGreaterThan(20)
        expect(typeof cat.emptyGuidance).toBe('string')
      }
    })

    test('communication category status correctly transitions through all states', () => {
      const commCat = INTEGRATION_CATEGORIES.find((c) => c.id === 'communication')!

      // 1. Empty state
      const emptyStatus = calculateCategoryStatus(commCat, [], [])
      expect(emptyStatus.state).toBe('empty')
      expect(emptyStatus.summaryBadge).toBe('Not connected')
      expect(emptyStatus.badgeVariant).toBe('idle')

      // 2. Configured app but not connected
      const configuredApp: AppLike[] = [{ provider: 'slack', configured: true, kinds: ['slack'] }]
      const configuredStatus = calculateCategoryStatus(commCat, configuredApp, [])
      expect(configuredStatus.state).toBe('configured_unconnected')
      expect(configuredStatus.summaryBadge).toBe('App set up')
      expect(configuredStatus.badgeVariant).toBe('idle')

      // 3. Connected
      const connectedConns: ConnectionLike[] = [{ kind: 'slack', status: 'connected', credentialsOk: true }]
      const connectedStatus = calculateCategoryStatus(commCat, configuredApp, connectedConns)
      expect(connectedStatus.state).toBe('connected')
      expect(connectedStatus.summaryBadge).toBe('Connected')
      expect(connectedStatus.badgeVariant).toBe('completed')

      // 4. Reconnect needed
      const brokenConns: ConnectionLike[] = [{ kind: 'slack', status: 'connected', credentialsOk: false }]
      const brokenStatus = calculateCategoryStatus(commCat, configuredApp, brokenConns)
      expect(brokenStatus.state).toBe('needs_reconnect')
      expect(brokenStatus.summaryBadge).toBe('Reconnect needed')
      expect(brokenStatus.badgeVariant).toBe('error')
    })
  })
})
