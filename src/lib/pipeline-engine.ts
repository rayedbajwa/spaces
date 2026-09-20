import {
  AIDLCFlow,
  runAIDLCParallelSubAgents,
  type FlowOptions,
  type FlowProgress,
  type ParallelSubAgentProgressEvent,
  type ParallelSubAgentResult,
  type StageName,
  type StepNavigator,
  type StepNavigatorContext,
  type StepNavigatorResult,
} from './aidlc'
import type { PipelineStep, PipelineTemplate } from './pipeline-template'
import { evaluateBranchExpression, readCodeReviewStatus, readDeliveryStatus, readVerificationStatus } from './pipeline-branch'
import { loadPersona } from './persona-loader'
import { loadRoutingConfig, routeModel, type SpeedMode } from './model-router'
import { getTierModels } from './model-policy'
import { isProviderConfiguredWith, tierOfModel } from './default-model'
import { loadProviderKeys } from './provider-keys'
import { getDefaultOrgId, orgIdForProject } from './orgs'
import { compactHandoff } from './context-compactor'
import { prepareResearchInputs } from './research-stage'
import { responsibilityContextForStage } from './project-responsibilities'
import { log } from './logger'

export interface PipelineEngineOptions extends FlowOptions {
  /**
   * Speed vs. quality mode. Passed to the model router — 'fast' picks Haiku
   * across most stages, 'quality' picks Sonnet+high-thinking (Opus for merges),
   * 'balanced' (default) uses the shipped defaults in data/org/model-routing.yml.
   * Pipeline step `model:` fields always override this.
   */
  speedMode?: SpeedMode
  /** Approval notes given at review gates (applied on restart when the live engine was gone). */
  reviewerNotes?: Array<{ stage: string | null; note: string; at: string }>
  /**
   * Handoffs captured by earlier attempts of this run (from run_thread_entries).
   * Seeded on a rerun/resume so the stage that restarts still sees what the
   * previous stages decided instead of starting from a blank thread.
   */
  priorHandoffs?: Array<{ stepId: string; stage: string; model?: string; text: string; compacted?: boolean }>
}

export interface PipelineEngineSinks {
  stdout?: (chunk: string) => void
  stderr?: (chunk: string) => void
  onUsage?: (message: { provider: string; model: string; responseId?: string; responseModel?: string; usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: { total: number } } }, stage?: StageName) => void
  onParallelProgress?: (stepId: string, event: ParallelSubAgentProgressEvent) => void
  onBranch?: (from: string, to: string, reason: string) => void
  onStageHandoff?: (handoff: { stepIndex: number; stepId: string; stage: string; model?: string; tail: string; summary?: string; summaryHash?: string }) => Promise<void> | void
}

export interface PipelineEngineDryRunPlan {
  template: string
  stages: StageName[]
  reviewStages: StageName[]
  humanGateStages: StageName[]
  parallelSteps: Array<{ id: string; stage: StageName; maxConcurrency: number }>
  branches: Array<{ from: string; when: string; goto: string }>
  models: Array<{ id: string; stage: StageName; role?: string; model?: string; thinking?: string }>
}

const DEFAULT_MAX_ITERATIONS = 3

export class PipelineEngine {
  private readonly flow: AIDLCFlow
  private readonly template: PipelineTemplate
  private readonly reviewStages: Set<StageName>
  private readonly humanGateStages: Set<StageName>
  private readonly parallelStepsByStage: Map<StageName, PipelineStep>
  private readonly stepsByStage: Map<StageName, PipelineStep>
  private readonly stepsById: Map<string, PipelineStep>
  private readonly visitCount: Map<string, number> = new Map()
  // Cross-model memory: compacted output of each completed stage. Injected as
  // preamble into subsequent stages so the next model can see prior decisions
  // even when the Pi session was replaced due to a model swap.
  // `text` is either a Haiku-generated summary (when tail was large enough to
  // be worth compacting) or the raw tail (below-threshold or compactor error).
  private readonly stageHandoffs: Array<{ stepId: string; stage: string; model?: string; text: string; compacted: boolean }> = []
  private readonly sinks: PipelineEngineSinks
  private readonly options: PipelineEngineOptions

