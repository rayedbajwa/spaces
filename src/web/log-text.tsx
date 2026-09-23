import { useMemo, type ReactNode } from 'react'

/**
 * A run or agent log with its line stamps made readable. Lines are stamped
 * `[03:41:05Z implement] …` (UTC, lib/agent-activity.ts); here the time is
 * shown in the viewer's own time zone, dimmed, and the agent as a small tag
 * coloured by name, so who did what, and when, can be scanned down the page.
 * Everything else is left exactly as logged. Render it inside a <pre>.
 */

const STAMP = /^\[(\d\d):(\d\d):(\d\d)Z(?: ([^\]]+))?\] /

function localTime(h: string, m: string, s: string): string {
  const d = new Date()
  d.setUTCHours(Number(h), Number(m), Number(s), 0)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/** A stable hue per agent name, so each agent keeps its colour down the log. */
function hue(name: string): number {
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360
  return h
}

export function LogText({ text }: { text: string }) {
  const nodes = useMemo(() => {
    const out: ReactNode[] = []
    let plain = ''
    text.split(/(?<=\n)/).forEach((line, i) => {
      const m = STAMP.exec(line)
      if (!m) { plain += line; return }
      if (plain) { out.push(plain); plain = '' }
      const [, h, mi, s, agent] = m
      out.push(
        <span key={i} className="log-line">
          <span className="log-time" title={`${h}:${mi}:${s} UTC`}>{localTime(h!, mi!, s!)}</span>
          {agent && <span className="log-agent" style={{ color: `hsl(${hue(agent)} 70% 72%)`, borderColor: `hsl(${hue(agent)} 60% 45% / 0.5)` }}>{agent}</span>}
          {line.slice(m[0].length)}
        </span>,
      )
    })
    if (plain) out.push(plain)
    return out
  }, [text])
  return <>{nodes}</>
}
