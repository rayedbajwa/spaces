/**
 * Datasets and evaluators in Phoenix for what Spaces expects of its agents
 * (src/lib/agent-evals.ts).
 *
 *   bun run phoenix:evals                 # sample dataset + experiment
 *   bun run phoenix:evals --traces 300    # the checks on recent real agent turns
 *   bun run phoenix:evals --handoffs 300  # handoff checks on the latest stage handoffs
 *   bun run phoenix:evals --handoffs-file rows.json  # the same, on exported rows
 *   bun run phoenix:evals --judges        # print the LLM-judge prompts for the UI
 *
 * Needs PHOENIX_COLLECTOR_ENDPOINT (the Phoenix base URL; the public one works
 * from a laptop) and PHOENIX_API_KEY when Phoenix has authentication.
 * `--handoffs` reads run_thread_entries from DATABASE_URL; `--handoffs-file`
 * takes those rows as a JSON array instead (run_id, stage, tail, summary…),
 * for when the database is not reachable from where this runs.
 *
 * The sample dataset `spaces-agent-expectations` has a passing and a failing
 * output for each expectation; its experiment shows each check's verdict and
 * whether it matched the expected one (the evaluators are right before they
 * are trusted). `--traces` builds `spaces-agent-turns` from the latest LLM and
 * bash spans whose output is an artifact Spaces parses, each example linked to
 * its span, and runs the same checks on them. `--handoffs` builds
 * `spaces-handoffs`: each stage's output tail and what the next stage received,
 * checked by src/lib/handoff-evals.ts.
 */

import { createClient } from '@arizeai/phoenix-client'
import { createDataset } from '@arizeai/phoenix-client/datasets'
import { asExperimentEvaluator, runExperiment } from '@arizeai/phoenix-client/experiments'
import { getSpans } from '@arizeai/phoenix-client/spans'
import type { Example } from '@arizeai/phoenix-client/types/datasets'
import { AGENT_CHECKS, detectArtifact, JUDGE_PROMPTS, type AgentCheck, type ArtifactKind } from '../src/lib/agent-evals'
import { AGENT_EVAL_SAMPLES } from '../src/lib/agent-eval-samples'
import { closeDb, getDb } from '../src/lib/db'
import { HANDOFF_CHECKS, HANDOFF_JUDGE_PROMPTS, type Handoff, type HandoffCheck } from '../src/lib/handoff-evals'

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const text = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const value = (name: string, fallback: number) => {
  const i = args.indexOf(name)
  const n = i >= 0 ? Number(args[i + 1]) : NaN
  return Number.isFinite(n) && n > 0 ? n : fallback
}

if (flag('--judges')) {
  for (const judge of JUDGE_PROMPTS) console.log(`### ${judge.name} (${judge.artifact})\n\n${judge.prompt}\n`)
  for (const judge of HANDOFF_JUDGE_PROMPTS) console.log(`### ${judge.name} (spaces-handoffs)\n\n${judge.prompt}\n`)
  process.exit(0)
}

const baseUrl = process.env.PHOENIX_COLLECTOR_ENDPOINT?.trim().replace(/\/+$/, '')
if (!baseUrl) {
  console.error('Set PHOENIX_COLLECTOR_ENDPOINT to the Phoenix base URL (and PHOENIX_API_KEY when it has authentication).')
  process.exit(1)
}
const apiKey = process.env.PHOENIX_API_KEY?.trim()
const client = createClient({ options: { baseUrl, headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} } })
const project = process.env.PHOENIX_PROJECT_NAME?.trim() || 'spaces'

type Input = { artifact: ArtifactKind; output: string }

/** One Phoenix evaluator per check; examples of another artifact are not applicable. */
function evaluatorFor(check: AgentCheck) {
  return asExperimentEvaluator({
    name: check.name,
    kind: 'CODE',
    evaluate: ({ input }) => {
      const { artifact, output } = input as Input
      if (check.artifact !== 'any' && check.artifact !== artifact) return { label: 'not applicable', score: null, explanation: `applies to ${check.artifact}` }
      const r = check.check(String(output ?? ''))
      return { label: r.pass ? 'pass' : 'fail', score: r.pass ? 1 : 0, explanation: r.pass ? check.rule : r.problems.join('; ') }
    },
  })
}

