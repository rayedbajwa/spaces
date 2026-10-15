/**
 * What a stage handoff must carry, as checks Phoenix can run.
 *
 * When a stage finishes, the pipeline keeps the tail of its output, compacts
 * it into a summary (src/lib/context-compactor.ts) and puts that summary in
 * the next stage's prompt as cross-stage memory (run_thread_entries). These
 * checks compare what the next stage receives with what the stage wrote: the
 * status it reached, the commits, pull requests and files it named, a question
 * it left open, and that masking did not hide what was never a secret. Whether
 * the summary is faithful overall needs judgement: HANDOFF_JUDGE_PROMPTS.
 *
 * `scripts/phoenix-evals.ts --handoffs` builds the `spaces-handoffs` dataset
 * from run_thread_entries and runs these checks on it.
 */

import { QUESTION_PATTERN } from './aidlc'
import { maskOutput } from './guardrails'
import type { CheckResult } from './agent-evals'

/** One saved handoff: what the stage wrote and what the next stage receives. */
export interface Handoff {
  stage: string
  /** The end of the stage's output, as the pipeline kept it. */
  tail: string
  /** What the next stage receives: the summary, or the tail when there is none. */
  handoff: string
  /** Whether `handoff` is a summary (false: the raw tail was passed on). */
  compacted: boolean
}

export interface HandoffCheck {
  /** Evaluator name in Phoenix. */
  name: string
  rule: string
  check: (h: Handoff) => CheckResult & { score?: number }
}

/** Below this the stage's output was cut off or empty: nothing a next stage can use. */
const MIN_OUTPUT_CHARS = 80
/** Share of the commits, pull requests and spec files the handoff must keep. */
const REFERENCE_THRESHOLD = 0.75
/** The compactor summarizes tails over 200 tokens; about 4 characters a token, with margin. */
const COMPACT_EXPECTED_CHARS = 1000

const result = (problems: Array<string | false | null | undefined>, score?: number): CheckResult & { score?: number } => {
  const list = problems.filter((p): p is string => Boolean(p))
  return { pass: list.length === 0, problems: list, ...(score === undefined ? {} : { score }) }
}

const STATUS_LINE = /\b(Verification|Code Review|Delivery|Dev Setup) Status:\s*\**\s*([A-Z_]+)\b/g
const MASK_LABEL = /\[(?:redacted[^\]]*|email|phone|ssn|card|iban)\]/gi

/** Commits, pull requests and spec files a stage named, as the strings to look for. */
export function references(text: string): string[] {
  const found = new Set<string>()
  // Short or full SHAs in backticks or after "commit"/"@": hex with at least one digit and one letter.
  for (const m of text.matchAll(/(?:`|\bcommit\s+|@\s*)([0-9a-f]{7,40})\b/gi)) {
    const sha = m[1]!.toLowerCase()
    if (/\d/.test(sha) && /[a-f]/.test(sha)) found.add(sha.slice(0, 7))
  }
  for (const m of text.matchAll(/\bPR\s*#(\d+)\b|\/pull\/(\d+)\b/gi)) found.add(`#${m[1] ?? m[2]}`)
  for (const m of text.matchAll(/\bspecs\/[\w.-]+\/([\w./-]+\.\w+)/g)) found.add(m[1]!.split('/').at(-1)!)
  return [...found]
}

export const HANDOFF_CHECKS: HandoffCheck[] = [
  {
    name: 'handoff-complete',
    rule: `The stage's output is there to hand off: at least ${MIN_OUTPUT_CHARS} characters, not cut off.`,
    check: ({ tail }) => {
      const text = tail.trim()
      return result([text.length < MIN_OUTPUT_CHARS && `the stage's output is ${text.length} characters (${JSON.stringify(text.slice(0, 40))}): cut off or empty, so the next stage gets nothing from it`])
    },
  },
  {
    name: 'handoff-compacted',
    rule: `An output over about ${COMPACT_EXPECTED_CHARS} characters reaches the next stage as a summary, not the raw tail.`,
    check: ({ tail, compacted }) => result([!compacted && tail.trim().length > COMPACT_EXPECTED_CHARS && `the raw ${tail.trim().length}-character tail was passed on: compaction failed or the organization has no key that can summarize`]),
  },
  {
    name: 'handoff-keeps-status',
    rule: 'A status the stage reached (Verification, Code Review, Delivery, Dev Setup) is in the handoff.',
    check: ({ tail, handoff }) => {
      const statuses = [...tail.matchAll(STATUS_LINE)].map((m) => ({ kind: m[1]!, value: m[2]! }))
      const lost = statuses.filter((s) => !handoff.toUpperCase().includes(s.value.toUpperCase()))
      return result(lost.map((s) => `${s.kind} Status ${s.value} is not in the handoff`))
    },
  },
  {
    name: 'handoff-keeps-references',
    rule: `The handoff keeps at least ${REFERENCE_THRESHOLD * 100}% of the commits, pull requests and spec files the stage named.`,
    check: ({ tail, handoff }) => {
      const refs = references(tail)
      if (refs.length === 0) return result([], 1)
      const lower = handoff.toLowerCase()
      const missing = refs.filter((r) => !lower.includes(r.toLowerCase()))
      const score = (refs.length - missing.length) / refs.length
      return result([score < REFERENCE_THRESHOLD && `kept ${refs.length - missing.length}/${refs.length}; missing ${missing.join(', ')}`], score)
    },
  },
  {
    name: 'handoff-keeps-question',
    rule: 'When the stage stopped on a question, the handoff says a question or approval is pending.',
    check: ({ tail, handoff }) => result([QUESTION_PATTERN.test(tail) && !/question|approv|await|waiting|confirm|\?/i.test(handoff) && 'the stage asked a question but the handoff does not say one is pending']),
  },
  {
    name: 'handoff-not-over-redacted',
    rule: "Masking in the handoff hides only what is sensitive in the stage's own output.",
    check: ({ tail, handoff }) => {
      const expected = maskOutput(tail).match(MASK_LABEL)?.length ?? 0
      const marks = [...handoff.matchAll(MASK_LABEL)]
      if (marks.length <= expected) return result([])
      const where = marks.slice(0, 3).map((m) => JSON.stringify(handoff.slice(Math.max(0, m.index! - 24), m.index! + m[0].length))).join(', ')
      return result([`${marks.length} masked value(s) in the handoff, ${expected} in the stage's output: ${where}`])
    },
  },
]

/**
 * Rules that need judgement, as LLM-judge prompts for Phoenix's evaluator UI.
 * {{input}} is the stage's output tail, {{output}} what the next stage receives.
 */
export const HANDOFF_JUDGE_PROMPTS: Array<{ name: string; prompt: string }> = [
  {
    name: 'handoff-faithful',
    prompt: `A pipeline stage finished and its output was summarized for the next stage, which sees only the summary.
Stage output:
{{input}}
Summary passed on:
{{output}}
Does the summary keep what the next stage needs (the status reached, decisions, artifacts and commits, blockers, open questions) and state nothing the output does not? Answer "faithful", "lossy" (drops something needed) or "unfaithful" (adds or changes facts), then one sentence naming what.`,
  },
]
