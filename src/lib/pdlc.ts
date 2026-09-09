import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
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

const require = createRequire(import.meta.url)

export const STAGE_DEFINITIONS = {
  init: { skill: 'speckit-init', argKey: undefined },
  constitution: { skill: 'speckit-constitution', argKey: 'constitution' },
  specify: { skill: 'speckit-specify', argKey: 'feature' },
  clarify: { skill: 'speckit-clarify', argKey: undefined },
  plan: { skill: 'speckit-plan', argKey: 'planContext' },
  tasks: { skill: 'speckit-tasks', argKey: undefined },
  checklist: { skill: 'speckit-checklist', argKey: 'checklistDomain' },
  analyze: { skill: 'speckit-analyze', argKey: undefined },
  implement: { skill: 'speckit-implement', argKey: undefined },
  taskstoissues: { skill: 'speckit-taskstoissues', argKey: undefined },
} as const

export const DEFAULT_STAGES: StageName[] = ['init', 'specify', 'plan', 'tasks', 'analyze']
export const REVIEW_STAGES: StageName[] = ['specify', 'plan', 'tasks', 'implement']
export const QUESTION_PATTERN = /(##\s*Question\s+\d+|Your choice:|Wait for user response|Please respond|NEEDS CLARIFICATION)/i
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export type StageName = keyof typeof STAGE_DEFINITIONS
export type ThinkingLevel = NonNullable<CreateAgentSessionOptions['thinkingLevel']>
export type PauseKind = 'clarification' | 'review'

export interface FlowOptions {
  cwd: string
  feature?: string
  constitution?: string
  planContext?: string
  checklistDomain?: string
  model?: string
  thinking?: ThinkingLevel
  persistSession?: boolean
  nonInteractive?: boolean
  verbose?: boolean
  reviewHarness?: boolean
  humanInLoop?: boolean
}

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

export class PDLCFlow {
  private readonly options: Required<Pick<FlowOptions, 'persistSession' | 'nonInteractive' | 'verbose' | 'reviewHarness' | 'humanInLoop'>> & Omit<FlowOptions, 'persistSession' | 'nonInteractive' | 'verbose' | 'reviewHarness' | 'humanInLoop'>
  private readonly stages: StageName[]
  private readonly sinks: OutputSinks
  private readonly speckitRoot: string
  private readonly modelRuntimePromise: Promise<ModelRuntime>
  private session?: AgentSession
  private stageIndex = 0
  private waitState?: WaitState
  private log = ''
  private sessionFile?: string

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
    this.modelRuntimePromise = ModelRuntime.create()
  }

  async start(): Promise<FlowProgress> {
    await this.ensureSession()
    this.print(`Starting PDLC flow in ${this.options.cwd}\n`)
    if (this.options.model) {
      this.print(`Model: ${this.options.model}${this.options.thinking ? ` (${this.options.thinking})` : ''}\n`)
    }
    if (this.options.reviewHarness) {
      this.print(`Review harness enabled for: ${REVIEW_STAGES.filter((stage) => this.stages.includes(stage)).join(', ') || 'none'}\n`)
      this.print(`Human-in-loop approvals: ${this.options.humanInLoop ? 'enabled' : 'disabled'}\n`)
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

  getCurrentStage(): StageName | undefined {
    return this.stages[this.stageIndex]
  }

  getSessionFile(): string | undefined {
    return this.sessionFile
  }

  private async ensureSession(): Promise<void> {
    if (this.session) {
      return
    }

    const modelRuntime = await this.modelRuntimePromise
    const modelSelection = resolveModelSelection(modelRuntime, this.options)
    const sessionManager = this.options.persistSession
      ? SessionManager.create(this.options.cwd)
      : SessionManager.inMemory(this.options.cwd)

    const { session } = await createAgentSession({
      cwd: this.options.cwd,
      modelRuntime,
      model: modelSelection.model,
      thinkingLevel: modelSelection.thinkingLevel,
      tools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'],
      sessionManager,
    })

    this.session = session
  }

  private async advance(): Promise<FlowProgress> {
    while (this.stageIndex < this.stages.length) {
      const stage = this.stages[this.stageIndex]
      this.print(`\n=== Stage ${this.stageIndex + 1}/${this.stages.length}: ${STAGE_DEFINITIONS[stage].skill} ===\n\n`)

      const output = await this.runStage(stage)
      if (QUESTION_PATTERN.test(output)) {
        return this.pause('clarification', stage)
      }

      const reviewProgress = await this.handleStageCompletion(stage)
      if (reviewProgress) {
        return reviewProgress
      }
    }

    this.print('\nPDLC flow complete.\n')
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
      this.stageIndex += 1
      return undefined
    }

    return this.runReviewGate(stage)
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
      this.stageIndex += 1
      return this.advance()
    }

    this.print(`\nApplying human feedback for ${stage}: ${answer}\n`)
    const output = await this.streamPrompt(buildReviewFeedbackPrompt(stage, answer))
    if (QUESTION_PATTERN.test(output)) {
      return this.pause('clarification', stage)
    }

    this.waitState = undefined
    return this.runReviewGate(stage)
  }

  private shouldRunReviewGate(stage: StageName): boolean {
    return this.options.reviewHarness && REVIEW_STAGES.includes(stage)
  }

  private async runReviewGate(stage: StageName): Promise<FlowProgress> {
    this.print(`\n--- Review gate after ${stage} ---\n\n`)
    const output = await this.streamPrompt(buildReviewPrompt(stage))

    if (QUESTION_PATTERN.test(output)) {
      return this.pause('clarification', stage)
    }

    if (!this.options.humanInLoop) {
      this.print(`\nReview gate complete for ${stage}. Auto-continuing because human-in-loop is disabled.\n`)
      this.stageIndex += 1
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
    const prompt = await loadStagePrompt({
      speckitRoot: this.speckitRoot,
      stage,
      stageArgument: getStageArgument(stage, this.options),
    })
    return this.streamPrompt(prompt)
  }

  private async streamPrompt(prompt: string): Promise<string> {
    if (!this.session) {
      throw new Error('Flow session has not been created yet.')
    }

    let assistantOutput = ''
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
    stages.push('implement')
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

function resolveSpeckitRoot(): string {
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
    console.warn(`Model warning: ${result.warning}`)
  }

  return {
    model: result.model,
    thinkingLevel: result.thinkingLevel,
  }
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

function getReviewScope(stage: StageName): string {
  switch (stage) {
    case 'specify':
      return 'spec quality, assumptions, success criteria, edge cases, and readiness for planning'
    case 'plan':
      return 'technical plan quality, research completeness, contract and data-model coverage, and readiness for task generation'
    case 'tasks':
      return 'task completeness, execution order, traceability to stories, and readiness for implementation'
    case 'implement':
      return 'implementation completeness, test and verification coverage, and release readiness'
    default:
      return 'quality and readiness for the next PDLC step'
  }
}

async function loadStagePrompt(options: {
  speckitRoot: string
  stage: StageName
  stageArgument: string
}): Promise<string> {
  const skillPath = getSkillPath(options.speckitRoot, options.stage)
  const rawSkill = await readFile(skillPath, 'utf8')

  return rawSkill
    .replaceAll('SKILL_PATH', skillPath)
    .replaceAll('$ARGUMENTS', options.stageArgument)
}
