import { describe, expect, test } from 'bun:test'
import { normalizeScope, parseScope, scopeInstruction, scopeLabel, setScopeInSpec } from '../src/lib/intent-scope'
import { summarizeIntent } from '../src/lib/intent-store'

describe('intent scope', () => {
  test('normalizes labels, aliases and custom scopes; auto and blanks are no scope', () => {
    expect(normalizeScope('Bug Fix')).toBe('bugfix')
    expect(normalizeScope('hotfix')).toBe('bugfix')
    expect(normalizeScope('MVP')).toBe('mvp')
    expect(normalizeScope('  Security hardening! ')).toBe('security-hardening')
    expect(normalizeScope('auto')).toBeUndefined()
    expect(normalizeScope('  ')).toBeUndefined()
    expect(normalizeScope('x'.repeat(50))).toHaveLength(30)
    expect(scopeLabel('mvp')).toBe('MVP')
    expect(scopeLabel('security-hardening')).toBe('Security hardening')
  })

  test('reads and writes the spec\'s Scope line', () => {
    const spec = '# Feature Specification: Login\n\n**Feature Branch**: `001-login`\n\n## Out of Scope\n- SSO\n'
    expect(parseScope(spec)).toBeUndefined()
    const scoped = setScopeInSpec(spec, 'mvp')
    expect(scoped.split('\n').slice(0, 3)).toEqual(['# Feature Specification: Login', '', '**Scope**: mvp'])
    expect(parseScope(scoped)).toBe('mvp')
    expect(parseScope(setScopeInSpec(scoped, 'bugfix'))).toBe('bugfix')
    expect(setScopeInSpec(scoped, 'bugfix').match(/Scope\*\*:/g)).toHaveLength(1)
    expect(parseScope('# X\n\n- **Scope**: Bug fix\n')).toBe('bugfix')
    expect(summarizeIntent('001-login', new Map([['spec.md', scoped]])).scope).toBe('mvp')
  })

  test('specify is told the chosen scope, or to decide one', () => {
    expect(scopeInstruction('bugfix')).toContain('steps to reproduce')
    expect(scopeInstruction('security')).toContain('custom scope')
    const auto = scopeInstruction(undefined)
    expect(auto).toContain('Decide it from the description')
    expect(auto).toContain('**Scope**: <scope>')
    expect(auto).toContain('- mvp:')
  })
})
