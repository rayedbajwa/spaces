import { execFileSync } from 'node:child_process'

export type VersionMetadata = {
  name: string
  version: string
  commit: string
}

type PackageMetadata = {
  name?: unknown
  version?: unknown
}

type VersionMetadataOptions = {
  packageMetadata: PackageMetadata
  env?: Record<string, string | undefined>
  resolveGitRevision?: () => string
}

function resolveGitRevision(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return ''
  }
}

export function resolveVersionMetadata({ packageMetadata, env = process.env, resolveGitRevision: resolveGit = resolveGitRevision }: VersionMetadataOptions): VersionMetadata {
  const configuredCommit = (env.GIT_COMMIT?.trim() || env.RAILWAY_GIT_COMMIT_SHA?.trim())
  let commit = configuredCommit ?? ''
  if (!commit) {
    try {
      commit = resolveGit().trim()
    } catch {
      commit = ''
    }
  }

  const configuredVersion = env.SPACES_VERSION?.trim() ?? ''
  const version =
    configuredVersion ||
    String(packageMetadata.version ?? '').trim() ||
    'unknown'

  return {
    name: String(packageMetadata.name ?? ''),
    version,
    commit: commit || 'unknown',
  }
}
