import { marked } from 'marked'

/**
 * Markdown → HTML for assistant answers and documents. `marked` does not sanitise, so strip
 * the few things that could execute: script/style/iframe blocks, inline event
 * handlers and javascript: URLs.
 */
export function renderMarkdown(text: string): string {
  const html = marked.parse(text ?? '', { async: false, gfm: true, breaks: true }) as string
  return html
    // Task lists (- [x] T001 …): a check mark, not a form control — the app's
    // input styles would stretch a real checkbox across the line.
    .replace(/<li>\s*<input([^>]*?)type="checkbox"([^>]*)>\s*/gi, (_all, before: string, after: string) => {
      const done = /\bchecked\b/i.test(`${before} ${after}`)
      return `<li class="task-item${done ? ' done' : ''}"><span class="task-box" role="img" aria-label="${done ? 'done' : 'not done'}">${done ? '✓' : ''}</span>`
    })
    .replace(/<(script|style|iframe|object|embed)[\s\S]*?<\/\1>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1="#"')
}
