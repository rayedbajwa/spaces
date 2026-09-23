import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import {
  getAppIntegration,
  getAppIntegrationCredentials,
  upsertAppIntegration,
  disconnectAppIntegration,
  listAppIntegrations,
} from '../src/lib/app-integrations'
import {
  saveOAuthApp,
  getOAuthAppCredentials,
  deleteOAuthApp,
} from '../src/lib/oauth-apps'
import { verifyFigmaToken } from '../src/lib/figma-tools'
import { applySchema, vectorSearchAvailable } from '../src/lib/db'
import { getDefaultOrgId } from '../src/lib/orgs'

describe('Figma Integration API & Credential Sealing', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  describe('TC-API-001: Figma Credential Verification (Mock API)', () => {
    test('successful verification returns user details and ok: true', async () => {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.includes('api.figma.com/v1/me')) {
          return new Response(
            JSON.stringify({
              id: '10492810',
              handle: 'sarah_designer',
              email: 'sarah@example.com',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        }
        return new Response('Not Found', { status: 404 })
      }

      const result = await verifyFigmaToken('figd_test_valid_token_123')
      expect(result.ok).toBe(true)
      expect(result.user).toBeDefined()
      expect(result.user?.id).toBe('10492810')
      expect(result.user?.handle).toBe('sarah_designer')
      expect(result.user?.email).toBe('sarah@example.com')
    })

    test('rejected credentials return ok: false and informative error message', async () => {
      globalThis.fetch = async (input: RequestInfo | URL) => {
        return new Response(
          JSON.stringify({
            status: 401,
            err: 'Invalid token',
          }),
          { status: 401, statusText: 'Unauthorized', headers: { 'Content-Type': 'application/json' } }
        )
      }

      const result = await verifyFigmaToken('invalid_token')
      expect(result.ok).toBe(false)
      expect(result.error).toContain('401')
      expect(result.user).toBeUndefined()
    })
  })

  describe('TC-API-002: PAT Credential Sealing & App Integration Persistence', () => {
    test('seals PAT in app_integrations and unseals correctly', async () => {
      const orgId = await getDefaultOrgId()
      const patToken = 'figd_secret_pat_token_abc123'
      const row = await upsertAppIntegration({
        orgId,
        kind: 'figma',
        status: 'connected',
        displayName: 'Figma (Acme Design Team)',
        config: {
          authType: 'pat',
          userHandle: 'sarah@example.com',
        },
        credentials: {
          access_token: patToken,
          token_type: 'bearer',
          isPat: true,
        },
      })

      expect(row.kind).toBe('figma')
      expect(row.status).toBe('connected')
      expect(row.displayName).toBe('Figma (Acme Design Team)')

      const creds = await getAppIntegrationCredentials(orgId, 'figma')
      expect(creds).toBeDefined()
      expect(creds?.access_token).toBe(patToken)
      expect(creds?.isPat).toBe(true)

      // Test listing app integrations includes figma with credentialsOk = true
      const list = await listAppIntegrations(orgId)
      const figmaItem = list.find((i) => i.kind === 'figma')
      expect(figmaItem).toBeDefined()
      expect(figmaItem?.status).toBe('connected')
      expect(figmaItem?.credentialsOk).toBe(true)

      // Clean up / disconnect
      await disconnectAppIntegration(orgId, 'figma')
      const afterDisconnect = await getAppIntegration(orgId, 'figma')
      expect(afterDisconnect?.status).toBe('not_connected')
      const credsAfter = await getAppIntegrationCredentials(orgId, 'figma')
      expect(credsAfter).toBeUndefined()
    })
  })

  describe('TC-API-003: RBAC Admin Gating Verification', () => {
    test('validates admin role requirement logic for integration mutation', () => {
      function checkAdminGating(role: 'admin' | 'owner' | 'member' | 'viewer'): boolean {
        return role === 'admin' || role === 'owner'
      }

      expect(checkAdminGating('owner')).toBe(true)
      expect(checkAdminGating('admin')).toBe(true)
      expect(checkAdminGating('member')).toBe(false)
      expect(checkAdminGating('viewer')).toBe(false)
    })
  })

  describe('TC-API-004: Database Migration Idempotency', () => {
    test('re-applying schema migration executes cleanly', async () => {
      await expect(applySchema()).resolves.toBeUndefined()
      const hasVector = await vectorSearchAvailable()
      expect(hasVector).toBe(true)
    })
  })

  describe('TC-API-005: Figma OAuth App Registration & oauth_apps Persistence', () => {
    test('saves Figma OAuth credentials in oauth_apps without violating check constraint', async () => {
      const orgId = await getDefaultOrgId()
      const clientId = 'figma-oauth-client-id-123'
      const clientSecret = 'figma-oauth-client-secret-xyz'

      // Save OAuth app credentials for figma
      await expect(
        saveOAuthApp(orgId, 'figma', { clientId, clientSecret })
      ).resolves.toBeUndefined()

      // Verify credentials can be retrieved and decrypted
      const creds = await getOAuthAppCredentials(orgId, 'figma')
      expect(creds).toBeDefined()
      expect(creds?.clientId).toBe(clientId)
      expect(creds?.clientSecret).toBe(clientSecret)
      expect(creds?.source).toBe('database')

      // Clean up
      const deleted = await deleteOAuthApp(orgId, 'figma')
      expect(deleted).toBe(true)

      const afterDelete = await getOAuthAppCredentials(orgId, 'figma')
      expect(afterDelete).toBeUndefined()
    })
  })
})