  constructor(template: PipelineTemplate, options: PipelineEngineOptions, sinks: PipelineEngineSinks = {}) {
    this.template = template
    this.sinks = sinks
    this.options = options
    // Rerun/resume: start with the previous attempt's cross-stage memory.
    for (const h of options.priorHandoffs ?? []) {
      this.stageHandoffs.push({ stepId: h.stepId, stage: h.stage, model: h.model, text: h.text, compacted: h.compacted ?? false })
    }
    while (this.stageHandoffs.length > 6) this.stageHandoffs.shift()

    const stages = template.steps.map((step) => step.stage)
    this.reviewStages = new Set(template.steps.filter((s) => s.review).map((s) => s.stage))
    this.humanGateStages = new Set(template.steps.filter((s) => s.humanGate).map((s) => s.stage))
    this.parallelStepsByStage = new Map(
      template.steps.filter((s) => s.parallel).map((s) => [s.stage, s]),
    )
    this.stepsByStage = new Map(template.steps.map((s) => [s.stage, s]))
    this.stepsById = new Map(template.steps.map((s) => [s.id, s]))

    const flowOptions: FlowOptions = {
      ...options,
      reviewHarness: this.reviewStages.size > 0,
      // Autonomous mode disables human-in-loop entirely — the loop-back branch
      // and verify-fix re-runs happen without pausing for approval.
      humanInLoop: !options.autonomousMode && this.humanGateStages.size > 0,
      reviewStagesOverride: this.reviewStages,
      humanGateStagesOverride: options.autonomousMode ? new Set<StageName>() : this.humanGateStages,
      stepNavigator: this.buildNavigator(),
      beforeStagePrompt: this.buildStagePreambleLoader(),
      stepModel: this.buildStepModelResolver(),
      afterStageComplete: this.buildStageCompletionCapture(),
    }

    this.flow = new AIDLCFlow(flowOptions, stages, {
      stdout: sinks.stdout,
      stderr: sinks.stderr,
      onUsage: sinks.onUsage,
    })
  }

  async start(): Promise<FlowProgress> {
    return await this.flow.start()
  }

  async answer(input: string): Promise<FlowProgress> {
    return await this.flow.answer(input)
  }

  async dispose(): Promise<void> {
    await this.flow.dispose()
  }

  getLog(): string {
    return this.flow.getLog()
  }

  getCurrentStage(): StageName | undefined {
    return this.flow.getCurrentStage()
  }

  /** True while the flow is paused at a gate and can accept an answer. */
  isWaitingForInput(): boolean {
    return this.flow.isWaitingForInput()
  }

  getSessionFile(): string | undefined {
    return this.flow.getSessionFile()
  }

  getTemplateName(): string {
    return this.template.name
  }

  static describePlan(template: PipelineTemplate): PipelineEngineDryRunPlan {
    const branches: Array<{ from: string; when: string; goto: string }> = []
    for (const step of template.steps) {
      for (const rule of step.onComplete?.branch ?? []) {
        branches.push({ from: step.id, when: rule.when, goto: rule.goto })
      }
    }
    return {
      template: template.name,
      stages: template.steps.map((s) => s.stage),
      reviewStages: template.steps.filter((s) => s.review).map((s) => s.stage),
      humanGateStages: template.steps.filter((s) => s.humanGate).map((s) => s.stage),
      parallelSteps: template.steps
        .filter((s) => s.parallel)
        .map((s) => ({ id: s.id, stage: s.stage, maxConcurrency: s.parallel?.maxConcurrency ?? 4 })),
      branches,
      models: template.steps.map((s) => ({ id: s.id, stage: s.stage, role: s.role, model: s.model, thinking: s.thinking })),
    }
  }

