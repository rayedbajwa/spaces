/**
 * AI data guardrails: keep secrets and personal data away from the model.
 *
 * Everything an agent sends to its model provider — the system prompt, the
 * stage prompt and shared context, every tool result (file reads, command
 * output), the whole history — passes one choke point (the session's
 * streamFn). There each secret (keys, tokens, passwords, connection strings)
 * and each piece of personal data (emails, phone numbers, SSNs, card numbers,
 * IBANs) is swapped for a stable token such as <EMAIL_1> or <SECRET_2>. The
 * model reasons with the tokens; when it calls a tool, the real values are put
 * back into the call's arguments, so the file it writes or the command it runs
 * still works (`export DATABASE_URL=<SECRET_1>` runs with the real URL) — the
 * value itself never reaches the provider. Logs show the tokens.
 *
 * Organizations choose the mode: off, warn (count only), mask (default) or
 * strict (mask, and agents may not read secret files or dump the environment),
 * plus an allowlist of values or patterns never to mask. Text that leaves
 * Spaces without an agent (Slack posts, PR bodies, embeddings, summaries) is
 * masked one way with maskOutput.
 */

import { log } from './logger'

const guardLog = log.child({ mod: 'guardrails' })

export type GuardMode = 'off' | 'warn' | 'mask' | 'strict'
export const GUARD_MODES: GuardMode[] = ['off', 'warn', 'mask', 'strict']

export interface GuardPolicy {
  mode: GuardMode
  /** Values never masked: literal strings, or /regex/ (e.g. a public support address). */
  allow: string[]
}

export const DEFAULT_POLICY: GuardPolicy = { mode: 'mask', allow: [] }

export type SensitiveKind = 'SECRET' | 'EMAIL' | 'PHONE' | 'SSN' | 'CARD' | 'IBAN'

interface Detector {
  kind: SensitiveKind
  re: RegExp
  /** Capture groups holding the sensitive part (the first one that matched); the whole match when unset. */
  groups?: number[]
  check?: (value: string) => boolean
}

function luhn(value: string): boolean {
  const digits = value.replace(/\D/g, '')
  if (digits.length < 13 || digits.length > 19 || !/^[3-6]/.test(digits)) return false
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9 }
    sum += d
  }
  return sum % 10 === 0
}

function iban(value: string): boolean {
  const v = value.replace(/\s/g, '')
  if (v.length < 15 || v.length > 34) return false
  const rearranged = (v.slice(4) + v.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55))
  let remainder = 0
  for (const ch of rearranged) remainder = (remainder * 10 + Number(ch)) % 97
  return remainder === 1
}

/** Addresses that are not personal data: git remotes and no-reply senders. */
const NOT_PERSONAL_EMAIL = /^(git|noreply|no-reply|donotreply)@|@users\.noreply\.github\.com$|@example\.(com|org|net)$/i

