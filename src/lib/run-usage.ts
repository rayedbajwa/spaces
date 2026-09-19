/**
 * Token usage and cost per model call, recorded as runs execute and rolled up
 * per run, per project and for the organization. Cost comes from the model
 * runtime's price table (USD per million tokens) via the SDK's usage object.
 */

import { getDb } from './db'

export interface UsageRecord {
  runId: string
  projectNamespace: string
  stage?: string | null
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
}

export interface UsageSummary {
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  costUsd: number
}

export const EMPTY_USAGE: UsageSummary = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0 }

/** Translate the SDK's usage object on an assistant message into a record. */
export function usageFromMessage(message: { provider?: string; model?: string; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: { total: number } } }, base: { runId: string; projectNamespace: string; stage?: string | null }): UsageRecord | undefined {
  const usage = message.usage
  if (!usage) return undefined
  const total = (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
  if (total <= 0) return undefined
  return {
    ...base,
    provider: message.provider ?? 'unknown',
    model: message.model ?? 'unknown',
    inputTokens: usage.input ?? 0,
    outputTokens: usage.output ?? 0,
    cacheReadTokens: usage.cacheRead ?? 0,
    cacheWriteTokens: usage.cacheWrite ?? 0,
    costUsd: Number(usage.cost?.total ?? 0) || 0,
  }
}

export async function recordUsage(record: UsageRecord): Promise<void> {
  const sql = getDb()
  await sql`
    INSERT INTO run_usage (run_id, project_namespace, stage, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
    VALUES (${record.runId}, ${record.projectNamespace}, ${record.stage ?? null}, ${record.provider}, ${record.model},
            ${record.inputTokens}, ${record.outputTokens}, ${record.cacheReadTokens}, ${record.cacheWriteTokens}, ${record.costUsd})
  `
}

interface SumRow { calls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number }

function toSummary(row: SumRow | undefined): UsageSummary {
  if (!row || !row.calls) return EMPTY_USAGE
  const s = { calls: Number(row.calls), inputTokens: Number(row.inputTokens), outputTokens: Number(row.outputTokens), cacheReadTokens: Number(row.cacheReadTokens), cacheWriteTokens: Number(row.cacheWriteTokens), costUsd: Number(row.costUsd) }
  return { ...s, totalTokens: s.inputTokens + s.outputTokens + s.cacheReadTokens + s.cacheWriteTokens }
}

const SUM = `count(*)::int AS calls, coalesce(sum(input_tokens),0)::bigint AS "inputTokens", coalesce(sum(output_tokens),0)::bigint AS "outputTokens",
  coalesce(sum(cache_read_tokens),0)::bigint AS "cacheReadTokens", coalesce(sum(cache_write_tokens),0)::bigint AS "cacheWriteTokens", coalesce(sum(cost_usd),0)::float8 AS "costUsd"`

export async function summarizeRunUsage(runId: string): Promise<UsageSummary> {
  const sql = getDb()
  const [row] = await sql<SumRow[]>`SELECT ${sql.unsafe(SUM)} FROM run_usage WHERE run_id = ${runId}`.catch(() => [] as SumRow[])
  return toSummary(row)
}

export async function summarizeProjectUsage(projectNamespace: string): Promise<UsageSummary & { byStage: Array<{ stage: string; summary: UsageSummary }>; byModel: Array<{ model: string; summary: UsageSummary }>; byRun: Array<{ runId: string; createdAt: string; summary: UsageSummary }> }> {
  const sql = getDb()
  const [total] = await sql<SumRow[]>`SELECT ${sql.unsafe(SUM)} FROM run_usage WHERE project_namespace = ${projectNamespace}`.catch(() => [] as SumRow[])
  const byStage = await sql<Array<SumRow & { stage: string }>>`SELECT coalesce(stage, 'other') AS stage, ${sql.unsafe(SUM)} FROM run_usage WHERE project_namespace = ${projectNamespace} GROUP BY 1 ORDER BY "costUsd" DESC`.catch(() => [])
  const byModel = await sql<Array<SumRow & { model: string }>>`SELECT provider || '/' || model AS model, ${sql.unsafe(SUM)} FROM run_usage WHERE project_namespace = ${projectNamespace} GROUP BY 1 ORDER BY "costUsd" DESC`.catch(() => [])
  const byRun = await sql<Array<SumRow & { runId: string; createdAt: string }>>`SELECT run_id AS "runId", min(created_at) AS "createdAt", ${sql.unsafe(SUM)} FROM run_usage WHERE project_namespace = ${projectNamespace} GROUP BY run_id ORDER BY min(created_at) DESC LIMIT 20`.catch(() => [])
  return {
    ...toSummary(total),
    byStage: byStage.map((r) => ({ stage: r.stage, summary: toSummary(r) })),
    byModel: byModel.map((r) => ({ model: r.model, summary: toSummary(r) })),
    byRun: byRun.map((r) => ({ runId: r.runId, createdAt: r.createdAt, summary: toSummary(r) })),
  }
}

/** Totals per project namespace, for board cards. */
export async function summarizeUsageByProject(): Promise<Map<string, UsageSummary>> {
  const sql = getDb()
  const rows = await sql<Array<SumRow & { projectNamespace: string }>>`SELECT project_namespace AS "projectNamespace", ${sql.unsafe(SUM)} FROM run_usage GROUP BY 1`.catch(() => [])
  return new Map(rows.map((r) => [r.projectNamespace, toSummary(r)]))
}

export async function summarizeOrgUsage(days = 30): Promise<{ window: UsageSummary; allTime: UsageSummary; byProject: Array<{ projectNamespace: string; summary: UsageSummary }> }> {
  const sql = getDb()
  const [window] = await sql<SumRow[]>`SELECT ${sql.unsafe(SUM)} FROM run_usage WHERE created_at > now() - make_interval(days => ${days})`.catch(() => [] as SumRow[])
  const [allTime] = await sql<SumRow[]>`SELECT ${sql.unsafe(SUM)} FROM run_usage`.catch(() => [] as SumRow[])
  const byProject = await sql<Array<SumRow & { projectNamespace: string }>>`SELECT project_namespace AS "projectNamespace", ${sql.unsafe(SUM)} FROM run_usage WHERE created_at > now() - make_interval(days => ${days}) GROUP BY 1 ORDER BY "costUsd" DESC LIMIT 20`.catch(() => [])
  return { window: toSummary(window), allTime: toSummary(allTime), byProject: byProject.map((r) => ({ projectNamespace: r.projectNamespace, summary: toSummary(r) })) }
}
