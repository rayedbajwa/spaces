/**
 * Which part of Spaces this process runs (specs/014-project-workers).
 *
 * - `all` (default): the web app, the supervisor and every project's workers in
 *   one place with one workspace disk — local, docker compose, self-hosted.
 * - `web`: the public app with no workspace disk. Project work that touches a
 *   workspace is forwarded to that project's worker (lib/project-forward.ts).
 * - `project`: one project's worker (WORKER_PROJECT_ID) with its own disk. It
 *   serves the forwarded requests and runs that project's jobs; it is reachable
 *   only on the private network, with the internal token.
 */

export type SpacesRole = 'all' | 'web' | 'project'

export function spacesRole(): SpacesRole {
  const value = process.env.SPACES_ROLE?.trim().toLowerCase()
  return value === 'web' || value === 'project' ? value : 'all'
}

export const isWebRole = (): boolean => spacesRole() === 'web'
export const isProjectRole = (): boolean => spacesRole() === 'project'

/** The project a `project`-role process serves. */
export function workerProjectId(): string | undefined {
  return process.env.WORKER_PROJECT_ID?.trim() || undefined
}

/** Header carrying the shared secret between the web service and project workers. */
export const INTERNAL_TOKEN_HEADER = 'x-spaces-internal'

export function internalToken(): string | undefined {
  return process.env.SPACES_INTERNAL_TOKEN?.trim() || undefined
}

/** Constant-time comparison of the internal token on a request. */
export function hasInternalToken(req: Request): boolean {
  const expected = internalToken()
  const given = req.headers.get(INTERNAL_TOKEN_HEADER) ?? ''
  if (!expected || given.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i)
  return diff === 0
}

/** Settings each role cannot start without. */
export function roleConfigProblem(role: SpacesRole = spacesRole()): string | undefined {
  if (role === 'all') return undefined
  if (!internalToken()) return `SPACES_ROLE=${role} needs SPACES_INTERNAL_TOKEN (shared by the web service and project workers).`
  if (role === 'project' && !workerProjectId()) return 'SPACES_ROLE=project needs WORKER_PROJECT_ID.'
  return undefined
}
