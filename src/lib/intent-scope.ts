/**
 * An intent's scope: what kind of work it is (a bug fix, a feature, an MVP…).
 *
 * The person picks one when starting an intent, or leaves it to the agent
 * ("auto"), which chooses from the description. Either way specify records it
 * as a `**Scope**: <scope>` line under the spec's title and sizes the spec to
 * it — a bug fix gets a short reproduce-and-fix spec, an MVP only what the
 * first usable version needs. The spec line is the record: syncs read it into
 * intents.scope, and changing the scope rewrites the line. Any short label is
 * allowed; the known ones below come with guidance.
 */

export interface ScopeOption {
  id: string
  label: string
  /** What the spec should look like for this scope (for specify). */
  guidance: string
}

export const INTENT_SCOPES: ScopeOption[] = [
  { id: 'bugfix', label: 'Bug fix', guidance: 'Keep the spec short: the defect, steps to reproduce, expected versus actual behaviour, the fix and a regression test. No new user stories beyond restoring correct behaviour.' },
  { id: 'feature', label: 'Feature', guidance: 'A complete feature: user stories with priorities, functional requirements and measurable acceptance criteria.' },
  { id: 'mvp', label: 'MVP', guidance: 'The smallest version that is usable end to end: only the P1 user stories, the fewest requirements that prove the idea, and everything else listed as out of scope for later.' },
  { id: 'improvement', label: 'Improvement', guidance: 'A change to existing behaviour: what is there today, what changes and why, and acceptance criteria that show the improvement without breaking what works.' },
  { id: 'chore', label: 'Chore', guidance: 'Maintenance with no user-facing change (refactor, upgrade, cleanup): the goal, the constraints, and how to confirm nothing changed for users.' },
  { id: 'spike', label: 'Spike', guidance: 'A time-boxed investigation: the question to answer, the options to explore and what a useful answer looks like. The outcome is findings, not production code.' },
]

export const AUTO_SCOPE = 'auto'

/**
 * A scope as stored: lower-case, words joined by hyphens, at most 30
 * characters. Undefined when there is nothing usable (or "auto").
 */
export function normalizeScope(input: string | null | undefined): string | undefined {
  const clean = (input ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '')
  if (!clean || clean === AUTO_SCOPE) return undefined
  const aliases: Record<string, string> = { bug: 'bugfix', 'bug-fix': 'bugfix', fix: 'bugfix', hotfix: 'bugfix', feat: 'feature', enhancement: 'improvement', refactor: 'chore', research: 'spike' }
  return aliases[clean] ?? clean
}

/** The label a person sees for a stored scope. */
export function scopeLabel(scope: string): string {
  return INTENT_SCOPES.find((s) => s.id === scope)?.label ?? scope.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

const SCOPE_LINE = /^\s*[-*]?\s*\**\s*Scope\s*\**\s*:\s*\**\s*([^*\n]+?)\s*\**\s*$/im

/** The scope a spec records, if any. */
export function parseScope(spec: string | undefined): string | undefined {
  const match = spec ? SCOPE_LINE.exec(spec) : null
  return match ? normalizeScope(match[1]) : undefined
}

/** The spec with its scope line set (replaced, or added under the title). */
export function setScopeInSpec(spec: string, scope: string): string {
  const line = `**Scope**: ${scope}`
  if (SCOPE_LINE.test(spec)) return spec.replace(SCOPE_LINE, line)
  const lines = spec.split('\n')
  const title = lines.findIndex((l) => l.startsWith('# '))
  lines.splice(title === -1 ? 0 : title + 1, 0, ...(title === -1 ? [line, ''] : ['', line]))
  return lines.join('\n')
}

/** What specify is told about the scope: the one chosen, or to choose one. */
export function scopeInstruction(scope: string | undefined): string {
  const known = INTENT_SCOPES.map((s) => `- ${s.id}: ${s.guidance}`).join('\n')
  const record = 'Record it in spec.md as a line directly under the title, exactly in this form: `**Scope**: <scope>`.'
  if (scope) {
    const option = INTENT_SCOPES.find((s) => s.id === scope)
    return [
      `## Intent scope: ${scope}`,
      `The person chose this intent's scope. ${record}`,
      option ? `Size the spec to it: ${option.guidance}` : `"${scope}" is a custom scope: size the spec to what that kind of work needs.`,
    ].join('\n\n')
  }
  return [
    '## Intent scope: decide it',
    `No scope was chosen. Decide it from the description: one of the scopes below, or a short custom label when none fits. ${record} Then size the spec to it:`,
    known,
  ].join('\n\n')
}
