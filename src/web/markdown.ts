import { marked } from 'marked'

/**
 * Markdown → HTML for assistant answers and documents. `marked` does not sanitise, so strip
 * the few things that could execute: script/style/iframe blocks, inline event
 * handlers and javascript: URLs.
 */
export function renderMarkdown(text: string): string {
  const html = marked.parse(text ?? '', { async: false, gfm: true, breaks: true }) as string
  return html
    .replace(/<(script|style|iframe|object|embed)[\s\S]*?<\/\1>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1="#"')
}
