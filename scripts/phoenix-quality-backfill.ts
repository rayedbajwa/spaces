/**
 * Score past runs' handoffs onto their Phoenix sessions (handoff-quality and
 * loop-progress, see src/lib/phoenix-quality.ts), so the Metrics page has
 * history before the worker started scoring live.
 *
 *   PHOENIX_COLLECTOR_ENDPOINT=… PHOENIX_API_KEY=… \
 *     bun run scripts/phoenix-quality-backfill.ts --file rows.json
 *
 * rows.json: run_thread_entries joined with the run's project, as a JSON
 * array of { run_id, project_namespace, step_index, stage, tail, summary, created_at }.
 * report-format is not backfilled: it reads the report file as it was written.
 */

import { annotateRun, ensureAnnotationConfigs, type SessionAnnotation } from '../src/lib/phoenix-annotations'
import { criteriaMet, handoffQuality, loopProgress, type CriteriaMet } from '../src/lib/phoenix-quality'

interface Row { run_id: string; project_namespace: string; step_index: number; stage: string; tail: string; summary: string | null; created_at: string }

const i = process.argv.indexOf('--file')
const file = i >= 0 ? process.argv[i + 1] : undefined
if (!file || !process.env.PHOENIX_COLLECTOR_ENDPOINT) {
  console.error('Usage: PHOENIX_COLLECTOR_ENDPOINT=… PHOENIX_API_KEY=… bun run scripts/phoenix-quality-backfill.ts --file rows.json')
  process.exit(1)
}

const rows = ((await Bun.file(file).json()) as Row[]).sort((a, b) => a.created_at.localeCompare(b.created_at))
await ensureAnnotationConfigs()

const byRun = new Map<string, SessionAnnotation[]>()
const lastVerify = new Map<string, CriteriaMet>()
const counts: Record<string, number> = {}
for (const row of rows) {
  const list = byRun.get(row.run_id) ?? []
  const quality = handoffQuality({ stage: row.stage, stepIndex: row.step_index, tail: row.tail ?? '', summary: row.summary })
  list.push(quality)
  counts[`handoff-quality ${quality.label}`] = (counts[`handoff-quality ${quality.label}`] ?? 0) + 1
  if (row.stage === 'verify') {
    const met = criteriaMet(`${row.summary ?? ''}\n${row.tail ?? ''}`)
    if (met) {
      const progress = loopProgress(row.step_index, lastVerify.get(row.project_namespace), met)
      list.push(progress)
      lastVerify.set(row.project_namespace, met)
      counts[`loop-progress ${progress.label}`] = (counts[`loop-progress ${progress.label}`] ?? 0) + 1
    }
  }
  byRun.set(row.run_id, list)
}

for (const [runId, annotations] of byRun) await annotateRun(runId, annotations)
console.log(`scored ${rows.length} handoffs on ${byRun.size} run sessions`)
for (const [k, v] of Object.entries(counts).sort()) console.log(`  ${k}: ${v}`)
