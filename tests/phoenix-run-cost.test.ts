import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { getDb } from '../src/lib/db'
import { runCost } from '../src/lib/phoenix-annotations'
import { appendEvent, createRun } from '../src/lib/run-store'

const runIds: string[] = []
afterAll(async () => {
  if (runIds.length) await getDb()`DELETE FROM pipeline_runs WHERE run_id IN ${getDb()(runIds)}`
})

describe('run cost for Phoenix', () => {
  test('sums the run\'s usage events, by stage', async () => {
    const run = await createRun({ projectNamespace: `cost-${randomUUID().slice(0, 8)}`, projectLabel: 'Cost', projectPath: '/tmp', pipelineName: 'test', options: {} as never, template: { stages: [] } as never })
    runIds.push(run.runId)
    await appendEvent({ runId: run.runId, kind: 'usage', payload: { stage: 'plan', model: 'm', costUsd: 0.25, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 500 } })
    await appendEvent({ runId: run.runId, kind: 'usage', payload: { stage: 'plan', model: 'm', costUsd: 0.05, inputTokens: 100, outputTokens: 20 } })
    await appendEvent({ runId: run.runId, kind: 'usage', payload: { stage: 'implement', model: 'm', priced: true, costUsd: 0.7 } })
    await appendEvent({ runId: run.runId, kind: 'log', payload: { chunk: 'not usage' } })
    expect(await runCost(run.runId)).toEqual({
      costUsd: 1,
      calls: 3,
      inputTokens: 1100,
      outputTokens: 220,
      cacheReadTokens: 500,
      byStage: { plan: { costUsd: 0.3, calls: 2 }, implement: { costUsd: 0.7, calls: 1 } },
    })
  })

  test('a run without usage has no cost', async () => {
    const run = await createRun({ projectNamespace: `cost-${randomUUID().slice(0, 8)}`, projectLabel: 'Cost', projectPath: '/tmp', pipelineName: 'test', options: {} as never, template: { stages: [] } as never })
    runIds.push(run.runId)
    expect(await runCost(run.runId)).toBeUndefined()
  })
})
