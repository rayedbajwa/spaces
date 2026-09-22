import { describe, expect, test } from 'bun:test'
import { commentAnchor, parsePatch } from '../src/lib/diff-parse'

const PATCH = [
  '@@ -1,4 +1,5 @@',
  ' import a',
  '-const x = 1',
  '+const x = 2',
  '+const y = 3',
  ' ',
  ' export {}',
  '@@ -20,2 +21,2 @@ function tail() {',
  '-  return 1',
  '+  return 2',
  '\\ No newline at end of file',
].join('\n')

describe('parsePatch', () => {
  const lines = parsePatch(PATCH)

  test('numbers old and new lines through each hunk', () => {
    expect(lines.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([
      ['hunk', undefined, undefined],
      ['context', 1, 1],
      ['del', 2, undefined],
      ['add', undefined, 2],
      ['add', undefined, 3],
      ['context', 3, 4],
      ['context', 4, 5],
      ['hunk', undefined, undefined],
      ['del', 20, undefined],
      ['add', undefined, 21],
      ['note', undefined, undefined],
    ])
  })

  test('strips the diff marker from the text', () => {
    expect(lines[3]!.text).toBe('const x = 2')
    expect(lines[5]!.text).toBe('')
  })

  test('ignores the trailing newline of a patch', () => {
    expect(parsePatch('@@ -1 +1 @@\n-a\n+b\n').map((l) => l.kind)).toEqual(['hunk', 'del', 'add'])
  })
})

describe('commentAnchor', () => {
  const lines = parsePatch(PATCH)
  test('added and unchanged lines are addressed on the RIGHT by new number', () => {
    expect(commentAnchor(lines[3]!)).toEqual({ side: 'RIGHT', line: 2 })
    expect(commentAnchor(lines[1]!)).toEqual({ side: 'RIGHT', line: 1 })
  })
  test('removed lines are addressed on the LEFT by old number', () => {
    expect(commentAnchor(lines[2]!)).toEqual({ side: 'LEFT', line: 2 })
  })
  test('hunk headers and notes take no comments', () => {
    expect(commentAnchor(lines[0]!)).toBeUndefined()
    expect(commentAnchor(lines[10]!)).toBeUndefined()
  })
})
