import { describe, expect, test } from 'bun:test'
import { normalizeResponsibilityName, responsibilityKeyForStage, STANDARD_RESPONSIBILITIES } from '../src/lib/project-responsibilities'

describe('project responsibilities', () => {
  test('defines the six standard responsibilities in display order', () => {
    expect(STANDARD_RESPONSIBILITIES.map((item) => item.key)).toEqual([
      'owner', 'product-owner', 'lead-engineer', 'designer', 'qa', 'release-manager',
    ])
  })

  test('normalizes names for stable matching', () => {
    expect(normalizeResponsibilityName('  Lead   Engineer ')).toBe('lead engineer')
    expect(normalizeResponsibilityName('\tQA\n')).toBe('qa')
  })

  test('maps workflow stages to advisory responsibility contacts with Owner escalation', () => {
    expect(responsibilityKeyForStage('specify')).toBe('product-owner')
    expect(responsibilityKeyForStage('review')).toBe('product-owner')
    expect(responsibilityKeyForStage('plan')).toBe('lead-engineer')
    expect(responsibilityKeyForStage('implement')).toBe('lead-engineer')
    expect(responsibilityKeyForStage('design')).toBe('designer')
    expect(responsibilityKeyForStage('verify')).toBe('qa')
    expect(responsibilityKeyForStage('deliver')).toBe('release-manager')
    expect(responsibilityKeyForStage('unknown-stage')).toBe('owner')
  })
})
