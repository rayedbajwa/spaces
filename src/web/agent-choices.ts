/**
 * Reads the options out of the agent's last question so the dock can offer
 * them as choices instead of a blank box. Handles the shapes agents write:
 * spec-kit clarify tables (`| A | … |` with `**Recommended:** Option A`),
 * lettered or numbered lists after a "which/choose" question, and plain
 * yes/no questions ("Approve merging PR #76?").
 */

export type AgentChoice = { key: string; label: string; detail?: string; recommended?: boolean }

export type AgentQuestion = {
  /** The question as the agent phrased it, if one could be found. */
  title?: string
  choices: AgentChoice[]
  /** The choices are a plain yes/no the dock made up, not the agent's own. */
  yesNo?: boolean
  recommendedReason?: string
}

// Free-text rows the dock already offers as "Other".
const FREE_TEXT_KEYS = /^(short|custom|other)$/i
const CHOOSING = /\b(which|choose|pick|select|prefer|option|options|reply with (a|the) (letter|number))\b/i
const YES_NO = /\b(approve|may i|should i|shall i|can i|do you want|ok to|okay to|proceed|go ahead|confirm|merge|deploy|release|publish)\b/i
const OPEN_QUESTION = /\b(what|where|which|how|who|when|why)\b/i

// Run logs stamp every line `[03:41:05Z implement] ` (lib/agent-activity.ts).
const STAMP = /^\[\d\d:\d\d:\d\dZ(?: [^\]]+)?\] /gm

function unstamp(log: string): string {
  return log.replace(STAMP, '')
}

function clean(text: string): string {
  return text.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim()
}

/** The tail of the log that holds the agent's latest question. */
function lastQuestionBlock(log: string): string {
  const tail = unstamp(log.slice(-12000)).slice(-8000)
  const heading = [...tail.matchAll(/^#{1,4}\s*Question\b.*$/gim)].pop()
  if (heading?.index !== undefined) return tail.slice(heading.index)
  const stage = [...tail.matchAll(/^(=== Stage .*===|--- Review gate .*---)$/gm)].pop()
  const from = stage?.index !== undefined ? stage.index : 0
  return tail.slice(from).slice(-3000)
}

function tableChoices(block: string): AgentChoice[] {
  const choices: AgentChoice[] = []
  for (const line of block.split('\n')) {
    const cells = line.trim().match(/^\|(.+)\|$/)?.[1].split('|').map((c) => clean(c))
    if (!cells || cells.length < 2) continue
    const [key, label, detail] = cells
    if (!/^([A-Z]|\d{1,2})$/i.test(key) || FREE_TEXT_KEYS.test(key) || !label) continue
    choices.push({ key: key.toUpperCase(), label, ...(detail ? { detail } : {}) })
  }
  return choices
}

function listChoices(block: string): AgentChoice[] {
  const choices: AgentChoice[] = []
  for (const line of block.split('\n')) {
    const m = line.match(/^\s*(?:[-*]\s+)?(?:\*\*)?(?:Option\s+)?(?:\(?([A-H])[).:]|([A-H])\*\*\s*[:.)—-]|(\d{1,2})[.)])(?:\*\*)?\s+(.+)$/)
    if (!m) continue
    const key = (m[1] ?? m[2] ?? m[3]).toUpperCase()
    // "**Lead** — the rest": the bold lead is the choice, the rest explains it.
    const lead = m[4].match(/^\*\*(.+?)\*\*\s*[:.—-]?\s*(.*)$/)
    const label = clean(lead ? lead[1] : m[4]).replace(/^[:—-]\s*/, '')
    const detail = lead?.[2] ? clean(lead[2]) : ''
    if (label) choices.push({ key, label, ...(detail ? { detail } : {}) })
  }
  // Only a run of distinct keys is a set of choices.
  const keys = new Set(choices.map((c) => c.key))
  return keys.size === choices.length ? choices : []
}

