import { execFileSync } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import {
  createAgentSession,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  type AgentSession,
  type CreateAgentSessionOptions,
} from '@earendil-works/pi-coding-agent'
import { log } from './logger'
import { buildKnowledgeTools } from './integration-sources'
import { readVerificationStatus } from './pipeline-branch'
import {
  commentOnPullRequest,
  defaultBranch as gitDefaultBranch,
  ensureWorktree,
  publishBranchAsPullRequest,
  pullRequestBody,
  slugForBranch,
} from './pull-requests'

const aidlcLog = log.child({ mod: 'aidlc' })

const require = createRequire(import.meta.url)

export const STAGE_DEFINITIONS = {
  init: { skill: 'speckit-init', argKey: undefined },
  constitution: { skill: 'speckit-constitution', argKey: 'constitution' },
  specify: { skill: 'speckit-specify', argKey: 'feature' },
  clarify: { skill: 'speckit-clarify', argKey: undefined },
  plan: { skill: 'speckit-plan', argKey: 'planContext' },
  tasks: { skill: 'speckit-tasks', argKey: undefined },
  testplan: { skill: 'aidlc-testplan', argKey: undefined },
  parallelize: { skill: 'aidlc-parallelize', argKey: undefined },
  checklist: { skill: 'speckit-checklist', argKey: 'checklistDomain' },
  analyze: { skill: 'speckit-analyze', argKey: undefined },
  implement: { skill: 'speckit-implement', argKey: undefined },
  orchestrate: { skill: 'aidlc-orchestrate', argKey: undefined },
  verify: { skill: 'aidlc-verify', argKey: undefined },
  taskstoissues: { skill: 'speckit-taskstoissues', argKey: undefined },
} as const

