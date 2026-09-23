import { useEffect, useState } from 'react'
import { SkeletonTiles } from './loading'
import { json } from './auth'

/** Token usage and cost, as the API reports it. */
export interface UsageSummary {
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  costUsd: number
}

export function formatUsd(value: number | undefined): string {
  if (!value) return '$0.00'
  if (value < 0.01) return `$${value.toFixed(4)}`
  if (value < 1) return `$${value.toFixed(3)}`
  return `$${value.toFixed(2)}`
}

export function formatTokens(value: number | undefined): string {
  const n = value ?? 0
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`
  return String(n)
}

/** Compact "$0.42 · 1.2M tok" chip. */
export function UsageChip({ usage, label, className = '' }: { usage?: UsageSummary | null; label?: string; className?: string }) {
  if (!usage || usage.calls === 0) return null
  return (
    <span className={`chip usage-chip ${className}`} title={`${usage.calls} model calls · ${usage.inputTokens.toLocaleString()} in · ${usage.outputTokens.toLocaleString()} out · ${usage.cacheReadTokens.toLocaleString()} cached`}>
      {label && <span className="text-subtle">{label} </span>}
      <strong>{formatUsd(usage.costUsd)}</strong>
      <span className="text-subtle"> · {formatTokens(usage.totalTokens)} tok</span>
    </span>
  )
}

interface ProjectUsage extends UsageSummary {
  byStage: Array<{ stage: string; summary: UsageSummary }>
  byModel: Array<{ model: string; summary: UsageSummary }>
  byRun: Array<{ runId: string; createdAt: string; summary: UsageSummary }>
}

/** Project overview card: totals, per stage and per model. Refreshes while a run is live. */
export function ProjectUsagePanel({ projectNamespace, live }: { projectNamespace: string; live: boolean }) {
  const [usage, setUsage] = useState<ProjectUsage | null>(null)
  useEffect(() => {
    let cancelled = false
    const load = () => json<ProjectUsage>(`/api/projects/${encodeURIComponent(projectNamespace)}/usage`).then((u) => { if (!cancelled) setUsage(u) }).catch(() => undefined)
    void load()
    const timer = live ? window.setInterval(() => void load(), 10_000) : undefined
    return () => { cancelled = true; if (timer) window.clearInterval(timer) }
  }, [projectNamespace, live])
  if (!usage) return (
    <section className="card panel team-section usage-panel">
      <div className="team-section-head"><h3>Tokens &amp; cost</h3></div>
      <SkeletonTiles count={4} minWidth={120} label="Loading tokens and cost…" />
    </section>
  )
  return (
    <section className="card panel team-section usage-panel">
      <div className="team-section-head">
        <h3>Tokens &amp; cost</h3>
        <span className="panel-subtitle">{usage.calls === 0 ? 'No model calls recorded yet.' : `${usage.calls} model calls across ${usage.byRun.length} run${usage.byRun.length === 1 ? '' : 's'}${live ? ' · updating live' : ''}`}</span>
      </div>
      <div className="usage-totals">
        <div><span>Total cost</span><strong>{formatUsd(usage.costUsd)}</strong></div>
        <div><span>Input</span><strong>{formatTokens(usage.inputTokens)}</strong></div>
        <div><span>Output</span><strong>{formatTokens(usage.outputTokens)}</strong></div>
        <div><span>Cache reads</span><strong>{formatTokens(usage.cacheReadTokens)}</strong></div>
      </div>
      {usage.byStage.length > 0 && (
        <div className="usage-breakdown">
          <div>
            <strong>By stage</strong>
            <ul>{usage.byStage.map((s) => <li key={s.stage}><span>{s.stage}</span><em>{formatTokens(s.summary.totalTokens)} tok</em><b>{formatUsd(s.summary.costUsd)}</b></li>)}</ul>
          </div>
          <div>
            <strong>By model</strong>
            <ul>{usage.byModel.map((m) => <li key={m.model}><span>{m.model}</span><em>{m.summary.calls} calls</em><b>{formatUsd(m.summary.costUsd)}</b></li>)}</ul>
          </div>
        </div>
      )}
    </section>
  )
}