function questionTitle(block: string): string | undefined {
  const heading = block.match(/^#{1,4}\s*Question\s*\d*\s*[:—-]?\s*(.+)$/im)?.[1]
  if (heading) return clean(heading)
  const labelled = block.match(/^\s*\*{0,2}Question:?\*{0,2}:?\s*([^?\n]+\?)/im)?.[1]
  if (labelled) return clean(labelled)
  // A question the agent ends on, not one asked further up in its output.
  const lines = block.split('\n').map((l) => clean(l)).filter(Boolean).slice(-15)
  const asked = lines.filter((l) => l.endsWith('?')).pop()
  // The question itself, not the sentences before it on the same line.
  return asked?.split(/(?<=[.!])\s+(?=[A-Z])/).pop() || undefined
}

export function parseAgentQuestion(log: string | undefined): AgentQuestion | undefined {
  if (!log) return undefined
  const block = lastQuestionBlock(log)
  const title = questionTitle(block)

  let choices = tableChoices(block)
  if (choices.length < 2) {
    const listed = listChoices(block)
    const lettered = listed.length > 0 && /[A-Z]/.test(listed[0].key)
    // Numbered steps after "Do you approve:" are a plan, not alternatives.
    choices = listed.length >= 2 && listed.length <= 8 && (lettered || CHOOSING.test(block)) ? listed : []
  }

  if (choices.length >= 2) {
    const rec = block.match(/\*{0,2}Recommended:?\*{0,2}:?\s*(?:Option\s+)?([A-Z]|\d{1,2})\b\s*[—:-]?\s*(.*)/i)
    const recKey = rec?.[1].toUpperCase()
    return {
      title,
      choices: choices.map((c) => (c.key === recKey ? { ...c, recommended: true } : c)),
      recommendedReason: rec?.[2] ? clean(rec[2]) : undefined,
    }
  }

  if (title && YES_NO.test(title) && !OPEN_QUESTION.test(title)) {
    return { title, yesNo: true, choices: [{ key: 'yes', label: 'Yes, go ahead' }, { key: 'no', label: 'No, hold off' }] }
  }
  return title ? { title, choices: [] } : undefined
}

/** The answer sent to the agent for a picked choice plus optional details. */
export function composeChoiceAnswer(choice: AgentChoice | undefined, details: string, yesNo?: boolean): string {
  const extra = details.trim()
  if (!choice) return extra
  const picked = yesNo ? choice.key : `${choice.key} — ${choice.label}`
  return extra ? `${picked}\n\nAdditional details: ${extra}` : picked
}

export type Recommendations = { title: string; items: AgentChoice[] }

const HEADING = /^(#{1,4}\s+.+|\*\*[^*\n]+\*\*:?)\s*$/

/**
 * The changes a reviewer recommends before the run moves on: the list under
 * the latest "Recommended changes" (or "Recommendations") heading of the
 * stage's output, so they can be ticked off instead of retyped.
 */
export function parseRecommendations(log: string | undefined): Recommendations | undefined {
  if (!log) return undefined
  const text = unstamp(log.slice(-16000))
  const stage = [...text.matchAll(/^(=== Stage .*===|--- Review gate .*---)$/gm)].pop()
  const lines = text.slice(stage?.index ?? 0).split('\n')
  let start = -1
  lines.forEach((line, i) => { if (HEADING.test(line.trim()) && /recommend/i.test(line) && !/recommended:\*{0,2}\s*option/i.test(line)) start = i })
  if (start < 0) return undefined
  const title = clean(lines[start].replace(/^#+\s*/, '').replace(/^\d+[.)]\s*/, '').replace(/:$/, ''))
  const items: AgentChoice[] = []
  for (const line of lines.slice(start + 1)) {
    if (HEADING.test(line.trim()) && items.length > 0) break
    const m = line.match(/^\s*(?:[-*]|(\d{1,2})[.)])\s+(.+)$/)
    if (!m) continue
    const lead = m[2].match(/^\*\*(.+?)\*\*\s*[:.—-]?\s*(.*)$/)
    const label = clean(lead ? lead[1] : m[2]).replace(/[:.]$/, '')
    const detail = lead?.[2] ? clean(lead[2]) : ''
    if (label) items.push({ key: m[1] ?? String(items.length + 1), label, ...(detail ? { detail } : {}) })
  }
  return items.length > 0 && items.length <= 12 ? { title, items } : undefined
}

/** The ticked recommendations, written out so the agent knows exactly which to apply. */
export function composeRecommendationList(items: AgentChoice[]): string {
  if (items.length === 0) return ''
  return `Apply these recommended changes:\n${items.map((i) => `${i.key}. ${i.label}${i.detail ? ` — ${i.detail}` : ''}`).join('\n')}`
}
