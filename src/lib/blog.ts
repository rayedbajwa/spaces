/**
 * The blog at spacesos.dev/blog: posts are Markdown in docs/blog/<slug>.md
 * with a small front matter (title, description, date, image), built into
 * static pages at build time (src/build-web.ts) so search engines and link
 * previews read them without JavaScript. The server serves them (lib/seo.ts
 * lists them in the sitemap).
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { marked } from 'marked'

export interface BlogPost {
  slug: string
  title: string
  description: string
  date: string
  image?: string
  html: string
}

const SITE = 'https://spacesos.dev'

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** `---\nkey: value\n---\nbody` → fields and body. */
export function parsePost(slug: string, source: string): BlogPost {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(source)
  const fields: Record<string, string> = {}
  for (const line of (match?.[1] ?? '').split('\n')) {
    const kv = /^(\w+):\s*(.*)$/.exec(line.trim())
    if (kv) fields[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, '')
  }
  const body = match ? match[2]! : source
  const title = fields.title ?? /^#\s+(.+)$/m.exec(body)?.[1] ?? slug
  return {
    slug,
    title,
    description: fields.description ?? '',
    date: fields.date ?? '',
    image: fields.image,
    // The page prints the title itself; a leading `# Title` in the body would repeat it.
    html: marked.parse(body.replace(/^\s*#\s+.+\n/, ''), { async: false, gfm: true }) as string,
  }
}

const STYLE = `
  :root { color-scheme: dark; --bg: #0a0a0b; --text: #e6e6e8; --muted: #8a8a94; --strong: #f5f5f7; --accent: #a4aef7; --border: rgba(255,255,255,.1); --code: #131316; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 18px/1.7 "Inter", -apple-system, "Segoe UI", sans-serif; }
  header, main, footer { max-width: 740px; margin: 0 auto; padding: 0 20px; }
  header { padding-top: 28px; display: flex; justify-content: space-between; align-items: center; font-size: 15px; }
  header a { color: var(--text); text-decoration: none; font-weight: 600; }
  header nav a { color: var(--muted); margin-left: 18px; font-weight: 500; }
  main { padding-top: 48px; padding-bottom: 64px; }
  h1 { font-size: 40px; line-height: 1.15; letter-spacing: -.8px; color: var(--strong); margin: 0 0 12px; }
  h2 { font-size: 27px; color: var(--strong); margin: 44px 0 12px; letter-spacing: -.3px; }
  h3 { font-size: 21px; color: var(--muted); font-weight: 500; margin: 0 0 24px; }
  .meta { color: var(--muted); font-size: 15px; margin-bottom: 32px; }
  a { color: var(--accent); }
  img, video { max-width: 100%; border-radius: 12px; border: 1px solid var(--border); margin: 12px 0; }
  pre { background: var(--code); border: 1px solid var(--border); border-radius: 10px; padding: 16px; overflow-x: auto; font-size: 14px; line-height: 1.5; }
  code { font-family: "JetBrains Mono", ui-monospace, Menlo, monospace; font-size: .88em; background: var(--code); padding: 2px 5px; border-radius: 4px; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; width: 100%; font-size: 16px; margin: 16px 0; }
  th, td { border-bottom: 1px solid var(--border); padding: 8px 10px; text-align: left; }
  hr { border: 0; border-top: 1px solid var(--border); margin: 40px 0; }
  em { color: var(--muted); }
  .posts { list-style: none; padding: 0; }
  .posts li { padding: 22px 0; border-bottom: 1px solid var(--border); }
  .posts a { font-size: 24px; font-weight: 650; color: var(--strong); text-decoration: none; }
  .posts p { margin: 6px 0 0; color: var(--muted); }
  footer { padding-bottom: 48px; color: var(--muted); font-size: 15px; }
`

function page(opts: { title: string; description: string; path: string; image?: string; body: string; type: 'article' | 'website'; date?: string }): string {
  const url = `${SITE}${opts.path}`
  const image = `${SITE}${opts.image ?? '/screenshots/board.png'}`
  const ld = opts.type === 'article'
    ? `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'BlogPosting', headline: opts.title, description: opts.description, datePublished: opts.date, image, url, author: { '@type': 'Person', name: 'Rayed Bajwa' }, publisher: { '@type': 'Organization', name: 'Spaces', url: SITE } }).replace(/</g, '\\u003c')}</script>`
    : ''
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
<meta name="description" content="${escapeHtml(opts.description)}">
<link rel="canonical" href="${url}">
<meta property="og:type" content="${opts.type}"><meta property="og:url" content="${url}">
<meta property="og:title" content="${escapeHtml(opts.title)}"><meta property="og:description" content="${escapeHtml(opts.description)}">
<meta property="og:image" content="${image}"><meta name="twitter:card" content="summary_large_image">
<link rel="alternate" type="application/rss+xml" title="Spaces blog" href="${SITE}/blog/rss.xml">
<link rel="preconnect" href="https://rsms.me/"><link rel="stylesheet" href="https://rsms.me/inter/inter.css">
<style>${STYLE}</style>${ld}
</head><body>
<header><a href="/">Spaces</a><nav><a href="/blog">Blog</a><a href="https://rayedbajwa.github.io/spaces/">Docs</a><a href="https://github.com/rayedbajwa/spaces">GitHub</a></nav></header>
<main>${opts.body}</main>
<footer>Spaces is the AI software factory for your team: specs go in, reviewed and tested pull requests come out. <a href="https://github.com/rayedbajwa/spaces">Star it on GitHub</a>.</footer>
</body></html>`
}

function formatDate(date: string): string {
  const d = new Date(`${date}T12:00:00Z`)
  return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
}

export function renderPost(post: BlogPost): string {
  return page({
    title: `${post.title} · Spaces`,
    description: post.description,
    path: `/blog/${post.slug}`,
    image: post.image,
    type: 'article',
    date: post.date,
    body: `<article><h1>${escapeHtml(post.title)}</h1><div class="meta">${escapeHtml(formatDate(post.date))} · Rayed Bajwa</div>${post.html}</article>`,
  })
}

export function renderIndex(posts: BlogPost[]): string {
  const items = posts.map((p) => `<li><a href="/blog/${p.slug}">${escapeHtml(p.title)}</a><p>${escapeHtml(formatDate(p.date))} · ${escapeHtml(p.description)}</p></li>`).join('')
  return page({ title: 'Blog · Spaces', description: 'Building Spaces, an assembly line of AI agents with human gates: what works, what breaks, and the numbers.', path: '/blog', type: 'website', body: `<h1>Blog</h1><ul class="posts">${items}</ul>` })
}

export function renderRss(posts: BlogPost[]): string {
  const items = posts.map((p) => `<item><title>${escapeHtml(p.title)}</title><link>${SITE}/blog/${p.slug}</link><guid>${SITE}/blog/${p.slug}</guid><pubDate>${new Date(`${p.date}T12:00:00Z`).toUTCString()}</pubDate><description>${escapeHtml(p.description)}</description></item>`).join('')
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Spaces blog</title><link>${SITE}/blog</link><description>Building an assembly line of AI agents with human gates.</description>${items}</channel></rss>`
}

/** Build docs/blog/*.md into <out>/blog: a page per post, the index, RSS and posts.json for the sitemap. */
export async function buildBlog(sourceDir: string, outDir: string): Promise<BlogPost[]> {
  const files = (await readdir(sourceDir).catch(() => [] as string[])).filter((f) => f.endsWith('.md'))
  const posts = await Promise.all(files.map(async (f) => parsePost(f.replace(/\.md$/, ''), await readFile(join(sourceDir, f), 'utf8'))))
  posts.sort((a, b) => b.date.localeCompare(a.date))
  const dir = join(outDir, 'blog')
  await mkdir(dir, { recursive: true })
  for (const post of posts) await writeFile(join(dir, `${post.slug}.html`), renderPost(post))
  await writeFile(join(dir, 'index.html'), renderIndex(posts))
  await writeFile(join(dir, 'rss.xml'), renderRss(posts))
  await writeFile(join(dir, 'posts.json'), JSON.stringify(posts.map(({ slug, date }) => ({ slug, date }))))
  return posts
}