const DETECTORS: Detector[] = [
  // Secrets first: a connection string's user@host must not be read as an email.
  { kind: 'SECRET', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { kind: 'SECRET', re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { kind: 'SECRET', re: /\bsk-(?:ant-|or-|proj-)?[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'SECRET', re: /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'SECRET', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'SECRET', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: 'SECRET', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@"'`]+:([^\s/@"'`]+)@/gi, groups: [1] },
  { kind: 'SECRET', re: /[?&](?:password|passwd|pass|pwd|token|access_token|secret|client_secret|api[_-]?key|apikey|sig|signature)=([^&\s"'`#]+)/gi, groups: [1] },
  { kind: 'SECRET', re: /\b(?:Bearer|token)\s+([A-Za-z0-9._~+/=-]{16,})/gi, groups: [1] },
  { kind: 'SECRET', re: /\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|API_?KEY|_KEY|CREDENTIALS?|AUTH)[A-Z0-9_]*=(?:"([^"]+)"|'([^']+)'|([^\s"'`]+))/g, groups: [1, 2, 3] },
  { kind: 'SECRET', re: /["']?(?:password|passwd|secret|client_secret|token|access_token|refresh_token|api_?key|private_key)["']?\s*[:=]\s*(?:"([^"]+)"|'([^']+)')/gi, groups: [1, 2] },
  // Personal data.
  { kind: 'EMAIL', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, check: (v) => !NOT_PERSONAL_EMAIL.test(v) },
  { kind: 'SSN', re: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g },
  { kind: 'CARD', re: /\b(?:\d[ -]?){12,18}\d\b/g, check: luhn },
  { kind: 'IBAN', re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g, check: iban },
  { kind: 'PHONE', re: /(?<![\w.:/-])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?![\w-])|(?<![\w.:/-])\+\d{11,15}(?!\w)/g },
]

interface Span { start: number; end: number; kind: SensitiveKind; value: string }

/** Where the sensitive values in `text` are (non-overlapping, in order). */
export function findSensitive(text: string, allow: Array<string | RegExp> = []): Span[] {
  const spans: Span[] = []
  for (const detector of DETECTORS) {
    const re = new RegExp(detector.re.source, detector.re.flags.includes('d') ? detector.re.flags : `${detector.re.flags}d`)
    for (const m of text.matchAll(re)) {
      const indices = (m as RegExpMatchArray & { indices?: Array<[number, number] | undefined> }).indices
      const group = detector.groups?.find((g) => m[g] !== undefined)
      const [start, end] = group !== undefined ? indices![group]! : [m.index!, m.index! + m[0].length]
      const value = text.slice(start, end)
      if (!value || (detector.check && !detector.check(value))) continue
      if (/^<(SECRET|EMAIL|PHONE|SSN|CARD|IBAN)_\d+>$/.test(value) || value.includes('[redacted')) continue
      if (allow.some((a) => (typeof a === 'string' ? a === value : a.test(value)))) continue
      if (spans.some((s) => start < s.end && end > s.start)) continue
      spans.push({ start, end, kind: detector.kind, value })
    }
  }
  return spans.sort((a, b) => a.start - b.start)
}

function compileAllow(allow: string[]): Array<string | RegExp> {
  return allow.map((a) => a.trim()).filter(Boolean).flatMap((a): Array<string | RegExp> => {
    const re = /^\/(.+)\/([a-z]*)$/.exec(a)
    if (!re) return [a]
    try { return [new RegExp(re[1]!, re[2]!.replace(/[gy]/g, ''))] } catch { return [] }
  })
}

const OUTPUT_LABEL: Record<SensitiveKind, string> = { SECRET: '[redacted]', EMAIL: '[email]', PHONE: '[phone]', SSN: '[ssn]', CARD: '[card]', IBAN: '[iban]' }

/** One-way masking for text leaving Spaces without an agent (Slack, PR bodies, embeddings, summaries). */
export function maskOutput(text: string, policy: GuardPolicy = DEFAULT_POLICY): string {
  if (!text || policy.mode === 'off' || policy.mode === 'warn') return text
  const spans = findSensitive(text, compileAllow(policy.allow))
  let out = ''
  let at = 0
  for (const s of spans) { out += text.slice(at, s.start) + OUTPUT_LABEL[s.kind]; at = s.end }
  return out + text.slice(at)
}

/** maskOutput applied to every string in a JSON-like value (Slack blocks, API payloads). */
export function maskOutputDeep<T>(value: T, policy: GuardPolicy = DEFAULT_POLICY): T {
  if (typeof value === 'string') return maskOutput(value, policy) as T
  if (Array.isArray(value)) return value.map((v) => maskOutputDeep(v, policy)) as T
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskOutputDeep(v, policy)])) as T
  return value
}

const TOKEN = /<(SECRET|EMAIL|PHONE|SSN|CARD|IBAN)_(\d+)>/g

/** Files whose every value is a secret, and commands that print the environment. */
const SECRET_FILE = /(?:^|[\s/'"=])(\.env(?:\.(?!example\b|sample\b|template\b)[\w.-]+)?|[\w.-]*\.pem|id_(?:rsa|dsa|ecdsa|ed25519)|\.pgpass|\.npmrc|\.netrc|credentials(?:\.json)?|[\w.-]*secrets?\.(?:json|ya?ml|env))(?=$|[\s'";|&)])/
const ENV_DUMP = /(?:^|[;&|]\s*|\s)(env|printenv|export -p|set)\s*(?:$|[;&|>])/

/**
 * The guardrails for one agent session: a vault of tokens (stable for the
 * session), what was masked and blocked, and the hooks installed on the session.
 */
export class AgentGuard {
  readonly policy: GuardPolicy
  private readonly allow: Array<string | RegExp>
  private readonly byValue = new Map<string, string>()
  private readonly byToken = new Map<string, string>()
  private readonly next: Record<SensitiveKind, number> = { SECRET: 0, EMAIL: 0, PHONE: 0, SSN: 0, CARD: 0, IBAN: 0 }
  /** Distinct values seen per kind, and tool calls blocked. */
  readonly counts: Record<SensitiveKind | 'BLOCKED', number> = { SECRET: 0, EMAIL: 0, PHONE: 0, SSN: 0, CARD: 0, IBAN: 0, BLOCKED: 0 }
  private reported = { ...this.counts }

  constructor(policy: GuardPolicy = DEFAULT_POLICY) {
    this.policy = policy
    this.allow = compileAllow(policy.allow)
  }

  get active(): boolean { return this.policy.mode !== 'off' }
  private get masking(): boolean { return this.policy.mode === 'mask' || this.policy.mode === 'strict' }

  private tokenFor(kind: SensitiveKind, value: string): string {
    const known = this.byValue.get(value)
    if (known) return known
    this.next[kind] += 1
    this.counts[kind] += 1
    const token = `<${kind}_${this.next[kind]}>`
    this.byValue.set(value, token)
    this.byToken.set(token, value)
    return token
  }

  /** The text as the model may see it: sensitive values as tokens (warn mode: unchanged, but counted). */
  mask(text: string): string {
    if (!text || !this.active) return text
    const spans = findSensitive(text, this.allow)
    if (!spans.length) return text
    let out = ''
    let at = 0
    for (const s of spans) {
      const token = this.tokenFor(s.kind, s.value)
      out += text.slice(at, s.start) + (this.masking ? token : s.value)
      at = s.end
    }
    return out + text.slice(at)
  }

  /** Every value in a file of secrets (KEY=value lines) as a token, whatever its name. */
  maskSecretFile(text: string): string {
    if (!this.masking) return this.mask(text)
    return this.mask(text.replace(/^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*)(.+)$/gm, (_all, head: string, value: string) => {
      const v = value.trim().replace(/^(["'])(.*)\1$/, '$2')
      return v ? `${head}${this.tokenFor('SECRET', v)}` : `${head}${value}`
    }))
  }

  /**
   * Real values back in place of tokens (what the model wrote, before a tool
   * runs it). `secrets: false` restores personal data only — for replies shown
   * to the person who asked, where a password must still not appear.
   */
  unmask(text: string, options: { secrets?: boolean } = {}): string {
    return text.replace(TOKEN, (token, kind: string) => (kind === 'SECRET' && options.secrets === false ? token : this.byToken.get(token) ?? token))
  }

  private unmaskDeep(value: unknown): unknown {
    if (typeof value === 'string') return this.unmask(value)
    if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) value[i] = this.unmaskDeep(value[i]); return value }
    if (value && typeof value === 'object') { for (const k of Object.keys(value)) (value as Record<string, unknown>)[k] = this.unmaskDeep((value as Record<string, unknown>)[k]); return value }
    return value
  }

  /** A masked copy of any JSON-like value (tool-call arguments). */
  private maskDeep(value: unknown): unknown {
    if (typeof value === 'string') return this.mask(value)
    if (Array.isArray(value)) return value.map((v) => this.maskDeep(v))
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.maskDeep(v)]))
    return value
  }

  private maskContent(content: unknown): unknown {
    if (typeof content === 'string') return this.mask(content)
    if (!Array.isArray(content)) return content
    return content.map((block: Record<string, unknown>) => {
      if (block?.type === 'text' && typeof block.text === 'string') return { ...block, text: this.mask(block.text) }
      if (block?.type === 'thinking' && typeof block.thinking === 'string') return { ...block, thinking: this.mask(block.thinking) }
      if (block?.type === 'toolCall' && block.arguments) return { ...block, arguments: this.maskDeep(block.arguments) }
      return block
    })
  }

  /** The request as the provider may receive it (a copy; the session's own history is untouched). */
  maskContext<T extends { systemPrompt?: string; messages?: unknown[] }>(context: T): T {
    if (!this.active) return context
    return {
      ...context,
      systemPrompt: typeof context.systemPrompt === 'string' ? this.mask(context.systemPrompt) : context.systemPrompt,
      messages: (context.messages ?? []).map((m) => {
        const message = m as { content?: unknown }
        return 'content' in (message ?? {}) ? { ...message, content: this.maskContent(message.content) } : m
      }),
    }
  }

  /** Why a tool call is refused in strict mode, if it is. */
  blockReason(toolName: string, args: Record<string, unknown>): string | undefined {
    if (this.policy.mode !== 'strict') return undefined
    const path = String(args.path ?? args.file_path ?? args.filePath ?? '')
    const command = toolName === 'bash' ? String(args.command ?? '') : ''
    const touches = (path && SECRET_FILE.test(` ${path}`)) || (command && SECRET_FILE.test(` ${command}`))
    const dumps = command && ENV_DUMP.test(` ${command}`)
    if (!touches && !dumps) return undefined
    return 'Blocked by the organization\'s AI data guardrails (strict mode): agents do not read secret files (.env, keys, credentials) or print the environment. '
      + 'Refer to variables by name instead (for example "$DATABASE_URL" in a command), or ask a person to make the change.'
  }

  private readsSecretFile(toolName: string, args: Record<string, unknown>): boolean {
    const path = String(args.path ?? args.file_path ?? args.filePath ?? '')
    if (toolName === 'read' && path) return SECRET_FILE.test(` ${path}`)
    return toolName === 'bash' && SECRET_FILE.test(` ${String(args.command ?? '')}`)
  }

  /**
   * Put the guardrails on an agent session: mask every provider request,
   * restore real values in tool calls, refuse what strict mode forbids, and
   * treat everything read from a secret file as a secret.
   */
  install(session: { agent: unknown }): void {
    if (!this.active) return
    const agent = session.agent as {
      streamFn: (model: unknown, context: { systemPrompt?: string; messages?: unknown[] }, options?: unknown) => unknown
      beforeToolCall?: (ctx: { toolCall: { name: string }; args: unknown }, signal?: AbortSignal) => Promise<{ block?: boolean; reason?: string } | undefined>
      afterToolCall?: (ctx: { toolCall: { name: string }; args: unknown; result: { content?: unknown }; isError: boolean }, signal?: AbortSignal) => Promise<{ content?: unknown; isError?: boolean } | undefined>
    }
    const stream = agent.streamFn
    agent.streamFn = (model, context, options) => stream(model, this.maskContext(context), options)

    const before = agent.beforeToolCall
    agent.beforeToolCall = async (ctx, signal) => {
      // The validated arguments are the tool's own copy: restore real values in them.
      this.unmaskDeep(ctx.args)
      const reason = this.blockReason(ctx.toolCall.name, (ctx.args ?? {}) as Record<string, unknown>)
      if (reason) {
        this.counts.BLOCKED += 1
        guardLog.info('tool call blocked', { tool: ctx.toolCall.name })
        return { block: true, reason }
      }
      return before ? before(ctx, signal) : undefined
    }

    const after = agent.afterToolCall
    agent.afterToolCall = async (ctx, signal) => {
      const hooked = after ? await after(ctx, signal) : undefined
      if (!this.masking || !this.readsSecretFile(ctx.toolCall.name, (ctx.args ?? {}) as Record<string, unknown>)) return hooked
      const content = (hooked?.content ?? ctx.result.content) as Array<{ type?: string; text?: string }> | undefined
      if (!Array.isArray(content)) return hooked
      return { ...(hooked ?? {}), content: content.map((b) => (b?.type === 'text' && typeof b.text === 'string' ? { ...b, text: this.maskSecretFile(b.text) } : b)) }
    }
  }

  /** A log line saying what was masked or blocked since the last one, if anything. */
  report(): string | undefined {
    const delta = Object.fromEntries(Object.entries(this.counts).map(([k, v]) => [k, v - (this.reported as Record<string, number>)[k]!])) as Record<string, number>
    this.reported = { ...this.counts }
    const names: Record<string, [string, string]> = { SECRET: ['secret', 'secrets'], EMAIL: ['email', 'emails'], PHONE: ['phone number', 'phone numbers'], SSN: ['SSN', 'SSNs'], CARD: ['card number', 'card numbers'], IBAN: ['IBAN', 'IBANs'] }
    const found = Object.entries(names).filter(([k]) => delta[k]! > 0).map(([k, [one, many]]) => `${delta[k]} ${delta[k] === 1 ? one : many}`)
    if (!found.length && !delta.BLOCKED) return undefined
    const verb = this.masking ? 'kept from the model' : 'seen (warn mode: sent unchanged)'
    return `[guardrails] ${found.length ? `${found.join(', ')} ${verb}` : ''}${found.length && delta.BLOCKED ? '; ' : ''}${delta.BLOCKED ? `${delta.BLOCKED} tool call${delta.BLOCKED === 1 ? '' : 's'} blocked` : ''}\n`
  }
}
