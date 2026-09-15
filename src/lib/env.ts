/**
 * Environment validation. Called once at process start to fail fast with a
 * clear diagnostic if required vars are missing or malformed.
 *
 * We only enforce the vars that are truly required for the process to run.
 * Integration vars (GITHUB_CLIENT_ID, etc.) are optional — missing means the
 * integration is disabled, not an error.
 */

export interface EnvReport {
  ok: boolean
  errors: string[]
  warnings: string[]
}

const REQUIRED = [
  {
    key: 'DATABASE_URL',
    validate: (v: string) => v.startsWith('postgres://') || v.startsWith('postgresql://')
      ? null
      : 'must be a postgres:// URL',
  },
  {
    key: 'ENCRYPTION_KEY',
    validate: (v: string) => v.length >= 8
      ? null
      : 'must be at least 8 characters (generate one with `openssl rand -base64 48`)',
  },
] as const

const AT_LEAST_ONE_OF = [
  { keys: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'], label: 'LLM provider API key' },
] as const

/** Non-fatal cross-checks — report as warnings only. */
function collectWarnings(): string[] {
  const w: string[] = []

  // OAuth: both id + secret must be set together or neither. Half-configured
  // credentials will confuse the OAuth flow at authorize-time.
  const pairs: Array<[string, string, string]> = [
    ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'GitHub'],
    ['ATLASSIAN_CLIENT_ID', 'ATLASSIAN_CLIENT_SECRET', 'Atlassian'],
    ['SLACK_CLIENT_ID', 'SLACK_CLIENT_SECRET', 'Slack'],
  ]
  for (const [idKey, secretKey, label] of pairs) {
    const hasId = !!process.env[idKey]
    const hasSecret = !!process.env[secretKey]
    if (hasId !== hasSecret) {
      w.push(`${label} OAuth is half-configured: set both ${idKey} and ${secretKey}, or neither.`)
    }
  }

  const port = process.env.PORT
  if (port && !/^\d+$/.test(port)) {
    w.push(`PORT is set to "${port}" — must be an integer; defaulting to 3000.`)
  }

  return w
}

export function validateEnv(): EnvReport {
  const errors: string[] = []

  for (const { key, validate } of REQUIRED) {
    const value = process.env[key]
    if (!value || !value.trim()) {
      errors.push(`${key} is required but not set`)
      continue
    }
    const msg = validate(value)
    if (msg) errors.push(`${key} ${msg}`)
  }

  for (const { keys, label } of AT_LEAST_ONE_OF) {
    if (!keys.some((k) => process.env[k])) {
      errors.push(`At least one ${label} must be set: ${keys.join(' or ')}`)
    }
  }

  return { ok: errors.length === 0, errors, warnings: collectWarnings() }
}

/**
 * Convenience wrapper for entry points. Prints a formatted report and exits
 * the process with code 1 if validation fails. Returns cleanly otherwise.
 */
export function assertEnvOrExit(context = 'startup'): void {
  const report = validateEnv()

  if (report.warnings.length) {
    for (const w of report.warnings) {
      // eslint-disable-next-line no-console
      console.warn(`[env] warning: ${w}`)
    }
  }

  if (report.ok) return

  // eslint-disable-next-line no-console
  console.error('')
  // eslint-disable-next-line no-console
  console.error(`[env] Refusing to start ${context}: environment is invalid.`)
  for (const e of report.errors) {
    // eslint-disable-next-line no-console
    console.error(`  - ${e}`)
  }
  // eslint-disable-next-line no-console
  console.error('')
  // eslint-disable-next-line no-console
  console.error('See .env.example for the full list of variables and how to set them.')
  process.exit(1)
}