export const DEFAULT_STAGES: StageName[] = ['init', 'specify', 'plan', 'tasks', 'testplan', 'parallelize', 'analyze']
export const REVIEW_STAGES: StageName[] = ['specify', 'plan', 'tasks', 'testplan', 'implement', 'orchestrate', 'verify']
export const FEATURE_BRANCH_STAGES: StageName[] = ['clarify', 'plan', 'tasks', 'testplan', 'parallelize', 'analyze', 'implement', 'orchestrate', 'verify', 'checklist', 'taskstoissues']
export const QUESTION_PATTERN = /(##\s*Question\s+\d+|Your choice:|Wait for user response|Please respond|\[NEEDS CLARIFICATION:)/i
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export type StageName = keyof typeof STAGE_DEFINITIONS
export type ThinkingLevel = NonNullable<CreateAgentSessionOptions['thinkingLevel']>
export type PauseKind = 'clarification' | 'review'

export interface ParallelSubAgentResult {
  workstream: string
  outputFile: string
  summary: string
  log: string
  runtimeMs: number
  estimatedTokens: number
  /** Set when the agent failed (provider error, thrown exception, or no output). */
  error?: string
  /** Branch the workstream was delivered on (GitHub-hosted repos). */
  branch?: string
  /** Pull request opened/updated for this workstream (GitHub-hosted repos). */
  pullRequestUrl?: string
  /** Branch this workstream's PR targets; another workstream's branch when stacked. */
  baseBranch?: string
}

export interface ParallelSubAgentProgressEvent {
  type: 'job_start' | 'workstream_start' | 'workstream_update' | 'workstream_complete' | 'workstream_error' | 'job_complete' | 'job_error'
  featureDir?: string
  workstream?: string
  outputFile?: string
  summary?: string
  log?: string
  runtimeMs?: number
  estimatedTokens?: number
  error?: string
  branch?: string
  pullRequestUrl?: string
  baseBranch?: string
  results?: ParallelSubAgentResult[]
}

export interface FlowOptions {
  cwd: string
  feature?: string
  constitution?: string
  planContext?: string
  checklistDomain?: string
  model?: string
  thinking?: ThinkingLevel
  projectMemory?: string
  sharedContextPrompt?: string
  persistSession?: boolean
  nonInteractive?: boolean
  verbose?: boolean
  reviewHarness?: boolean
  humanInLoop?: boolean
  reviewStagesOverride?: ReadonlySet<StageName>
  humanGateStagesOverride?: ReadonlySet<StageName>
  stepNavigator?: StepNavigator
  /** When true, all human gates auto-approve (used by project autonomous mode). */
  autonomousMode?: boolean
  /** Pre-built SessionManager to reuse (from the warm agent pool). Bypasses ensureSession's default create/inMemory. */
  sessionManagerFactory?: () => Promise<import('@earendil-works/pi-coding-agent').SessionManager>
  /** Per-stage model override. Returns undefined → use run-level model. */
  stepModel?: (ctx: { stageIndex: number; stage: StageName }) => { model?: string; thinking?: ThinkingLevel } | undefined | Promise<{ model?: string; thinking?: ThinkingLevel } | undefined>
  /**
   * Called after each stage's prompt fully returns, with the raw assistant output.
   * PipelineEngine uses this to build a cross-stage handoff thread that preserves
   * context across model boundaries.
   */
  afterStageComplete?: (ctx: { stageIndex: number; stage: StageName; output: string; model?: string }) => Promise<void> | void
  /**
   * Called just before each stage's prompt is sent. Returns a preamble to
   * prepend to the stage prompt (empty string = no injection). Used by
   * PipelineEngine to inject role-specific persona system prompts.
   */
  beforeStagePrompt?: (ctx: { stageIndex: number; stage: StageName }) => Promise<string> | string
  /**
   * Begin at this stage instead of the first one. Used to rerun/resume a run
   * from the stage where it failed or was interrupted; earlier stages' artifacts
   * are expected to already exist on disk.
   */
  startStage?: StageName
  /** Owning project; scopes the knowledge tools (which integrations/repos agents may query). */
  projectId?: string
  /**
   * Set when the target repo is GitHub-hosted: after implement/orchestrate/verify
   * the flow commits, pushes the feature branch and opens/updates a pull request
   * against `baseBranch` (default: the repo's default branch).
   */
  pullRequests?: { githubRepo: string; baseBranch?: string }
}

/** Stages after which the feature branch is published as a pull request. */
export const PULL_REQUEST_STAGES: StageName[] = ['implement', 'orchestrate', 'verify']

export interface StepNavigatorContext {
  currentIndex: number
  stage: StageName
  stages: StageName[]
}

export interface StepNavigatorResult {
  /**
   * Index to run next. Return >= stages.length (after any extendStages) to end the flow.
   * If omitted, defaults to currentIndex + 1.
   */
  nextIndex?: number
  /**
   * Stages to append to the flow's stages array before jumping. Enables loops.
   */
  extendStages?: StageName[]
}

export type StepNavigator = (ctx: StepNavigatorContext) => Promise<StepNavigatorResult> | StepNavigatorResult

export interface FlowProgress {
  status: 'paused' | 'completed'
  stage?: StageName
  pauseKind?: PauseKind
  log: string
  sessionFile?: string
}

export interface DryRunStage {
  stage: StageName
  skillPath: string
  argument: string
}

export interface DryRunPlan {
  cwd: string
  stages: StageName[]
  stageDetails: DryRunStage[]
  reviewStages: StageName[]
  reviewHarness: boolean
  humanInLoop: boolean
}

interface OutputSinks {
  stdout?: (chunk: string) => void
  stderr?: (chunk: string) => void
}

interface WaitState {
  kind: PauseKind
  stage: StageName
}

export class AIDLCFlow {
  private readonly options: Required<Pick<FlowOptions, 'persistSession' | 'nonInteractive' | 'verbose' | 'reviewHarness' | 'humanInLoop'>> & Omit<FlowOptions, 'persistSession' | 'nonInteractive' | 'verbose' | 'reviewHarness' | 'humanInLoop'>
  private readonly stages: StageName[]  // Mutable to support template loop-back via stepNavigator.extendStages.
  private readonly sinks: OutputSinks
  private readonly speckitRoot: string
  private readonly modelRuntimePromise: Promise<ModelRuntime>
  private session?: AgentSession
  private currentModelSpec?: string
  private stageIndex = 0
  private waitState?: WaitState
  private log = ''
  private sessionFile?: string
  private activeFeatureBranch?: string

  constructor(options: FlowOptions, stages: StageName[], sinks: OutputSinks = {}) {
    validateStageInputs(stages, options)
    this.options = {
      ...options,
      cwd: resolveCwd(options.cwd),
      persistSession: options.persistSession ?? false,
      nonInteractive: options.nonInteractive ?? false,
      verbose: options.verbose ?? false,
      reviewHarness: options.reviewHarness ?? true,
      humanInLoop: options.humanInLoop ?? true,
    }
    this.stages = stages
    this.sinks = sinks
    this.speckitRoot = resolveSpeckitRoot()
    this.modelRuntimePromise = createConfiguredModelRuntime()
    if (options.startStage) {
      const idx = stages.indexOf(options.startStage)
      if (idx > 0) this.stageIndex = idx
    }
  }

  async start(): Promise<FlowProgress> {
    await this.ensureSession()
    this.print(`Starting AIDLC flow in ${this.options.cwd}\n`)
    if (this.options.model) {
      this.print(`Model: ${this.options.model}${this.options.thinking ? ` (${this.options.thinking})` : ''}\n`)
    }
    if (this.options.reviewHarness) {
      this.print(`Review harness enabled for: ${REVIEW_STAGES.filter((stage) => this.stages.includes(stage)).join(', ') || 'none'}\n`)
      this.print(`Human-in-loop approvals: ${this.options.humanInLoop ? 'enabled' : 'disabled'}\n`)
    }
    if (this.options.sharedContextPrompt?.trim()) {
      this.print('Loaded shared context layer for this run.\n')
    } else if (this.options.projectMemory?.trim()) {
      this.print('Loaded project long-term memory for this run.\n')
    }
    if (this.stageIndex > 0) {
      this.print(`Resuming from stage ${this.stageIndex + 1}/${this.stages.length}: ${this.stages[this.stageIndex]} (earlier stages skipped; their artifacts are reused).\n`)
    }
    return this.advance()
  }

  async answer(input: string): Promise<FlowProgress> {
    if (!this.session) {
      throw new Error('Flow session has not been created yet.')
    }
    if (!this.waitState) {
      throw new Error('This flow is not waiting for input.')
    }

    const trimmed = input.trim()
    if (!trimmed) {
      throw new Error('Response cannot be empty.')
    }

    if (this.waitState.kind === 'clarification') {
      return this.handleClarificationAnswer(trimmed)
    }

    return this.handleReviewAnswer(trimmed)
  }

  async dispose(): Promise<void> {
    this.session?.dispose()
    this.session = undefined
  }

  getLog(): string {
    return this.log
  }

  /** True while the flow is paused at a clarification/review gate and can accept an answer. */
  isWaitingForInput(): boolean {
    return Boolean(this.waitState)
  }

  getCurrentStage(): StageName | undefined {
    return this.stages[this.stageIndex]
  }

  getSessionFile(): string | undefined {
    return this.sessionFile
  }

  private async ensureSession(overrideModel?: string, overrideThinking?: ThinkingLevel): Promise<void> {
    if (this.session) {
      return
    }

    const modelRuntime = await this.modelRuntimePromise
    // Per-stage override wins over run-level; falls back to run-level on resolution failure.
    const effectiveOptions: FlowOptions = overrideModel
      ? { ...this.options, model: overrideModel, ...(overrideThinking ? { thinking: overrideThinking } : {}) }
      : this.options
    let modelSelection: ReturnType<typeof resolveModelSelection>
    try {
      modelSelection = resolveModelSelection(modelRuntime, effectiveOptions)
    } catch (err) {
      // Fall back to run-level model if per-stage override can't be resolved.
      if (overrideModel) {
        this.print(`\n[model] per-stage override "${overrideModel}" unresolvable (${err instanceof Error ? err.message : err}); falling back to run-level.\n`)
        modelSelection = resolveModelSelection(modelRuntime, this.options)
      } else {
        throw err
      }
    }
    const sessionManager = this.options.sessionManagerFactory
      ? await this.options.sessionManagerFactory()
      : this.options.persistSession
        ? SessionManager.create(this.options.cwd)
        : SessionManager.inMemory(this.options.cwd)

    const { session } = await createAgentSession({
      cwd: this.options.cwd,
      modelRuntime,
      model: modelSelection.model,
      thinkingLevel: modelSelection.thinkingLevel,
      tools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'],
      // Connected integrations (Jira/Linear/Confluence/GitHub) as on-demand knowledge tools.
      customTools: await buildKnowledgeTools({ projectId: this.options.projectId }).catch(() => []),
      sessionManager,
    })

    this.session = session
    this.currentModelSpec = modelSelection.model?.id ? `${modelSelection.model.provider}/${modelSelection.model.id}` : (overrideModel ?? this.options.model)
  }

  private async maybeSwapSessionForStage(stage: StageName): Promise<void> {
    const desired = await this.options.stepModel?.({ stageIndex: this.stageIndex, stage })
    if (!desired?.model) {
      await this.ensureSession()
      return
    }
    if (this.session && this.currentModelSpec === desired.model) {
      return // already on the right model
    }
    if (this.session) {
      this.print(`\n[model] switching from ${this.currentModelSpec ?? '(default)'} → ${desired.model} for stage ${stage}\n`)
      this.session.dispose()
      this.session = undefined
    }
    await this.ensureSession(desired.model, desired.thinking)
  }

  private async advance(): Promise<FlowProgress> {
    while (this.stageIndex < this.stages.length) {
      const stage = this.stages[this.stageIndex]
      this.print(`\n=== Stage ${this.stageIndex + 1}/${this.stages.length}: ${STAGE_DEFINITIONS[stage].skill} ===\n\n`)

      const output = await this.runStage(stage)
      if (QUESTION_PATTERN.test(output)) {
        return this.pause('clarification', stage)
      }

      // Remote repos: publish the feature branch as a PR once code stages finish.
      await this.maybePublishPullRequest(stage, output)

      const reviewProgress = await this.handleStageCompletion(stage)
      if (reviewProgress) {
        return reviewProgress
      }
    }

    this.print('\nAIDLC flow complete.\n')
    this.sessionFile = this.session?.sessionFile
    if (this.sessionFile) {
      this.print(`Session saved to: ${this.sessionFile}\n`)
    }

    await this.dispose()
    return {
      status: 'completed',
      log: this.log,
      sessionFile: this.sessionFile,
    }
  }

  private async handleStageCompletion(stage: StageName): Promise<FlowProgress | undefined> {
    if (!this.shouldRunReviewGate(stage)) {
      await this.advanceToNextStep(stage)
      return undefined
    }

    return this.runReviewGate(stage)
  }

  private async advanceToNextStep(currentStage: StageName): Promise<void> {
    const navigator = this.options.stepNavigator
    if (!navigator) {
      this.stageIndex += 1
      return
    }

    const result = await navigator({
      currentIndex: this.stageIndex,
      stage: currentStage,
      stages: [...this.stages],
    })

    if (result.extendStages && result.extendStages.length > 0) {
      this.stages.push(...result.extendStages)
    }

    this.stageIndex = result.nextIndex ?? this.stageIndex + 1
  }

  private async handleClarificationAnswer(answer: string): Promise<FlowProgress> {
    const stage = this.waitState?.stage
    if (!stage) {
      throw new Error('Missing clarification stage.')
    }

    const output = await this.streamPrompt(answer)
    if (QUESTION_PATTERN.test(output)) {
      return this.pause('clarification', stage)
    }

    this.waitState = undefined
    const reviewProgress = await this.handleStageCompletion(stage)
    if (reviewProgress) {
      return reviewProgress
    }

    return this.advance()
  }

  private async handleReviewAnswer(answer: string): Promise<FlowProgress> {
    const stage = this.waitState?.stage
    if (!stage) {
      throw new Error('Missing review stage.')
    }

    if (isApprovalAnswer(answer)) {
      this.print(`\nApproved review gate for ${stage}. Continuing.\n`)
      this.waitState = undefined
      await this.advanceToNextStep(stage)
      return this.advance()
    }

    this.print(`\nApplying human feedback for ${stage}: ${answer}\n`)
    const output = await this.streamPrompt(withSharedContext(buildReviewFeedbackPrompt(stage, answer), this.options))
    if (QUESTION_PATTERN.test(output)) {
      return this.pause('clarification', stage)
    }

    this.waitState = undefined
    return this.runReviewGate(stage)
  }

  private shouldRunReviewGate(stage: StageName): boolean {
    if (!this.options.reviewHarness) return false
    const override = this.options.reviewStagesOverride
    if (override) return override.has(stage)
    return REVIEW_STAGES.includes(stage)
  }

  private shouldGateOnHuman(stage: StageName): boolean {
    if (!this.options.humanInLoop) return false
    const override = this.options.humanGateStagesOverride
    if (override) return override.has(stage)
    return true
  }

  private async runReviewGate(stage: StageName): Promise<FlowProgress> {
    this.print(`\n--- Review gate after ${stage} ---\n\n`)
    const output = await this.streamPrompt(withSharedContext(buildReviewPrompt(stage), this.options))

    if (QUESTION_PATTERN.test(output)) {
      return this.pause('clarification', stage)
    }

    if (!this.shouldGateOnHuman(stage)) {
      this.print(`\nReview gate complete for ${stage}. Auto-continuing (no human gate configured for this stage).\n`)
      await this.advanceToNextStep(stage)
      return this.advance()
    }

    this.print(`\nHuman approval required for ${stage}. Reply "approve" to continue, or provide requested changes.\n`)
    return this.pause('review', stage)
  }

  private pause(kind: PauseKind, stage: StageName): FlowProgress {
    this.waitState = { kind, stage }
    return {
      status: 'paused',
      stage,
      pauseKind: kind,
      log: this.log,
      sessionFile: this.session?.sessionFile,
    }
  }

  private async runStage(stage: StageName): Promise<string> {
    await this.ensureFeatureBranchForStage(stage)
    await this.maybeSwapSessionForStage(stage)

    const skillPrompt = await loadStagePrompt({
      speckitRoot: this.speckitRoot,
      stage,
      stageArgument: getStageArgument(stage, this.options),
    })

    const preamble = this.options.beforeStagePrompt
      ? (await this.options.beforeStagePrompt({ stageIndex: this.stageIndex, stage })).trim()
      : ''
    const prompt = preamble ? `${preamble}\n\n---\n\n${skillPrompt}` : skillPrompt

    const output = await this.streamPrompt(withSharedContext(prompt, this.options))
    this.captureActiveFeatureBranch()

    // Notify PipelineEngine so it can capture handoff for downstream stages.
    if (this.options.afterStageComplete) {
      try {
        await this.options.afterStageComplete({
          stageIndex: this.stageIndex,
          stage,
          output,
          model: this.currentModelSpec,
        })
      } catch (err) {
        this.error(`[handoff] afterStageComplete threw: ${err instanceof Error ? err.message : err}\n`)
      }
    }

    return output
  }

  /**
   * After implement/orchestrate/verify on a GitHub-hosted repo: commit the
   * agent's changes on the feature branch, push, and open or update the PR.
   * PR plumbing never fails the stage — problems are printed to the run log.
   */
  private async maybePublishPullRequest(stage: StageName, output: string): Promise<void> {
    const pr = this.options.pullRequests
    if (!pr || !PULL_REQUEST_STAGES.includes(stage)) return

    const branch = getCurrentGitBranch(this.options.cwd)
    if (!branch || !isFeatureBranchName(branch)) {
      this.print(`\n[pr] Skipped: ${branch ? `"${branch}" is not a feature branch` : 'detached HEAD'}; nothing published.\n`)
      return
    }

    try {
      const base = pr.baseBranch ?? await gitDefaultBranch(this.options.cwd, pr.githubRepo)
      const featureDirAbs = await findLatestFeatureDirAbsolute(this.options.cwd)
      const featureDirRel = featureDirAbs ? path.relative(this.options.cwd, featureDirAbs) : undefined
      const specTitle = featureDirAbs ? await readSpecTitle(featureDirAbs) : undefined
      const artifacts = featureDirAbs
        ? (await Promise.all(['spec.md', 'plan.md', 'tasks.md', 'test-plan.md', 'parallel-workstreams.md', 'merge-orchestrator.md', 'verification-report.md']
            .map(async (f) => (await pathExistsAsync(path.join(featureDirAbs, f))) ? `${featureDirRel}/${f}` : undefined)))
            .filter((f): f is string => Boolean(f))
        : []
      const tail = output.trim().split('\n').slice(-25).join('\n').slice(-1500)
      const ref = await publishBranchAsPullRequest({
        cwd: this.options.cwd,
        githubRepo: pr.githubRepo,
        branch,
        base,
        commitMessage: `${stage}: ${specTitle ?? branch}\n\nGenerated by the AIDLC pipeline (${stage} stage).`,
        title: specTitle ? `${specTitle} (${branch})` : branch,
        body: pullRequestBody({
          summary: `Feature \`${branch}\` implemented by the AIDLC pipeline. Latest completed stage: **${stage}**.\n\n<details><summary>Agent summary from the ${stage} stage</summary>\n\n${tail}\n\n</details>`,
          featureDir: featureDirRel,
          artifacts,
        }),
      })
      if (!ref) {
        this.print(`\n[pr] Nothing new to publish after ${stage} (branch ${branch} has no commits ahead of ${base}).\n`)
        return
      }
      this.print(`\n[pr] ${ref.created ? 'Opened' : 'Updated'} pull request #${ref.number}: ${ref.url} (${branch} → ${base})\n`)
      if (stage === 'verify') {
        const status = await readVerificationStatus(this.options.cwd)
        await commentOnPullRequest(pr.githubRepo, ref.number, `**Verification: ${(status ?? 'unknown').toUpperCase()}** — see \`${featureDirRel ?? 'specs/<feature>'}/verification-report.md\` for the requirement-by-requirement table and test results.`)
      }
    } catch (error) {
      this.print(`\n[pr] Failed to publish pull request: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }

  private async ensureFeatureBranchForStage(stage: StageName): Promise<void> {
    if (!FEATURE_BRANCH_STAGES.includes(stage)) {
      this.captureActiveFeatureBranch()
      return
    }

    const currentBranch = getCurrentGitBranch(this.options.cwd)
    if (currentBranch && isFeatureBranchName(currentBranch)) {
      this.activeFeatureBranch = currentBranch
      return
    }

    const candidateBranch = this.activeFeatureBranch && branchExists(this.options.cwd, this.activeFeatureBranch)
      ? this.activeFeatureBranch
      : inferLatestFeatureBranch(this.options.cwd)

    if (!candidateBranch) {
      return
    }

    checkoutBranch(this.options.cwd, candidateBranch)
    this.activeFeatureBranch = candidateBranch
    this.print(`Auto-checked out feature branch ${candidateBranch} for ${stage}.\n`)
  }

  private captureActiveFeatureBranch(): void {
    const currentBranch = getCurrentGitBranch(this.options.cwd)
    if (currentBranch && isFeatureBranchName(currentBranch)) {
      this.activeFeatureBranch = currentBranch
    }
  }

  private async streamPrompt(prompt: string): Promise<string> {
    if (!this.session) {
      throw new Error('Flow session has not been created yet.')
    }

    let assistantOutput = ''
    let providerError: string | undefined
    const verbose = this.options.verbose === true

    const unsubscribe = this.session.subscribe((event) => {
      if (event.type === 'message_update') {
        if (event.assistantMessageEvent.type === 'text_delta') {
          assistantOutput += event.assistantMessageEvent.delta
          this.print(event.assistantMessageEvent.delta)
        }

        if (verbose && event.assistantMessageEvent.type === 'thinking_delta') {
          this.error(event.assistantMessageEvent.delta)
        }
      }

      if (event.type === 'agent_end') {
        const lastMessage = (event as { messages?: Array<{ stopReason?: string; errorMessage?: string }> }).messages?.slice(-1)[0]
        if (lastMessage?.stopReason === 'error' && lastMessage.errorMessage) {
          providerError = lastMessage.errorMessage.trim()
        }
      }

      if (!verbose) {
        return
      }

      if (event.type === 'tool_execution_start') {
        this.error(`\n[tool:start] ${event.toolName}\n`)
      }

      if (event.type === 'tool_execution_end') {
        this.error(`\n[tool:end] ${event.toolName} (${event.isError ? 'error' : 'ok'})\n`)
      }
    })

    try {
      await this.session.prompt(prompt, { expandPromptTemplates: false })
    } finally {
      unsubscribe()
    }

    if (providerError) {
      throw new Error(`LLM provider error: ${humanizeProviderError(providerError)}`)
    }

    if (assistantOutput && !assistantOutput.endsWith('\n')) {
      this.print('\n')
    }

    return assistantOutput
  }

  private print(text: string): void {
    this.log += text
    this.sinks.stdout?.(text)
  }

  private error(text: string): void {
    this.log += text
    this.sinks.stderr?.(text)
  }
}

export function parseStages(rawStages: string): StageName[] {
  const stages = rawStages
    .split(',')
    .map((stage) => stage.trim().toLowerCase())
    .filter(Boolean) as StageName[]

  if (stages.length === 0) {
    throw new Error('No stages were provided.')
  }

  for (const stage of stages) {
    if (!(stage in STAGE_DEFINITIONS)) {
      throw new Error(`Unknown stage "${stage}". Valid stages: ${Object.keys(STAGE_DEFINITIONS).join(', ')}`)
    }
  }

  return stages
}

export function buildDefaultStages(options: {
  withConstitution?: boolean
  withClarify?: boolean
  withImplement?: boolean
}): StageName[] {
  const stages = [...DEFAULT_STAGES]

  if (options.withConstitution) {
    stages.splice(1, 0, 'constitution')
  }

  if (options.withClarify) {
    stages.splice(stages.indexOf('specify') + 1, 0, 'clarify')
  }

  if (options.withImplement) {
    stages.push('implement', 'orchestrate', 'verify')
  }

  return stages
}

export function validateStageInputs(stages: StageName[], options: FlowOptions): void {
  if (stages.includes('specify') && !options.feature) {
    throw new Error('The specify stage requires --feature.')
  }

  if (stages.includes('constitution') && !options.constitution) {
    throw new Error('The constitution stage requires --constitution.')
  }

  if (stages.includes('checklist') && !options.checklistDomain) {
    throw new Error('The checklist stage requires --checklist-domain.')
  }
}

export function resolveCwd(cwd?: string): string {
  const base = cwd ? path.resolve(cwd) : process.cwd()
  const gitRoot = detectGitRoot(base)
  return gitRoot ?? base
}

export function normalizeThinkingLevel(value?: string): ThinkingLevel | undefined {
  if (!value) {
    return undefined
  }

  const normalized = value.toLowerCase() as ThinkingLevel
  if (!THINKING_LEVELS.includes(normalized)) {
    throw new Error(`Invalid thinking level "${value}". Use one of: ${THINKING_LEVELS.join(', ')}`)
  }

  return normalized
}

export function getDryRunPlan(options: FlowOptions, stages: StageName[]): DryRunPlan {
  const cwd = resolveCwd(options.cwd)
  const speckitRoot = resolveSpeckitRoot()
  const reviewHarness = options.reviewHarness ?? true
  const humanInLoop = options.humanInLoop ?? true

  return {
    cwd,
    stages,
    stageDetails: stages.map((stage) => ({
      stage,
      skillPath: getSkillPath(speckitRoot, stage),
      argument: getStageArgument(stage, options),
    })),
    reviewStages: reviewHarness ? REVIEW_STAGES.filter((stage) => stages.includes(stage)) : [],
    reviewHarness,
    humanInLoop,
  }
}

function detectGitRoot(cwd: string): string | null {
  try {
    const root = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return root || null
  } catch {
    return null
  }
}

function getCurrentGitBranch(cwd: string): string | null {
  try {
    const branch = execFileSync('git', ['-C', cwd, 'branch', '--show-current'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return branch || null
  } catch {
    return null
  }
}

function branchExists(cwd: string, branch: string): boolean {
  try {
    execFileSync('git', ['-C', cwd, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
}

function checkoutBranch(cwd: string, branch: string): void {
  execFileSync('git', ['-C', cwd, 'checkout', branch], {
    stdio: ['ignore', 'ignore', 'ignore'],
  })
}

function inferLatestFeatureBranch(cwd: string): string | null {
  try {
    const output = execFileSync('git', ['-C', cwd, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })

    const branches = output
      .split('\n')
      .map((branch) => branch.trim())
      .filter((branch) => isFeatureBranchName(branch))
      .sort(compareFeatureBranchesDescending)

    return branches[0] ?? null
  } catch {
    return null
  }
}

function isFeatureBranchName(branch: string): boolean {
  return /^\d+-[a-z0-9][a-z0-9-]*$/i.test(branch)
}

function compareFeatureBranchesDescending(a: string, b: string): number {
  const aNum = Number.parseInt(a.split('-')[0] ?? '0', 10)
  const bNum = Number.parseInt(b.split('-')[0] ?? '0', 10)
  if (aNum !== bNum) {
    return bNum - aNum
  }
  return b.localeCompare(a)
}

export function resolveSpeckitRoot(): string {
  const packageJsonPath = require.resolve('@the-agency/pi-spec-kit/package.json')
  return path.dirname(packageJsonPath)
}

function getSkillPath(speckitRoot: string, stage: StageName): string {
  return path.join(speckitRoot, 'skills', STAGE_DEFINITIONS[stage].skill, 'SKILL.md')
}

function getStageArgument(stage: StageName, options: FlowOptions): string {
  const argKey = STAGE_DEFINITIONS[stage].argKey
  if (!argKey) {
    return ''
  }

  return options[argKey] ?? ''
}

/**
 * Create a ModelRuntime with env-provided credentials injected. Every code path
 * that spins up an agent session (the main flow, assistant chat, task/workstream
 * runners, parallel sub-agents) must go through this so they all authenticate
 * the same way. If ANTHROPIC_API_KEY / OPENAI_API_KEY are set (from .env or the
 * shell), they override any stored OAuth token for that provider.
 */
async function createConfiguredModelRuntime(): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create()
  if (process.env.ANTHROPIC_API_KEY) {
    await runtime.setRuntimeApiKey('anthropic', process.env.ANTHROPIC_API_KEY)
  }
  if (process.env.OPENAI_API_KEY) {
    await runtime.setRuntimeApiKey('openai', process.env.OPENAI_API_KEY)
  }
  return runtime
}

function resolveModelSelection(modelRuntime: ModelRuntime, options: FlowOptions) {
  if (!options.model) {
    return { model: undefined, thinkingLevel: options.thinking }
  }

  const result = resolveCliModel({
    cliModel: options.model,
    cliThinking: options.thinking,
    modelRuntime,
  })

  if (result.error) {
    throw new Error(result.error)
  }

  if (result.warning) {
    aidlcLog.warn('model warning', { warning: result.warning })
  }

  return {
    model: result.model,
    thinkingLevel: result.thinkingLevel,
  }
}

/**
 * Extract the human message from a provider error string. Providers often
 * return raw JSON in the error body — HTTP 429 with "monthly spend limit
 * exceeded" is technically a rate-limit shape but a very different meaning.
 */
function humanizeProviderError(raw: string): string {
  const trimmed = raw.trim()
  const jsonStart = trimmed.indexOf('{')
  if (jsonStart < 0) return trimmed
  const prefix = trimmed.slice(0, jsonStart).trim() // e.g. "429"
  try {
    const parsed = JSON.parse(trimmed.slice(jsonStart)) as {
      error?: { message?: string; type?: string }
      request_id?: string
    }
    const message = parsed.error?.message
    const type = parsed.error?.type
    if (message) {
      const hint = /monthly spend limit/i.test(message)
        ? ' — increase your cap in the Anthropic Console → Settings → Billing → Usage limits.'
        : ''
      return `${prefix ? `${prefix} ` : ''}${type ? `[${type}] ` : ''}${message}${hint}`
    }
  } catch { /* fall through to raw */ }
  return trimmed
}

function isApprovalAnswer(answer: string): boolean {
  return /^(approve|approved|continue|ok|okay|yes|y)$/i.test(answer.trim())
}

function buildReviewPrompt(stage: StageName): string {
  const scope = getReviewScope(stage)

  return `Review the outputs produced by the ${STAGE_DEFINITIONS[stage].skill} stage in the current repository.
Use the available tools to inspect the generated repo artifacts before responding.

Focus on ${scope}.

Return a concise review with these sections:
1. Summary
2. Findings
3. Recommended changes before moving on
4. Decision support for the human reviewer

Do not ask the human to repeat context they already supplied unless it is strictly necessary.`
}

function buildReviewFeedbackPrompt(stage: StageName, feedback: string): string {
  return `A human reviewer gave feedback after ${STAGE_DEFINITIONS[stage].skill}:

${feedback}

Apply the requested changes in the repository artifacts for this stage, then summarize what changed and what still needs review.`
}

function withSharedContext(prompt: string, options: Pick<FlowOptions, 'sharedContextPrompt' | 'projectMemory'>): string {
  if (options.sharedContextPrompt?.trim()) {
    return `${options.sharedContextPrompt.trim()}\n\n---\n\n${prompt}`
  }

  if (options.projectMemory?.trim()) {
    return `Project long-term memory:\n${options.projectMemory.trim()}\n\n---\n\n${prompt}`
  }

  return prompt
}

function getReviewScope(stage: StageName): string {
  switch (stage) {
    case 'specify':
      return 'spec quality, assumptions, success criteria, edge cases, and readiness for planning'
    case 'plan':
      return 'technical plan quality, research completeness, contract and data-model coverage, and readiness for task generation'
    case 'tasks':
      return 'task completeness, execution order, traceability to stories, and readiness for implementation'
    case 'testplan':
      return 'test strategy quality, acceptance coverage, automation priorities, and QA readiness'
    case 'implement':
      return 'implementation completeness, test and verification coverage, and release readiness'
    case 'verify':
      return 'verification evidence, QA findings, unresolved risks, and release readiness'
    default:
      return 'quality and readiness for the next AIDLC step'
  }
}

export async function runAIDLCAssistantChat(options: {
  cwd: string
  message: string
  model?: string
  thinking?: ThinkingLevel
  sharedContextPrompt?: string
}): Promise<string> {
  const modelRuntime = await createConfiguredModelRuntime()
  const modelSelection = resolveModelSelection(modelRuntime, {
    cwd: options.cwd,
    model: options.model,
    thinking: options.thinking,
  })

  const { session } = await createAgentSession({
    cwd: resolveCwd(options.cwd),
    modelRuntime,
    model: modelSelection.model,
    thinkingLevel: modelSelection.thinkingLevel,
    tools: ['read', 'bash', 'grep', 'find', 'ls'],
    customTools: await buildKnowledgeTools().catch(() => []),
    sessionManager: SessionManager.inMemory(options.cwd),
  })

  let output = ''
  let providerError: string | undefined
  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      output += event.assistantMessageEvent.delta
    }
    // Catch LLM provider errors (rate limits, credit exhaustion, invalid key,
    // etc.). Without this the chat would silently return an empty string.
    if (event.type === 'agent_end') {
      const lastMessage = (event as { messages?: Array<{ stopReason?: string; errorMessage?: string }> }).messages?.slice(-1)[0]
      if (lastMessage?.stopReason === 'error' && lastMessage.errorMessage) {
        providerError = lastMessage.errorMessage.trim()
      }
    }
  })

  try {
    await session.prompt(
      withSharedContext(
        `Answer the following user question about this project, its artifacts, or its AI-assisted delivery history.\n\nRequirements:\n- Cite the most relevant artifact names or stage names explicitly when possible.\n- When the answer depends on an artifact, include a short quoted excerpt or snippet from that artifact.\n- If evidence is missing, say so clearly.\n\nUser question: ${options.message}`,
        { sharedContextPrompt: options.sharedContextPrompt },
      ),
      { expandPromptTemplates: false },
    )
    if (providerError) throw new Error(`LLM provider error: ${providerError}`)
    return output.trim()
  } finally {
    unsubscribe()
    session.dispose()
  }
}

/**
 * Read-only exploration of a freshly registered codebase. Produces the
 * project's auto-summary memory (purpose, architecture, build/test commands,
 * conventions, risks) that every later stage receives via the context bundle.
 * Provider failures are surfaced as thrown errors instead of an empty string.
 */
export async function summarizeCodebaseForMemory(options: {
  cwd: string
  model?: string
  thinking?: ThinkingLevel
  inventory: string
  projectName: string
  onProgress?: (chunk: string) => void
}): Promise<string> {
  const cwd = resolveCwd(options.cwd)
  const modelRuntime = await createConfiguredModelRuntime()
  const modelSelection = resolveModelSelection(modelRuntime, { cwd, model: options.model, thinking: options.thinking })

  const { session } = await createAgentSession({
    cwd,
    modelRuntime,
    model: modelSelection.model,
    thinkingLevel: modelSelection.thinkingLevel,
    tools: ['read', 'grep', 'find', 'ls'],
    sessionManager: SessionManager.inMemory(cwd),
  })

  let output = ''
  let providerError: string | undefined
  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      output += event.assistantMessageEvent.delta
      options.onProgress?.(event.assistantMessageEvent.delta)
    }
    if (event.type === 'agent_end') {
      const lastMessage = (event as { messages?: Array<{ stopReason?: string; errorMessage?: string }> }).messages?.slice(-1)[0]
      if (lastMessage?.stopReason === 'error' && lastMessage.errorMessage) {
        providerError = lastMessage.errorMessage.trim()
      }
    }
  })

  try {
    await session.prompt(
      `You are onboarding onto the project "${options.projectName}" so future AI delivery stages start with real context. Explore the repository (read-only) and write a project brief in Markdown.

A filesystem inventory has already been gathered for you:

${options.inventory}

Use it to decide what to open. Read the README, entry points, package/build manifests, CI config, and a few representative modules. Do not read every file.

Write the brief with exactly these sections:
## Purpose
## Architecture & key modules
## Tech stack & tooling
## Build, run & test commands
## Conventions & patterns
## Risks, gaps & open questions

Rules: be concrete (name real files, commands, and modules), keep it under 600 words, no preamble, output only the Markdown brief.`,
      { expandPromptTemplates: false },
    )
  } finally {
    unsubscribe()
    session.dispose()
  }

  if (providerError) {
    throw new Error(`LLM provider error: ${humanizeProviderError(providerError)}`)
  }
  if (!output.trim()) {
    throw new Error('Codebase summary agent produced no output.')
  }
  // Agents narrate between tool calls ("Now let me check…"); keep only the brief,
  // which starts at its first required heading.
  const start = output.search(/^## Purpose/m)
  const brief = start >= 0 ? output.slice(start) : output.slice(Math.max(0, output.search(/^## /m)))
  return brief.trim()
}

export async function runAIDLCMergeOrchestrator(options: {
  cwd: string
  model?: string
  thinking?: ThinkingLevel
  sharedContextPrompt?: string
}): Promise<{ featureDir: string; outputFile: string; summary: string; log: string }> {
  const cwd = resolveCwd(options.cwd)
  const featureDir = await findLatestFeatureDirAbsolute(cwd)
  if (!featureDir) {
    throw new Error('No active feature directory found for orchestrator.')
  }

  const outputFile = path.join(featureDir, 'merge-orchestrator.md')
  const modelRuntime = await createConfiguredModelRuntime()
  const modelSelection = resolveModelSelection(modelRuntime, { cwd, model: options.model, thinking: options.thinking })
  const { session } = await createAgentSession({
    cwd,
    modelRuntime,
    model: modelSelection.model,
    thinkingLevel: modelSelection.thinkingLevel,
    tools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'],
    sessionManager: SessionManager.inMemory(cwd),
  })

  let log = ''
  let providerError: string | undefined
  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      log += event.assistantMessageEvent.delta
    }
    if (event.type === 'agent_end') {
      const lastMessage = (event as { messages?: Array<{ stopReason?: string; errorMessage?: string }> }).messages?.slice(-1)[0]
      if (lastMessage?.stopReason === 'error' && lastMessage.errorMessage) {
        providerError = lastMessage.errorMessage.trim()
      }
    }
  })

  try {
    await session.prompt(
      withSharedContext(
        `You are the merge and verification orchestrator for the active feature.\n\nYour job:\n1. Read parallel-workstreams.md, test-plan.md, and all sub-agent reports.\n2. Reconcile integration issues across completed workstreams.\n3. Make any safe edits needed to align code/tests across workstreams.\n4. Write ${outputFile} with merge status, reconciliations, conflicts, and verification readiness.\n5. If project checks can be run safely, run them and record the results in the report.`,
        { sharedContextPrompt: options.sharedContextPrompt },
      ),
      { expandPromptTemplates: false },
    )
    if (providerError) throw new Error(`LLM provider error: ${providerError}`)

    return {
      featureDir,
      outputFile,
      summary: log.trim().split('\n').slice(-3).join(' ').trim() || 'Orchestration complete',
      log: log.trim(),
    }
  } finally {
    unsubscribe()
    session.dispose()
  }
}

export async function runAIDLCSpecificTask(options: {
  cwd: string
  taskId: string
  sharedContextPrompt?: string
  model?: string
  thinking?: ThinkingLevel
}): Promise<{ featureDir: string; outputFile: string; summary: string; log: string }> {
  const cwd = resolveCwd(options.cwd)
  const featureDir = await findLatestFeatureDirAbsolute(cwd)
  if (!featureDir) {
    throw new Error('No active feature directory found for task execution.')
  }

  const tasksMarkdown = await readFile(path.join(featureDir, 'tasks.md'), 'utf8')
  const taskLine = tasksMarkdown
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.includes(options.taskId))

  if (!taskLine) {
    throw new Error(`Task ${options.taskId} not found in tasks.md.`)
  }

  const outputDir = path.join(featureDir, 'task-runs')
  await mkdir(outputDir, { recursive: true })
  const outputFile = path.join(outputDir, `${options.taskId.toLowerCase()}.md`)

  const modelRuntime = await createConfiguredModelRuntime()
  const modelSelection = resolveModelSelection(modelRuntime, { cwd, model: options.model, thinking: options.thinking })
  const { session } = await createAgentSession({
    cwd,
    modelRuntime,
    model: modelSelection.model,
    thinkingLevel: modelSelection.thinkingLevel,
    tools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'],
    sessionManager: SessionManager.inMemory(cwd),
  })

  let log = ''
  let providerError: string | undefined
  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      log += event.assistantMessageEvent.delta
    }
    if (event.type === 'agent_end') {
      const lastMessage = (event as { messages?: Array<{ stopReason?: string; errorMessage?: string }> }).messages?.slice(-1)[0]
      if (lastMessage?.stopReason === 'error' && lastMessage.errorMessage) {
        providerError = lastMessage.errorMessage.trim()
      }
    }
  })

  try {
    await session.prompt(
      withSharedContext(
        `You are executing one task only.\n\nTask ID: ${options.taskId}\nTask line: ${taskLine}\n\nYour job:\n1. Implement this task in the repository.\n2. Update or add tests where appropriate.\n3. Write a task execution report to ${outputFile} summarizing files changed, tests, risks, and follow-ups.\n4. Do not drift into unrelated tasks.`,
        { sharedContextPrompt: options.sharedContextPrompt },
      ),
      { expandPromptTemplates: false },
    )
    if (providerError) throw new Error(`LLM provider error: ${providerError}`)

    return {
      featureDir,
      outputFile,
      summary: log.trim().split('\n').slice(-3).join(' ').trim() || `Task ${options.taskId} executed`,
      log: log.trim(),
    }
  } finally {
    unsubscribe()
    session.dispose()
  }
}

export async function runAIDLCSpecificWorkstream(options: {
  cwd: string
  taskId?: string
  workstreamTitle?: string
  sharedContextPrompt?: string
  model?: string
  thinking?: ThinkingLevel
}): Promise<{ featureDir: string; outputFile: string; summary: string; log: string }> {
  const cwd = resolveCwd(options.cwd)
  const featureDir = await findLatestFeatureDirAbsolute(cwd)
  if (!featureDir) {
    throw new Error('No active feature directory found for workstream execution.')
  }

  const workstreams = await readWorkstreams(cwd, featureDir)
  const workstream = workstreams.find((item) =>
    (options.workstreamTitle && item.title === options.workstreamTitle) ||
    (options.taskId && item.tasks.includes(options.taskId)),
  )

  if (!workstream) {
    throw new Error('No matching workstream found for the selected task.')
  }

  const outputDir = path.join(featureDir, 'subagents')
  await mkdir(outputDir, { recursive: true })
  const outputFile = path.join(outputDir, `single-${slugify(workstream.title)}.md`)

  const modelRuntime = await createConfiguredModelRuntime()
  const modelSelection = resolveModelSelection(modelRuntime, { cwd, model: options.model, thinking: options.thinking })
  const { session } = await createAgentSession({
    cwd,
    modelRuntime,
    model: modelSelection.model,
    thinkingLevel: modelSelection.thinkingLevel,
    tools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'],
    sessionManager: SessionManager.inMemory(cwd),
  })

  let log = ''
  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      log += event.assistantMessageEvent.delta
    }
  })

  try {
    await session.prompt(
      withSharedContext(
        `You are executing one approved implementation workstream only.\n\nWorkstream: ${workstream.title}\n\nTasks:\n${workstream.tasks}\n\nScoped Files:\n${workstream.scopedFiles}\n\nQA Focus:\n${workstream.qaFocus}\n\nYour job:\n1. Implement only this workstream.\n2. Add/update tests needed for this workstream.\n3. Write a workstream report to ${outputFile}.\n4. Do not modify unrelated workstreams.`,
        { sharedContextPrompt: options.sharedContextPrompt },
      ),
      { expandPromptTemplates: false },
    )

    return {
      featureDir,
      outputFile,
      summary: log.trim().split('\n').slice(-3).join(' ').trim() || `Workstream ${workstream.title} executed`,
      log: log.trim(),
    }
  } finally {
    unsubscribe()
    session.dispose()
  }
}

export async function runAIDLCParallelSubAgents(options: {
  cwd: string
  model?: string
  thinking?: ThinkingLevel
  sharedContextPrompt?: string
  maxAgents?: number
  /**
   * Registered repositories with local checkouts. A workstream whose
   * "### Repository" names one of these runs inside that checkout instead of
   * the primary repo (multi-repo projects). Reports still land in the primary
   * repo's feature directory.
   */
  repoTargets?: WorkstreamRepoTarget[]
  /** Owning project; scopes knowledge tools to the project's selected integrations/repos. */
  projectId?: string
  /**
   * Deliver each workstream on its own branch + pull request when its repo is
   * GitHub-hosted. Workstreams run in isolated git worktrees; a workstream that
   * depends on another is branched from that workstream's branch and its PR
   * targets it (stacked PRs). Dependencies are honoured by running in waves.
   */
  pullRequests?: { enabled: boolean; baseBranch?: string; draft?: boolean }
  onProgress?: (event: ParallelSubAgentProgressEvent) => void
  registerSession?: (workstream: string, session: AgentSession) => void
  unregisterSession?: (workstream: string) => void
}): Promise<{ featureDir: string; results: ParallelSubAgentResult[] }> {
  const cwd = resolveCwd(options.cwd)
  const featureDir = await findLatestFeatureDirAbsolute(cwd)
  if (!featureDir) {
    throw new Error('No active feature directory found for parallel sub-agents.')
  }

  const workstreams = await readWorkstreams(cwd, featureDir)
  if (workstreams.length === 0) {
    throw new Error('No parallel workstreams found. Generate parallel-workstreams.md first.')
  }

  const maxAgents = Math.max(1, Math.min(options.maxAgents ?? 4, workstreams.length))
  const outputDir = path.join(featureDir, 'subagents')
  options.onProgress?.({ type: 'job_start', featureDir })
  await mkdir(outputDir, { recursive: true })

  const modelRuntime = await createConfiguredModelRuntime()
  const modelSelection = resolveModelSelection(modelRuntime, {
    cwd,
    model: options.model,
    thinking: options.thinking,
  })

  const selected = workstreams.slice(0, maxAgents)
  const knowledgeTools = await buildKnowledgeTools({
    projectId: options.projectId,
    repos: (options.repoTargets ?? []).map((t) => t.githubRepo).filter((r): r is string => Boolean(r)),
  }).catch(() => [])

  // ---- Branch / PR plumbing for GitHub-hosted repos ------------------------
  const prEnabled = options.pullRequests?.enabled === true
  const featureBranch = getCurrentGitBranch(cwd)
  const featureSlug = isFeatureBranchName(featureBranch ?? '') ? featureBranch! : `aidlc/${slugForBranch(path.basename(featureDir))}`
  const branchFor = (index: number, workstream: ParsedWorkstream) => `${featureSlug}/ws-${index + 1}-${slugForBranch(workstream.title).slice(0, 30)}`
  // Which registered repo a workstream lands in (falls back to the primary checkout's repo).
  const repoFor = (workstream: ParsedWorkstream): WorkstreamRepoTarget | undefined =>
    resolveWorkstreamRepo(workstream.repository, options.repoTargets)
      ?? options.repoTargets?.find((t) => path.resolve(t.localPath) === path.resolve(cwd))
      ?? options.repoTargets?.find((t) => t.isPrimary)
  // "Workstream N" references in the Dependencies section → indices into `selected`.
  const dependenciesOf = (index: number): number[] => {
    const text = selected[index]?.dependencies ?? ''
    if (/^\s*(none|n\/a|independent|-)?\s*$/i.test(text)) return []
    const deps = new Set<number>()
    for (const match of text.matchAll(/workstream\s+(\d+)/gi)) {
      const dep = Number(match[1]) - 1
      if (dep >= 0 && dep < selected.length && dep !== index) deps.add(dep)
    }
    return [...deps]
  }
  const defaultBaseCache = new Map<string, Promise<string>>()
  const baseBranchFor = (repo: WorkstreamRepoTarget): Promise<string> => {
    if (options.pullRequests?.baseBranch) return Promise.resolve(options.pullRequests.baseBranch)
    if (!defaultBaseCache.has(repo.localPath)) defaultBaseCache.set(repo.localPath, gitDefaultBranch(repo.localPath, repo.githubRepo!))
    return defaultBaseCache.get(repo.localPath)!
  }
  const branchDelivered = new Map<number, { branch: string; repoPath: string }>()

  try {
    const runWorkstream = async (workstream: ParsedWorkstream, index: number): Promise<ParallelSubAgentResult> => {
        options.onProgress?.({ type: 'workstream_start', featureDir, workstream: workstream.title })
        const startedAt = Date.now()
        // Multi-repo: run inside the workstream's repository when it names one we know.
        const target = resolveWorkstreamRepo(workstream.repository, options.repoTargets)
        let workstreamCwd = target?.localPath ?? cwd

        // GitHub-hosted repo → isolated worktree on its own branch. Stacked on the
        // branch of the last dependency that lives in the same repo, else on base.
        const prRepo = prEnabled ? repoFor(workstream) : undefined
        let prPlan: { repo: WorkstreamRepoTarget; branch: string; base: string; stackedOn?: string } | undefined
        if (prRepo?.githubRepo) {
          const branch = branchFor(index, workstream)
          const depInSameRepo = dependenciesOf(index)
            .map((dep) => branchDelivered.get(dep))
            .filter((d): d is { branch: string; repoPath: string } => Boolean(d && path.resolve(d.repoPath) === path.resolve(prRepo.localPath)))
            .pop()
          const base = depInSameRepo?.branch
            ?? (isFeatureBranchName(featureBranch ?? '') && path.resolve(prRepo.localPath) === path.resolve(cwd) ? featureBranch! : await baseBranchFor(prRepo))
          try {
            workstreamCwd = await ensureWorktree({ repoPath: prRepo.localPath, branch, base })
            prPlan = { repo: prRepo, branch, base, stackedOn: depInSameRepo?.branch }
          } catch (error) {
            options.onProgress?.({ type: 'workstream_update', featureDir, workstream: workstream.title, summary: `Worktree setup failed (${error instanceof Error ? error.message : String(error)}); running in the shared checkout without a PR.` })
          }
        }
        const repoLine = (target
          ? `${target.label}${target.githubRepo ? ` (${target.githubRepo})` : ''} — working directory: ${workstreamCwd}`
          : workstream.repository && !/^primary$/i.test(workstream.repository)
            ? `${workstream.repository} (not a registered repository — falling back to the primary checkout at ${workstreamCwd})`
            : `primary — working directory: ${workstreamCwd}`)
          + (prPlan
            ? `\nBranch: ${prPlan.branch} (isolated git worktree, based on ${prPlan.base}${prPlan.stackedOn ? `, stacked on workstream branch ${prPlan.stackedOn}` : ''}). Do not switch branches or run git commit/push — the pipeline commits your changes and opens the pull request when you finish.`
            : '')
        const { session } = await createAgentSession({
          cwd: workstreamCwd,
          modelRuntime,
          model: modelSelection.model,
          thinkingLevel: modelSelection.thinkingLevel,
          tools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'],
          customTools: knowledgeTools,
          sessionManager: SessionManager.inMemory(workstreamCwd),
        })

        const outputFile = path.join(outputDir, `${String(index + 1).padStart(2, '0')}-${slugify(workstream.title)}.md`)
        options.registerSession?.(workstream.title, session)
        let log = ''
        let providerError: string | undefined
        let toolCalls = 0
        const unsubscribe = session.subscribe((event) => {
          if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
            log += event.assistantMessageEvent.delta
            options.onProgress?.({
              type: 'workstream_update',
              featureDir,
              workstream: workstream.title,
              outputFile,
              log,
              summary: log.trim().split('\n').slice(-2).join(' ').trim(),
              runtimeMs: Date.now() - startedAt,
              estimatedTokens: estimateTokenCount(log),
            })
          }

          if (event.type === 'tool_execution_start') {
            toolCalls += 1
          }

          // Provider failures (auth, quota, unknown model) don't throw from
          // session.prompt(); they surface as an assistant message with
          // stopReason 'error'. Without this the agent looks like it
          // "completed" in under a second with no output.
          if (event.type === 'agent_end') {
            const lastMessage = (event as { messages?: Array<{ stopReason?: string; errorMessage?: string }> }).messages?.slice(-1)[0]
            if (lastMessage?.stopReason === 'error' && lastMessage.errorMessage) {
              providerError = lastMessage.errorMessage.trim()
            }
          }
        })

        const prompt = withSharedContext(
          `You are an implementation sub-agent assigned to one approved workstream only.\n\nWorkstream: ${workstream.title}\n\nRepository: ${repoLine}\nOnly edit files inside this working directory. The Spec Kit feature directory (specs, tasks, reports) lives in the primary checkout at ${cwd}.\n\nTasks:\n${workstream.tasks || '(not specified)'}\n\nInputs:\n${workstream.inputs || '(not specified)'}\n\nOutputs:\n${workstream.outputs || '(not specified)'}\n\nDependencies:\n${workstream.dependencies || '(not specified)'}\n\nScoped Files:\n${workstream.scopedFiles || '(not specified)'}\n\nQA Focus:\n${workstream.qaFocus || '(not specified)'}\n\nYour job:\n1. Implement this workstream by editing code and tests only within the scoped area.\n2. Add or update tests that prove the workstream behavior.\n3. Avoid touching files outside the scoped area unless absolutely necessary for imports or wiring.\n4. Write a workstream report to ${outputFile} summarizing files changed, tests added, risks, and follow-ups.\n5. End with a concise status summary in chat.`,
          { sharedContextPrompt: options.sharedContextPrompt },
        )

        let outcome: ParallelSubAgentResult | undefined
        try {
          let thrown: string | undefined
          try {
            await session.prompt(prompt, { expandPromptTemplates: false })
          } catch (err) {
            thrown = err instanceof Error ? err.message : String(err)
          }

          const error = providerError
            ? `LLM provider error: ${humanizeProviderError(providerError)}`
            : thrown
              ? thrown
              : (!log.trim() && toolCalls === 0)
                ? 'Agent produced no output and made no tool calls.'
                : undefined

          const result: ParallelSubAgentResult = {
            workstream: workstream.title,
            outputFile,
            summary: error ?? (log.trim().split('\n').slice(-3).join(' ').trim() || 'Completed'),
            log: log.trim(),
            runtimeMs: Date.now() - startedAt,
            estimatedTokens: estimateTokenCount(log),
            ...(error ? { error } : {}),
          }
          options.onProgress?.({
            type: error ? 'workstream_error' : 'workstream_complete',
            featureDir,
            workstream: workstream.title,
            outputFile,
            log: result.log,
            summary: result.summary,
            runtimeMs: result.runtimeMs,
            estimatedTokens: result.estimatedTokens,
            ...(error ? { error } : {}),
          })
          outcome = result
        } finally {
          unsubscribe()
          options.unregisterSession?.(workstream.title)
          session.dispose()
        }

        // Deliver the workstream as a pull request (GitHub-hosted repos only).
        if (prPlan && outcome && !outcome.error) {
          try {
            const ref = await publishBranchAsPullRequest({
              cwd: workstreamCwd,
              githubRepo: prPlan.repo.githubRepo!,
              branch: prPlan.branch,
              base: prPlan.base,
              commitMessage: `${workstream.title}\n\nWorkstream ${index + 1} of feature ${featureSlug}, implemented by an AIDLC sub-agent.`,
              title: `${featureSlug}: ${workstream.title}`,
              body: pullRequestBody({
                summary: `Workstream **${workstream.title}** of feature \`${featureSlug}\`.\n\n${workstream.tasks ? `**Tasks**\n${workstream.tasks}\n\n` : ''}${workstream.qaFocus ? `**QA focus**\n${workstream.qaFocus}\n\n` : ''}<details><summary>Sub-agent summary</summary>\n\n${outcome.log.split('\n').slice(-20).join('\n').slice(-1500)}\n\n</details>`,
                featureDir: path.relative(cwd, featureDir),
                artifacts: [path.relative(cwd, outputFile)],
                stackedOn: prPlan.stackedOn,
                workstream: workstream.title,
              }),
              draft: options.pullRequests?.draft,
            })
            branchDelivered.set(index, { branch: prPlan.branch, repoPath: prPlan.repo.localPath })
            outcome = {
              ...outcome,
              branch: prPlan.branch,
              baseBranch: prPlan.base,
              ...(ref ? { pullRequestUrl: ref.url } : {}),
              summary: ref
                ? `${ref.created ? 'Opened' : 'Updated'} PR ${ref.url} (${prPlan.branch} → ${prPlan.base}${prPlan.stackedOn ? ', stacked' : ''}). ${outcome.summary}`
                : `No code changes to publish on ${prPlan.branch}. ${outcome.summary}`,
            }
            options.onProgress?.({
              type: 'workstream_complete',
              featureDir,
              workstream: workstream.title,
              outputFile,
              log: outcome.log,
              summary: outcome.summary,
              runtimeMs: outcome.runtimeMs,
              estimatedTokens: outcome.estimatedTokens,
              branch: prPlan.branch,
              baseBranch: prPlan.base,
              pullRequestUrl: ref?.url,
            })
          } catch (error) {
            const message = `Pull request publish failed: ${error instanceof Error ? error.message : String(error)}`
            outcome = { ...outcome, branch: prPlan.branch, baseBranch: prPlan.base, summary: `${message}. ${outcome.summary}` }
            options.onProgress?.({ type: 'workstream_update', featureDir, workstream: workstream.title, outputFile, summary: outcome.summary, branch: prPlan.branch, baseBranch: prPlan.base })
          }
        }
        return outcome!
    }

    // Dependency-aware scheduling: run every workstream whose dependencies are
    // done, in parallel; repeat until all ran. A cycle (or self-dependency) falls
    // back to running the remainder together so nothing is silently skipped.
    const done = new Map<number, ParallelSubAgentResult>()
    const pending = new Set(selected.map((_, index) => index))
    while (pending.size > 0) {
      let ready = [...pending].filter((index) => dependenciesOf(index).every((dep) => done.has(dep)))
      if (ready.length === 0) ready = [...pending]
      await Promise.all(ready.map(async (index) => {
        pending.delete(index)
        done.set(index, await runWorkstream(selected[index]!, index))
      }))
    }
    const results = selected.map((_, index) => done.get(index)!)

    const failed = results.filter((result) => result.error)
    if (failed.length > 0) {
      const detail = failed.map((result) => `${result.workstream}: ${result.error}`).join('; ')
      throw new Error(
        failed.length === results.length
          ? `All ${results.length} sub-agents failed — ${detail}`
          : `${failed.length}/${results.length} sub-agents failed — ${detail}`,
      )
    }

    options.onProgress?.({ type: 'job_complete', featureDir, results })
    return { featureDir, results }
  } catch (error) {
    options.onProgress?.({
      type: 'job_error',
      featureDir,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

interface ParsedWorkstream {
  title: string
  tasks: string
  inputs: string
  outputs: string
  dependencies: string
  qaFocus: string
  scopedFiles: string
  /** Registered repo (label or owner/name) this workstream runs in; empty → primary. */
  repository: string
}

/** A registered repository the sub-agent runner may execute inside. */
export interface WorkstreamRepoTarget {
  label: string
  githubRepo?: string
  localPath: string
  isPrimary?: boolean
}

function resolveWorkstreamRepo(repository: string, targets: WorkstreamRepoTarget[] | undefined): WorkstreamRepoTarget | undefined {
  if (!targets?.length) return undefined
  const wanted = repository.trim().toLowerCase().replace(/^`|`$/g, '')
  if (!wanted) return undefined
  return targets.find((t) => t.label.toLowerCase() === wanted)
    ?? targets.find((t) => t.githubRepo?.toLowerCase() === wanted)
    ?? targets.find((t) => t.githubRepo?.toLowerCase().split('/')[1] === wanted)
    ?? targets.find((t) => path.basename(t.localPath).toLowerCase() === wanted)
}

async function loadStagePrompt(options: {
  speckitRoot: string
  stage: StageName
  stageArgument: string
}): Promise<string> {
  if (options.stage === 'testplan') {
    return buildTestPlanPrompt()
  }

  if (options.stage === 'parallelize') {
    return buildParallelizationPrompt()
  }

  if (options.stage === 'orchestrate') {
    return buildOrchestrationPrompt()
  }

  if (options.stage === 'verify') {
    return buildVerificationPrompt()
  }

  const skillPath = getSkillPath(options.speckitRoot, options.stage)
  const rawSkill = await readFile(skillPath, 'utf8')

  const basePrompt = rawSkill
    .replaceAll('SKILL_PATH', skillPath)
    .replaceAll('$ARGUMENTS', options.stageArgument)

  if (options.stage === 'specify') {
    return `${basePrompt}\n\nAdditional AIDLC requirement:\n- Include explicit test cases or acceptance test scenarios in the specification so QA can trace requirements early.`
  }

  if (options.stage === 'plan') {
    return `${basePrompt}\n\nAdditional AIDLC requirement:\n- Include test planning as part of the implementation plan and make sure the plan prepares for generation of test-plan.md.`
  }

  return basePrompt
}

function buildTestPlanPrompt(): string {
  return `Create a comprehensive test plan for the active feature in the current repository.

Requirements:
- Resolve the active feature directory from the existing Spec Kit artifacts.
- Read spec.md, plan.md, tasks.md, and any research/data-model/contracts/quickstart docs that exist.
- Write a test plan to the active feature directory as test-plan.md.
- The document must cover:
  1. Scope and feature overview
  2. Test levels (unit, integration, e2e, regression, smoke)
  3. Acceptance criteria coverage matrix traced back to the spec
  4. Test data and environment needs
  5. Risks, gaps, and deferred verification
  6. Suggested automation priorities
- Keep it human-readable and execution-ready.
- Include a compact traceability table mapping acceptance areas to planned tests.
- End with a short summary of what was written and any uncovered risks.`
}

function buildParallelizationPrompt(): string {
  return `Create a parallel execution plan for the active feature tasks in the current repository.

Requirements:
- Resolve the active feature directory and read tasks.md plus supporting artifacts.
- Identify tasks explicitly marked [P] and any other safe parallel workstreams.
- Write parallel-workstreams.md in the active feature directory.
- The document must cover:
  1. Parallelizable tasks grouped into workstreams
  2. Proposed sub-agent assignments per workstream
  3. Inputs, outputs, dependencies, and merge checkpoints for each workstream
  4. Scoped files/tests each workstream is allowed to modify
  5. Which tasks must stay sequential
  6. QA coordination notes to avoid integration conflicts
- Use explicit sections in this exact form for machine readability:
  - ## Workstream 1: <name>
  - ### Repository
  - ### Tasks
  - ### Inputs
  - ### Outputs
  - ### Dependencies
  - ### Scoped Files
  - ### QA Focus
- "### Repository" names the single registered repository the workstream runs in, exactly as listed in the project's repository map (label or owner/name). A workstream never spans two repositories; split it instead. For single-repository projects write "primary".
- End with a concise recommendation for how many concurrent workstreams are safe.`
}

function buildOrchestrationPrompt(): string {
  return `Create a merge-and-verification orchestration report for the active feature in the current repository.

Requirements:
- Resolve the active feature directory and read tasks.md, test-plan.md, parallel-workstreams.md, subagent reports, and current implementation changes.
- If sub-agent reports mention branches or pull requests, the workstreams were delivered on separate branches (possibly stacked). Inspect them with \`git log\`/\`git diff <base>...<branch>\` and \`git worktree list\`; where safe, merge the workstream branches into the feature branch (respecting the stack order) and note which PRs remain to be merged upstream.
- Reconcile workstream outputs, identify integration conflicts, and write merge-orchestrator.md in the active feature directory.
- The report must cover:
  1. Workstreams merged or pending
  2. Integration conflicts and resolutions
  3. Shared test surfaces and regression risk
  4. Verification readiness and what verify should check next
- Where safe, update project files to reconcile obvious conflicts and improve integration readiness.
- Keep the report concise and human-reviewable.`
}

function buildVerificationPrompt(): string {
  return `Create a QA and verification report for the active feature in the current repository.

Requirements:
- Resolve the active feature directory and read spec.md, plan.md, tasks.md, test-plan.md, and any implementation artifacts that exist.
- **Actually run the tests.** Use bash to execute the project's test suite (e.g. \`go test ./...\`, \`npm test\`, \`pytest\`, \`bun test\`, whatever the project uses). Capture pass/fail counts and error output. Do NOT just review code; execute.
- Write verification-report.md in the active feature directory.
- Start the document with an exact status line: \`Verification Status: PASS\`, \`Verification Status: FAIL\`, or \`Verification Status: PARTIAL\`. Use FAIL if any acceptance test fails or is missing; PARTIAL if some acceptance criteria are unverified but nothing is actively failing; PASS only when every acceptance criterion has a passing test.
- The report must cover:
  1. Test execution: command run, pass/fail counts, duration
  2. Requirement-by-requirement verification status (traceability table: requirement id → test id → pass/fail)
  3. **Unsatisfied test cases** — a section titled exactly \`## Unsatisfied Test Cases\` containing a bulleted list. Each bullet has the form \`- [TEST_ID] <name> — <one-line reason>\`. This section MUST exist even if empty (write \`- (none)\` when nothing is unsatisfied). Downstream loop-back implementations read this section to know what to fix.
  4. Missing tests — tests the spec calls for but that are not present in the codebase
  5. Remaining defects, risks, and unknowns
  6. Release readiness recommendation
- If implementation is incomplete, clearly report that and focus on readiness gaps.
- Keep the report actionable and suitable for human review AND for a follow-up developer loop to consume.`
}

async function findLatestFeatureDirAbsolute(cwd: string): Promise<string | null> {
  const specsDir = path.join(cwd, 'specs')
  try {
    const entries = execFileSync('bash', ['-lc', `find ${shellEscape(specsDir)} -maxdepth 1 -mindepth 1 -type d -print | sort -r`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    return entries[0] ?? null
  } catch {
    return null
  }
}

async function readWorkstreams(cwd: string, featureDir: string): Promise<ParsedWorkstream[]> {
  const workstreamsPath = path.join(featureDir, 'parallel-workstreams.md')
  try {
    const markdown = await readFile(workstreamsPath, 'utf8')
    const parsed = parseWorkstreams(markdown)
    if (parsed.length > 0) {
      return parsed
    }
  } catch {
    // fall back to tasks.md parsing below
  }

  try {
    const tasks = await readFile(path.join(featureDir, 'tasks.md'), 'utf8')
    return parseParallelTasks(tasks)
  } catch {
    return []
  }
}

function parseWorkstreams(markdown: string): ParsedWorkstream[] {
  const chunks = markdown.split(/^##\s+Workstream\s+\d+:\s+/m).slice(1)
  return chunks.map((chunk) => {
    const lines = chunk.split('\n')
    const title = lines[0]?.trim() ?? 'Workstream'
    const body = lines.slice(1).join('\n')
    return {
      title,
      tasks: extractSection(body, 'Tasks'),
      inputs: extractSection(body, 'Inputs'),
      outputs: extractSection(body, 'Outputs'),
      dependencies: extractSection(body, 'Dependencies'),
      qaFocus: extractSection(body, 'QA Focus'),
      scopedFiles: extractSection(body, 'Scoped Files'),
      repository: extractSection(body, 'Repository').split('\n')[0]?.replace(/^[-*]\s*/, '').trim() ?? '',
    }
  }).filter((workstream) => workstream.title)
}

function parseParallelTasks(tasksMarkdown: string): ParsedWorkstream[] {
  return tasksMarkdown
    .split('\n')
    .filter((line) => line.includes('[P]'))
    .slice(0, 4)
    .map((line, index) => ({
      title: `Parallel Task ${index + 1}`,
      tasks: line.trim(),
      inputs: 'tasks.md and relevant supporting artifacts',
      outputs: 'Sub-agent execution brief',
      dependencies: 'Review adjacent tasks before merge',
      qaFocus: 'Verify file ownership and regression surface for this task',
      scopedFiles: 'Infer from task description and related files',
      repository: '',
    }))
}

function extractSection(markdown: string, heading: string): string {
  const regex = new RegExp(`###\\s+${heading}\\n([\\s\\S]*?)(?=\\n###\\s+|$)`, 'i')
  return markdown.match(regex)?.[1]?.trim() ?? ''
}

async function pathExistsAsync(target: string): Promise<boolean> {
  try {
    await readFile(target)
    return true
  } catch {
    return false
  }
}

/** First "# " heading of spec.md, without the "Feature Specification:" prefix Spec Kit adds. */
async function readSpecTitle(featureDirAbs: string): Promise<string | undefined> {
  try {
    const spec = await readFile(path.join(featureDirAbs, 'spec.md'), 'utf8')
    const heading = spec.split('\n').find((line) => line.startsWith('# '))
    return heading?.replace(/^#\s+/, '').replace(/^Feature Specification:\s*/i, '').trim() || undefined
  } catch {
    return undefined
  }
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'workstream'
}

function estimateTokenCount(text: string): number {
  return Math.max(1, Math.ceil(text.trim().length / 4))
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
