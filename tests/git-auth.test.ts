import { describe, expect, test } from 'bun:test'
import { describeGitError, gitAuthEnv, isGitAuthFailure, withoutInjectedGitConfig } from '../src/lib/github-app-auth'
import { redactSecretValues } from '../src/lib/guardrails'

// A fake installation token, shaped like the one that leaked on Oct 17.
const TOKEN = 'ghs_FAKEfakeFAKEfakeFAKEfakeFAKEfake1234'
const HEADER = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`

describe('git auth', () => {
  test('the header goes in the environment, not the command line', () => {
    expect(gitAuthEnv(TOKEN)).toMatchObject({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: HEADER })
  })

  test("a command with its own token drops the run's injected (maybe expired) header", () => {
    const env = withoutInjectedGitConfig({ PATH: '/bin', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'k', GIT_CONFIG_VALUE_0: 'old', GH_TOKEN: 't' })
    expect(env).toEqual({ PATH: '/bin', GH_TOKEN: 't' })
  })

  test("git's error keeps the reason and loses the credentials", () => {
    const error = Object.assign(new Error(`Command failed: git -c http.extraheader=${HEADER} push -u origin 005-x:005-x`), {
      stderr: `remote: Invalid username or token. Password authentication is not supported for Git operations.\nfatal: Authentication failed for 'https://github.com/rayedbajwa/taasq.git/'\n`,
    })
    const text = describeGitError(error, TOKEN)
    expect(text).toContain('Invalid username or token')
    expect(text).not.toContain('basic ')
    expect(text).not.toContain(TOKEN)
    expect(isGitAuthFailure(text)).toBe(true)
  })

  test('without stderr, the command line is scrubbed', () => {
    const text = describeGitError(new Error(`Command failed: git -c http.extraheader=${HEADER} push`))
    expect(text).toContain('AUTHORIZATION: basic [redacted]')
    expect(text).not.toContain(Buffer.from(`x-access-token:${TOKEN}`).toString('base64'))
  })

  test('the guardrails mask a basic auth header wherever it appears', () => {
    const masked = redactSecretValues(`[pr] taasq: could not publish: Command failed: git -c http.extraheader=${HEADER} push`)
    expect(masked).not.toContain(Buffer.from(`x-access-token:${TOKEN}`).toString('base64'))
  })

  test('a non-auth failure is not retried', () => {
    expect(isGitAuthFailure('git push failed: ! [rejected] 005-x -> 005-x (non-fast-forward)')).toBe(false)
  })
})
