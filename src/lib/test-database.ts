/**
 * Whether a database URL is safe for the test suite to write into: a local
 * server, or a database named for tests (…test…, agent_…, …ci…). A deployed
 * application's database (e.g. Railway's "railway") is not.
 */
export function isTestDatabaseUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    const host = url.hostname.replace(/^\[|\]$/g, '')
    const database = decodeURIComponent(url.pathname.replace(/^\//, ''))
    if (['localhost', '127.0.0.1', '::1'].includes(host) || host.endsWith('.localhost')) return true
    return /(^|[_-])(test|tests|testing|agent|ci)([_-]|\d|$)/i.test(database)
  } catch {
    return false
  }
}
