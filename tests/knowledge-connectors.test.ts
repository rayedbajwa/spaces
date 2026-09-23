import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import {
  validateSourceConfig,
  importFigma,
} from '../src/lib/knowledge-connectors'
import type { KnowledgeSourceRow } from '../src/lib/knowledge-store'
import { upsertAppIntegration } from '../src/lib/app-integrations'
import { getDefaultOrgId } from '../src/lib/orgs'

describe('Figma Knowledge Connector', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  describe('TC-KNOW-001: Source Config Validation', () => {
    test('validates correct fileUrls and fileKeys', () => {
      expect(
        validateSourceConfig('figma', {
          fileUrls: ['https://www.figma.com/design/Vf123Abc456/Acme-Design-System'],
        })
      ).toBeUndefined()

      expect(
        validateSourceConfig('figma', {
          fileKeys: ['Vf123Abc456'],
        })
      ).toBeUndefined()
    })

    test('rejects empty configuration without files or urls', () => {
      const result = validateSourceConfig('figma', {})
      expect(result).toBeDefined()
      expect(result).toContain('Figma')
    })
  })

  describe('TC-KNOW-002: Document Transformation & Deep Links', () => {
    test('transforms styles and components into structured markdown documents', async () => {
      const orgId = await getDefaultOrgId()
      await upsertAppIntegration({
        orgId,
        kind: 'figma',
        status: 'connected',
        displayName: 'Figma Test',
        credentials: { access_token: '<SECRET_24>', isPat: true },
      })

      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.includes('/v1/files/TestKey123?depth=1')) {
          return new Response(
            JSON.stringify({
              name: 'Acme Design System',
              lastModified: '2026-09-23T12:00:00Z',
              version: '1001',
              document: { id: '0:0', name: 'Document', type: 'DOCUMENT' },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        }
        if (url.includes('/v1/files/TestKey123/styles')) {
          return new Response(
            JSON.stringify({
              meta: {
                styles: [
                  {
                    key: 'token_color_primary',
                    file_key: 'TestKey123',
                    node_id: '1:10',
                    style_type: 'FILL',
                    name: 'brand/primary',
                    description: 'Primary brand blue',
                  },
                  {
                    key: 'token_text_h1',
                    file_key: 'TestKey123',
                    node_id: '1:20',
                    style_type: 'TEXT',
                    name: 'typography/h1',
                    description: 'Heading level 1',
                  },
                ],
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        }
        if (url.includes('/v1/files/TestKey123/components')) {
          return new Response(
            JSON.stringify({
              meta: {
                components: [
                  {
                    key: 'comp_btn',
                    file_key: 'TestKey123',
                    node_id: '2:50',
                    name: 'Button',
                    description: 'Standard interactive button with variant states.',
                  },
                ],
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        }
        if (url.includes('/v1/files/TestKey123/component_sets')) {
          return new Response(
            JSON.stringify({
              meta: {
                component_sets: [
                  {
                    key: 'set_btn',
                    file_key: 'TestKey123',
                    node_id: '2:40',
                    name: 'Button Variants',
                    description: 'Button component set with Size and Intent properties.',
                  },
                ],
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        }
        return new Response('Not Found', { status: 404 })
      }

      const mockSource: KnowledgeSourceRow = {
        orgId,
        sourceId: '11111111-1111-1111-1111-111111111111',
        teamId: null,
        teamName: null,
        kind: 'figma',
        label: 'Acme Design System',
        config: {
          fileKeys: ['TestKey123'],
          extractTokens: true,
          extractComponents: true,
        },
        enabled: true,
        syncIntervalMinutes: 360,
        cursor: {},
        syncRequestedAt: null,
        lastSyncStartedAt: null,
        lastSyncFinishedAt: null,
        lastSyncStatus: null,
        lastSyncError: null,
        lastSyncStats: {},
        documentCount: 0,
        chunkCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }

      const batch = await importFigma(mockSource)
      expect(batch.complete).toBe(true)
      expect(batch.hasMore).toBe(false)
      expect(batch.documents.length).toBeGreaterThanOrEqual(3)

      // Verify overview style guide doc
      const stylesOverview = batch.documents.find((d) => d.externalId.includes('styles:overview'))
      expect(stylesOverview).toBeDefined()
      expect(stylesOverview?.title).toContain('Acme Design System')
      expect(stylesOverview?.content).toContain('brand/primary')
      expect(stylesOverview?.content).toContain('typography/h1')

      // Verify component doc has deep link
      const btnDoc = batch.documents.find((d) => d.externalId.includes('comp_btn') || d.externalId.includes('2:50'))
      expect(btnDoc).toBeDefined()
      expect(btnDoc?.url).toContain('https://www.figma.com/design/TestKey123?node-id=2:50')
      expect(btnDoc?.content).toContain('Button')
      expect(btnDoc?.content).toContain('Standard interactive button')
    })
  })

  describe('TC-KNOW-003: Incremental Sync Cursor Tracking', () => {
    test('skips unchanged files when version ID matches cursor', async () => {
      const orgId = await getDefaultOrgId()
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.includes('/v1/files/UnchangedKey?depth=1')) {
          return new Response(
            JSON.stringify({
              name: 'Design System',
              lastModified: '2026-09-23T12:00:00Z',
              version: 'v42',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        }
        return new Response('Not Found', { status: 404 })
      }

      const mockSource: KnowledgeSourceRow = {
        orgId,
        sourceId: '22222222-2222-2222-2222-222222222222',
        teamId: null,
        teamName: null,
        kind: 'figma',
        label: 'Design System',
        config: {
          fileKeys: ['UnchangedKey'],
        },
        enabled: true,
        syncIntervalMinutes: 360,
        cursor: {
          fileVersions: {
            UnchangedKey: 'v42',
          },
        },
        syncRequestedAt: null,
        lastSyncStartedAt: null,
        lastSyncFinishedAt: null,
        lastSyncStatus: null,
        lastSyncError: null,
        lastSyncStats: {},
        documentCount: 5,
        chunkCount: 10,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }

      const batch = await importFigma(mockSource)
      expect(batch.complete).toBe(true)
      expect(batch.documents.length).toBe(0) // Unchanged file skipped
    })
  })
})
