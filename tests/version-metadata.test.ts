import { describe, expect, test } from 'bun:test'
import packageMetadata from '../package.json'
import { resolveVersionMetadata } from '../src/lib/version-metadata'

const packageIdentity = { name: packageMetadata.name, version: packageMetadata.version }

describe('resolveVersionMetadata', () => {
  test('returns the root package identity', () => {
    expect(resolveVersionMetadata({ packageMetadata: packageIdentity, env: {}, resolveGitRevision: () => 'abc123' })).toEqual({
      ...packageIdentity,
      commit: 'abc123',
    })
  })

  test('prefers a trimmed non-empty GIT_COMMIT without invoking Git', () => {
    let gitCalls = 0
    const metadata = resolveVersionMetadata({
      packageMetadata: packageIdentity,
      env: { GIT_COMMIT: ' release-abc ' },
      resolveGitRevision: () => { gitCalls += 1; return 'git-head' },
    })

    expect(metadata.commit).toBe('release-abc')
    expect(gitCalls).toBe(0)
  })

  test('falls back to a trimmed Git revision when GIT_COMMIT is absent', () => {
    expect(resolveVersionMetadata({
      packageMetadata: packageIdentity,
      env: {},
      resolveGitRevision: () => '  abc123\n',
    }).commit).toBe('abc123')
  })

  test('falls back to Git when GIT_COMMIT is whitespace-only', () => {
    expect(resolveVersionMetadata({
      packageMetadata: packageIdentity,
      env: { GIT_COMMIT: '   ' },
      resolveGitRevision: () => 'git-head',
    }).commit).toBe('git-head')
  })

  test('returns unknown when Git fails', () => {
    expect(resolveVersionMetadata({
      packageMetadata: packageIdentity,
      env: {},
      resolveGitRevision: () => { throw new Error('not a repository') },
    }).commit).toBe('unknown')
  })

  test('returns unknown when Git output is empty or whitespace-only', () => {
    expect(resolveVersionMetadata({ packageMetadata: packageIdentity, env: {}, resolveGitRevision: () => '' }).commit).toBe('unknown')
    expect(resolveVersionMetadata({ packageMetadata: packageIdentity, env: {}, resolveGitRevision: () => '  ' }).commit).toBe('unknown')
  })

  test('resolves once and reuses the captured metadata', () => {
    let gitCalls = 0
    const resolve = () => resolveVersionMetadata({
      packageMetadata: packageIdentity,
      env: {},
      resolveGitRevision: () => { gitCalls += 1; return 'boot-revision' },
    })
    const bootMetadata = resolve()

    expect(bootMetadata).toEqual({ ...packageIdentity, commit: 'boot-revision' })
    expect({ ...bootMetadata }).toEqual(bootMetadata)
    expect(gitCalls).toBe(1)
  })
})
