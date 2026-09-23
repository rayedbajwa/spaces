/**
 * Runs before every `bun test` (bunfig.toml): the suite never writes into a
 * database that is not a test database.
 *
 * Tests create projects, runs and jobs. Run against a live deployment's
 * database — an agent testing Spaces inside the production container did —
 * they appear there as real work: the supervisor spawns workers for them,
 * they take the worker slots, and real runs wait. So:
 * - TEST_DATABASE_URL, when set, is the database.
 * - Otherwise DATABASE_URL is used only if it is local, or its database is
 *   named like a test one (test, agent, ci), or ALLOW_TEST_DATABASE=1.
 * - Anything else is replaced by an unreachable address: database suites skip
 *   (they check reachability) and say why, instead of writing to it.
 */
import { isTestDatabaseUrl } from '../../src/lib/test-database'

const chosen = process.env.TEST_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim()
if (process.env.TEST_DATABASE_URL?.trim()) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL.trim()
if (chosen && process.env.ALLOW_TEST_DATABASE !== '1' && !isTestDatabaseUrl(chosen)) {
  console.warn('[tests] DATABASE_URL is not a test database (not local, and not named test/agent/ci): database suites will skip. Set TEST_DATABASE_URL to a test database, or ALLOW_TEST_DATABASE=1 if this one is disposable.')
  process.env.DATABASE_URL = 'postgres://refused:refused@127.0.0.1:1/refused_not_a_test_database'
}
