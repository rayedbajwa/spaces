import { getAppIntegration, getAppIntegrationCredentials } from './app-integrations'
import { log } from './logger'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'

const figmaLog = log.child({ mod: 'figma-tools' })

export interface FigmaNodeRef {
  fileKey: string
  nodeId?: string
  url?: string
}

export interface FigmaLayoutSummary {
  id: string
  name: string
  type: string
  visible: boolean
  width?: number
  height?: number
  layoutMode?: 'NONE' | 'HORIZONTAL' | 'VERTICAL'
  primaryAxisAlignItems?: string
  counterAxisAlignItems?: string
  paddingTop?: number
  paddingRight?: number
  paddingBottom?: number
  paddingLeft?: number
  itemSpacing?: number
  fills?: Array<{ type: string; colorHex?: string; opacity?: number }>
  strokes?: Array<{ type: string; colorHex?: string; weight?: number }>
  cornerRadius?: number | number[]
  typography?: {
    fontFamily: string
    fontWeight: number
    fontSize: number
    lineHeightPx?: number
    letterSpacing?: number
  }
  characters?: string
  children?: FigmaLayoutSummary[]
}

/**
 * Parse and normalize a Figma file or node URL.
 * e.g. https://www.figma.com/design/Vf123Abc456/Project?node-id=10-25
 * Converts node-id dashes to colons ('10-25' -> '10:25').
 */
export function parseFigmaUrl(rawUrl: string): { fileKey: string; nodeId?: string } | undefined {
  if (!rawUrl || typeof rawUrl !== 'string') return undefined
  try {
    const parsed = new URL(rawUrl)
    if (!parsed.hostname.includes('figma.com')) return undefined
    const segments = parsed.pathname.split('/').filter(Boolean)
    const typeIdx = segments.findIndex((s) => s === 'design' || s === 'file')
    if (typeIdx === -1 || typeIdx + 1 >= segments.length) return undefined
    const fileKey = segments[typeIdx + 1]
    const rawNodeId = parsed.searchParams.get('node-id')
    let nodeId: string | undefined
    if (rawNodeId) {
      nodeId = decodeURIComponent(rawNodeId).replace(/-/g, ':')
    }
    return { fileKey, nodeId }
  } catch {
    return undefined
  }
}

/**
 * Normalizes a Figma node ID (converting dashes to colons if needed).
 */
export function normalizeNodeId(nodeId: string): string {
  return decodeURIComponent(nodeId).replace(/-/g, ':')
}

/**
 * Convert Figma RGBA color object (floats 0..1) to #RRGGBB hex string.
 */
