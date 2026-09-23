import { execFileSync } from 'node:child_process'

/**
 * What an intent changed in a checkout: the files its branch changed against
 * the repository's default branch, plus uncommitted work. Quality stages
 * (review, verify) test that area instead of the whole suite; CI runs the
 * suite. The intent's own documents (specs/), Spaces' notes (.aidlc/) and
 * dependency folders are not part of the scope.
 */

const IGNORED = /^(specs\/|\.aidlc\/|node_modules\/|\.aidlc-worktrees\/)/
const MAX_FILES = 200

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 * 1024 * 1024 }).trim()
  } catch {
    return undefined
  }
}

/** Files changed on the checkout's branch (against its default branch) and in its working tree. */
export function changedFiles(cwd: string, defaultBranchName?: string): string[] {
  const candidates = [
    ...(defaultBranchName ? [`origin/${defaultBranchName}`, defaultBranchName] : []),
    git(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']),
    'origin/main', 'origin/master', 'main', 'master',
  ].filter((b): b is string => Boolean(b))
  let committed: string[] = []
  for (const base of candidates) {
    const mergeBase = git(cwd, ['merge-base', base, 'HEAD'])
    if (!mergeBase) continue
    committed = (git(cwd, ['diff', '--name-only', `${mergeBase}...HEAD`]) ?? '').split('\n').filter(Boolean)
    break
  }
  const working = (git(cwd, ['status', '--porcelain', '--untracked-files=all']) ?? '')
    .split('\n').filter(Boolean).map((line) => line.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, ''))
  return [...new Set([...committed, ...working])].filter((f) => !IGNORED.test(f)).sort().slice(0, MAX_FILES)
}

/** Whether a change touches what a container image is built from (so the image build is worth running). */
export function touchesContainerBuild(files: string[]): boolean {
  return files.some((f) => /(^|\/)(Dockerfile[^/]*|\.dockerignore|(docker-)?compose[^/]*\.ya?ml|package\.json|bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|go\.(mod|sum)|Gemfile(\.lock)?|Cargo\.(toml|lock))$/i.test(f))
}
