/**
 * What crawlers, link previews and AI assistants read about Spaces. The
 * landing page is a React app, so its HTML body was an empty `#root`; for a
 * signed-out visit to `/` the server now puts the page's own words there
 * (React replaces them on load) with JSON-LD, and serves robots.txt,
 * sitemap.xml and llms.txt.
 */

import { DOCS_URL, FEATURES, LEDE, REPO_URL, STATIONS, SUMMARY, TAGLINE } from './landing-content'

// App pages are behind sign-in; only the landing page is for search.
const PRIVATE_PATHS = ['/api/', '/spaces/', '/teams/', '/approvals/', '/invite/', '/join/', '/slack-link/', '/integrations/', '/intake', '/outbound', '/organization', '/login']

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function robotsTxt(origin: string): string {
  return ['User-agent: *', 'Allow: /', ...PRIVATE_PATHS.map((p) => `Disallow: ${p}`), '', `Sitemap: ${origin}/sitemap.xml`, ''].join('\n')
}

export function sitemapXml(origin: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${escapeHtml(origin)}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>
</urlset>
`
}

/** A plain summary for AI assistants, in the llms.txt format (https://llmstxt.org). */
export function llmsTxt(origin: string): string {
  return `# Spaces

> ${TAGLINE} ${LEDE}

${SUMMARY} Built on GitHub Spec Kit and the Pi Coding Agent SDK, following AWS's AI-Driven Development Life Cycle (AIDLC). Source-available, free for personal use; self-host with Bun and Postgres, or use the hosted app at ${origin} (invitation-only, with a waitlist).

## The assembly line

${STATIONS.map((s) => `- ${s.name}${s.gate ? ' (human approval gate)' : ''}: ${s.does}`).join('\n')}

## Features

${FEATURES.map((f) => `- ${f.title}: ${f.body}`).join('\n')}

## Links

- [Source code and README](${REPO_URL})
- [Documentation](${DOCS_URL})
- [Getting started and self-hosting](${DOCS_URL}getting-started/)
- [License](${REPO_URL}/blob/main/LICENSE)
`
}

function jsonLd(origin: string): string {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Spaces',
    description: `${TAGLINE} ${LEDE}`,
    url: `${origin}/`,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Web, Linux, macOS',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    license: `${REPO_URL}/blob/main/LICENSE`,
    sameAs: [REPO_URL, DOCS_URL],
  }
  // `</` would end the script element early.
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`
}

function landingMarkup(): string {
  const stations = STATIONS.map((s) => `<li><h3>${escapeHtml(s.name)}${s.gate ? ' <small>Human gate</small>' : ''}</h3><p>${escapeHtml(s.does)}</p></li>`).join('')
  const features = FEATURES.map((f) => `<li><h3>${escapeHtml(f.title)}</h3><p>${escapeHtml(f.body)}</p></li>`).join('')
  return `<main class="landing-static">
<p class="eyebrow">AI software factory</p>
<h1>${escapeHtml(TAGLINE)}</h1>
<p class="landing-static-lede">${escapeHtml(LEDE)}</p>
<p>${escapeHtml(SUMMARY)}</p>
<p><a href="${REPO_URL}">GitHub</a> · <a href="${DOCS_URL}">Documentation</a> · <a href="${DOCS_URL}getting-started/">Self-host it</a></p>
<h2>From ticket to merged pull request</h2>
<ol>${stations}</ol>
<h2>Built to run like a factory floor</h2>
<ul>${features}</ul>
</main>`
}

/** The landing page as crawlers should see it: the page's text in `#root`, and JSON-LD. */
export function landingHtml(shell: string, origin: string): string {
  return shell
    .replace('</head>', `    ${jsonLd(origin)}\n  </head>`)
    .replace('<div id="root"></div>', `<div id="root">${landingMarkup()}</div>`)
}
