/**
 * Model routing: pick the right model + thinking level for each agent call
 * based on stage type, workload characteristics, and a global speed mode.
 *
 * Precedence (highest wins):
 *   1. Explicit `model:` field on the pipeline step (author knows best)
 *   2. Prompt-size guard (large prompts → Sonnet regardless, Haiku's context
 *      ceiling would silently truncate)
 *   3. Retry escalation (attempt N → next tier up)
 *   4. Speed mode override (fast → cheapest viable; quality → most capable)
 *   5. Stage-family default from data/org/model-routing.yml
 *   6. The default tier models (DEFAULT_MODEL* env, else the first configured
 *      provider — see default-model.ts)
 *
 * The router is decision-only — actually setting the model on the session is
 * still `stepModel` in AIDLCFlow. This module is pure functions + async config
 * loading so it can be unit-tested without a live LLM.
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { log } from './logger'
import { resolveTierModels, type ModelTier } from './default-model'

const routerLog = log.child({ mod: 'model-router' })

export type SpeedMode = 'fast' | 'balanced' | 'quality'
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high'

export interface RouteInput {
  /** The AIDLC stage (specify, plan, tasks, implement, verify, etc.). */
  stage: string
  /** The persona role — often mirrors stage but decoupled (e.g. reviewer). */
  role?: string
  /** Estimated character count of the prompt about to be sent. */
  promptSize?: number
  /** 0 for first attempt; N for the Nth retry. Drives escalation. */
  attempt?: number
  /** Per-project speed mode. Overrides stage defaults. */
  mode?: SpeedMode
  /** If the pipeline step hard-coded a model, we honor it and skip routing. */
  explicitModel?: string
  /** Same for explicit thinking level. */
  explicitThinking?: ThinkingLevel
}

export interface RouteDecision {
  model: string
  thinking?: ThinkingLevel
  /** Human-readable reason for the choice — logged and shown in UI. */
  reason: string
}

/**
 * Tier → model spec. The routing tables (and data/org/model-routing.yml) speak
 * in tiers named after the Anthropic line-up — haiku (small), sonnet (medium),
 * opus (large) — but what each tier resolves to comes from DEFAULT_MODEL* or the
 * first provider with credentials (see default-model.ts), so the same tables
 * work for OpenAI- or OpenRouter-only setups.
 */
const tiers = resolveTierModels()
export const MODELS: Record<'haiku' | 'sonnet' | 'opus', string> = {
  haiku: tiers.small,
  sonnet: tiers.medium,
  opus: tiers.large,
}

/** Routing-table key for a size tier. */
export const TIER_KEY: Record<ModelTier, keyof typeof MODELS> = { small: 'haiku', medium: 'sonnet', large: 'opus' }

const TIER: Array<keyof typeof MODELS> = ['haiku', 'sonnet', 'opus']

/**
 * Stage-family classification. Multiple AIDLC stages share a family and
 * therefore share routing defaults. Anything not listed falls into 'other'.
 */
function stageFamily(stage: string): 'plan' | 'implement' | 'review' | 'orchestrate' | 'chat' | 'other' {
  const s = stage.toLowerCase()
  if (['specify', 'plan', 'checklist', 'constitution', 'clarify'].includes(s)) return 'plan'
  if (['implement', 'tasks', 'testplan', 'parallelize', 'verify'].includes(s)) return 'implement'
  if (['review', 'gate'].includes(s)) return 'review'
  if (['orchestrate', 'merge'].includes(s)) return 'orchestrate'
  if (['chat', 'assistant'].includes(s)) return 'chat'
  return 'other'
}

interface RoutingConfig {
  defaults: Record<'plan' | 'implement' | 'review' | 'orchestrate' | 'chat' | 'other', {
    model: keyof typeof MODELS
    thinking?: ThinkingLevel
  }>
  modes: Record<SpeedMode, Partial<Record<
    'plan' | 'implement' | 'review' | 'orchestrate' | 'chat' | 'other',
    { model: keyof typeof MODELS; thinking?: ThinkingLevel }
  >>>
  /** Prompt size (chars) at which we always upgrade to Sonnet. */
  haikuMaxPromptChars: number
}

const BUILTIN_CONFIG: RoutingConfig = {
  defaults: {
    plan:        { model: 'sonnet', thinking: 'medium' },
    implement:   { model: 'sonnet', thinking: 'medium' },
    review:      { model: 'haiku' },
    orchestrate: { model: 'sonnet', thinking: 'medium' },
    chat:        { model: 'haiku' },
    other:       { model: 'sonnet' },
  },
  modes: {
    fast: {
      plan:        { model: 'haiku' },
      implement:   { model: 'haiku' },
      review:      { model: 'haiku' },
      orchestrate: { model: 'sonnet' },
      chat:        { model: 'haiku' },
      other:       { model: 'haiku' },
    },
    balanced: {
      // Empty override → use defaults.
    },
    quality: {
      plan:        { model: 'sonnet', thinking: 'high' },
      implement:   { model: 'sonnet', thinking: 'high' },
      review:      { model: 'sonnet' },
      orchestrate: { model: 'opus', thinking: 'high' },
      chat:        { model: 'sonnet' },
      other:       { model: 'sonnet', thinking: 'medium' },
    },
  },
  haikuMaxPromptChars: 50_000,
}

