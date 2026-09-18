import { describe, expect, test } from 'bun:test'
import { chunkText } from '../src/lib/chunker'

describe('chunkText', () => {
  test('empty input → no chunks', () => {
    expect(chunkText('')).toEqual([])
    expect(chunkText('   \n\n  ')).toEqual([])
  })

  test('short document is one chunk with its heading path', () => {
    const chunks = chunkText('# Title\n\nHello world.\n\n## Sub\n\nMore text.')
    expect(chunks.length).toBe(1)
    expect(chunks[0]!.text).toContain('Hello world.')
    expect(chunks[0]!.headingPath).toEqual(['Title'])
  })

  test('respects maxChars and overlaps neighbours', () => {
    const para = (n: number) => `Paragraph ${n} ${'lorem ipsum dolor sit amet '.repeat(20)}`.trim()
    const doc = Array.from({ length: 12 }, (_, i) => para(i)).join('\n\n')
    const chunks = chunkText(doc, { maxChars: 1_500, overlapChars: 200 })
    expect(chunks.length).toBeGreaterThan(3)
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(1_500 + 200 + 2)
    // Each chunk after the first starts with text that ended the previous one.
    for (let i = 1; i < chunks.length; i++) {
      const head = chunks[i]!.text.slice(0, 40)
      expect(chunks[i - 1]!.text).toContain(head)
    }
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i))
  })

  test('never splits a fenced code block', () => {
    const code = '```ts\n' + Array.from({ length: 80 }, (_, i) => `const v${i} = ${i}`).join('\n') + '\n```'
    const chunks = chunkText(`Intro.\n\n${code}\n\nOutro.`, { maxChars: 600, overlapChars: 0 })
    const withCode = chunks.filter((c) => c.text.includes('```ts'))
    expect(withCode.length).toBe(1)
    expect(withCode[0]!.text.trim().endsWith('```')).toBe(true)
  })

  test('new top-level heading starts a new chunk and tracks nested path', () => {
    const doc = '# A\n\nalpha text\n\n## A.1\n\nnested text\n\n# B\n\nbeta text'
    const chunks = chunkText(doc, { overlapChars: 0, minSectionChars: 1 })
    expect(chunks.length).toBe(2)
    expect(chunks[0]!.headingPath).toEqual(['A'])
    expect(chunks[0]!.text).toContain('nested text')
    expect(chunks[1]!.headingPath).toEqual(['B'])
  })

  test('a lone title line is merged with the section that follows it', () => {
    const chunks = chunkText('# Database migration policy\n\n# Migrations\n\nNever drop a column in the same release.', { overlapChars: 0 })
    expect(chunks.length).toBe(1)
    expect(chunks[0]!.text).toContain('Never drop a column')
  })

  test('oversized paragraph is hard-split at sentence boundaries', () => {
    const doc = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} is here.`).join(' ')
    const chunks = chunkText(doc, { maxChars: 400, overlapChars: 0 })
    expect(chunks.length).toBeGreaterThan(3)
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(400)
    expect(chunks.map((c) => c.text).join(' ').replace(/\s+/g, ' ')).toContain('Sentence number 59 is here.')
  })
})