  async runDeclaredParallelSubAgents(): Promise<Array<{ stepId: string; results: ParallelSubAgentResult[] }>> {
    const outputs: Array<{ stepId: string; results: ParallelSubAgentResult[] }> = []
    for (const step of this.template.steps) {
      if (!step.parallel) continue
      const { results } = await runAIDLCParallelSubAgents({
        cwd: this.options.cwd,
        orgId: await this.orgId(),
        projectId: this.options.projectId,
        model: this.options.model,
        thinking: this.options.thinking,
        sharedContextPrompt: this.options.sharedContextPrompt,
        maxAgents: step.parallel.maxConcurrency,
        onProgress: (event) => this.sinks.onParallelProgress?.(step.id, event),
      })
      outputs.push({ stepId: step.id, results })
    }
    return outputs
  }

  hasParallelSteps(): boolean {
    return this.parallelStepsByStage.size > 0
  }

  private buildStagePreambleLoader(): FlowOptions['beforeStagePrompt'] {
    return async ({ stageIndex, stage }) => {
      // Steps map 1:1 to template.steps by index for the linear prefix.
      // Loop-back extensions past the original array look up the step by stage.
      const step = this.template.steps[stageIndex] ?? this.stepsByStage.get(stage)
      if (!step) return ''

      const previousVisits = this.visitCount.get(step.id) ?? 0
      const isRerun = previousVisits > 0

      const parts: string[] = []

      // Cross-stage memory FIRST — it's context the model needs to reason with.
      const handoffs = this.renderHandoffs()
      if (handoffs) parts.push(handoffs)

      // Notes a reviewer attached to an approval: the previous stage was
      // approved on the condition that these are applied, so do that first.
      const notes = (this.options.reviewerNotes ?? []).filter((n) => !n.stage || this.stepsByStage.has(n.stage as StageName) || true)
      if (notes.length) {
        parts.push(`# Reviewer notes to apply first\n\nA reviewer approved earlier stages with these notes. Apply each one to the relevant artifacts before doing this stage's work, and mention what you changed.\n\n${notes.map((n) => `- (${n.stage ?? 'run'}, ${n.at}) ${n.note}`).join('\n')}`)
      }

      if (step.role) {
        const persona = await loadPersona(step.role)
        if (persona) parts.push(`# Active role: ${step.role}\n\n${persona.trim()}`)
      }

      // Accountability contacts guide the agent but never alter existing team
      // authorization or the human-gate decision path.
      if (this.options.projectId) {
        try {
          parts.push(await responsibilityContextForStage(this.options.projectId, String(step.stage)))
        } catch {
          // Legacy projects may not have responsibility tables until repaired;
          // a missing advisory note must not stop a pipeline stage.
        }
      }

      // Research: bring in the repositories the feature needs and what is
      // already known about them, so the agent starts from facts.
      if (step.stage === 'research') {
        try {
          const prep = await prepareResearchInputs({
            projectId: this.options.projectId,
            cwd: this.options.cwd,
            feature: this.options.feature,
            model: this.options.model,
            print: (line) => this.sinks.stdout?.(line),
          })
          parts.push(prep.markdown)
        } catch (error) {
          parts.push(`# Research inputs\n\n_Automatic preparation failed: ${error instanceof Error ? error.message : String(error)}. Gather the inputs yourself._`)
        }
      }

      if (isRerun && step.stage === 'implement') {
        parts.push(
          `# Loop iteration ${previousVisits + 1} — verify-driven re-run\n\n` +
          `This step is being re-executed because the verify stage flagged remaining work.\n` +
          `The latest \`verification-report.md\` is available in the shared context bundle above.\n\n` +
          `**Focus rules for this iteration:**\n` +
          `- Read the \`## Unsatisfied Test Cases\` section of the verification report FIRST.\n` +
          `- Fix ONLY the specific failing test cases listed there.\n` +
          `- Do not rewrite passing code, do not re-plan, do not re-architect.\n` +
          `- Add production code only when a failing test needs it.\n` +
          `- Prefer minimal, surgical diffs.\n` +
          `- After your changes, list which tests should now pass so the next verify pass can check.\n`,
        )
      }

      if (isRerun && step.stage === 'verify') {
        parts.push(
          `# Loop iteration ${previousVisits + 1} — re-verification\n\n` +
          `Verification failed previously and code has been changed since. Re-run the test suite in full.\n` +
          `Preserve the same status-line format so downstream loops keep working.\n`,
        )
      }

      return parts.join('\n\n---\n\n')
    }
  }

