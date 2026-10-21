import { describe, expect, test } from 'bun:test'
import { parsePost, renderIndex, renderPost, renderRss } from '../src/lib/blog'
import { sitemapXml } from '../src/lib/seo'

const SOURCE = `---
title: What Broke
description: Lessons from agents.
date: 2026-10-21
image: /screenshots/board.png
---

# What Broke

### A subtitle

Body with a [link](https://example.com) and <video src="/media/spaces-demo.mp4"></video>.
`

describe('blog', () => {
  test('front matter and body', () => {
    const post = parsePost('what-broke', SOURCE)
    expect(post).toMatchObject({ slug: 'what-broke', title: 'What Broke', description: 'Lessons from agents.', date: '2026-10-21', image: '/screenshots/board.png' })
    expect(post.html).not.toContain('<h1')            // the page prints the title once
    expect(post.html).toContain('<h3>A subtitle</h3>')
    expect(post.html).toContain('<video src="/media/spaces-demo.mp4">')
  })

  test('the post page has its canonical URL, social tags and article data', () => {
    const html = renderPost(parsePost('what-broke', SOURCE))
    expect(html).toContain('<link rel="canonical" href="https://spacesos.dev/blog/what-broke">')
    expect(html).toContain('<meta property="og:image" content="https://spacesos.dev/screenshots/board.png">')
    expect(html).toContain('"@type":"BlogPosting"')
    expect(html).toContain('October 21, 2026')
  })

  test('index, RSS and sitemap list the post', () => {
    const post = parsePost('what-broke', SOURCE)
    expect(renderIndex([post])).toContain('href="/blog/what-broke"')
    expect(renderRss([post])).toContain('<link>https://spacesos.dev/blog/what-broke</link>')
    const map = sitemapXml('https://spacesos.dev', [{ slug: 'what-broke', date: '2026-10-21' }])
    expect(map).toContain('<loc>https://spacesos.dev/blog</loc>')
    expect(map).toContain('<loc>https://spacesos.dev/blog/what-broke</loc><lastmod>2026-10-21</lastmod>')
  })
})
