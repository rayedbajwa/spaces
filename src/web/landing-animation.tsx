import { useEffect, useMemo, useState } from 'react'

/**
 * The landing page's hero: a feature card riding the line. It moves station
 * by station, the agent's log fills in below, it waits at each human gate
 * until it is approved, and it ends merged and deployed before the next
 * feature starts. Visitors who prefer reduced motion get the finished state.
 */

interface Station { name: string; gate?: string; log: string[] }

const STATIONS: Station[] = [
  { name: 'Research', log: ['▸ clone acme/web, acme/api', '✓ learned 2 repos · 14 Confluence pages'] },
  { name: 'Specify', gate: 'the spec', log: ['▸ write spec.md from the ticket', '✓ 6 acceptance criteria'] },
  { name: 'Plan', gate: 'the plan', log: ['▸ write plan.md', '✓ 2 workstreams · web, api'] },
  { name: 'Tasks', gate: 'the tasks', log: ['▸ write tasks.md', '✓ 11 tasks, ordered'] },
  { name: 'Implement', gate: 'the pull request', log: ['▸ $ bun test search', '✓ 3.4s · 48 pass', '▸ open PR #42'] },
  { name: 'Review', log: ['▸ review PR #42', '✓ approved · 0 blocking'] },
  { name: 'Verify', gate: 'the verification', log: ['▸ browser: save, rename, delete', '✓ 6/6 criteria met'] },
  { name: 'Deliver', log: ['▸ CI green · merge PR #42', '✓ deployed to production'] },
]

const FEATURES = [
  { code: 'JIRA-482', title: 'Saved searches' },
  { code: 'LIN-117', title: 'Dark mode for reports' },
  { code: 'JIRA-509', title: 'CSV export' },
]

type Phase = 'work' | 'gate' | 'approved' | 'done'
interface Frame { station: number; phase: Phase; ms: number }

const FRAMES: Frame[] = [
  ...STATIONS.flatMap((s, i): Frame[] => [
    { station: i, phase: 'work', ms: 1500 },
    ...(s.gate ? [{ station: i, phase: 'gate' as const, ms: 1300 }, { station: i, phase: 'approved' as const, ms: 700 }] : []),
  ]),
  { station: STATIONS.length - 1, phase: 'done', ms: 3200 },
]
const LAST = STATIONS.length - 1

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
  })
  useEffect(() => {
    let query: MediaQueryList
    try { query = window.matchMedia('(prefers-reduced-motion: reduce)') } catch { return }
    const onChange = () => setReduced(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return reduced
}

export function FactoryAnimation() {
  const reduced = usePrefersReducedMotion()
  const [frameIndex, setFrameIndex] = useState(0)
  const [round, setRound] = useState(0)

  useEffect(() => {
    if (reduced) return
    const timer = window.setTimeout(() => {
      if (frameIndex === FRAMES.length - 1) { setFrameIndex(0); setRound((r) => r + 1) }
      else setFrameIndex(frameIndex + 1)
    }, FRAMES[frameIndex]!.ms)
    return () => window.clearTimeout(timer)
  }, [frameIndex, reduced])

  const frame = reduced ? FRAMES[FRAMES.length - 1]! : FRAMES[frameIndex]!
  const feature = FEATURES[round % FEATURES.length]!
  const station = STATIONS[frame.station]!
  const done = frame.phase === 'done'

  // The log shows every finished station's lines plus the current one's, newest last.
  const logLines = useMemo(() => {
    const lines: Array<{ key: string; text: string; station: string }> = []
    STATIONS.forEach((s, i) => {
      if (i > frame.station) return
      s.log.forEach((text, j) => lines.push({ key: `${round}-${i}-${j}`, text, station: s.name }))
    })
    if (done) lines.push({ key: `${round}-final`, text: `✓ ${feature.code} done · next feature queued`, station: 'Spaces' })
    return lines.slice(-5)
  }, [frame.station, round, done, feature.code])

  const status = done
    ? 'Merged and deployed'
    : frame.phase === 'gate' ? `Waiting for you: approve ${station.gate}?`
    : frame.phase === 'approved' ? `Approved ${station.gate}`
    : `${station.name} · agent working…`

  const progress = frame.station / LAST

  return (
    <div className="factory-anim" role="img" aria-label="Animation: a feature card moves through research, specify, plan, tasks, implement, review, verify and deliver, stopping at human approval gates, and ends merged and deployed.">
      <div className="factory-anim-chrome" aria-hidden="true">
        <span /><span /><span />
        <span className="factory-anim-url">spacesos.dev</span>
      </div>

      <div className="factory-anim-body" aria-hidden="true">
        <div className="factory-anim-lane">
          <div
            className={`factory-anim-card ${frame.phase}`}
            style={{ left: `${progress * 100}%`, transform: `translateX(${-progress * 100}%)` }}
          >
            <div className="factory-anim-card-top">
              <span className="factory-anim-code">{feature.code}</span>
              <span className={`factory-anim-badge ${frame.phase}`}>{done ? 'Done' : frame.phase === 'gate' ? 'Needs you' : frame.phase === 'approved' ? 'Approved' : 'Running'}</span>
            </div>
            <strong className="factory-anim-title">{feature.title}</strong>
            <span className="factory-anim-status">{status}</span>
            {frame.phase === 'gate' && (
              <span className="factory-anim-actions">
                <span className="factory-anim-btn primary">Approve</span>
                <span className="factory-anim-btn">Request changes</span>
              </span>
            )}
          </div>
        </div>

        <ol className="factory-anim-track">
          {STATIONS.map((s, i) => {
            const state = done || i < frame.station ? 'done' : i > frame.station ? 'todo' : frame.phase === 'gate' ? 'gate' : 'current'
            return (
              <li key={s.name} className={`factory-anim-node ${state}`}>
                <span className="factory-anim-dot">{state === 'done' ? '✓' : i + 1}</span>
                <span className="factory-anim-label">{s.name}</span>
                {s.gate && <span className="factory-anim-gate" title="Human gate" />}
              </li>
            )
          })}
        </ol>

        <div className="factory-anim-log">
          {logLines.map((line) => (
            <div key={line.key} className={`factory-anim-line ${line.text.startsWith('✓') ? 'ok' : ''} ${line.key.endsWith('-final') ? 'final' : ''}`}>
              <span className="factory-anim-who">{line.station.toLowerCase()}</span>
              <span>{line.text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
