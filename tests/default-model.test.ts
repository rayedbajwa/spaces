import { describe, expect, test } from 'bun:test'
import { configuredProviders, isProviderConfigured, providerOfModel, tierOfModel } from '../src/lib/default-model'

// Every call passes an explicit env so the real .env never leaks in.

describe('configuredProviders', () => {
  test('lists providers with a non-blank key', () => {
    expect(configuredProviders({})).toEqual([])
    expect(configuredProviders({ OPENAI_API_KEY: 'a', OPENROUTER_API_KEY: '  ' })).toEqual(['openai'])
    expect(configuredProviders({ ANTHROPIC_API_KEY: 'c', OPENAI_API_KEY: 'a' })).toEqual(['anthropic', 'openai'])
  })
})

describe('isProviderConfigured', () => {
  test('known providers need their key', () => {
    expect(isProviderConfigured('anthropic/claude-sonnet-4-5', {})).toBe(false)
    expect(isProviderConfigured('anthropic/claude-sonnet-4-5', { ANTHROPIC_API_KEY: 'k' })).toBe(true)
    expect(isProviderConfigured('openrouter/openrouter/auto', { OPENROUTER_API_KEY: 'k' })).toBe(true)
    expect(isProviderConfigured('OpenAI/gpt-5.4', { OPENAI_API_KEY: 'k' })).toBe(true)
  })

  test('providers we do not key by env are left to the runtime', () => {
    expect(isProviderConfigured('google/gemini-2.5-pro', {})).toBe(true)
    expect(isProviderConfigured('no-slash-model', {})).toBe(true)
    expect(providerOfModel('no-slash-model')).toBeUndefined()
  })
})

describe('tierOfModel', () => {
  test('maps by name', () => {
    expect(tierOfModel('anthropic/claude-haiku-4-5')).toBe('small')
    expect(tierOfModel('openai/gpt-5.4-mini')).toBe('small')
    expect(tierOfModel('anthropic/claude-sonnet-4-5')).toBe('medium')
    expect(tierOfModel('openai/gpt-5.4')).toBe('medium')
    expect(tierOfModel('anthropic/claude-opus-4-5')).toBe('large')
    expect(tierOfModel('openai/gpt-5.4-pro')).toBe('large')
  })
})
