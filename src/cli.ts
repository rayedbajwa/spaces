#!/usr/bin/env bun

import process from 'node:process'
import readline from 'node:readline/promises'
import { parseArgs } from 'node:util'
import {
  buildDefaultStages,
  getDryRunPlan,
  normalizeThinkingLevel,
  parseStages,
  PDLCFlow,
  resolveCwd,
  type FlowOptions,
  type StageName,
} from './lib/pdlc'

main().catch((error) => {
  console.error(`\nPDLC flow failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      cwd: { type: 'string' },
      feature: { type: 'string' },
      constitution: { type: 'string' },
      'plan-context': { type: 'string' },
      'checklist-domain': { type: 'string' },
      stages: { type: 'string' },
      model: { type: 'string' },
      thinking: { type: 'string' },
      'with-constitution': { type: 'boolean' },
      'with-clarify': { type: 'boolean' },
      'with-implement': { type: 'boolean' },
      'persist-session': { type: 'boolean' },
      'non-interactive': { type: 'boolean' },
      'skip-reviews': { type: 'boolean' },
      'skip-hitl': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      verbose: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  })

  if (values.help) {
    printHelp()
    return
  }

  const options = getFlowOptions(values)
  const stages = getStages(values)

  if (values['dry-run']) {
    const plan = getDryRunPlan(options, stages)
    console.log('PDLC flow dry run')
    console.log(`cwd: ${plan.cwd}`)
    console.log(`stages: ${plan.stages.join(', ')}`)
    console.log(`review harness: ${plan.reviewHarness ? 'enabled' : 'disabled'}`)
    console.log(`human in loop: ${plan.humanInLoop ? 'enabled' : 'disabled'}`)
    if (plan.reviewStages.length > 0) {
      console.log(`review gates: ${plan.reviewStages.join(', ')}`)
    }
    for (const stage of plan.stageDetails) {
      console.log(`- ${stage.stage} -> ${stage.skillPath}${stage.argument ? `\n  args: ${stage.argument}` : ''}`)
    }
    return
  }

  const flow = new PDLCFlow(options, stages, {
    stdout: (chunk) => process.stdout.write(chunk),
    stderr: (chunk) => process.stderr.write(chunk),
  })

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  try {
    let result = await flow.start()

    while (result.status === 'paused') {
      if (options.nonInteractive) {
        throw new Error(`Stage "${result.stage}" is paused for ${result.pauseKind ?? 'input'}, but --non-interactive was set.`)
      }

      const prompt = result.pauseKind === 'review'
        ? '\nReview gate paused. Type "approve" to continue, or enter requested changes: '
        : '\nClarification requested. Reply and press Enter: '
      const answer = (await rl.question(prompt)).trim()
      if (!answer) {
        throw new Error(`Stage "${result.stage}" needs input before the flow can continue.`)
      }

      result = await flow.answer(answer)
    }
  } finally {
    rl.close()
    await flow.dispose()
  }
}

function getStages(values: ReturnType<typeof parseArgs>['values']): StageName[] {
  const rawStages = getStringValue(values.stages)

  return rawStages
    ? parseStages(rawStages)
    : buildDefaultStages({
        withConstitution: values['with-constitution'] === true,
        withClarify: values['with-clarify'] === true,
        withImplement: values['with-implement'] === true,
      })
}

function getFlowOptions(values: ReturnType<typeof parseArgs>['values']): FlowOptions {
  return {
    cwd: resolveCwd(getStringValue(values.cwd)),
    feature: getStringValue(values.feature),
    constitution: getStringValue(values.constitution),
    planContext: getStringValue(values['plan-context']),
    checklistDomain: getStringValue(values['checklist-domain']),
    model: getStringValue(values.model),
    thinking: normalizeThinkingLevel(getStringValue(values.thinking)),
    persistSession: values['persist-session'] === true,
    nonInteractive: values['non-interactive'] === true,
    reviewHarness: values['skip-reviews'] !== true,
    humanInLoop: values['skip-hitl'] !== true,
    verbose: values.verbose === true,
  }
}

function getStringValue(value: string | boolean | Array<string | boolean> | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function printHelp(): void {
  console.log(`Bun PDLC flow runner for Pi SDK + Spec Kit

Usage:
  bun run pdlc --feature "Add multi-signer templates"
  bun run pdlc --feature "Add multi-signer templates" --with-clarify --with-implement
  bun run pdlc --feature "..." --plan-context "Use Bun + TypeScript and keep the app isolated"
  bun run pdlc --stages init,constitution,specify,clarify,plan,tasks,analyze,implement \
    --constitution "AI-assisted secure document workflow" \
    --feature "Add reusable signing templates"

Web UI:
  bun run web

Options:
  --cwd <path>                Run the flow against a specific repository
  --feature <text>            Input for speckit-specify
  --constitution <text>       Input for speckit-constitution
  --plan-context <text>       Extra implementation context for speckit-plan
  --checklist-domain <text>   Input for speckit-checklist
  --stages <csv>              Explicit stage list. Default: init,specify,plan,tasks,analyze
  --with-constitution         Insert constitution after init
  --with-clarify              Insert clarify after specify
  --with-implement            Append implement after analyze
  --model <provider/model>    Pi model selector, e.g. anthropic/claude-sonnet-4-5:high
  --thinking <level>          Override thinking level when --model omits it
  --persist-session           Save the Pi session instead of using in-memory mode
  --non-interactive           Fail instead of waiting for clarification or review input
  --skip-reviews              Disable the review harness after specify, plan, tasks, and implement
  --skip-hitl                 Disable human approval gates and auto-continue after review
  --dry-run                   Print the resolved stages, skill files, and review gates only
  --verbose                   Print tool lifecycle events
  -h, --help                  Show this help`)
}
