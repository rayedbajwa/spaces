/**
 * Full, clickable links to a feature's artifacts for anything Spaces posts
 * outside the app: pull request descriptions and comments, Slack, Jira and
 * Linear. A bare `specs/012-x/spec.md` cannot be clicked from GitHub or Slack.
 *
 * Spaces' own artifact page is preferred: it serves the intent's recorded
 * document, so the link keeps working when the branch moves or is deleted.
 * Files that live in another repository (a repo-local change, a workstream's
 * report) link to that file on the pull request's branch on GitHub.
 */

/** The public origin of this Spaces deployment, e.g. https://spacesos.dev; undefined when not configured. */
export function publicBaseUrl(): string | undefined {
  const base = process.env.PUBLIC_URL?.trim().replace(/\/+$/, '')
  return base || undefined
}

/** The project's page in Spaces. */
export function spacesProjectUrl(namespace: string | undefined): string | undefined {
  const base = publicBaseUrl()
  return base && namespace ? `${base}/spaces/${encodeURIComponent(namespace)}` : undefined
}

/** An artifact of the project's governing workspace (e.g. specs/012-x/spec.md), rendered by Spaces. */
export function spacesArtifactUrl(namespace: string | undefined, relativePath: string): string | undefined {
  const base = publicBaseUrl()
  return base && namespace ? `${base}/api/projects/${encodeURIComponent(namespace)}/artifact?path=${encodeURIComponent(relativePath)}` : undefined
}

/** A file on a branch of a GitHub repository. */
export function githubFileUrl(githubRepo: string | undefined, branch: string | undefined, relativePath: string): string | undefined {
  if (!githubRepo || !branch) return undefined
  const filePath = relativePath.split('/').map(encodeURIComponent).join('/')
  return `https://github.com/${githubRepo}/blob/${branch.split('/').map(encodeURIComponent).join('/')}/${filePath}`
}

/** `[spec.md](https://…)` when a link can be made, else the path as code. */
export function markdownArtifactLink(relativePath: string, url: string | undefined, label = relativePath.split('/').pop() ?? relativePath): string {
  return url ? `[${label}](${url})` : `\`${relativePath}\``
}
