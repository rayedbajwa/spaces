/**
 * Unified-diff parsing for the code review tab.
 *
 * GitHub returns each changed file's diff as a `patch` string of hunks. The
 * review UI renders it line by line and anchors inline comments the way
 * GitHub's review API expects: an added or unchanged line is addressed by its
 * new line number on the RIGHT side, a removed line by its old number on the
 * LEFT. No Node imports, so the web bundle can use it too.
 */

export type DiffLineKind = 'hunk' | 'context' | 'add' | 'del' | 'note'

export interface DiffLine {
  kind: DiffLineKind
  text: string
  oldLine?: number
  newLine?: number
}

export type DiffSide = 'LEFT' | 'RIGHT'

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

export function parsePatch(patch: string): DiffLine[] {
  const lines: DiffLine[] = []
  let oldLine = 0
  let newLine = 0
  for (const raw of patch.split('\n')) {
    const hunk = HUNK_HEADER.exec(raw)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      lines.push({ kind: 'hunk', text: raw })
      continue
    }
    if (raw.startsWith('\\')) {
      lines.push({ kind: 'note', text: raw.slice(1).trim() })
    } else if (raw.startsWith('+')) {
      lines.push({ kind: 'add', text: raw.slice(1), newLine: newLine++ })
    } else if (raw.startsWith('-')) {
      lines.push({ kind: 'del', text: raw.slice(1), oldLine: oldLine++ })
    } else if (lines.length > 0 && raw !== '') {
      // Context lines start with a space; an empty string is only the patch's final newline.
      lines.push({ kind: 'context', text: raw.slice(1), oldLine: oldLine++, newLine: newLine++ })
    }
  }
  return lines
}

/** Where a review comment on this line goes, or undefined for hunk headers and notes. */
export function commentAnchor(line: DiffLine): { side: DiffSide; line: number } | undefined {
  if (line.kind === 'del' && line.oldLine !== undefined) return { side: 'LEFT', line: line.oldLine }
  if ((line.kind === 'add' || line.kind === 'context') && line.newLine !== undefined) return { side: 'RIGHT', line: line.newLine }
  return undefined
}

export function anchorKey(path: string, side: DiffSide, line: number): string {
  return `${path}:${side}:${line}`
}
