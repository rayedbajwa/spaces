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
    // Private key blocks, whole.
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted private key]')
    // Provider tokens by shape.
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[redacted]')
    .replace(/\b(sk-(?:ant-|or-|proj-)?[A-Za-z0-9_-]{16,})\b/g, '[redacted]')
    .replace(/\b(xox[abpr]-[A-Za-z0-9-]{10,})\b/g, '[redacted]')
    .replace(/\b((?:AKIA|ASIA)[0-9A-Z]{16})\b/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted jwt]')
    // Credentials in any URL (postgres://, mysql://, redis://, https://…): keep the user, mask the password.
.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@"'`]*):([^\s/@"'`]+)@/gi, '$1$2:[redacted]@')
    // Secrets passed as query parameters.
    .replace(/([?&](?:password|passwd|pass|pwd|token|access_token|secret|client_secret|api[_-]?key|apikey|sig|signature|key)=)[^&\s"'`#]+/gi, '$1[redacted]')
    .replace(/\b(Bearer|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi, '$1 [redacted]')
    // NAME=value where the name says it is secret (TOKEN, SECRET, PASSWORD, PASS, PWD, *_KEY, CREDENTIAL, AUTH).
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|API_?KEY|_KEY|CREDENTIALS?|AUTH)[A-Z0-9_]*)=("[^"]*"|'[^']*'|[^\s"'`]+)/g, '$1=[redacted]')
    // "password": "…" in JSON or YAML-ish output.
    .replace(/(["']?(?:password|passwd|secret|client_secret|token|access_token|refresh_token|api_?key|private_key)["']?\s*[:=]\s*)(["'])(?:(?!\2).)+\2/gi, '$1$2[redacted]$2')
}

/**
 * redactSecrets for text that arrives in pieces (streamed agent output). A
 * secret can be split across chunks, so only complete lines are masked and
 * passed on; a partial line waits for its newline (or `flush`, or until it is
 * longer than `maxHold`). A private key block is dropped from BEGIN to END
 * even though it spans lines.
 */
export function createSecretRedactor(options: { maxHold?: number } = {}) {
  const maxHold = options.maxHold ?? 8192
  let pending = ''
  let inPrivateKey = false
  const line = (text: string): string => {
    if (inPrivateKey) {
      if (/-----END [A-Z ]*PRIVATE KEY-----/.test(text)) {
        inPrivateKey = false
        return redactSecrets(text.replace(/^[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/, ''))
      }
      return ''
    }
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text) && !/-----END [A-Z ]*PRIVATE KEY-----/.test(text)) inPrivateKey = true
    return redactSecrets(text)
  }
  return {
    /** The complete lines of `chunk` (with what was waiting), masked; the rest waits. */
    push(chunk: string): string {
      pending += chunk
      const cut = pending.lastIndexOf('\n')
      if (cut === -1) return pending.length > maxHold ? this.flush() : ''
      const complete = pending.slice(0, cut + 1)
      pending = pending.slice(cut + 1)
      return complete.split(/(?<=\n)/).map(line).join('')
    },
    /** Whatever is waiting, masked (end of a stream, or a pause in it). */
    flush(): string {
      const out = pending ? line(pending) : ''
      pending = ''
      return out
    },
    get pending(): boolean { return pending.length > 0 },
  }
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

/** A log line's stamp: `[03:41:05Z implement] `. Time is UTC. */
const STAMPED = /^\[\d\d:\d\d:\d\dZ[ \]]/

function clock(now: Date): string {
  return `${now.toISOString().slice(11, 19)}Z`
}

/**
 * Marks the start of every line in a stream of log chunks with the time and
 * the agent writing it: `[03:41:05Z implement] ▸ $ bun test`. Chunks can end
 * mid-line (streamed text); the stamp goes where each line begins. A line
 * that already carries a stamp (a sub-agent's, mirrored in) keeps its own.
 */
export function createLineStamper(options: { label?: () => string | undefined; timestamps?: boolean; now?: () => Date } = {}) {
  const timestamps = options.timestamps ?? true
  const now = options.now ?? (() => new Date())
  let atLineStart = true
  const stampFor = () => {
    const label = options.label?.()
    const parts = [timestamps ? clock(now()) : '', label ?? ''].filter(Boolean)
    return parts.length ? `[${parts.join(' ')}] ` : ''
  }
  return {
    stamp(chunk: string): string {
      if (!chunk) return chunk
      let out = ''
      for (const piece of chunk.split(/(?<=\n)/)) {
        if (atLineStart && piece !== '\n' && !STAMPED.test(piece)) out += stampFor()
        out += piece
        atLineStart = piece.endsWith('\n')
      }
      return out
    },
  }
}

/**
 * Follows one agent session and says what to append to its log: the agent's
 * text as it streams, and a line per tool call. Feed it every event; write
 * what it returns. With `label` (and by default a time) every line is stamped
 * with who wrote it and when — for sub-agents whose lines join a shared log,
 * or a log of their own.
 */
export function createActivityLog(options: { label?: string; timestamps?: boolean; now?: () => Date; redact?: boolean } = {}) {
  // Masked line by line as it is written (a secret can span streamed deltas); off when the caller masks.
  const redactor = options.redact === false ? undefined : createSecretRedactor()
  const stamper = options.label || options.timestamps
    ? createLineStamper({ label: () => options.label, timestamps: options.timestamps ?? true, now: options.now })
    : undefined
  const started = new Map<string, { at: number; name: string }>()
  let atLineStart = true

  const emit = (text: string): string => {
    atLineStart = text.endsWith('\n')
    const safe = redactor ? redactor.push(text) : text
    return stamper ? stamper.stamp(safe) : safe
  }
  const line = (text: string): string => emit(`${atLineStart ? '' : '\n'}${redactSecrets(text)}\n`)

  return {
    /** The end of the log: what the redactor was still holding back. */
    flush(): string {
      const rest = redactor?.flush() ?? ''
      return rest && stamper ? stamper.stamp(rest) : rest
    },
    /** What to append to the log for this event, if anything. */
    onEvent(event: AgentEvent): string | undefined {
      if (event.type === 'message_update') {
        const inner = event.assistantMessageEvent as { type?: string; delta?: string } | undefined
        if (inner?.type !== 'text_delta' || !inner.delta) return undefined
        return emit(inner.delta)
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