const applicable = (artifact: ArtifactKind) => AGENT_CHECKS.filter((c) => c.artifact === artifact || c.artifact === 'any')

async function samples() {
  const examples: Example[] = AGENT_EVAL_SAMPLES.map((s) => ({
    input: { artifact: s.artifact, stage: s.stage, task: s.task, output: s.output },
    output: { verdict: s.expected, reason: s.reason },
    metadata: { sample: s.id, artifact: s.artifact, stage: s.stage, expected: s.expected },
    splits: [s.artifact, s.expected],
  }))
  const { datasetId } = await createDataset({
    client,
    name: 'spaces-agent-expectations',
    description: 'What Spaces expects of its agents (status lines, sections, formats, rules), with a passing and a failing output for each. Source: src/lib/agent-evals.ts, src/lib/agent-eval-samples.ts.',
    examples,
  })
  console.log(`dataset spaces-agent-expectations: ${examples.length} examples (${datasetId})`)

  const matches = asExperimentEvaluator({
    name: 'matches-expected',
    kind: 'CODE',
    evaluate: ({ input, expected }) => {
      const { artifact, output } = input as Input
      const failed = applicable(artifact).filter((c) => !c.check(String(output)).pass).map((c) => c.name)
      const verdict = failed.length ? 'fail' : 'pass'
      const want = (expected as { verdict?: string } | undefined)?.verdict
      return { label: verdict === want ? 'match' : 'mismatch', score: verdict === want ? 1 : 0, explanation: `checks say ${verdict}${failed.length ? ` (${failed.join(', ')})` : ''}; expected ${want}` }
    },
  })
  const experiment = await runExperiment({
    client,
    dataset: { datasetId },
    experimentName: `spaces-checks ${new Date().toISOString().slice(0, 16)}`,
    experimentDescription: 'Spaces code checks on the sample outputs (the task replays each sample).',
    task: (example) => String((example.input as Input).output),
    evaluators: [matches, ...AGENT_CHECKS.map(evaluatorFor)],
    concurrency: 4,
    record: !flag('--dry-run'),
  })
  report(experiment.evaluationRuns ?? [])
}

async function traces(limit: number) {
  const found: Example[] = []
  let cursor: string | null | undefined
  let seen = 0
  while (seen < limit) {
    const page = await getSpans({ client, project: { projectName: project }, spanKind: ['LLM', 'TOOL'], limit: Math.min(100, limit - seen), cursor })
    seen += page.spans.length
    for (const span of page.spans) {
      const attrs = (span.attributes ?? {}) as Record<string, unknown>
      const meta = (() => { try { return JSON.parse(String(attrs['metadata'] ?? '{}')) as Record<string, unknown> } catch { return {} } })()
      let artifact: ArtifactKind | undefined
      let output = ''
      if (span.span_kind === 'LLM') {
        output = String(attrs['output.value'] ?? '')
        artifact = detectArtifact(output)
      } else if (span.name === 'tool bash' && meta.kind === 'subagent') {
        // What a workstream agent ran: the command, for the no-commit/push rule.
        try { output = String((JSON.parse(String(attrs['input.value'] ?? '{}')) as { command?: string }).command ?? '') } catch { output = '' }
        artifact = output ? 'commands' : undefined
      }
      if (!artifact) continue
      found.push({
        input: { artifact, stage: meta.stage ?? null, task: String(attrs['input.value'] ?? '').slice(0, 2000), output },
        output: null,
        metadata: { artifact, kind: meta.kind, stage: meta.stage, runId: meta.runId, projectId: meta.projectId, spanName: span.name },
        splits: [artifact],
        spanId: span.context.span_id,
      })
    }
    cursor = page.nextCursor
    if (!cursor || page.spans.length === 0) break
  }
  if (found.length === 0) {
    console.log(`No agent output Spaces parses in the last ${seen} spans of project ${project}.`)
    return
  }
  const { datasetId } = await createDataset({
    client,
    name: 'spaces-agent-turns',
    description: `Recent agent outputs from project ${project} that Spaces parses (reports, reviews, tasks, plans, workstreams, questions, workstream commands), each linked to its span.`,
    examples: found,
  })
  console.log(`dataset spaces-agent-turns: ${found.length} examples from ${seen} spans (${datasetId})`)
  const experiment = await runExperiment({
    client,
    dataset: { datasetId },
    experimentName: `spaces-checks on traces ${new Date().toISOString().slice(0, 16)}`,
    experimentDescription: 'Spaces code checks on real agent outputs.',
    task: (example) => String((example.input as Input).output),
    evaluators: AGENT_CHECKS.map(evaluatorFor),
    concurrency: 4,
    record: !flag('--dry-run'),
  })
  report(experiment.evaluationRuns ?? [])
}

