/**
 * What an agent does, as lines a person can follow in its log.
 *
 * An agent's text says what it intends ("Now T004 — Dockerfile build args");
 * the work itself happens in tool calls (commands, reads, edits, test runs),
 * which used to leave nothing in the log but blank lines. Each tool call now
 * adds one line when it starts (`▸ $ bun test tests/version.test.ts`,
 * `▸ edit src/lib/version.ts`) and, for commands and failures, one when it ends
 * (`✓ 2.1s · 12 pass, 0 fail`, `✗ 1.4s · error: …`). Lines always start on a
 * line of their own, even mid-sentence in the agent's text, and credentials
 * are masked before anything is written.
 */

type AgentEvent = { type: string; [key: string]: unknown }

const MAX_LINE = 160

/** Mask tokens and passwords that commands and outputs can carry. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[redacted]')
    .replace(/\b(sk-(?:ant-|or-|proj-)?[A-Za-z0-9_-]{16,})\b/g, '[redacted]')
    .replace(/\b(xox[abpr]-[A-Za-z0-9-]{10,})\b/g, '[redacted]')
    .replace(/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/g, '$1[redacted]@')
    .replace(/\b(Bearer|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi, '$1 [redacted]')
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|APIKEY)[A-Z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g, '$1=[redacted]')
}

function clip(text: string, max = MAX_LINE): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

/** The one line that says what a tool call is doing. */
export function describeToolCall(toolName: string, args: unknown): string {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
  const file = str(a.path) ?? str(a.file_path) ?? str(a.filePath) ?? str(a.file)
  switch (toolName) {
    case 'bash': return `$ ${clip(str(a.command) ?? '')}`
    case 'read': return `read ${file ?? ''}${typeof a.offset === 'number' ? ` (from line ${a.offset})` : ''}`
    case 'write': return `write ${file ?? ''}`
    case 'edit': return `edit ${file ?? ''}`
    case 'grep': return `grep ${clip(JSON.stringify(str(a.pattern) ?? ''), 80)}${file ? ` in ${file}` : ''}`
    case 'find': return `find ${clip(str(a.pattern) ?? str(a.name) ?? '', 80)}${file ? ` in ${file}` : ''}`
    case 'ls': return `ls ${file ?? '.'}`
    default: {
      const detail = Object.entries(a).filter(([, v]) => typeof v === 'string' || typeof v === 'number').map(([k, v]) => `${k}=${v}`).join(' ')
      return clip(`${toolName}${detail ? ` ${detail}` : ''}`)
    }
  }
}

/** The text a tool returned (its text content blocks, or the value itself). */
function resultText(result: unknown): string {
  if (typeof result === 'string') return result
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content
  if (Array.isArray(content)) return content.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n')
  return ''
}

function lastLine(text: string): string | undefined {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).at(-1)
}

function seconds(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

/**
 * Follows one agent session and says what to append to its log: the agent's
 * text as it streams, and a line per tool call. Feed it every event; write
 * what it returns.
 */
export function createActivityLog(options: { prefix?: string } = {}) {
  const prefix = options.prefix ? `[${options.prefix}] ` : ''
  const started = new Map<string, { at: number; name: string }>()
  let atLineStart = true

  const line = (text: string): string => {
    const out = `${atLineStart ? '' : '\n'}${prefix}${redactSecrets(text)}\n`
    atLineStart = true
    return out
  }

  return {
    /** What to append to the log for this event, if anything. */
    onEvent(event: AgentEvent): string | undefined {
      if (event.type === 'message_update') {
        const inner = event.assistantMessageEvent as { type?: string; delta?: string } | undefined
        if (inner?.type !== 'text_delta' || !inner.delta) return undefined
        // Prefixed logs (a sub-agent mirrored into another log) carry its text line by line.
        let text = inner.delta
        if (prefix) text = text.replace(/\n(?=.)/g, `\n${prefix}`).replace(/^(?=.)/, atLineStart ? prefix : '')
        atLineStart = text.endsWith('\n')
        return text
      }
      if (event.type === 'tool_execution_start') {
        const id = String(event.toolCallId ?? '')
        const name = String(event.toolName ?? 'tool')
        started.set(id, { at: Date.now(), name })
        return line(`▸ ${describeToolCall(name, event.args)}`)
      }
      if (event.type === 'tool_execution_end') {
        const id = String(event.toolCallId ?? '')
        const name = String(event.toolName ?? started.get(id)?.name ?? 'tool')
        const took = seconds(Date.now() - (started.get(id)?.at ?? Date.now()))
        started.delete(id)
        const tail = lastLine(resultText(event.result))
        if (event.isError) return line(`  ✗ ${took}${tail ? ` · ${clip(tail, 140)}` : ''}`)
        // Commands say how they ended (a test summary, a build line); reads and edits need no second line.
        if (name === 'bash') return line(`  ✓ ${took}${tail ? ` · ${clip(tail, 140)}` : ''}`)
        return undefined
      }
      return undefined
    },
  }
}