let cachedConfig: RoutingConfig | undefined

/**
 * Load routing config from `data/org/model-routing.yml` if present, else use
 * the built-in defaults. Called lazily; cached for the process lifetime.
 * Config is intentionally optional so the app runs without any customisation.
 */
export async function loadRoutingConfig(dataDir?: string): Promise<RoutingConfig> {
  if (cachedConfig) return cachedConfig
  const configPath = path.join(dataDir ?? path.join(process.cwd(), 'data'), 'org', 'model-routing.yml')
  try {
    const raw = await readFile(configPath, 'utf8')
    const parsed = parseYaml(raw) as Partial<RoutingConfig>
    // Shallow-merge on top of built-ins so config only needs to override what changes.
    cachedConfig = {
      defaults: { ...BUILTIN_CONFIG.defaults, ...(parsed.defaults ?? {}) },
      modes: {
        fast: { ...BUILTIN_CONFIG.modes.fast, ...(parsed.modes?.fast ?? {}) },
        balanced: { ...BUILTIN_CONFIG.modes.balanced, ...(parsed.modes?.balanced ?? {}) },
        quality: { ...BUILTIN_CONFIG.modes.quality, ...(parsed.modes?.quality ?? {}) },
      },
      haikuMaxPromptChars: parsed.haikuMaxPromptChars ?? BUILTIN_CONFIG.haikuMaxPromptChars,
    }
    routerLog.debug('loaded routing config', { configPath })
  } catch {
    cachedConfig = BUILTIN_CONFIG
    routerLog.debug('routing config not found; using built-in defaults', { configPath })
  }
  return cachedConfig
}

/** Test-only: reset the config cache (used by tests to swap in fixtures). */
export function _resetRoutingConfigCache(): void {
  cachedConfig = undefined
}

/**
 * Bump a model tier up by N steps. Haiku → Sonnet → Opus.
 * Capped at Opus; going beyond returns Opus.
 */
function bumpTier(model: keyof typeof MODELS, steps: number): keyof typeof MODELS {
  const idx = TIER.indexOf(model)
  const next = Math.min(TIER.length - 1, idx + Math.max(0, steps))
  return TIER[next]!
}

/**
 * The core routing function. Pure — takes an input + config, returns a decision.
 * Uses the loaded config; call loadRoutingConfig() first (pipeline-engine does
 * this on start).
 */
export function routeModel(input: RouteInput, config: RoutingConfig = BUILTIN_CONFIG): RouteDecision {
  // Precedence 1: explicit model on the pipeline step wins outright.
  if (input.explicitModel) {
    return {
      model: input.explicitModel,
      thinking: input.explicitThinking,
      reason: `pipeline template pinned model to ${input.explicitModel}`,
    }
  }

  const family = stageFamily(input.stage)
  const mode: SpeedMode = input.mode ?? 'balanced'

  // Precedence 5: base pick from mode override or family default.
  const modeOverride = config.modes[mode]?.[family]
  const base = modeOverride ?? config.defaults[family]
  let modelKey = base.model
  let thinking = base.thinking

  // Precedence 3: retry escalation. Each retry bumps one tier up.
  const attempt = input.attempt ?? 0
  if (attempt > 0) {
    const previous = modelKey
    modelKey = bumpTier(modelKey, attempt)
    if (previous !== modelKey) {
      return {
        model: MODELS[modelKey],
        thinking,
        reason: `retry #${attempt} — escalated ${previous} → ${modelKey} for ${family} stage`,
      }
    }
  }

  // Precedence 2: prompt-size guard. Haiku's context ceiling is lower than
  // Sonnet's; if we're routing to Haiku but the prompt is huge, bump.
  if (modelKey === 'haiku' && input.promptSize && input.promptSize > config.haikuMaxPromptChars) {
    return {
      model: MODELS.sonnet,
      thinking,
      reason: `prompt is ${input.promptSize} chars (>${config.haikuMaxPromptChars} threshold); routed to Sonnet instead of Haiku to avoid truncation`,
    }
  }

  const modeSuffix = mode === 'balanced' ? '' : ` (${mode} mode)`
  return {
    model: MODELS[modelKey],
    thinking,
    reason: `default for ${family} stage${modeSuffix}`,
  }
}
