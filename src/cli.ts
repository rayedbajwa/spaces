#!/usr/bin/env bun

import process from 'node:process'
import readline from 'node:readline/promises'
import { parseArgs } from 'node:util'
import {
  normalizeThinkingLevel,
  resolveCwd,
  type FlowOptions,
} from './lib/aidlc'
import { PipelineEngine } from './lib/pipeline-engine'
import { getTemplate, listTemplates } from './lib/pipeline-loader'
import { log } from './lib/logger'

const cliLog = log.child({ mod: 'cli' })

const DEFAULT_PIPELINE = 'aidlc-classic'

main().catch((error) => {
  cliLog.error('AIDLC flow failed', error instanceof Error ? error : new Error(String(error)))
  process.exitCode = 1
})

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      cwd: { type: 'string' },
      pipeline: { type: 'string' },
      feature: { type: 'string' },
      constitution: { type: 'string' },
      'plan-context': { type: 'string' },
      'checklist-domain': { type: 'string' },
      model: { type: 'string' },
      thinking: { type: 'string' },
      'persist-session': { type: 'boolean' },
      'non-interactive': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      'list-pipelines': { type: 'boolean' },
      verbose: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  })

  if (values.help) {
    printHelp()
    return
  }

  if (values['list-pipelines']) {
    const templates = await listTemplates()
    for (const t of templates) {
      console.log(`- ${t.name} (v${t.version}, ${t.stepCount} steps, ${t.source})${t.description ? `\n    ${t.description.trim()}` : ''}`)
    }
    return
  }

  const options = getFlowOptions(values)
  const pipelineName = getStringValue(values.pipeline) ?? DEFAULT_PIPELINE
  const { template } = await getTemplate(pipelineName)

  if (values['dry-run']) {
    const plan = PipelineEngine.describePlan(template)
    console.log(`AIDLC pipeline dry run: ${template.name} (v${template.version})`)
    console.log(`cwd: ${options.cwd}`)
    console.log(`stages: ${plan.stages.join(', ')}`)
    console.log(`review gates: ${plan.reviewStages.join(', ') || 'none'}`)
    console.log(`human gates: ${plan.humanGateStages.join(', ') || 'none'}`)
    if (plan.parallelSteps.length > 0) {
      console.log(`parallel steps: ${plan.parallelSteps.map((s) => `${s.id} (max ${s.maxConcurrency})`).join(', ')}`)
    }
    if (plan.branches.length > 0) {
      console.log(`branches:`)
      for (const b of plan.branches) {
        console.log(`  ${b.from} --[${b.when}]--> ${b.goto}`)
      }
    }
    return
  }

  const engine = new PipelineEngine(template, options, {
    stdout: (chunk) => process.stdout.write(chunk),
    stderr: (chunk) => process.stderr.write(chunk),
  })

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  try {
    let result = await engine.start()

    while (result.status === 'paused') {
      if (options.nonInteractive) {
        throw new Error(`Stage "${result.stage}" is paused for ${result.pauseKind ?? 'input'}, but --non-interactive was set.`)
      }

      const prompt = result.pauseKind === 'review'
        ? '\nReview gate paused. Type "approve" to continue, or enter requested changes: '
        : '\nClarification requested. Reply and press Enter: '
      const answer = (await rl.question(prompt)).trim()
      if (!answer) {
        throw new Error(`Stage "${result.stage}" needs input before the pipeline can continue.`)
      }

      result = await engine.answer(answer)
    }
  } finally {
    rl.close()
    await engine.dispose()
  }
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
    verbose: values.verbose === true,
  }
}

function getStringValue(value: string | boolean | Array<string | boolean> | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function printHelp(): void {
  console.log(`Bun AIDLC pipeline runner for Pi SDK + Spec Kit

Usage:
  bun run aidlc --feature "Add multi-signer templates"
  bun run aidlc --pipeline aidlc-mvp --feature "Add multi-signer templates"
  bun run aidlc --feature "..." --plan-context "Use Bun + TypeScript"
  bun run aidlc --list-pipelines

Web UI:
  bun run web

Options:
  --cwd <path>                Run against a specific repository
  --pipeline <name>           Template name (default: aidlc-classic). Use --list-pipelines to enumerate
  --feature <text>            Input for the specify stage
  --constitution <text>       Input for the constitution stage
  --plan-context <text>       Extra implementation context for the plan stage
  --checklist-domain <text>   Input for the checklist stage
  --model <provider/model>    Pi model selector, e.g. anthropic/claude-sonnet-4-5:high
  --thinking <level>          Override thinking level when --model omits it
  --persist-session           Save the Pi session instead of using in-memory mode
  --non-interactive           Fail instead of waiting for clarification or review input
  --dry-run                   Print the resolved template plan only
  --list-pipelines            List available pipeline templates and exit
  --verbose                   Print tool lifecycle events
  -h, --help                  Show this help`)
}
