/**
 * Whether an implement run changed any code.
 *
 * Implement works through what verification flagged. When what is left needs a
 * person (a device, production keys, a sign-off), it has nothing to change, and
 * running it again lands in the same place: DEFA-4 recorded 55 such no-op
 * passes, each a full agent run. After each implement stage the engine writes
 * `implement-result.md` in the intent's directory: whether the checkouts changed
 * outside `specs/`, and which verification report it worked from. While that
 * report is still the current one, a NO_CHANGES result means another implement
 * run would not help (lib/verification-summary.ts: stalled).
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

export const IMPLEMENT_RESULT_FILE = 'implement-result.md'

/** Every local branch's commit, plus uncommitted changes outside specs/, per checkout. */
export type CheckoutSnapshot = Map<string, { refs: Map<string, string>; dirty: string }>

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

/** Pathspec for code: everything but the intent documents. */
const OUTSIDE_SPECS = ['--', '.', ':(exclude)specs']

export function snapshotCheckouts(paths: string[]): CheckoutSnapshot {
  const snapshot: CheckoutSnapshot = new Map()
  for (const cwd of paths) {
    try {
      const refs = new Map(git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'])
        .split('\n').filter(Boolean).map((line) => line.split(' ') as [string, string]))
      const dirty = git(cwd, ['status', '--porcelain', ...OUTSIDE_SPECS])
      snapshot.set(cwd, { refs, dirty })
    } catch {
      // Not a git checkout: nothing to compare.
    }
  }
  return snapshot
}

/**
 * Whether any checkout changed code between two snapshots: a branch moved or
 * appeared with changes outside specs/, or uncommitted changes outside specs/
 * differ. Commits that only touch specs/ (tasks.md notes) do not count.
 */
export function codeChanged(before: CheckoutSnapshot, after: CheckoutSnapshot): boolean {
  for (const [cwd, now] of after) {
    const was = before.get(cwd)
    if (!was) return true
    if (now.dirty !== was.dirty) return true
    for (const [ref, sha] of now.refs) {
      const old = was.refs.get(ref)
      if (old === sha) continue
      // A new branch is compared with where HEAD was; a moved one with where it was.
      const base = old ?? was.refs.get(headRef(cwd) ?? '') ?? [...was.refs.values()][0]
      if (!base) return true
      try {
        if (git(cwd, ['diff', '--name-only', base, sha, ...OUTSIDE_SPECS])) return true
      } catch {
        return true
      }
    }
  }
  return false
}

function headRef(cwd: string): string | undefined {
  try {
    return git(cwd, ['symbolic-ref', '-q', 'HEAD']) || undefined
  } catch {
    return undefined
  }
}

export function reportFingerprint(report: string): string {
  return createHash('sha256').update(report.trim()).digest('hex').slice(0, 16)
}

export function renderImplementResult(input: { changed: boolean; verificationReport?: string; at?: Date }): string {
  return [
    `Implement Result: ${input.changed ? 'CHANGED' : 'NO_CHANGES'}`,
    `Verification Report: ${input.verificationReport ? reportFingerprint(input.verificationReport) : 'none'}`,
    `At: ${(input.at ?? new Date()).toISOString()}`,
    '',
    input.changed
      ? 'Implement changed code in the checkouts.'
      : 'Implement changed no code outside specs/. While the verification report above is the current one, running implement again would not change it: what is left needs a person.',
    '',
  ].join('\n')
}

/** Implement ran against this very verification report and changed no code. */
export function implementStalled(verificationReport: string | undefined, implementResult: string | undefined): boolean {
  if (!verificationReport || !implementResult) return false
  if (!/^Implement Result:\s*NO_CHANGES\b/im.test(implementResult)) return false
  const against = /^Verification Report:\s*([0-9a-f]+)/im.exec(implementResult)?.[1]
  return against === reportFingerprint(verificationReport)
}
