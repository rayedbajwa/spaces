import type { ReactNode } from 'react'

/**
 * Loading states, one look everywhere.
 *
 *   <Spinner />                 inline, beside a label or inside a button
 *   <LoadingBlock label="…" />  a panel or page that is fetching
 *   <SkeletonRows count={3} />  a list whose rows have not arrived yet
 *   <SkeletonTiles count={6} /> a grid of cards or tiles
 *
 * Skeletons stand in for content with its rough shape, so the page does not
 * jump when data lands. Everything carries role="status" / aria-busy for
 * screen readers, and the motion stops under prefers-reduced-motion.
 */

export function Spinner({ size = 14, label }: { size?: number; label?: string }) {
  return <span className="spinner" style={{ width: size, height: size }} role={label ? 'status' : undefined} aria-label={label} aria-hidden={label ? undefined : true} />
}

export function LoadingBlock({ label = 'Loading…', compact = false }: { label?: ReactNode; compact?: boolean }) {
  return (
    <div className={`loading-block ${compact ? 'compact' : ''}`} role="status" aria-busy="true">
      <Spinner size={compact ? 12 : 16} />
      <span>{label}</span>
    </div>
  )
}

export function SkeletonRows({ count = 3, label = 'Loading…' }: { count?: number; label?: string }) {
  return (
    <div className="skeleton-rows" role="status" aria-busy="true" aria-label={label}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton-row">
          <span className="skeleton-line" style={{ width: `${38 + ((i * 17) % 40)}%` }} />
          <span className="skeleton-line short" style={{ width: `${18 + ((i * 11) % 20)}%` }} />
        </div>
      ))}
    </div>
  )
}

export function SkeletonTiles({ count = 6, label = 'Loading…', minWidth = 220 }: { count?: number; label?: string; minWidth?: number }) {
  return (
    <div className="skeleton-tiles" role="status" aria-busy="true" aria-label={label} style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${minWidth}px, 1fr))` }}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton-tile">
          <span className="skeleton-line short" />
          <span className="skeleton-line" />
        </div>
      ))}
    </div>
  )
}