  private buildStageCompletionCapture(): FlowOptions['afterStageComplete'] {
    return async ({ stageIndex, stage, output, model }) => {
      const step = this.template.steps[stageIndex] ?? this.stepsByStage.get(stage)
      if (!step) return
      const trimmed = output.trim()
      if (!trimmed) return

      // First-pass truncation cap: never send more than ~12k chars to the
      // compactor, matches the raw tail we'd have used pre-compaction. Above
      // that we lose the head of the message anyway; keep the tail (which is
      // usually where the conclusion + artifacts land).
      const raw = trimmed.length > 12_000 ? '…' + trimmed.slice(-12_000) : trimmed

      // Compact the tail into a preamble-ready summary. Safe-fails to the raw
      // tail on any error, so the pipeline never breaks because compaction did.
      const compaction = await compactHandoff({ stage: String(stage), stepId: step.id, model, tail: raw, orgId: await this.orgId() })
      const text = compaction.text

      this.stageHandoffs.push({ stepId: step.id, stage, model, text, compacted: compaction.compacted })
      while (this.stageHandoffs.length > 6) this.stageHandoffs.shift()

      // Best-effort persist so a UI/observer can inspect the thread across
      // restarts. We persist the RAW tail (for inspection) plus the compacted
      // summary (for cross-run cache reuse).
      if (this.sinks.onStageHandoff) {
        try {
          await this.sinks.onStageHandoff({
            stepIndex: stageIndex,
            stepId: step.id,
            stage,
            model,
            tail: raw,
            summary: compaction.compacted ? text : undefined,
            summaryHash: compaction.hash,
          })
        } catch {
          // never fail the run because of a handoff persistence hiccup
        }
      }
    }
  }

  private renderHandoffs(): string {
    if (this.stageHandoffs.length === 0) return ''
    const entries = this.stageHandoffs.map((h, i) => {
      const modelHint = h.model ? ` · model: ${h.model}` : ''
      const modeHint = h.compacted ? ' · summarized' : ''
      return `### Prior stage ${i + 1}: ${h.stepId} (${h.stage})${modelHint}${modeHint}\n\n${h.text}`
    })
    return `# Cross-stage memory\n\nCompact summaries of what prior stages produced in this run. The Pi session may have been reset when the model changed, but this thread carries context across boundaries.\n\n${entries.join('\n\n---\n\n')}`
  }

  private orgIdPromise?: Promise<string>

  /** Organization of this run: explicit option, else the project's, else the default one. */
  private orgId(): Promise<string> {
    this.orgIdPromise ??= this.options.orgId ? Promise.resolve(this.options.orgId) : this.options.projectId ? orgIdForProject(this.options.projectId) : getDefaultOrgId()
    return this.orgIdPromise
  }

