/**
 * Token usage and cost per model call, recorded as runs execute and rolled up
 * per run, per project and for the organization. Cost comes from the model
 * runtime's price table (USD per million tokens) via the SDK's usage object.
 */

import { getDb } from './db'
import { log } from './logger'

const usageLog = log.child({ mod: 'run-usage' })

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
  /** Provider response id (OpenRouter generation id, Anthropic message id). */
  responseId?: string
  /** The model that actually answered, when the provider reports it (OpenRouter routing). */
  responseModel?: string
  costSource: 'sdk' | 'provider' | 'estimated' | 'none'
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
export function usageFromMessage(message: { provider?: string; model?: string; responseId?: string; responseModel?: string; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: { total: number } } }, base: { runId: string; projectNamespace: string; stage?: string | null }): UsageRecord | undefined {
  const usage = message.usage
  if (!usage) return undefined
  const total = (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
  if (total <= 0) return undefined
  const costUsd = Number(usage.cost?.total ?? 0) || 0
  return {
    ...base,
    provider: message.provider ?? 'unknown',
    model: message.model ?? 'unknown',
    inputTokens: usage.input ?? 0,
    outputTokens: usage.output ?? 0,
    cacheReadTokens: usage.cacheRead ?? 0,
    cacheWriteTokens: usage.cacheWrite ?? 0,
    costUsd,
    responseId: message.responseId,
    responseModel: message.responseModel,
    costSource: costUsd > 0 ? 'sdk' : 'none',
  }
}

/** Price per million tokens for a model, as the catalog reports it. */
export interface PriceCard { inputCost: number; outputCost: number; cacheReadCost: number; cacheWriteCost: number }

/**
 * Find the price for the model that actually answered. OpenRouter's automatic
 * routing reports `auto` as the requested model and the routed one (e.g.
 * "openai/gpt-5.6") as responseModel; the catalog lists those under the
 * openrouter provider with their prices.
 */
export function findPrice(catalog: Array<PriceCard & { provider: string; id: string }>, provider: string, model: string, responseModel?: string): PriceCard | undefined {
  const priced = (m: PriceCard) => m.inputCost > 0 || m.outputCost > 0
  const wanted = responseModel && responseModel !== model ? responseModel : model
  const exact = catalog.find((m) => m.provider === provider && m.id === wanted && priced(m))
  if (exact) return exact
  const anyProvider = catalog.find((m) => m.id === wanted && priced(m))
  if (anyProvider) return anyProvider
  const tail = wanted.split('/').pop()!
  return catalog.find((m) => (m.id === tail || m.id.endsWith(`/${tail}`)) && priced(m))
}

/** Cost from a price card and token counts (USD). */
export function estimateCost(record: Pick<UsageRecord, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>, price: PriceCard): number {
  return (record.inputTokens * price.inputCost + record.outputTokens * price.outputCost + record.cacheReadTokens * price.cacheReadCost + record.cacheWriteTokens * price.cacheWriteCost) / 1_000_000
}

/** Fill in an estimated cost when the SDK reported none and the routed model is priced. */
export function priceRecord(record: UsageRecord, catalog: Array<PriceCard & { provider: string; id: string }>): UsageRecord {
  if (record.costUsd > 0) return record
  const price = findPrice(catalog, record.provider, record.model, record.responseModel)
  if (!price) return record
  const costUsd = estimateCost(record, price)
  return costUsd > 0 ? { ...record, costUsd, costSource: 'estimated' } : record
}

/** True when the provider can tell us the real cost after the fact (OpenRouter's routed models have no static price). */
export function needsProviderCost(record: UsageRecord): boolean {
  return record.provider === 'openrouter' && record.costUsd === 0 && Boolean(record.responseId)
}

interface OpenRouterGeneration { data?: { id: string; model?: string; total_cost?: number; usage?: number; native_tokens_prompt?: number; native_tokens_completion?: number } }

/**
 * Ask OpenRouter what a generation actually cost and which model served it,
 * then update the row. The generation record appears a moment after the
 * response, so retry briefly.
 */
export async function enrichOpenRouterUsage(usageId: number, responseId: string, apiKey = process.env.OPENROUTER_API_KEY): Promise<{ costUsd: number; model?: string } | undefined> {
  if (!apiKey) return undefined
  const delays = [3_000, 15_000, 45_000]
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    await new Promise((r) => setTimeout(r, delays[attempt]))
    try {
      const response = await fetch(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(responseId)}`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(8_000) })
      if (response.status === 404) continue
      if (!response.ok) { usageLog.warn('OpenRouter generation lookup failed', { status: response.status }); return undefined }
      const gen = (await response.json()) as OpenRouterGeneration
      const cost = Number(gen.data?.total_cost ?? gen.data?.usage ?? 0)
      if (!gen.data) continue
      const sql = getDb()
      await sql`UPDATE run_usage SET cost_usd = ${cost}, response_model = ${gen.data.model ?? null}, cost_source = 'provider' WHERE usage_id = ${usageId}`
      return { costUsd: cost, model: gen.data.model }
    } catch (error) {
      usageLog.warn('OpenRouter generation lookup error', { error: error instanceof Error ? error.message : String(error) })
    }
  }
  return undefined
}

export async function recordUsage(record: UsageRecord): Promise<number> {
  const sql = getDb()
  const [row] = await sql<Array<{ usageId: number }>>`
    INSERT INTO run_usage (run_id, project_namespace, stage, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, response_id, response_model, cost_source)
    VALUES (${record.runId}, ${record.projectNamespace}, ${record.stage ?? null}, ${record.provider}, ${record.model},
            ${record.inputTokens}, ${record.outputTokens}, ${record.cacheReadTokens}, ${record.cacheWriteTokens}, ${record.costUsd},
            ${record.responseId ?? null}, ${record.responseModel ?? null}, ${record.costSource})
    RETURNING usage_id AS "usageId"
  `
  return Number(row!.usageId)
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
  const byModel = await sql<Array<SumRow & { model: string }>>`SELECT provider || '/' || coalesce(response_model, model) AS model, ${sql.unsafe(SUM)} FROM run_usage WHERE project_namespace = ${projectNamespace} GROUP BY 1 ORDER BY "costUsd" DESC`.catch(() => [])
  const byRun = await sql<Array<SumRow & { runId: string; createdAt: string }>>`SELECT run_id AS "runId", min(created_at) AS "createdAt", ${sql.unsafe(SUM)} FROM run_usage WHERE project_namespace = ${projectNamespace} GROUP BY run_id ORDER BY min(created_at) DESC LIMIT 20`.catch(() => [])
  return {
    ...toSummary(total),
    byStage: byStage.map((r) => ({ stage: r.stage, summary: toSummary(r) })),
    byModel: byModel.map((r) => ({ model: r.model, summary: toSummary(r) })),
    byRun: byRun.map((r) => ({ runId: r.runId, createdAt: r.createdAt, summary: toSummary(r) })),
  }
}

/** Totals per project namespace, for board cards. */
/** Usage of just these projects, for the board: never an aggregate over every tenant's rows. */
export async function summarizeUsageForProjects(projectNamespaces: string[]): Promise<Map<string, UsageSummary>> {
  if (projectNamespaces.length === 0) return new Map()
  const sql = getDb()
  const rows = await sql<Array<SumRow & { projectNamespace: string }>>`SELECT project_namespace AS "projectNamespace", ${sql.unsafe(SUM)} FROM run_usage WHERE project_namespace = ANY(${projectNamespaces}) GROUP BY 1`.catch(() => [])
  return new Map(rows.map((r) => [r.projectNamespace, toSummary(r)]))
}

export async function summarizeUsageByProject(): Promise<Map<string, UsageSummary>> {
  const sql = getDb()
  const rows = await sql<Array<SumRow & { projectNamespace: string }>>`SELECT project_namespace AS "projectNamespace", ${sql.unsafe(SUM)} FROM run_usage GROUP BY 1`.catch(() => [])
  return new Map(rows.map((r) => [r.projectNamespace, toSummary(r)]))
}

export async function summarizeOrgUsage(orgId: string, days = 30): Promise<{ window: UsageSummary; allTime: UsageSummary; byProject: Array<{ projectNamespace: string; summary: UsageSummary }> }> {
  const sql = getDb()
  // Usage belongs to the organization of the project that ran it (through the project's team).
  const inOrg = sql`project_namespace IN (SELECT p.slug FROM projects p JOIN teams t ON t.team_id = p.team_id WHERE t.org_id = ${orgId})`
  const [window] = await sql<SumRow[]>`SELECT ${sql.unsafe(SUM)} FROM run_usage WHERE ${inOrg} AND created_at > now() - make_interval(days => ${days})`.catch(() => [] as SumRow[])
  const [allTime] = await sql<SumRow[]>`SELECT ${sql.unsafe(SUM)} FROM run_usage WHERE ${inOrg}`.catch(() => [] as SumRow[])
  const byProject = await sql<Array<SumRow & { projectNamespace: string }>>`SELECT project_namespace AS "projectNamespace", ${sql.unsafe(SUM)} FROM run_usage WHERE ${inOrg} AND created_at > now() - make_interval(days => ${days}) GROUP BY 1 ORDER BY "costUsd" DESC LIMIT 20`.catch(() => [])
  return { window: toSummary(window), allTime: toSummary(allTime), byProject: byProject.map((r) => ({ projectNamespace: r.projectNamespace, summary: toSummary(r) })) }
}
