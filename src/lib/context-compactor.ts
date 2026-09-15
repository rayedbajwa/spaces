/**
 * Cross-stage token compaction — turn a stage's raw output tail into a compact
 * summary suitable for injection as preamble to the next stage.
 *
 * Why this exists separately from Pi's built-in compaction:
 *   - Pi's `AgentSession` auto-compacts INSIDE a live session (via
 *     shouldCompact + generateSummary). That handles context-window pressure
 *     within one stage.
 *   - THIS module handles the CROSS-STAGE case: when Spaces swaps models
 *     between stages (per the model router), the prior Pi session is torn
 *     down and its message history is gone. We only have the raw output
 *     string. Pi's `generateSummary` needs `AgentMessage[]` — not a fit.
 *   - We still use Pi's `estimateTokens` heuristic for the "should we
 *     bother compacting" decision so our threshold matches Pi's token math.
 *
 * Design choices:
 *   - Direct fetch to Anthropic Messages API — no Pi session spin-up for a
 *     one-shot summarization call.
 *   - Cheap model (Haiku by default) — negligible cost + latency.
 *   - Cache-first: keyed by SHA-1 of the raw tail via run_thread_entries.
 *     Same tail (e.g. repeated across runs) → reuse the existing summary.
 *   - Safe degrade: any error falls back to the raw tail, so a compactor
 *     outage never breaks the pipeline.
 */

import { createHash } from 'node:crypto'
import { estimateTokens } from '@earendil-works/pi-coding-agent'
import { getDb } from './db'
import { log } from './logger'

const compactorLog = log.child({ mod: 'context-compactor' })

/**
 * Tails shorter than this (estimated tokens) skip compaction — the summary
 * call itself would cost more than just injecting the raw text. Uses Pi's
 * `estimateTokens` for consistency with Pi's own compaction thresholds.
 */
const COMPACT_THRESHOLD_TOKENS = 200

/** Target size for the compact summary. Haiku respects this loosely. */
const TARGET_SUMMARY_CHARS = 400

/** Model used for compaction. Cheap + fast; overridable via env. */
const COMPACT_MODEL = process.env.COMPACT_MODEL || 'claude-haiku-4-5'

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

export interface CompactionResult {
  /** The text to actually inject into the next stage's preamble. */
  text: string
  /** SHA-1 of the raw tail — persisted so we can hit the cache on next compaction. */
  hash: string
  /** Whether we produced a real LLM summary or fell back to the raw tail. */
  compacted: boolean
  /** Whether the summary came from the cross-run cache instead of a fresh LLM call. */
  cached: boolean
}

function sha1(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex')
}

async function lookupCachedSummary(hash: string): Promise<string | undefined> {
  try {
    const sql = getDb()
    const [row] = await sql<Array<{ summary: string }>>`
      SELECT summary FROM run_thread_entries
       WHERE summary_hash = ${hash} AND summary IS NOT NULL
       LIMIT 1
    `
    return row?.summary
  } catch (err) {
    // Cache lookup failures shouldn't block compaction — treat as cache miss.
    compactorLog.debug('cache lookup failed', { hash, err: err instanceof Error ? err.message : String(err) })
    return undefined
  }
}

/**
 * One-shot Anthropic Messages call. Returns the assistant's text or throws.
 * Deliberately not using the Pi SDK — we want a small, dependency-free call.
 */
async function callAnthropicOnce(prompt: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set')

  const res = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: COMPACT_MODEL,
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Anthropic ${res.status}: ${body.slice(0, 300)}`)
  }

  const data = await res.json() as {
    content?: Array<{ type: string; text?: string }>
  }
  const text = (data.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text!)
    .join('')
    .trim()

  if (!text) throw new Error('Anthropic returned empty text content')
  return text
}

/**
 * Compact a stage output tail into a preamble-ready summary. Never throws —
 * on any error, returns the raw tail so the pipeline still gets its context.
 */
export async function compactHandoff(input: {
  stage: string
  stepId: string
  model?: string
  tail: string
}): Promise<CompactionResult> {
  const hash = sha1(input.tail)

  // Below threshold: don't bother compacting, just return the raw tail.
  // estimateTokens takes an AgentMessage; wrap our string as one so we use
  // Pi's real token math instead of a char-based heuristic.
  const estimatedTokens = estimateTokens({
    role: 'assistant',
    content: [{ type: 'text', text: input.tail }],
  } as never)
  if (estimatedTokens < COMPACT_THRESHOLD_TOKENS) {
    return { text: input.tail, hash, compacted: false, cached: false }
  }

  // Cache hit?
  const cached = await lookupCachedSummary(hash)
  if (cached) {
    compactorLog.debug('cache hit', { hash, stage: input.stage })
    return { text: cached, hash, compacted: true, cached: true }
  }

  // LLM call — safe-fail to raw tail on any error.
  try {
    const prompt = `You are compacting the last output of an SDLC pipeline stage so that a downstream stage can see it as concise preamble context.

Stage: ${input.stage}
Step: ${input.stepId}
${input.model ? `Model that produced it: ${input.model}\n` : ''}
Instructions:
- Produce a compact summary (~${TARGET_SUMMARY_CHARS} chars) that preserves:
  * Key decisions made
  * Named artifacts created or modified
  * Any open questions / blockers left for the next stage
  * Any hard constraints (contracts, invariants) that downstream stages must respect
- Drop chatter, hedging, and any commentary that isn't load-bearing.
- Output the summary as plain markdown. Do not preamble with "Here is a summary".

---

${input.tail}
`
    const summary = await callAnthropicOnce(prompt)
    compactorLog.debug('compacted stage tail', {
      hash,
      stage: input.stage,
      inputChars: input.tail.length,
      summaryChars: summary.length,
      ratio: `${((summary.length / input.tail.length) * 100).toFixed(0)}%`,
    })
    return { text: summary, hash, compacted: true, cached: false }
  } catch (err) {
    compactorLog.warn('compaction failed, falling back to raw tail', {
      hash,
      stage: input.stage,
      err: err instanceof Error ? err.message : String(err),
    })
    return { text: input.tail, hash, compacted: false, cached: false }
  }
}
