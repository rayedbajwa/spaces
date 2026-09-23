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
  /** What maskOutput writes in its place (default: by kind). */
  label?: string
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

/** Names that say a value is secret: *TOKEN*, *SECRET*, *PASSWORD*, and whole parts PASS, PWD, KEY, API_KEY, CREDENTIALS, AUTH (so BYPASS or AUTHOR are not). */
const SECRET_NAME = String.raw`(?:(?:[A-Za-z0-9]+_)*[A-Za-z0-9]*(?:token|secret|password|passwd)(?:_[A-Za-z0-9]+)*|(?:[A-Za-z0-9]+_)*(?:pass|pwd|key|apikey|api_key|credentials?|auth)(?:_[A-Za-z0-9]+)*)`
/** A YAML/JSON value that is a type or an expression, not a literal secret (`token: string`, `password: req.body.password`). */
const NOT_A_LITERAL = /^(?:string|number|boolean|bool|any|unknown|null|undefined|none|nil|true|false|object|str|int|integer|float|bytes|optional|required|secret|password|token|\*+|x+|\.{3}|<[^>]*>|\[redacted.*)$|[()]|^this\.|^process\.env|^\$\{|^\{\{|^[A-Za-z_]+\.[A-Za-z_.]+$/i

export const SECRET_DETECTORS: Detector[] = [
  // Secrets first: a connection string's user@host must not be read as an email.
  { kind: 'SECRET', label: '[redacted private key]', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { kind: 'SECRET', re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { kind: 'SECRET', re: /\bsk-(?:ant-|or-|proj-)?[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'SECRET', re: /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'SECRET', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'SECRET', label: '[redacted jwt]', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  // Credentials in any URL (postgres://, redis://:pw@…, https://…): the password, with or without a user.
  { kind: 'SECRET', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@"'`]*:([^\s/@"'`]+)@/gi, groups: [1] },
  { kind: 'SECRET', re: /[?&](?:password|passwd|pass|pwd|token|access_token|secret|client_secret|api[_-]?key|apikey|key|sig|signature)=([^&\s"'`#]+)/gi, groups: [1] },
  { kind: 'SECRET', re: /\b(?:Bearer|token)\s+([A-Za-z0-9._~+/=-]{16,})/gi, groups: [1] },
  // Environment-style NAME=value (upper case: .env files, shell exports): any value.
  { kind: 'SECRET', re: new RegExp(String.raw`\b(?=[A-Z0-9_]*[A-Z])${SECRET_NAME.replace(/\[A-Za-z0-9\]/g, '[A-Z0-9]').replace(/token\|secret\|password\|passwd/, 'TOKEN|SECRET|PASSWORD|PASSWD').replace(/pass\|pwd\|key\|apikey\|api_key\|credentials\?\|auth/, 'PASS|PWD|KEY|APIKEY|API_KEY|CREDENTIALS?|AUTH')}\s*=(?![=>])\s*(?:"([^"]+)"|'([^']+)'|([^\s"'${'`'},;&]+))`, 'g'), groups: [1, 2, 3] },
  // Any-case name=value: a literal right after '=' (password=supersecret, api_key=abc) or a quoted one (password = "hunter2") — not code (password = req.body.password).
  { kind: 'SECRET', re: new RegExp(String.raw`\b${SECRET_NAME}(?:=(?![=>])(?:"([^"]+)"|'([^']+)'|([^\s"'${'`'},;&()]+)(?![(\w]))|\s+=\s*(?:"([^"]+)"|'([^']+)'))`, 'gi'), groups: [1, 2, 3, 4, 5], check: (v) => !NOT_A_LITERAL.test(v) },
  // "password": "…" and YAML password: abc123 — quoted or bare, but not a type or an expression.
  { kind: 'SECRET', re: /(?:^|[\s{,"'])["']?(?:password|passwd|secret|client_secret|secret_key|token|auth_token|access_token|refresh_token|api_?key|access_key|aws_secret_access_key|private_key)["']?\s*:\s*(?:"([^"]+)"|'([^']+)'|([^\s"'`,}\]#;|]+))/gim, groups: [1, 2, 3], check: (v) => !NOT_A_LITERAL.test(v) },
]

const DETECTORS: Detector[] = [
  ...SECRET_DETECTORS,
  // Personal data.
  { kind: 'EMAIL', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, check: (v) => !NOT_PERSONAL_EMAIL.test(v) },
  { kind: 'SSN', re: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g },
  { kind: 'CARD', re: /\b(?:\d[ -]?){12,18}\d\b/g, check: luhn },
  { kind: 'IBAN', re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g, check: iban },
  { kind: 'PHONE', re: /(?<![\w.:/-])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?![\w-])|(?<![\w.:/-])\+\d{11,15}(?!\w)/g },
]

interface Span { start: number; end: number; kind: SensitiveKind; value: string; label?: string }

/** Where the sensitive values in `text` are (non-overlapping, in order). */
export function findSensitive(text: string, allow: Array<string | RegExp> = [], detectors: Detector[] = DETECTORS): Span[] {
  const spans: Span[] = []
  for (const detector of detectors) {
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
      spans.push({ start, end, kind: detector.kind, value, ...(detector.label ? { label: detector.label } : {}) })
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
  for (const s of spans) { out += text.slice(at, s.start) + (s.label ?? OUTPUT_LABEL[s.kind]); at = s.end }
  return out + text.slice(at)
}

/** Secrets only, masked one way, whatever the organization's setting: logs never keep a secret. */
export function redactSecretValues(text: string): string {
  if (!text) return text
  const spans = findSensitive(text, [], SECRET_DETECTORS)
  let out = ''
  let at = 0
  for (const s of spans) { out += text.slice(at, s.start) + (s.label ?? '[redacted]'); at = s.end }
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
const SOURCE_CODE = /\.(?:[cm]?[jt]sx?|py|go|rb|java|kt|rs|cs|php|swift|scala|md|mdx|html|css|test\.\w+)$/i

/**
 * Whether a file name (its basename, whatever the extension) is a file of
 * secrets: .env and variants (not .example/.sample/.template), private keys,
 * .pgpass/.npmrc/.netrc/.git-credentials, credentials*, *secret(s).* —
 * but never source code (secrets.ts is code about secrets).
 */
export function isSecretFileName(name: string): boolean {
  const base = name.replace(/\/+$/, '').split('/').pop() ?? ''
  if (!base || SOURCE_CODE.test(base)) return false
  if (/^\.env(?:\.[\w.-]+)?$/i.test(base)) return !/\.(?:example|sample|template|dist|defaults?)$/i.test(base)
  return /\.(?:pem|p12|pfx|key|keystore|jks)$/i.test(base)
    || /^id_(?:rsa|dsa|ecdsa|ed25519)$/i.test(base)
    || /^\.(?:pgpass|npmrc|netrc|git-credentials|pypirc|dockercfg)$/i.test(base)
    || /^credentials/i.test(base)
    || /(?:^|[._-])secrets?(?:\.|$)/i.test(base)
}

/** The secret files a path or a command mentions. */
function secretFilesIn(text: string): string[] {
  return text.split(/[\s'"`=;|&<>()]+/).filter((t) => t && isSecretFileName(t))
}

/** Commands that print the environment: env or env -0 alone, printenv (with or without names), export -p, set alone, declare -x, /proc/…/environ. */
const ENV_DUMP = /(?:^|[;&|(`]\s*|\$\(\s*)(?:printenv\b|env(?:\s+-0)?\s*(?:$|[;&|>)`])|export\s+-p\b|set\s*(?:$|[;&|>)`])|declare\s+-[a-z]*x|compgen\s+-e\b)|\/proc\/(?:self|\d+)\/environ/

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

  /** Called when a new value gets a token, so a run can keep its vault across processes. */
  onNewToken?: () => void

  constructor(policy: GuardPolicy = DEFAULT_POLICY, vault?: Record<string, string>) {
    this.policy = policy
    this.allow = compileAllow(policy.allow)
    if (vault) this.importVault(vault)
  }

  /** Token → value, for storing (sealed) with the run. */
  exportVault(): Record<string, string> {
    return Object.fromEntries(this.byToken)
  }

  /** Tokens a resumed run's history already uses map to the same values again. */
  importVault(vault: Record<string, string>): void {
    for (const [token, value] of Object.entries(vault)) {
      const m = /^<(SECRET|EMAIL|PHONE|SSN|CARD|IBAN)_(\d+)>$/.exec(token)
      if (!m || typeof value !== 'string') continue
      const kind = m[1] as SensitiveKind
      this.byToken.set(token, value)
      this.byValue.set(value, token)
      this.next[kind] = Math.max(this.next[kind], Number(m[2]))
    }
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
    this.onNewToken?.()
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

  private allowed(value: string): boolean {
    return this.allow.some((a) => (typeof a === 'string' ? a === value : a.test(value)))
  }

  /**
   * Every value in a file of secrets as a token, whatever its name and layout:
   * NAME=value (.env, .npmrc, INI), key: value (YAML), "key": "value" (JSON),
   * and .pgpass's host:port:db:user:password. Allowlisted values stay.
   */
  maskSecretFile(text: string, fileName = ''): string {
    if (!this.masking) return this.mask(text)
    const token = (value: string) => (this.allowed(value) ? value : this.tokenFor('SECRET', value))
    const pgpass = /(?:^|\/)\.pgpass$/i.test(fileName)
    return this.mask(text.split('\n').map((line) => {
      if (!line.trim() || /^\s*(?:#|;|\[)/.test(line)) return line
      if (pgpass) {
        const cut = line.lastIndexOf(':')
        return cut === -1 ? line : `${line.slice(0, cut + 1)}${token(line.slice(cut + 1))}`
      }
      const m = /^(\s*(?:export\s+)?["']?[^=:"']*?["']?\s*[=:]\s*)(.*?)(\s*,?\s*)$/.exec(line)
      if (!m || !m[2]) return line
      const quoted = /^(["'])(.*)\1$/.exec(m[2])
      const value = quoted ? quoted[2]! : m[2]
      if (!value || value === '{' || value === '[' || this.allowed(value)) return line
      return `${m[1]}${quoted ? `${quoted[1]}${token(value)}${quoted[1]}` : token(value)}${m[3]}`
    }).join('\n'))
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

  /** Fields that name or route things rather than carry text: never masked. */
  private static readonly STRUCTURAL = new Set(['role', 'type', 'id', 'toolCallId', 'toolName', 'name', 'api', 'provider', 'model', 'stopReason', 'timestamp', 'mimeType', 'data', 'signature', 'thinkingSignature'])

  /** A masked copy of a message: every text field, at any depth (content blocks, system prompt sections, tool-call arguments). */
  private maskMessage(value: unknown, key?: string): unknown {
    if (typeof value === 'string') return key && AgentGuard.STRUCTURAL.has(key) ? value : this.mask(value)
    if (Array.isArray(value)) return value.map((v) => this.maskMessage(v))
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.maskMessage(v, k)]))
    return value
  }

  /** The request as the provider may receive it (a copy; the session's own history is untouched). */
  maskContext<T extends { systemPrompt?: string; messages?: unknown[] }>(context: T): T {
    if (!this.active) return context
    const masked: T = { ...context }
    if (typeof context.systemPrompt === 'string') masked.systemPrompt = this.mask(context.systemPrompt)
    if (Array.isArray(context.messages)) masked.messages = context.messages.map((m) => this.maskMessage(m))
    return masked
  }

  /** Why a tool call is refused in strict mode, if it is. */
  blockReason(toolName: string, args: Record<string, unknown>): string | undefined {
    if (this.policy.mode !== 'strict') return undefined
    const path = String(args.path ?? args.file_path ?? args.filePath ?? '')
    const command = toolName === 'bash' ? String(args.command ?? '') : ''
    const touches = (path && isSecretFileName(path)) || (command && secretFilesIn(command).length > 0)
    const dumps = command && ENV_DUMP.test(command.trim())
    if (!touches && !dumps) return undefined
    return 'Blocked by the organization\'s AI data guardrails (strict mode): agents do not read secret files (.env, keys, credentials) or print the environment. '
      + 'Refer to variables by name instead (for example "$DATABASE_URL" in a command), or ask a person to make the change.'
  }

  /** The secret file a tool call reads, if any (its name decides the layout). */
  private secretFileRead(toolName: string, args: Record<string, unknown>): string | undefined {
    const path = String(args.path ?? args.file_path ?? args.filePath ?? '')
    if (toolName === 'read' && path) return isSecretFileName(path) ? path : undefined
    return toolName === 'bash' ? secretFilesIn(String(args.command ?? ''))[0] : undefined
  }

  /**
   * Put the guardrails on an agent session: mask every provider request,
   * restore real values in tool calls, refuse what strict mode forbids, and
   * treat everything read from a secret file as a secret.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  install(session: { agent: unknown; prompt?: (text: string, options?: any) => Promise<unknown> }): void {
    if (!this.active) return
    type Stream = (model: unknown, context: { systemPrompt?: string; messages?: unknown[] }, options?: unknown) => unknown
    const agent = session.agent as {
      streamFunction?: Stream
      streamFn?: Stream
      beforeToolCall?: (ctx: { toolCall: { name: string }; args: unknown }, signal?: AbortSignal) => Promise<{ block?: boolean; reason?: string } | undefined>
      afterToolCall?: (ctx: { toolCall: { name: string }; args: unknown; result: { content?: unknown }; isError: boolean }, signal?: AbortSignal) => Promise<{ content?: unknown; isError?: boolean } | undefined>
    }
    const already = (agent as { __guarded?: AgentGuard }).__guarded
    if (already === this) return
    ;(agent as { __guarded?: AgentGuard }).__guarded = this

    // Every provider request (system prompt included) — the last line of defence.
    const key = typeof agent.streamFunction === 'function' ? 'streamFunction' : 'streamFn'
    const stream = agent[key]
    if (stream) agent[key] = (model, context, options) => stream(model, this.maskContext(context), options)

    // Prompts enter the history masked, so nothing else that reads the history
    // (compaction summaries, a resumed session) sees the real values either.
    if (typeof session.prompt === 'function') {
      const prompt = session.prompt.bind(session)
      session.prompt = (text: string, options?: unknown) => prompt(this.mask(text), options as never)
    }

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

    // Tool results enter the history masked; a secret file's every value is a secret.
    const after = agent.afterToolCall
    agent.afterToolCall = async (ctx, signal) => {
      const hooked = after ? await after(ctx, signal) : undefined
      const content = (hooked?.content ?? ctx.result.content) as Array<{ type?: string; text?: string }> | undefined
      if (!Array.isArray(content)) return hooked
      const secretFile = this.masking ? this.secretFileRead(ctx.toolCall.name, (ctx.args ?? {}) as Record<string, unknown>) : undefined
      const masked = content.map((b) => (b?.type === 'text' && typeof b.text === 'string' ? { ...b, text: secretFile ? this.maskSecretFile(b.text, secretFile) : this.mask(b.text) } : b))
      return { ...(hooked ?? {}), content: masked }
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
