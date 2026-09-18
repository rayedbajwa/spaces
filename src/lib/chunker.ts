/**
 * Split a document into retrieval-sized chunks.
 *
 * Markdown-aware: never splits inside a fenced code block, prefers heading and
 * paragraph boundaries, records the heading path each chunk sits under (so a
 * hit can be shown as "Runbooks › Deploys › Rollback"), and overlaps
 * neighbouring chunks a little so sentences cut at a boundary survive.
 */

export interface Chunk {
  index: number
  text: string
  /** Nearest enclosing headings, outermost first. */
  headingPath: string[]
  charStart: number
  charEnd: number
}

export interface ChunkOptions {
  /** Target size in characters (~4 chars per token). */
  maxChars?: number
  /** Characters repeated from the end of one chunk at the start of the next. */
  overlapChars?: number
  /** A top-level heading only starts a new chunk once the current one has this many characters. */
  minSectionChars?: number
}

const DEFAULTS: Required<ChunkOptions> = { maxChars: 3_000, overlapChars: 300, minSectionChars: 200 }

interface Block { text: string; headingPath: string[]; start: number }

export function chunkText(input: string, options: ChunkOptions = {}): Chunk[] {
  const { maxChars, overlapChars, minSectionChars } = { ...DEFAULTS, ...options }
  const text = input.replace(/\r\n?/g, '\n')
  if (!text.trim()) return []

  const blocks = splitBlocks(text)
  const chunks: Chunk[] = []
  let current: Block[] = []
  let currentLen = 0

  const flush = () => {
    if (current.length === 0) return
    const first = current[0]!
    const last = current[current.length - 1]!
    const body = current.map((b) => b.text).join('\n\n')
    chunks.push({
      index: chunks.length,
      text: body,
      headingPath: first.headingPath,
      charStart: first.start,
      charEnd: last.start + last.text.length,
    })
    // Carry the tail of this chunk into the next one as overlap.
    if (overlapChars > 0 && body.length > overlapChars) {
      const tail = body.slice(-overlapChars)
      const cut = tail.search(/\s/)
      const overlap = cut === -1 ? tail : tail.slice(cut + 1)
      current = [{ text: overlap, headingPath: last.headingPath, start: last.start + last.text.length - overlap.length }]
      currentLen = overlap.length
    } else {
      current = []
      currentLen = 0
    }
  }

  for (const block of blocks) {
    // Fenced code is kept whole unless it is far over budget (then split by line).
    const fenced = /^\s*(```|~~~)/.test(block.text)
    const limit = fenced ? maxChars * 4 : maxChars
    const pieces = block.text.length > limit ? hardSplit(block, maxChars, fenced) : [block]
    for (const piece of pieces) {
      // A new top-level heading starts a fresh chunk so sections stay separable —
      // unless the current chunk is still tiny (e.g. just a title line).
      const startsSection = /^#\s/.test(piece.text) && currentLen >= Math.max(1, minSectionChars)
      if (startsSection || (currentLen > 0 && currentLen + piece.text.length + 2 > maxChars)) flush()
      current.push(piece)
      currentLen += piece.text.length + (current.length > 1 ? 2 : 0)
    }
  }
  flush()

  // The overlap carried after the last real block would produce a chunk that is
  // only a repeat of the previous tail; drop it.
  const last = chunks[chunks.length - 1]
  const prev = chunks[chunks.length - 2]
  if (last && prev && prev.text.endsWith(last.text)) chunks.pop()
  return chunks
}

/** Paragraph-level blocks; fenced code stays whole; headings update the path. */
function splitBlocks(text: string): Block[] {
  const lines = text.split('\n')
  const blocks: Block[] = []
  const path: Array<{ level: number; title: string }> = []
  let buffer: string[] = []
  let bufferStart = 0
  let offset = 0
  let inFence = false

  const currentPath = () => path.map((p) => p.title)
  const flush = () => {
    const body = buffer.join('\n').trim()
    if (body) blocks.push({ text: body, headingPath: currentPath(), start: bufferStart })
    buffer = []
  }

  for (const line of lines) {
    const lineStart = offset
    offset += line.length + 1
    if (/^\s*(```|~~~)/.test(line)) {
      if (buffer.length === 0) bufferStart = lineStart
      buffer.push(line)
      inFence = !inFence
      if (!inFence) flush()
      continue
    }
    if (inFence) { buffer.push(line); continue }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flush()
      const level = heading[1]!.length
      while (path.length && path[path.length - 1]!.level >= level) path.pop()
      path.push({ level, title: heading[2]!.trim() })
      // Emit the heading with its section's path so the chunk carries it.
      blocks.push({ text: line.trim(), headingPath: currentPath(), start: lineStart })
      continue
    }
    if (line.trim() === '') { flush(); continue }
    if (buffer.length === 0) bufferStart = lineStart
    buffer.push(line)
  }
  flush()
  return blocks
}

/** Split an oversized block on sentence ends (or lines, for code), then on whitespace. */
function hardSplit(block: Block, maxChars: number, byLine = false): Block[] {
  const out: Block[] = []
  let rest = block.text
  let start = block.start
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars)
    let cut = byLine ? window.lastIndexOf('\n') : Math.max(window.lastIndexOf('. '), window.lastIndexOf('\n'), window.lastIndexOf('; '))
    if (cut < maxChars * 0.5) cut = window.lastIndexOf(' ')
    if (cut < maxChars * 0.5) cut = maxChars
    const piece = rest.slice(0, cut + 1).trimEnd()
    out.push({ text: piece, headingPath: block.headingPath, start })
    start += cut + 1
    rest = rest.slice(cut + 1).trimStart()
  }
  if (rest.trim()) out.push({ text: rest, headingPath: block.headingPath, start })
  return out
}
