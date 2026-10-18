/**
 * Quality scores on each run's Phoenix session, so the project's Metrics page
 * charts them over time next to cost, latency and errors:
 *
 *   - `handoff-quality`: the share of the handoff checks (lib/handoff-evals)
 *     a stage's handoff passes, one per stage visit;
 *   - `report-format`: whether the verification report or code review is in
 *     the form Spaces reads (lib/agent-evals);
 *   - `loop-progress`: whether a verify moved the acceptance criteria met
 *     compared with the previous verify of the same project. A run of
 *     `same` is an implement loop going nowhere.
 *
 * Scored by the worker as each stage hands off (scoreStageHandoff), and for
 * past runs by scripts/phoenix-quality-backfill.ts from exported handoffs.
 * Never throws.
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { AGENT_CHECKS } from './agent-evals'
import { HANDOFF_CHECKS, type Handoff } from './handoff-evals'
import { log } from './logger'
import type { SessionAnnotation } from './phoenix-annotations'
import { summarizeVerification } from './verification-summary'

const qualityLog = log.child({ mod: 'phoenix-quality' })

export interface StageHandoff {
  stage: string
  stepIndex: number
  tail: string
  summary?: string | null
}

/** The handoff checks on one stage's handoff, as a 0–1 score. */
export function handoffQuality(h: StageHandoff): SessionAnnotation {
  const handoff: Handoff = { stage: h.stage, tail: h.tail ?? '', handoff: h.summary || h.tail || '', compacted: Boolean(h.summary) }
  const results = HANDOFF_CHECKS.map((c) => ({ name: c.name, ...c.check(handoff) }))
  const failed = results.filter((r) => !r.pass)
  return {
    name: 'handoff-quality',
    kind: 'CODE',
    identifier: `${h.stepIndex}:${h.stage}`,
    score: Math.round(((results.length - failed.length) / results.length) * 1000) / 1000,
    label: failed.length === 0 ? 'pass' : 'fail',
    explanation: failed.length === 0 ? `${h.stage}: all ${results.length} handoff checks pass.` : `${h.stage}: ${failed.map((f) => `${f.name} (${f.problems.join('; ')})`).join(' · ')}`,
    metadata: { stage: h.stage, failed: failed.map((f) => f.name) },
  }
}

const FORMAT_CHECK: Record<string, string> = { verify: 'verify-report-format', review: 'code-review-format' }

/** The format check on the report a verify or review stage wrote; undefined for other stages. */
export function reportFormat(stage: string, stepIndex: number, report: string): SessionAnnotation | undefined {
  const check = AGENT_CHECKS.find((c) => c.name === FORMAT_CHECK[stage])
  if (!check || !report.trim()) return undefined
  const result = check.check(report)
  return {
    name: 'report-format',
    kind: 'CODE',
    identifier: `${stepIndex}:${stage}`,
    label: result.pass ? 'pass' : 'fail',
    score: result.pass ? 1 : 0,
    explanation: result.pass ? `${check.name}: in the form Spaces reads.` : `${check.name}: ${result.problems.join('; ')}`,
    metadata: { stage, check: check.name },
  }
}

export interface CriteriaMet { met: number; total: number }

/** Criteria met as a verify stage reported them: the report itself, else its handoff ("PARTIAL: 5/15 AC"). */
export function criteriaMet(text: string): CriteriaMet | undefined {
  const summary = summarizeVerification(text)
  if (summary) return { met: summary.met, total: summary.total }
  const m = /(\d+)\s*\/\s*(\d+)\s*(?:AC\b|acceptance|criteria)/i.exec(text)
    ?? /(?:criteria met|\bAC)\b[:\s]*(\d+)\s*\/\s*(\d+)/i.exec(text)
    ?? /\b(?:PASS|FAIL|PARTIAL)\b[^\d\n]{0,4}(\d+)\s*\/\s*(\d+)/.exec(text)
  return m ? { met: Number(m[1]), total: Number(m[2]) } : undefined
}

/** Did this verify move the criteria met since the previous one? */
export function loopProgress(stepIndex: number, previous: CriteriaMet | undefined, current: CriteriaMet): SessionAnnotation {
  const label = !previous ? 'first' : current.met > previous.met ? 'progressed' : current.met < previous.met ? 'regressed' : 'same'
  return {
    name: 'loop-progress',
    kind: 'CODE',
    identifier: `${stepIndex}:verify`,
    label,
    score: label === 'progressed' || label === 'first' ? 1 : 0,
    explanation: previous ? `Criteria met ${previous.met}/${previous.total} → ${current.met}/${current.total}.` : `First verify: ${current.met}/${current.total} criteria met.`,
    metadata: { met: current.met, total: current.total, ...(previous ? { previousMet: previous.met } : {}) },
  }
}

/**
 * Score a stage as it hands off and record the scores on the run's session.
 * `previousVerify` is the criteria met at this project's last verify;
 * `rememberVerify` keeps this one for the next.
 */
export async function scoreStageHandoff(runId: string, h: StageHandoff, context: {
  projectPath: string
  previousVerify: () => Promise<CriteriaMet | undefined>
  rememberVerify: (met: CriteriaMet) => Promise<void>
}): Promise<void> {
  try {
    const annotations: SessionAnnotation[] = [handoffQuality(h)]
    if (h.stage === 'verify' || h.stage === 'review') {
      const { findLatestFeatureDirAbsolute } = await import('./aidlc')
      const featureDir = await findLatestFeatureDirAbsolute(context.projectPath)
      const file = h.stage === 'verify' ? 'verification-report.md' : 'code-review.md'
      const report = featureDir ? await readFile(path.join(featureDir, file), 'utf8').catch(() => '') : ''
      const format = reportFormat(h.stage, h.stepIndex, report)
      if (format) annotations.push(format)
      const met = h.stage === 'verify' ? criteriaMet(report) ?? criteriaMet(`${h.summary ?? ''}\n${h.tail}`) : undefined
      if (met) {
        annotations.push(loopProgress(h.stepIndex, await context.previousVerify(), met))
        await context.rememberVerify(met)
      }
    }
    const { annotateRun } = await import('./phoenix-annotations')
    await annotateRun(runId, annotations)
  } catch (error) {
    qualityLog.warn('stage not scored', { runId, stage: h.stage, error: error instanceof Error ? error.message : String(error) })
  }
}
