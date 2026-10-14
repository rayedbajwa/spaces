/**
 * How close a verification report came to passing.
 *
 * PASS is all-or-nothing, so a report with 49 of 50 criteria verified and one
 * minor gap reads the same as one with half the feature missing. Accepting the
 * former is usually the right call, and the board should say so instead of
 * steering the person back to another verify run that will land in the same
 * place. This reads the numbers verify writes near the top of the report and
 * decides whether "Accept and finish" is the sensible next step.
 *
 * Verify writes two lines under its status line:
 *
 *   Acceptance Criteria Met: 48/50
 *   Critical Issues Open: 0
 *
 * Reports written before those lines existed fall back to the requirement
 * traceability table (rows whose status is PASS, out of all rows) and to the
 * unsatisfied test cases and failing rows for anything critical.
 *
 * Some of what is left can only be done by a person: a signed build on a
 * device, a check with production keys, a sign-off. Verify lists those under
 * `## Owner-Run Checks`, apart from `## Unsatisfied Test Cases` (what an agent
 * can fix). When nothing is left for an agent, or implement changed no code
 * for the report it was given (lib/implement-progress.ts), running implement
 * again only lands in the same place, so accepting is suggested instead.
 */

import { implementStalled } from './implement-progress'

export interface VerificationSummary {
  met: number
  total: number
  /** Failures or gaps the report marks critical (or blocker / P0 / high severity). */
  criticalOpen: number
  /** Checks only a person can run, from `## Owner-Run Checks`; absent on older reports. */
  ownerChecks?: string[]
  /** Items under `## Unsatisfied Test Cases` for an agent to fix; absent when the section is missing. */
  agentOpen?: number
  /** Implement ran against this very report and changed no code (lib/implement-progress.ts). */
  stalled?: boolean
}

/** More than this share of criteria must be met before accepting is suggested. */
export const ACCEPT_THRESHOLD = 0.95

const CRITICAL = /\b(critical|blocker|blocking|P0|sev(?:erity)?[\s:-]*(?:1|high))\b/i

function explicitCounts(markdown: string): { met?: number; total?: number; critical?: number } {
  const criteria = /^\**Acceptance Criteria Met:?\**:?\s*(\d+)\s*(?:\/|of)\s*(\d+)/im.exec(markdown)
  const critical = /^\**Critical Issues Open:?\**:?\s*(\d+)/im.exec(markdown)
  return {
    met: criteria ? Number(criteria[1]) : undefined,
    total: criteria ? Number(criteria[2]) : undefined,
    critical: critical ? Number(critical[1]) : undefined,
  }
}

/** The body of the `## ...` section whose heading matches, up to the next heading of that level. */
function section(markdown: string, heading: RegExp): string {
  const lines = markdown.split('\n')
  const start = lines.findIndex((line) => /^##\s/.test(line) && heading.test(line))
  if (start < 0) return ''
  const end = lines.findIndex((line, i) => i > start && /^##\s/.test(line))
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n')
}

/** Status cells of the requirement traceability table: one per requirement row. */
function traceabilityStatuses(markdown: string): string[] {
  const body = section(markdown, /requirement/i)
  const rows = body.split('\n').filter((line) => line.trim().startsWith('|'))
  if (rows.length < 3) return []
  const cells = (row: string) => row.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim())
  const header = cells(rows[0]!)
  const statusColumn = header.findIndex((cell) => /status|result|pass\s*\/\s*fail/i.test(cell))
  if (statusColumn < 0) return []
  return rows.slice(2).map((row) => cells(row)[statusColumn] ?? '').filter(Boolean)
}

export function summarizeVerification(markdown: string): VerificationSummary | undefined {
  const explicit = explicitCounts(markdown)
  const statuses = traceabilityStatuses(markdown)

  let met = explicit.met
  let total = explicit.total
  if (total === undefined && statuses.length > 0) {
    total = statuses.length
    met = statuses.filter((status) => /^\**\s*(pass|passed|met|✅)/i.test(status)).length
  }
  if (!total || met === undefined) return undefined

  let criticalOpen = explicit.critical
  if (criticalOpen === undefined) {
    const failing = statuses.filter((status) => /^\**\s*(fail|failed|❌)/i.test(status)).length
    const unsatisfied = section(markdown, /unsatisfied test cases/i)
      .split('\n')
      .filter((line) => /^\s*[-*]\s/.test(line) && !/\(none\)/i.test(line) && CRITICAL.test(line)).length
    criticalOpen = failing + unsatisfied
  }

  const ownerChecks = bullets(section(markdown, /owner[- ]run checks/i))
  const unsatisfied = section(markdown, /unsatisfied test cases/i)
  const agentOpen = /^##\s.*unsatisfied test cases/im.test(markdown) ? bullets(unsatisfied).length : undefined
  return {
    met: Math.min(met, total),
    total,
    criticalOpen,
    ...(ownerChecks.length ? { ownerChecks } : {}),
    ...(agentOpen !== undefined ? { agentOpen } : {}),
  }
}

/**
 * The report's summary, marked stalled when implement-result.md says the last
 * implement changed no code for this very report.
 */
export function summarizeWithProgress(report: string, implementResult: string | undefined): VerificationSummary | undefined {
  const summary = summarizeVerification(report)
  return summary && implementStalled(report, implementResult) ? { ...summary, stalled: true } : summary
}

/** The bullet items of a section, without `(none)`. */
function bullets(body: string): string[] {
  return body.split('\n')
    .map((line) => /^\s*[-*]\s+(.*\S)\s*$/.exec(line)?.[1])
    .filter((item): item is string => Boolean(item) && !/^\(?none\)?\.?$/i.test(item!))
}

/**
 * Accepting is the suggested next step when verification did not pass but
 * another implement run would not change that:
 * - it came close: more than 95% of criteria met and nothing critical open;
 * - nothing is left for an agent: the unsatisfied test cases are empty and
 *   nothing critical is open (what remains is owner-run or environment-only);
 * - implement ran against this report and changed no code (stalled). This
 *   holds even with critical items open: the decision is then a person's,
 *   to accept or to request changes with directions.
 */
export function acceptanceRecommended(
  status: 'pass' | 'partial' | 'fail' | 'missing',
  summary: VerificationSummary | undefined,
): boolean {
  return acceptanceBasis(status, summary) !== undefined
}

export type AcceptanceBasis = 'near_pass' | 'nothing_for_agent' | 'stalled'

/** Why accepting is suggested, or undefined when it is not (see acceptanceRecommended). */
export function acceptanceBasis(
  status: 'pass' | 'partial' | 'fail' | 'missing',
  summary: VerificationSummary | undefined,
): AcceptanceBasis | undefined {
  if (status !== 'partial' && status !== 'fail') return undefined
  if (!summary || summary.total === 0) return undefined
  if (summary.stalled) return 'stalled'
  if (summary.criticalOpen !== 0) return undefined
  if (summary.met / summary.total > ACCEPT_THRESHOLD) return 'near_pass'
  if (summary.agentOpen === 0) return 'nothing_for_agent'
  return undefined
}

export function describeSummary(summary: VerificationSummary): string {
  const percent = Math.floor((summary.met / summary.total) * 1000) / 10
  const critical = summary.criticalOpen === 0 ? 'nothing critical open' : `${summary.criticalOpen} critical open`
  return `${summary.met}/${summary.total} criteria met (${percent}%), ${critical}`
}