export function figmaColorToHex(color?: { r: number; g: number; b: number; a?: number }): string | undefined {
  if (!color) return undefined
  const toHex = (n: number) =>
    Math.min(255, Math.max(0, Math.round(n * 255)))
      .toString(16)
      .padStart(2, '0')
  return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`.toUpperCase()
}

/**
 * Prune heavy vector geometry, vectorNetworks, bezier paths, and extract layout properties.
 */
export function pruneNodeGeometry(node: Record<string, any>, currentDepth = 1, maxDepth = 2): FigmaLayoutSummary {
  const bbox = node.absoluteBoundingBox || node.size || {}
  const summary: FigmaLayoutSummary = {
    id: node.id || '',
    name: node.name || '',
    type: node.type || '',
    visible: node.visible !== false,
  }

  if (bbox.width !== undefined) summary.width = Math.round(bbox.width)
  if (bbox.height !== undefined) summary.height = Math.round(bbox.height)

  if (node.layoutMode && node.layoutMode !== 'NONE') {
    summary.layoutMode = node.layoutMode
    summary.primaryAxisAlignItems = node.primaryAxisAlignItems
    summary.counterAxisAlignItems = node.counterAxisAlignItems
    if (node.itemSpacing !== undefined) summary.itemSpacing = node.itemSpacing
    if (node.paddingTop !== undefined) summary.paddingTop = node.paddingTop
    if (node.paddingRight !== undefined) summary.paddingRight = node.paddingRight
    if (node.paddingBottom !== undefined) summary.paddingBottom = node.paddingBottom
    if (node.paddingLeft !== undefined) summary.paddingLeft = node.paddingLeft
  }

  if (Array.isArray(node.fills) && node.fills.length > 0) {
    summary.fills = node.fills
      .filter((f: any) => f.visible !== false)
      .map((f: any) => ({
        type: f.type,
        colorHex: figmaColorToHex(f.color),
        opacity: f.opacity !== undefined ? f.opacity : 1,
      }))
  }

  if (Array.isArray(node.strokes) && node.strokes.length > 0) {
    summary.strokes = node.strokes
      .filter((s: any) => s.visible !== false)
      .map((s: any) => ({
        type: s.type,
        colorHex: figmaColorToHex(s.color),
        weight: node.strokeWeight,
      }))
  }

  if (node.cornerRadius !== undefined) {
    summary.cornerRadius = node.cornerRadius
  } else if (node.rectangleCornerRadii) {
    summary.cornerRadius = node.rectangleCornerRadii
  }

  if (node.type === 'TEXT') {
    if (node.characters) summary.characters = node.characters
    if (node.style) {
      summary.typography = {
        fontFamily: node.style.fontFamily || 'sans-serif',
        fontWeight: node.style.fontWeight || 400,
        fontSize: Math.round(node.style.fontSize || 14),
        lineHeightPx: node.style.lineHeightPx ? Math.round(node.style.lineHeightPx) : undefined,
        letterSpacing: node.style.letterSpacing ? Math.round(node.style.letterSpacing) : undefined,
      }
    }
  }

  if (Array.isArray(node.children) && currentDepth < maxDepth) {
    summary.children = node.children
      .filter((child: any) => child.visible !== false)
      .map((child: any) => pruneNodeGeometry(child, currentDepth + 1, maxDepth))
  }

  return summary
}

/**
 * Format layout summary into human-readable text for agents within token bounds.
 */
export function formatLayoutSummary(summary: FigmaLayoutSummary, indent = 0): string {
  const pad = '  '.repeat(indent)
  const lines: string[] = []

  const dims = summary.width && summary.height ? `Bounds: ${summary.width}x${summary.height}` : ''
  lines.push(`${pad}${summary.name} (Type: ${summary.type}${dims ? `, ${dims}` : ''})`)

  if (summary.layoutMode) {
    const layoutDetails = [
      `Auto-Layout: ${summary.layoutMode}`,
      summary.itemSpacing !== undefined ? `Gap: ${summary.itemSpacing}px` : null,
      summary.paddingTop !== undefined
        ? `Padding: [T:${summary.paddingTop}px, R:${summary.paddingRight ?? 0}px, B:${summary.paddingBottom ?? 0}px, L:${summary.paddingLeft ?? 0}px]`
        : null,
      summary.primaryAxisAlignItems ? `Align: ${summary.primaryAxisAlignItems}` : null,
    ]
      .filter(Boolean)
      .join(', ')
    lines.push(`${pad}  ${layoutDetails}`)
  }

  if (summary.fills?.length) {
    const fillsText = summary.fills.map((f) => `${f.colorHex || f.type} (${Math.round((f.opacity ?? 1) * 100)}%)`).join(', ')
    lines.push(`${pad}  Fills: ${fillsText}`)
  }

  if (summary.strokes?.length) {
    const strokesText = summary.strokes.map((s) => `${s.colorHex || s.type}${s.weight ? ` (${s.weight}px)` : ''}`).join(', ')
    lines.push(`${pad}  Strokes: ${strokesText}`)
  }

  if (summary.cornerRadius) {
    lines.push(`${pad}  Corner Radius: ${Array.isArray(summary.cornerRadius) ? summary.cornerRadius.join('/') : summary.cornerRadius}px`)
  }

  if (summary.characters) {
    lines.push(`${pad}  Text: "${summary.characters.slice(0, 100).replace(/\n/g, ' ')}"`)
  }

  if (summary.typography) {
    const typo = summary.typography
    lines.push(`${pad}  Typography: ${typo.fontFamily} ${typo.fontWeight} ${typo.fontSize}px${typo.lineHeightPx ? ` (line-height: ${typo.lineHeightPx}px)` : ''}`)
  }

  if (summary.children?.length) {
    lines.push(`${pad}  Children:`)
    for (const child of summary.children) {
      lines.push(formatLayoutSummary(child, indent + 2))
    }
  }

  return lines.join('\n')
}

export const MAX_OUTPUT_CHARACTERS = 24_000

export function capOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARACTERS) return text
  return text.slice(0, MAX_OUTPUT_CHARACTERS - 100) + '\n\n... [Output truncated to stay within token budget]'
}

/**
 * Verify Figma token credentials against GET https://api.figma.com/v1/me.
 */
export async function verifyFigmaToken(
  token: string,
  isPat?: boolean,
): Promise<{ ok: boolean; user?: { id: string; handle: string; email: string }; error?: string }> {
  try {
    const isExplicitPat = isPat ?? (token.startsWith('figd_') || token.length >= 30)
    const headers: Record<string, string> = isExplicitPat
      ? { 'X-Figma-Token': token }
      : { Authorization: `Bearer ${token}` }

    let res = await fetch('https://api.figma.com/v1/me', { headers })
    if (!res.ok && isExplicitPat === false) {
      res = await fetch('https://api.figma.com/v1/me', { headers: { 'X-Figma-Token': token } })
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      return {
        ok: false,
        error: `Figma rejected credentials (${res.status} ${res.statusText}): ${errText.slice(0, 300) || 'Invalid token or revoked access.'}`,
      }
    }

    const data = (await res.json()) as { id: string; handle?: string; email?: string }
    return {
      ok: true,
      user: {
        id: String(data.id || ''),
        handle: data.handle || '',
        email: data.email || '',
      },
    }
  } catch (err) {
    return {
      ok: false,
      error: `Failed to connect to Figma API: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/**
 * Fetch from Figma REST API with rate limit exponential backoff.
 */
export async function fetchFigmaApi(
  endpointPath: string,
  token: string,
  isPat = true,
  options: RequestInit = {},
  retries = 3,
): Promise<any> {
  const url = endpointPath.startsWith('http') ? endpointPath : `https://api.figma.com/v1${endpointPath.startsWith('/') ? '' : '/'}${endpointPath}`
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(isPat ? { 'X-Figma-Token': token } : { Authorization: `Bearer ${token}` }),
    ...((options.headers as Record<string, string>) || {}),
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, { ...options, headers })

    if (res.status === 429) {
      const retryAfter = res.headers.get('retry-after')
      const delayMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : Math.min(1000 * Math.pow(2, attempt), 8000)
      figmaLog.warn('Figma rate limit hit (429), backing off', { delayMs, attempt })
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, delayMs))
        continue
      }
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(`Figma API error (${res.status} ${res.statusText}): ${errText.slice(0, 300)}`)
    }

    return await res.json()
  }
}

