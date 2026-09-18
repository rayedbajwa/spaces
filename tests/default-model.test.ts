import { describe, expect, test } from 'bun:test'
import { configuredProviders, defaultModel, isProviderConfigured, resolveTierModels, tierOfModel } from '../src/lib/default-model'

// Every call passes an explicit env so the real .env never leaks in.

describe('resolveTierModels', () => {
  test('no keys at all → Anthropic built-ins', () => {
    const t = resolveTierModels({})
    expect(t.medium).toBe('anthropic/claude-sonnet-4-5')
    expect(t.small).toContain('anthropic/')
    expect(t.large).toContain('anthropic/')
  })

  test('only OPENAI_API_KEY → OpenAI trio', () => {
    const t = resolveTierModels({ OPENAI_API_KEY: 'sk-x' })
    expect(t.small.startsWith('openai/')).toBe(true)
    expect(t.medium.startsWith('openai/')).toBe(true)
    expect(t.large.startsWith('openai/')).toBe(true)
    expect(new Set([t.small, t.medium, t.large]).size).toBe(3)
  })

  test('OpenRouter beats OpenAI, Anthropic beats both', () => {
    expect(resolveTierModels({ OPENAI_API_KEY: 'a', OPENROUTER_API_KEY: 'b' }).medium.startsWith('openrouter/')).toBe(true)
    expect(resolveTierModels({ OPENAI_API_KEY: 'a', OPENROUTER_API_KEY: 'b', ANTHROPIC_API_KEY: 'c' }).medium.startsWith('anthropic/')).toBe(true)
    expect(configuredProviders({ OPENAI_API_KEY: 'a', OPENROUTER_API_KEY: 'b' })).toEqual(['openrouter', 'openai'])
  })

  test('DEFAULT_MODEL alone applies to every tier', () => {
    const t = resolveTierModels({ ANTHROPIC_API_KEY: 'k', DEFAULT_MODEL: 'openrouter/openrouter/auto' })
    expect(t).toEqual({ small: 'openrouter/openrouter/auto', medium: 'openrouter/openrouter/auto', large: 'openrouter/openrouter/auto' })
    expect(defaultModel({ DEFAULT_MODEL: ' openai/gpt-5.4 ' })).toBe('openai/gpt-5.4')
  })

  test('tier overrides win over DEFAULT_MODEL, blanks are ignored', () => {
    const t = resolveTierModels({ DEFAULT_MODEL: 'openai/gpt-5.4', DEFAULT_MODEL_SMALL: 'openai/gpt-5.4-mini', DEFAULT_MODEL_LARGE: '   ' })
    expect(t).toEqual({ small: 'openai/gpt-5.4-mini', medium: 'openai/gpt-5.4', large: 'openai/gpt-5.4' })
  })
})

describe('isProviderConfigured', () => {
  test('known providers need their key', () => {
    expect(isProviderConfigured('anthropic/claude-sonnet-4-5', {})).toBe(false)
    expect(isProviderConfigured('anthropic/claude-sonnet-4-5', { ANTHROPIC_API_KEY: 'k' })).toBe(true)
    expect(isProviderConfigured('openrouter/anthropic/claude-sonnet-4.5', { OPENROUTER_API_KEY: 'k' })).toBe(true)
    expect(isProviderConfigured('OpenAI/gpt-5.4', { OPENAI_API_KEY: 'k' })).toBe(true)
  })

  test('providers we do not key by env are left to the runtime', () => {
    expect(isProviderConfigured('google/gemini-2.5-pro', {})).toBe(true)
    expect(isProviderConfigured('no-slash-model', {})).toBe(true)
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
