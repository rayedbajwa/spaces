import { describe, expect, test, afterEach } from 'bun:test'
import {
  parseFigmaUrl,
  normalizeNodeId,
  pruneNodeGeometry,
  figmaColorToHex,
  formatLayoutSummary,
  capOutput,
  MAX_OUTPUT_CHARACTERS,
  buildFigmaTools,
} from '../src/lib/figma-tools'
import { upsertAppIntegration } from '../src/lib/app-integrations'
import { getDefaultOrgId } from '../src/lib/orgs'

describe('Figma Autonomous Agent Tools Suite', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  describe('TC-FIG-001: URL Parser & Normalizer', () => {
    test('extracts fileKey and normalizes dashed nodeId to colon', () => {
      const url = 'https://www.figma.com/design/Vf123Abc456/Design-System?node-id=10-25&t=xyz'
      const parsed = parseFigmaUrl(url)
      expect(parsed).toBeDefined()
      expect(parsed?.fileKey).toBe('Vf123Abc456')
      expect(parsed?.nodeId).toBe('10:25')
    })

    test('extracts fileKey from legacy /file/ URLs', () => {
      const url = 'https://figma.com/file/OldKey789/Project-Mockups'
      const parsed = parseFigmaUrl(url)
      expect(parsed).toBeDefined()
      expect(parsed?.fileKey).toBe('OldKey789')
      expect(parsed?.nodeId).toBeUndefined()
    })

    test('handles encoded node IDs in query string', () => {
      const url = 'https://www.figma.com/design/Key123/File?node-id=100%3A200'
      const parsed = parseFigmaUrl(url)
      expect(parsed).toBeDefined()
      expect(parsed?.nodeId).toBe('100:200')
    })

    test('returns undefined for non-Figma URLs or invalid formats', () => {
      expect(parseFigmaUrl('https://github.com/rayedbajwa/spaces')).toBeUndefined()
      expect(parseFigmaUrl('not-a-url')).toBeUndefined()
      expect(parseFigmaUrl('')).toBeUndefined()
    })

    test('normalizeNodeId converts dashes to colons', () => {
      expect(normalizeNodeId('10-25')).toBe('10:25')
      expect(normalizeNodeId('10:25')).toBe('10:25')
      expect(normalizeNodeId('1%3A2')).toBe('1:2')
    })
  })

  describe('TC-FIG-002: Geometry Pruning & Layout Extraction', () => {
    test('converts Figma float color to hex correctly', () => {
      expect(figmaColorToHex({ r: 1, g: 1, b: 1 })).toBe('#FFFFFF')
      expect(figmaColorToHex({ r: 0, g: 0, b: 0 })).toBe('#000000')
      expect(figmaColorToHex({ r: 0.145, g: 0.388, b: 0.921 })).toBe('#2563EB')
    })

    test('strips vectorPaths and retains flexbox auto-layout properties', () => {
      const rawNode = {
        id: '10:25',
        name: 'Modal Container',
        type: 'FRAME',
        layoutMode: 'VERTICAL',
        primaryAxisAlignItems: 'CENTER',
        counterAxisAlignItems: 'MIN',
        itemSpacing: 16,
        paddingTop: 24,
        paddingRight: 24,
        paddingBottom: 24,
        paddingLeft: 24,
        cornerRadius: 12,
        absoluteBoundingBox: { x: 100, y: 100, width: 400, height: 300 },
        // Heavy vector payloads that must be pruned:
        vectorPaths: [{ data: 'M 0 0 L 100 100 Z', windingRule: 'NONZERO' }],
        fillGeometry: [{ path: 'M 10 10 L 20 20 Z' }],
        rawBezierStrokes: [1, 2, 3, 4, 5],
        fills: [
          {
            type: 'SOLID',
            color: { r: 1, g: 1, b: 1 },
            opacity: 1,
            visible: true,
          },
        ],
        strokes: [
          {
            type: 'SOLID',
            color: { r: 0.88, g: 0.91, b: 0.94 },
            visible: true,
          },
        ],
        strokeWeight: 1,
        children: [
          {
            id: '10:26',
            name: 'Title Text',
            type: 'TEXT',
            characters: 'Order Confirmation',
            style: {
              fontFamily: 'Inter',
              fontWeight: 600,
              fontSize: 18,
              lineHeightPx: 24,
            },
            vectorPaths: [{ data: 'heavy font glyph vector' }],
          },
        ],
      }

      const summary = pruneNodeGeometry(rawNode)

      // Pruned fields verify
      expect((summary as any).vectorPaths).toBeUndefined()
      expect((summary as any).fillGeometry).toBeUndefined()
      expect((summary as any).rawBezierStrokes).toBeUndefined()

      // Retained fields verify
      expect(summary.name).toBe('Modal Container')
      expect(summary.layoutMode).toBe('VERTICAL')
      expect(summary.itemSpacing).toBe(16)
      expect(summary.paddingTop).toBe(24)
      expect(summary.cornerRadius).toBe(12)
      expect(summary.fills?.[0].colorHex).toBe('#FFFFFF')
      expect(summary.children).toHaveLength(1)
      expect(summary.children?.[0].characters).toBe('Order Confirmation')
      expect(summary.children?.[0].typography?.fontFamily).toBe('Inter')

      const formatted = formatLayoutSummary(summary)
      expect(formatted).toContain('Auto-Layout: VERTICAL')
      expect(formatted).toContain('Gap: 16px')
      expect(formatted).toContain('Order Confirmation')
    })
  })

  describe('TC-FIG-003: Token Budget Capping & String Bounds', () => {
    test('enforces MAX_OUTPUT_CHARACTERS bound with clean notice', () => {
      expect(MAX_OUTPUT_CHARACTERS).toBe(24_000)

      const shortText = 'Small response text'
      expect(capOutput(shortText)).toBe(shortText)

      const longText = 'A'.repeat(30_000)
      const capped = capOutput(longText)
      expect(capped.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARACTERS)
      expect(capped).toContain('Output truncated to stay within token budget')
    })
  })

  describe('TC-FIG-004: Styles Extraction Tool', () => {
    test('figma_get_file_styles extracts colors and text styles', async () => {
      const orgId = await getDefaultOrgId()
      await upsertAppIntegration({
        orgId,
        kind: 'figma',
        status: 'connected',
        displayName: 'Figma Test',
        credentials: { access_token: '{t.id}', isPat: true },
      })

      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.includes('/files/TestFileKey/styles')) {
          return new Response(
            JSON.stringify({
              meta: {
                styles: [
                  { style_type: 'FILL', name: 'brand/primary', description: 'Primary brand blue' },
                  { style_type: 'TEXT', name: 'heading/xl', description: 'Page headers' },
                  { style_type: 'EFFECT', name: 'elevation/card', description: 'Soft drop shadow' },
                ],
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        }
        return new Response('Not Found', { status: 404 })
      }

      const tools = buildFigmaTools({ orgId })
      const result = await tools.figma_get_file_styles.execute({ fileKey: 'TestFileKey' })

      expect(result).toContain('Color Styles')
      expect(result).toContain('brand/primary')
      expect(result).toContain('Text Styles')
      expect(result).toContain('heading/xl')
      expect(result).toContain('Effect Styles')
      expect(result).toContain('elevation/card')
    })
  })

  describe('TC-FIG-005: Components Extraction Tool', () => {
    test('figma_get_components lists published components and canvas links', async () => {
      const orgId = await getDefaultOrgId()
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.includes('/files/TestFileKey/components')) {
          return new Response(
            JSON.stringify({
              meta: {
                components: [
                  {
                    name: 'PrimaryButton',
                    description: 'Primary action button element',
                    node_id: '5:10',
                  },
                ],
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        }
        return new Response('Not Found', { status: 404 })
      }

      const tools = buildFigmaTools({ orgId })
      const result = await tools.figma_get_components.execute({
        url: 'https://www.figma.com/design/TestFileKey/Components',
      })

      expect(result).toContain('PrimaryButton')
      expect(result).toContain('Primary action button element')
      expect(result).toContain('https://www.figma.com/design/TestFileKey?node-id=5%3A10')
    })
  })

  describe('TC-FIG-006: Missing Credentials Graceful Handling', () => {
    test('returns clean error when integration is not connected', async () => {
      const tools = buildFigmaTools({ orgId: '99999999-9999-9999-9999-999999999999' })
      await expect(
        tools.figma_inspect_node.execute({ url: 'https://www.figma.com/design/Abc/File?node-id=1-1' })
      ).rejects.toThrow('Figma integration is not connected')
    })
  })
})
