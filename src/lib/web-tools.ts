import type { ToolDefinition } from '@earendil-works/pi-coding-agent'

/**
 * Web access for Pi agent sessions: fetch a page as readable text, and search
 * the web. Both are plain HTTP (no browser process), safe to give every
 * session, and complement the CLI (`bash`) tool that agents already have for
 * `gh`, `curl`, package managers and the app itself.
 */

const MAX_CHARS = 20_000
const TIMEOUT_MS = 20_000

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<h([1-6])[^>]*>/gi, (_m, level: string) => `\n${'#'.repeat(Number(level))} `)
    .replace(/<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) => {
      const label = text.replace(/<[^>]+>/g, '').trim()
      return label && /^https?:\/\//.test(href) ? `${label} (${href})` : label
    })
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function textResult(text: string, details: unknown = {}) {
  return { content: [{ type: 'text' as const, text }], details }
}

function isPrivateHost(hostname: string): boolean {
  return /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0|\[::1\]|::1)/.test(hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
}

export async function fetchPageAsText(url: string, options: { allowPrivate?: boolean } = {}): Promise<{ title?: string; text: string; status: number; contentType: string; finalUrl: string }> {
  const parsed = new URL(url)
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('Only http(s) URLs are supported.')
  if (!options.allowPrivate && isPrivateHost(parsed.hostname)) throw new Error('Refusing to fetch private/loopback addresses; use bash + curl for local services.')
  const response = await fetch(parsed.toString(), {
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; pi-speckit-pdlc agent)', Accept: 'text/html,application/json,text/plain,*/*' },
  })
  const contentType = response.headers.get('content-type') ?? ''
  const raw = await response.text()
  let text: string
  let title: string | undefined
  if (/json/.test(contentType)) {
    try { text = JSON.stringify(JSON.parse(raw), null, 2) } catch { text = raw }
  } else if (/html/.test(contentType) || /^\s*</.test(raw)) {
    title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1]?.trim()
    text = htmlToText(raw)
  } else {
    text = raw
  }
  return { title, text: text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n\n…[truncated ${text.length - MAX_CHARS} chars]` : text, status: response.status, contentType, finalUrl: response.url || parsed.toString() }
}

export async function searchWeb(query: string, limit = 8): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; pi-speckit-pdlc agent)' },
  })
  if (!response.ok) throw new Error(`Search failed (${response.status}).`)
  const html = await response.text()
  const results: Array<{ title: string; url: string; snippet: string }> = []
  const blocks = html.split(/class="result\b/).slice(1)
  for (const block of blocks) {
    const link = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
    if (!link) continue
    let url = link[1]!
    const uddg = /[?&]uddg=([^&]+)/.exec(url)
    if (uddg) url = decodeURIComponent(uddg[1]!)
    if (url.startsWith('//')) url = `https:${url}`
    const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/(a|div|span)>/i.exec(block)?.[1] ?? ''
    results.push({ title: htmlToText(link[2]!), url, snippet: htmlToText(snippet) })
    if (results.length >= limit) break
  }
  return results
}

/** `web_fetch` + `web_search` tool definitions for a Pi session. */
export function buildWebTools(): ToolDefinition[] {
  const fetchTool: ToolDefinition = {
    name: 'web_fetch',
    label: 'Fetch a web page',
    description: 'Fetch a public http(s) URL and return it as readable text (HTML is stripped, JSON pretty-printed, truncated at 20k chars). Use for documentation, API references, issue pages, changelogs, or to check a deployed environment\'s public pages. For local services use bash + curl.',
    promptSnippet: 'web_fetch(url): read a public web page as text',
    parameters: { type: 'object', properties: { url: { type: 'string', description: 'Absolute http(s) URL.' } }, required: ['url'] } as unknown as ToolDefinition['parameters'],
    executionMode: 'parallel',
    async execute(_id, params) {
      const p = params as { url: string }
      try {
        const page = await fetchPageAsText(p.url)
        return textResult(`${page.title ? `# ${page.title}\n` : ''}URL: ${page.finalUrl} (HTTP ${page.status}, ${page.contentType || 'unknown type'})\n\n${page.text}`, { url: page.finalUrl, status: page.status })
      } catch (error) {
        return textResult(`web_fetch failed: ${error instanceof Error ? error.message : String(error)}`, { error: true })
      }
    },
  }
  const searchTool: ToolDefinition = {
    name: 'web_search',
    label: 'Search the web',
    description: 'Search the web (DuckDuckGo) and return up to 8 results with title, URL and snippet. Use it to find documentation, error messages, library versions or release notes; then web_fetch the best result.',
    promptSnippet: 'web_search(query): find pages, then web_fetch them',
    parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['query'] } as unknown as ToolDefinition['parameters'],
    executionMode: 'parallel',
    async execute(_id, params) {
      const p = params as { query: string; limit?: number }
      try {
        const results = await searchWeb(p.query, p.limit ?? 8)
        if (results.length === 0) return textResult(`No results for "${p.query}".`, { results: [] })
        return textResult(results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`).join('\n'), { results })
      } catch (error) {
        return textResult(`web_search failed: ${error instanceof Error ? error.message : String(error)}`, { error: true })
      }
    },
  }
  return [fetchTool, searchTool]
}