/**
 * Autonomous agent tools for inspecting Figma designs.
 */
export function buildFigmaTools(context: { orgId: string; projectId?: string }) {
  async function resolveCredentials(): Promise<{ token: string; isPat: boolean }> {
    const creds = await getAppIntegrationCredentials(context.orgId, 'figma')
    if (!creds?.access_token || typeof creds.access_token !== 'string') {
      throw new Error('Figma integration is not connected. Connect Figma under Organization → Integrations.')
    }
    return {
      token: creds.access_token,
      isPat: creds.isPat !== false,
    }
  }

  return {
    figma_inspect_node: {
      name: 'figma_inspect_node',
      description: 'Inspects a Figma frame or component node, returning auto-layout properties, typography, fills, and child hierarchy.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Figma file or node URL' },
          fileKey: { type: 'string', description: 'Figma file key' },
          nodeId: { type: 'string', description: 'Figma node ID (e.g. 10:25)' },
          depth: { type: 'integer', minimum: 1, maximum: 4, default: 2, description: 'Traversal depth' },
        },
      },
      execute: async (args: { url?: string; fileKey?: string; nodeId?: string; depth?: number }) => {
        let fileKey = args.fileKey
        let nodeId = args.nodeId

        if (args.url) {
          const parsed = parseFigmaUrl(args.url)
          if (parsed) {
            fileKey = fileKey || parsed.fileKey
            nodeId = nodeId || parsed.nodeId
          }
        }

        if (!fileKey) {
          return 'Error: Please provide a valid Figma URL or fileKey.'
        }

        const normalizedNodeId = nodeId ? normalizeNodeId(nodeId) : undefined
        const { token, isPat } = await resolveCredentials()

        const path = normalizedNodeId
          ? `/files/${fileKey}/nodes?ids=${encodeURIComponent(normalizedNodeId)}`
          : `/files/${fileKey}?depth=${args.depth ?? 2}`

        const data = await fetchFigmaApi(path, token, isPat)

        let targetNode = null
        if (normalizedNodeId) {
          targetNode = data.nodes?.[normalizedNodeId]?.document
        } else {
          targetNode = data.document
        }

        if (!targetNode) {
          return `Error: Node ${nodeId ?? 'document'} not found in Figma file ${fileKey}.`
        }

        const summary = pruneNodeGeometry(targetNode, 1, args.depth ?? 2)
        const formatted = formatLayoutSummary(summary)
        return capOutput(formatted)
      },
    },

    figma_get_file_styles: {
      name: 'figma_get_file_styles',
      description: 'Retrieves published color styles, typography tokens, and elevation effects defined in a Figma file.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Figma file URL' },
          fileKey: { type: 'string', description: 'Figma file key' },
        },
      },
      execute: async (args: { url?: string; fileKey?: string }) => {
        let fileKey = args.fileKey
        if (args.url) {
          const parsed = parseFigmaUrl(args.url)
          if (parsed) fileKey = fileKey || parsed.fileKey
        }
        if (!fileKey) return 'Error: Please provide a valid Figma URL or fileKey.'

        const { token, isPat } = await resolveCredentials()
        const data = await fetchFigmaApi(`/files/${fileKey}/styles`, token, isPat)

        const styles = data.meta?.styles || []
        if (styles.length === 0) {
          return `No published styles found in Figma file ${fileKey}.`
        }

        const colorStyles: string[] = []
        const textStyles: string[] = []
        const effectStyles: string[] = []

        for (const s of styles) {
          const desc = s.description ? ` (${s.description})` : ''
          if (s.style_type === 'FILL') colorStyles.push(`- ${s.name}${desc}`)
          else if (s.style_type === 'TEXT') textStyles.push(`- ${s.name}${desc}`)
          else if (s.style_type === 'EFFECT') effectStyles.push(`- ${s.name}${desc}`)
        }

        const sections = [
          `Published Styles for File ${fileKey}:`,
          colorStyles.length ? `\nColor Styles:\n${colorStyles.join('\n')}` : '',
          textStyles.length ? `\nText Styles:\n${textStyles.join('\n')}` : '',
          effectStyles.length ? `\nEffect Styles:\n${effectStyles.join('\n')}` : '',
        ].filter(Boolean)

        return capOutput(sections.join('\n'))
      },
    },

    figma_get_components: {
      name: 'figma_get_components',
      description: 'Retrieves published components and component set variants from a Figma file.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Figma file URL' },
          fileKey: { type: 'string', description: 'Figma file key' },
        },
      },
      execute: async (args: { url?: string; fileKey?: string }) => {
        let fileKey = args.fileKey
        if (args.url) {
          const parsed = parseFigmaUrl(args.url)
          if (parsed) fileKey = fileKey || parsed.fileKey
        }
        if (!fileKey) return 'Error: Please provide a valid Figma URL or fileKey.'

        const { token, isPat } = await resolveCredentials()
        const data = await fetchFigmaApi(`/files/${fileKey}/components`, token, isPat)

        const components = data.meta?.components || []
        if (components.length === 0) {
          return `No published components found in Figma file ${fileKey}.`
        }

        const lines = [`Components in Figma file ${fileKey}:`]
        components.slice(0, 100).forEach((c: any, i: number) => {
          lines.push(`${i + 1}. Component: ${c.name}`)
          if (c.description) lines.push(`   Description: ${c.description}`)
          if (c.node_id) lines.push(`   Node Link: https://www.figma.com/design/${fileKey}?node-id=${encodeURIComponent(c.node_id)}`)
        })

        return capOutput(lines.join('\n'))
      },
    },
  }
}

