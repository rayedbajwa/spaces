import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Variables available to `when` expressions in template branch rules.
 * All values are strings (or undefined). Expressions are evaluated as strict
 * equality/inequality against string literals.
 */
export interface BranchVariables {
  verification_status?: 'pass' | 'fail' | 'partial'
  last_review_decision?: 'approved' | 'changes_requested'
  iteration?: string  // stringified count for the current step id
}

/**
 * Minimal expression evaluator supporting:
 *   <var> == 'literal'
 *   <var> != 'literal'
 *   true | false
 * Whitespace is tolerated. Unknown variables compare as undefined (== 'x' is false).
 */
export function evaluateBranchExpression(expr: string, vars: BranchVariables): boolean {
  const trimmed = expr.trim()

  if (trimmed === 'true') return true
  if (trimmed === 'false') return false

  const match = trimmed.match(/^([a-z_][a-z0-9_]*)\s*(==|!=)\s*'([^']*)'$/i)
  if (!match) {
    throw new Error(`Unsupported branch expression: ${expr}`)
  }

  const [, name, op, literal] = match
  const actual = (vars as Record<string, string | undefined>)[name!]
  const eq = actual === literal
  return op === '==' ? eq : !eq
}

/**
 * Read the current run's verification status by scanning the latest verification-report.md.
 * The Spec Kit skill writes a header line: "Verification Status: PASS|FAIL|PARTIAL".
 */
export async function readVerificationStatus(cwd: string): Promise<'pass' | 'fail' | 'partial' | undefined> {
  const specsDir = join(cwd, 'specs')
  let features: string[]
  try {
    features = await readdir(specsDir)
  } catch {
    return undefined
  }
  const latest = features.sort().reverse()[0]
  if (!latest) return undefined

  const reportPath = join(specsDir, latest, 'verification-report.md')
  let content: string
  try {
    content = await readFile(reportPath, 'utf8')
  } catch {
    return undefined
  }

  const match = content.match(/Verification Status:\s*(PASS|FAIL|PARTIAL)/i)
  if (!match) return undefined
  return match[1]!.toLowerCase() as 'pass' | 'fail' | 'partial'
}
