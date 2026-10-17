import { describe, expect, test } from 'bun:test'
import { landingHtml, llmsTxt, robotsTxt, sitemapXml } from '../src/lib/seo'

const SHELL = '<html><head><title>Spaces</title></head><body><div id="root"></div></body></html>'

describe('seo', () => {
  test('the landing HTML carries the page text and JSON-LD', () => {
    const html = landingHtml(SHELL, 'https://spacesos.dev')
    expect(html).toContain('<h1>The AI software factory for your team.</h1>')
    expect(html).toContain('<h3>Specify <small>Human gate</small></h3>')
    expect(html).toContain('Bring your own models')
    const ld = JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/)![1])
    expect(ld).toMatchObject({ '@type': 'SoftwareApplication', name: 'Spaces', url: 'https://spacesos.dev/', applicationCategory: 'DeveloperApplication' })
  })

  test('robots keeps app pages out and points at the sitemap', () => {
    const robots = robotsTxt('https://spacesos.dev')
    expect(robots).toContain('Disallow: /api/')
    expect(robots).toContain('Disallow: /spaces/')
    expect(robots).toContain('Sitemap: https://spacesos.dev/sitemap.xml')
    expect(sitemapXml('https://spacesos.dev')).toContain('<loc>https://spacesos.dev/</loc>')
  })

  test('llms.txt summarises the product with the stages and links', () => {
    const text = llmsTxt('https://spacesos.dev')
    expect(text).toStartWith('# Spaces\n\n> The AI software factory for your team.')
    expect(text).toContain('- Verify (human approval gate):')
    expect(text).toContain('[Source code and README](https://github.com/rayedbajwa/spaces)')
    expect(text).toContain('Source-available, free for personal use')
  })
})
