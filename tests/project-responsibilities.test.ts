import { describe, expect, test } from 'bun:test'
import {
  normalizeResponsibilityName,
  ResponsibilityError,
  responsibilityKeyForStage,
  STAGE_RESPONSIBILITY_KEYS,
  STANDARD_RESPONSIBILITIES,
} from '../src/lib/project-responsibilities'

describe('project responsibilities', () => {
  test('defines the six standard responsibilities in display order', () => {
    expect(STANDARD_RESPONSIBILITIES.map((item) => item.key)).toEqual([
      'owner', 'product-owner', 'lead-engineer', 'designer', 'qa', 'release-manager',
    ])
    expect(STANDARD_RESPONSIBILITIES.map((item) => item.name)).toEqual([
      'Owner', 'Product Owner', 'Lead Engineer', 'Designer', 'QA', 'Release Manager',
    ])
  })

  test('keeps standard keys and display names unique and in fixed order', () => {
    const keys = STANDARD_RESPONSIBILITIES.map((item) => item.key)
    const names = STANDARD_RESPONSIBILITIES.map((item) => item.name)
    expect(new Set(keys).size).toBe(keys.length)
    expect(new Set(names).size).toBe(names.length)
    expect(keys[0]).toBe('owner')
  })

  test('normalizes names for stable matching', () => {
    expect(normalizeResponsibilityName('  Lead   Engineer ')).toBe('lead engineer')
    expect(normalizeResponsibilityName('\tQA\n')).toBe('qa')
    expect(normalizeResponsibilityName('Release\tManager')).toBe('release manager')
    expect(normalizeResponsibilityName('   ')).toBe('')
  })

  test('maps workflow stages to advisory responsibility contacts with Owner escalation', () => {
    expect(responsibilityKeyForStage('specify')).toBe('product-owner')
    expect(responsibilityKeyForStage('review')).toBe('product-owner')
    expect(responsibilityKeyForStage('plan')).toBe('lead-engineer')
    expect(responsibilityKeyForStage('implement')).toBe('lead-engineer')
    expect(responsibilityKeyForStage('design')).toBe('designer')
    expect(responsibilityKeyForStage('verify')).toBe('qa')
    expect(responsibilityKeyForStage('release')).toBe('release-manager')
    expect(responsibilityKeyForStage('deliver')).toBe('release-manager')
    expect(responsibilityKeyForStage('unknown-stage')).toBe('owner')
    expect(responsibilityKeyForStage('')).toBe('owner')
  })

  test('only maps stages to standard responsibility keys', () => {
    const standardKeys = new Set(STANDARD_RESPONSIBILITIES.map((item) => item.key))
    for (const key of Object.values(STAGE_RESPONSIBILITY_KEYS)) {
      expect(standardKeys.has(key)).toBe(true)
    }
  })

  test('exposes typed responsibility errors for callers to branch on', () => {
    const error = new ResponsibilityError('ineligible', 'Assignee is not an active owning-team member.')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('ResponsibilityError')
    expect(error.code).toBe('ineligible')
    expect(error.message).toContain('owning-team')
  })
})