  private buildStepModelResolver(): FlowOptions['stepModel'] {
    const engineLog = log.child({ mod: 'pipeline-engine', pipeline: this.template.name })
    const substituted = new Set<string>()
    return async ({ stageIndex, stage }) => {
      const step = this.template.steps[stageIndex] ?? this.stepsByStage.get(stage)
      const config = await loadRoutingConfig()
      const orgId = await this.orgId()
      const tiers = await getTierModels(orgId)
      const orgKeys = await loadProviderKeys(orgId).catch(() => ({}))
      const attempt = step ? this.visitCount.get(step.id) ?? 0 : 0
      // A template may pin a model from a provider this deployment has no key
      // for. Keep the author's intent — the size tier — on the provider in use.
      let explicitModel = step?.model
      if (explicitModel && !isProviderConfiguredWith(explicitModel, orgKeys)) {
        const substitute = tiers[tierOfModel(explicitModel)]
        if (step && !substituted.has(step.id)) {
          substituted.add(step.id)
          engineLog.warn('template pins a model whose provider has no credentials; using the equivalent tier instead', { stepId: step.id, pinned: explicitModel, model: substitute })
        }
        explicitModel = substitute
      }
      const decision = routeModel({
        stage: String(stage),
        role: step?.role,
        mode: this.options.speedMode,
        attempt: Math.max(0, attempt - 1), // first visit = attempt 0
        explicitModel,
        explicitThinking: step?.thinking as never,
        // promptSize would require pre-rendering the prompt; wired in the
        // beforeStagePrompt hook instead where the actual bytes are known.
      }, config, tiers)
      engineLog.debug('model chosen', {
        stage,
        stepId: step?.id,
        model: decision.model,
        thinking: decision.thinking,
        reason: decision.reason,
      })
      return { model: decision.model, thinking: decision.thinking as never }
    }
  }

  private buildNavigator(): StepNavigator {
    return async (ctx: StepNavigatorContext): Promise<StepNavigatorResult> => {
      // Record visit to this stage's step
      const step = this.stepsByStage.get(ctx.stage)
      if (step) {
        this.visitCount.set(step.id, (this.visitCount.get(step.id) ?? 0) + 1)
      }

      // No branch rules: linear advance.
      if (!step?.onComplete?.branch || step.onComplete.branch.length === 0) {
        return { nextIndex: ctx.currentIndex + 1 }
      }

      // Evaluate branch rules in order.
      const variables = await this.buildBranchVariables(step.id)
      for (const rule of step.onComplete.branch) {
        let matched = false
        try {
          matched = evaluateBranchExpression(rule.when, variables)
        } catch (error) {
          throw new Error(`Failed to evaluate branch on step "${step.id}": ${error instanceof Error ? error.message : String(error)}`)
        }
        if (!matched) continue

        if (rule.goto === 'end') {
          this.sinks.onBranch?.(step.id, 'end', rule.when)
          return { nextIndex: ctx.stages.length } // past the end → terminate
        }

        const targetStep = this.stepsById.get(rule.goto)
        if (!targetStep) {
          throw new Error(`Branch target step "${rule.goto}" not found in template.`)
        }

        // Cap iterations to prevent infinite loops.
        const maxIter = targetStep.maxIterations ?? DEFAULT_MAX_ITERATIONS
        const visits = this.visitCount.get(targetStep.id) ?? 0
        if (visits >= maxIter) {
          this.sinks.onBranch?.(step.id, targetStep.id, `${rule.when} (max ${maxIter} iterations reached; terminating)`)
          return { nextIndex: ctx.stages.length }
        }

        this.sinks.onBranch?.(step.id, targetStep.id, rule.when)
        // Append the target stage to the stages array so the flow can revisit it.
        return {
          nextIndex: ctx.stages.length,
          extendStages: [targetStep.stage],
        }
      }

      // No rule matched: linear advance (fall-through).
      return { nextIndex: ctx.currentIndex + 1 }
    }
  }

  private async buildBranchVariables(currentStepId: string): Promise<Record<string, string | undefined>> {
    const [verification, delivery, codeReview] = await Promise.all([
      readVerificationStatus(this.options.cwd).catch(() => undefined),
      readDeliveryStatus(this.options.cwd).catch(() => undefined),
      readCodeReviewStatus(this.options.cwd).catch(() => undefined),
    ])
    return {
      verification_status: verification,
      delivery_status: delivery,
      code_review_status: codeReview,
      iteration: String(this.visitCount.get(currentStepId) ?? 0),
    }
  }
}