function textResult(text: string, details: unknown = {}) {
  return { content: [{ type: 'text' as const, text }], details }
}

/**
 * Tool definitions compatible with Pi Coding Agent SDK session customTools.
 */
export async function buildFigmaToolDefinitions(context: { orgId: string; projectId?: string }): Promise<ToolDefinition[]> {
  const integration = await getAppIntegration(context.orgId, 'figma')
  if (integration?.status !== 'connected') return []
  const tools = buildFigmaTools(context)
  return [
    {
      name: 'figma_inspect_node',
      label: 'Inspect Figma Node',
      description: tools.figma_inspect_node.description,
      parameters: tools.figma_inspect_node.parameters as any,
      async execute(_toolCallId, params) {
        const text = await tools.figma_inspect_node.execute(params as any)
        return textResult(text)
      },
    },
    {
      name: 'figma_get_file_styles',
      label: 'Get Figma File Styles',
      description: tools.figma_get_file_styles.description,
      parameters: tools.figma_get_file_styles.parameters as any,
      async execute(_toolCallId, params) {
        const text = await tools.figma_get_file_styles.execute(params as any)
        return textResult(text)
      },
    },
    {
      name: 'figma_get_components',
      label: 'Get Figma Components',
      description: tools.figma_get_components.description,
      parameters: tools.figma_get_components.parameters as any,
      async execute(_toolCallId, params) {
        const text = await tools.figma_get_components.execute(params as any)
        return textResult(text)
      },
    },
  ]
}
