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

  test('version prefers a trimmed non-empty SPACES_VERSION override', () => {
    const metadata = resolveVersionMetadata({
      packageMetadata: packageIdentity,
      env: { SPACES_VERSION: ' 1.2.3 ' },
      resolveGitRevision: () => 'git-head',
    })

    expect(metadata.version).toBe('1.2.3')
  })

  test('version falls back to package.json when SPACES_VERSION is whitespace-only', () => {
    const metadata = resolveVersionMetadata({
      packageMetadata: packageIdentity,
      env: { SPACES_VERSION: '   ' },
      resolveGitRevision: () => 'git-head',
    })

    expect(metadata.version).toBe(packageIdentity.version)
  })

  test('version falls back to package.json when SPACES_VERSION is absent', () => {
    const metadata = resolveVersionMetadata({
      packageMetadata: packageIdentity,
      env: {},
      resolveGitRevision: () => 'git-head',
    })

    expect(metadata.version).toBe(packageIdentity.version)
  })

  test('version resolves to unknown when both SPACES_VERSION and package.json version are absent', () => {
    const metadata = resolveVersionMetadata({
      packageMetadata: {},
      env: {},
      resolveGitRevision: () => 'git-head',
    })

    expect(metadata.version).toBe('unknown')
  })

  test('SPACES_VERSION override wins over package.json version (source vs binary mismatch)', () => {
    const metadata = resolveVersionMetadata({
      packageMetadata: { name: 'spaces', version: '0.1.0' },
      env: { SPACES_VERSION: '2.0.0' },
      resolveGitRevision: () => 'git-head',
    })

    expect(metadata.version).toBe('2.0.0')
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

  describe('packaged build simulation (test-plan S1-S6: no Git history at runtime)', () => {
    const noGit = () => { throw new Error('fatal: not a git repository') }

    test('S1: packaged build with baked GIT_COMMIT reports the commit and not unknown', () => {
      const metadata = resolveVersionMetadata({
        packageMetadata: packageIdentity,
        env: { GIT_COMMIT: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' },
        resolveGitRevision: noGit,
      })
      expect(metadata.commit).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678')
      expect(metadata.commit).not.toBe('unknown')
    })

    test('S2: packaged build with baked GIT_COMMIT is stable across restarts / repeated queries', () => {
      const run1 = resolveVersionMetadata({
        packageMetadata: packageIdentity,
        env: { GIT_COMMIT: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' },
        resolveGitRevision: noGit,
      })
      const run2 = resolveVersionMetadata({
        packageMetadata: packageIdentity,
        env: { GIT_COMMIT: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' },
        resolveGitRevision: noGit,
      })
      expect(run1).toEqual(run2)
    })

    test('S3: two packaged builds from different commits report distinct commits', () => {
      const buildA = resolveVersionMetadata({
        packageMetadata: packageIdentity,
        env: { GIT_COMMIT: 'commit-aaa-111111' },
        resolveGitRevision: noGit,
      })
      const buildB = resolveVersionMetadata({
        packageMetadata: packageIdentity,
        env: { GIT_COMMIT: 'commit-bbb-222222' },
        resolveGitRevision: noGit,
      })
      expect(buildA.commit).toBe('commit-aaa-111111')
      expect(buildB.commit).toBe('commit-bbb-222222')
      expect(buildA.commit).not.toBe(buildB.commit)
    })

    test('S4: packaged build with baked SPACES_VERSION reports the version verbatim', () => {
      const metadata = resolveVersionMetadata({
        packageMetadata: packageIdentity,
        env: { SPACES_VERSION: '1.2.3' },
        resolveGitRevision: noGit,
      })
      expect(metadata.version).toBe('1.2.3')
    })

    test('S5: packaged build without SPACES_VERSION falls back to package.json version', () => {
      const metadata = resolveVersionMetadata({
        packageMetadata: packageIdentity,
        env: {},
        resolveGitRevision: noGit,
      })
      expect(metadata.version).toBe(packageIdentity.version)
    })

    test('S6: endpoint returns well-formed { name, version, commit } in no-Git environment', () => {
      const metadata = resolveVersionMetadata({
        packageMetadata: packageIdentity,
        env: {},
        resolveGitRevision: noGit,
      })
      expect(metadata).toEqual({
        name: String(packageIdentity.name),
        version: String(packageIdentity.version),
        commit: 'unknown',
      })
    })
  })
})
