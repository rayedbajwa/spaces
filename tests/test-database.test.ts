import { describe, expect, test } from 'bun:test'
import { isTestDatabaseUrl } from '../src/lib/test-database'

describe('which databases the test suite may write into', () => {
  test('local servers and databases named for tests', () => {
    for (const url of ['postgres://u:p@localhost:5432/spaces', 'postgres://u:p@127.0.0.1/pi_speckit', 'postgres://u:p@postgres.railway.internal:5432/agent_spaces_3f701200', 'postgres://u:p@db.example.com/spaces_test', 'postgres://u:p@ci-db/ci']) expect([url, isTestDatabaseUrl(url)]).toEqual([url, true])
  })
  test('not a deployed application\'s database', () => {
    for (const url of ['postgresql://postgres:p@postgres.railway.internal:5432/railway', 'postgres://u:p@prod.db.example.com/spaces', 'postgres://u:p@db/contest_entries', 'not a url']) expect([url, isTestDatabaseUrl(url)]).toEqual([url, false])
  })
})