type HandoffRow = { run_id: string; step_index: number; step_id: string; stage: string; model: string | null; tail: string; summary: string | null; created_at: string }

function handoffEvaluator(check: HandoffCheck) {
  return asExperimentEvaluator({
    name: check.name,
    kind: 'CODE',
    evaluate: ({ input }) => {
      const r = check.check(input as unknown as Handoff)
      return { label: r.pass ? 'pass' : 'fail', score: r.score ?? (r.pass ? 1 : 0), explanation: r.pass ? check.rule : r.problems.join('; ') }
    },
  })
}

async function handoffs(limit: number, file?: string) {
  const rows: HandoffRow[] = file
    ? ((await Bun.file(file).json()) as HandoffRow[]).slice(-limit)
    : (await getDb()<HandoffRow[]>`
        SELECT run_id::text, step_index, step_id, stage, model, tail, summary, created_at
          FROM run_thread_entries ORDER BY entry_id DESC LIMIT ${limit}
      `).reverse()
  if (!file) await closeDb()
  if (rows.length === 0) {
    console.log('No stage handoffs to evaluate.')
    return
  }
  const examples: Example[] = rows.map((r) => {
    const input: Handoff = { stage: r.stage, tail: r.tail, handoff: r.summary ?? r.tail, compacted: Boolean(r.summary) }
    return {
      input: { ...input },
      output: { handoff: input.handoff },
      metadata: { runId: r.run_id, stepIndex: r.step_index, stepId: r.step_id, stage: r.stage, model: r.model, compacted: input.compacted, createdAt: r.created_at },
      splits: [r.stage, input.compacted ? 'summary' : 'raw tail'],
    }
  })
  const { datasetId } = await createDataset({
    client,
    name: 'spaces-handoffs',
    description: 'Stage handoffs from run_thread_entries: the end of each stage\'s output (input.tail) and what the next stage received in its prompt (input.handoff, the summary or the raw tail). Checks: src/lib/handoff-evals.ts.',
    examples,
  })
  console.log(`dataset spaces-handoffs: ${examples.length} handoffs (${datasetId})`)
  const experiment = await runExperiment({
    client,
    dataset: { datasetId },
    experimentName: `handoff checks ${new Date().toISOString().slice(0, 16)}`,
    experimentDescription: 'Spaces handoff checks on saved stage handoffs (the task replays what the next stage received).',
    task: (example) => String((example.input as unknown as Handoff).handoff),
    evaluators: HANDOFF_CHECKS.map(handoffEvaluator),
    concurrency: 4,
    record: !flag('--dry-run'),
  })
  report(experiment.evaluationRuns ?? [])
}

function report(runs: Array<{ name: string; result?: { label?: string | null } | null }>) {
  const byName = new Map<string, Record<string, number>>()
  for (const run of runs) {
    const label = run.result?.label ?? 'error'
    if (label === 'not applicable') continue
    const counts = byName.get(run.name) ?? {}
    counts[label] = (counts[label] ?? 0) + 1
    byName.set(run.name, counts)
  }
  for (const [name, counts] of byName) console.log(`  ${name.padEnd(30)} ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}`)
}

if (flag('--traces')) await traces(value('--traces', 300))
else if (flag('--handoffs') || flag('--handoffs-file')) await handoffs(value('--handoffs', 300), text('--handoffs-file'))
else await samples()
