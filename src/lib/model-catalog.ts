/**
 * The model catalog: every chat model the Pi runtime knows, with the facts
 * routing needs — provider, price per million tokens, context size, reasoning
 * support — plus derived hints (generation, size class). Nothing here names a
 * model to use; the policy in model-policy.ts scores these facts.
 */

import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { log } from './logger'

const catalogLog = log.child({ mod: 'model-catalog' })

export type SizeHint = 'small' | 'large' | undefined

export interface CatalogModel {
  provider: string
  id: string
  /** `provider/id`, what runs and templates use. */
  spec: string
  name: string
  reasoning: boolean
  /** USD per million tokens. */
  inputCost: number
  outputCost: number
  cacheReadCost: number
  cacheWriteCost: number
  /** 3:1 input:output blend — a typical agent turn reads far more than it writes. */
  blendedCost: number
  contextWindow: number
  maxTokens: number
  /** Numeric generation parsed from the id (gpt-5.4 → 5.4, claude-opus-4-7 → 4.7). */
  generation: number
  sizeHint: SizeHint
  /** Why this model is skipped for routing, or undefined when it is a candidate. */
  excluded?: string
}

/** Models routing never picks on its own: non-chat modalities, aliases, snapshots, legacy. */
const EXCLUDE_PATTERNS: Array<[RegExp, string]> = [
  [/embed|embedding/i, 'embedding model'],
  [/audio|realtime|transcri|tts|whisper|speech|voxtral/i, 'audio model'],
  [/image|dall-e|vision-only|imagen/i, 'image model'],
  [/deep-research|search-preview|computer-use|codex-spark|owl-alpha/i, 'special-purpose model'],
  [/-\d{8}$|-\d{4}-\d{2}-\d{2}$|-\d{4}$/, 'dated snapshot (the alias is routed instead)'],
  [/chat-latest|latest$/i, 'floating alias'],
  [/free$/i, 'free tier (rate-limited)'],
  [/gpt-oss|gpt-3\.5|^gpt-4$|gpt-4-turbo|gpt-4\.1|gpt-4o/i, 'previous generation'],
  [/claude-3|claude-opus-4$|claude-sonnet-4$|claude-opus-4\.1|claude-opus-4-1/i, 'previous generation'],
  [/^o[134](-|$)/i, 'previous generation'],
]

export function generationOf(id: string): number {
  const base = id.split('/').pop() ?? id
  // gpt-5.4, gemini-2.5-pro, grok-4.3 → first "N.N"; claude-opus-4-7 → "4-7" → 4.7; gpt-5 → 5.
  const dotted = /(\d+)\.(\d+)/.exec(base)
  if (dotted) return Number(`${dotted[1]}.${dotted[2]}`)
  const dashed = /(\d+)-(\d)(?!\d)/.exec(base)
  if (dashed) return Number(`${dashed[1]}.${dashed[2]}`)
  const single = /(?:^|[^\d.])(\d+)(?![\d.])/.exec(base)
  return single ? Number(single[1]) : 0
}

export function sizeHintOf(id: string): SizeHint {
  const base = (id.split('/').pop() ?? id).toLowerCase()
  if (/mini|nano|haiku|flash|lite|small|fast|micro|tiny/.test(base)) return 'small'
  if (/opus|fable|(^|-)pro($|-)|max|large|ultra|premier/.test(base)) return 'large'
  return undefined
}

export function describeCatalogModel(model: { provider: string; id: string; name: string; reasoning: boolean; cost: { input: number; output: number; cacheRead?: number; cacheWrite?: number }; contextWindow: number; maxTokens: number; input?: string[] }): CatalogModel {
  const spec = `${model.provider}/${model.id}`
  const excluded = EXCLUDE_PATTERNS.find(([re]) => re.test(model.id))?.[1]
    ?? (model.input && !model.input.includes('text') ? 'no text input' : undefined)
    ?? (model.cost.input <= 0 && model.cost.output <= 0 ? 'no price data' : undefined)
  return {
    provider: model.provider,
    id: model.id,
    spec,
    name: model.name,
    reasoning: model.reasoning,
    inputCost: model.cost.input,
    outputCost: model.cost.output,
    cacheReadCost: model.cost.cacheRead ?? model.cost.input * 0.1,
    cacheWriteCost: model.cost.cacheWrite ?? model.cost.input * 1.25,
    blendedCost: (3 * model.cost.input + model.cost.output) / 4,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    generation: generationOf(model.id),
    sizeHint: sizeHintOf(model.id),
    ...(excluded ? { excluded } : {}),
  }
}

let cached: Promise<CatalogModel[]> | undefined

/** All models the runtime knows (cached for the process; the registry is static). */
export function loadModelCatalog(): Promise<CatalogModel[]> {
  if (!cached) {
    cached = (async () => {
      const runtime = await ModelRuntime.create()
      const models = runtime.getModels().map((m) => describeCatalogModel(m as never))
      catalogLog.debug('model catalog loaded', { models: models.length, providers: new Set(models.map((m) => m.provider)).size })
      return models
    })().catch((error) => {
      cached = undefined
      throw error
    })
  }
  return cached
}
