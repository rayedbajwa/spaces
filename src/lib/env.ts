/**
 * Environment validation. Called once at process start to fail fast with a
 * clear diagnostic if required vars are missing or malformed.
 *
 * We only enforce the vars that are truly required for the process to run.
 * Integration credentials are not environment variables at all: they are set
 * in the app (Organization → Integrations) and stored encrypted.
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
  { keys: ['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY'], label: 'LLM provider API key' },
] as const

/** Non-fatal cross-checks — report as warnings only. */
function collectWarnings(): string[] {
  const w: string[] = []

  // OAuth credentials moved into the app; leftover variables are ignored and
  // worth deleting so nobody believes they do something.
  const leftovers = ['GITHUB', 'ATLASSIAN', 'SLACK', 'LINEAR'].flatMap((p) => [`${p}_CLIENT_ID`, `${p}_CLIENT_SECRET`]).filter((k) => process.env[k])
  if (leftovers.length) w.push(`${leftovers.join(', ')} are no longer read. Integration credentials are managed under Organization → Integrations; remove these from .env.`)

  const port = process.env.PORT
  if (port && !/^\d+$/.test(port)) {
    w.push(`PORT is set to "${port}" — must be an integer; defaulting to 3000.`)
  }

  // Models are routed automatically per provider (Organization → Models); the
  // old DEFAULT_MODEL* variables are ignored.
  const modelVars = ['DEFAULT_MODEL', 'DEFAULT_MODEL_SMALL', 'DEFAULT_MODEL_LARGE'].filter((k) => process.env[k])
  if (modelVars.length) w.push(`${modelVars.join(', ')} are no longer read. Model routing is automatic per provider and tuned under Organization → Models; remove these from .env.`)

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
