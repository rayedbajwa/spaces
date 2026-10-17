import { afterEach, describe, expect, test } from 'bun:test'
import { githubFileUrl, markdownArtifactLink, spacesArtifactUrl, spacesProjectUrl } from '../src/lib/artifact-links'
import { pullRequestBody } from '../src/lib/pull-requests'

const saved = process.env.PUBLIC_URL
afterEach(() => { process.env.PUBLIC_URL = saved })

describe('artifact links', () => {
  test('Spaces links are full URLs on the public origin', () => {
    process.env.PUBLIC_URL = 'https://spacesos.dev/'
    expect(spacesProjectUrl('taasq')).toBe('https://spacesos.dev/spaces/taasq')
    expect(spacesArtifactUrl('taasq', 'specs/001-release-readiness/spec.md')).toBe('https://spacesos.dev/api/projects/taasq/artifact?path=specs%2F001-release-readiness%2Fspec.md')
  })

  test('without a public origin there is no Spaces link, and the path stays as code', () => {
    delete process.env.PUBLIC_URL
    expect(spacesArtifactUrl('taasq', 'specs/x/spec.md')).toBeUndefined()
    expect(markdownArtifactLink('specs/x/spec.md', undefined)).toBe('`specs/x/spec.md`')
  })

  test('a file on a GitHub branch', () => {
    expect(githubFileUrl('rayedbajwa/taasq', '001-release-readiness', 'specs/001-release-readiness/plan.md')).toBe('https://github.com/rayedbajwa/taasq/blob/001-release-readiness/specs/001-release-readiness/plan.md')
    expect(githubFileUrl(undefined, 'b', 'x.md')).toBeUndefined()
  })

  test('the pull request body links every artifact and the project', () => {
    process.env.PUBLIC_URL = 'https://spacesos.dev'
    const body = pullRequestBody({
      summary: 'Feature done.',
      featureDir: 'specs/001-x',
      artifacts: ['specs/001-x/spec.md', 'specs/001-x/plan.md'],
      artifactUrl: (a) => spacesArtifactUrl('taasq', a),
      projectUrl: spacesProjectUrl('taasq'),
    })
    expect(body).toContain('**Artifacts:** [spec.md](https://spacesos.dev/api/projects/taasq/artifact?path=specs%2F001-x%2Fspec.md) · [plan.md](https://spacesos.dev/api/projects/taasq/artifact?path=specs%2F001-x%2Fplan.md)')
    expect(body).toContain('**In Spaces:** [open the project](https://spacesos.dev/spaces/taasq)')
  })
})
