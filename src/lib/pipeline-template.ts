import { STAGE_DEFINITIONS, type StageName } from './aidlc'

export interface PipelineTemplate {
  name: string
  version: number
  description?: string
  steps: PipelineStep[]
  retry?: PipelineRetryPolicy
}

export type PipelinePhase = 'initialization' | 'ideation' | 'inception' | 'construction' | 'operation'

export type PipelineRole =
  | 'product'
  | 'product-lead'
  | 'architect'
  | 'architecture-reviewer'
  | 'developer'
  | 'design'
  | 'quality'
  | 'compliance'
  | 'devsecops'
  | 'delivery'
  | 'operations'
  | 'aws-platform'
  | 'pipeline-deploy'
  | 'composer'

export const PIPELINE_ROLES: readonly PipelineRole[] = [
  'product', 'product-lead', 'architect', 'architecture-reviewer',
  'developer', 'design', 'quality', 'compliance', 'devsecops',
  'delivery', 'operations', 'aws-platform', 'pipeline-deploy', 'composer',
] as const

export const PIPELINE_PHASES: readonly PipelinePhase[] = [
  'initialization', 'ideation', 'inception', 'construction', 'operation',
] as const

export interface PipelineStep {
  id: string
  stage: StageName
  review?: boolean
  humanGate?: boolean
  parallel?: PipelineParallelSpec
  requires?: string[]
  onComplete?: PipelineOnComplete
  maxIterations?: number
  role?: PipelineRole
  phase?: PipelinePhase
  /** Per-step model override, e.g. `anthropic/claude-haiku-4-5`. Falls back to run-level if unresolvable. */
  model?: string
  /** Per-step reasoning depth: off | minimal | low | medium | high | xhigh | max. */
  thinking?: string
}

export interface PipelineOnComplete {
  branch?: PipelineBranchRule[]
}

export interface PipelineRetryPolicy {
  max: number
  backoffMs?: number
}

export interface PipelineBranchRule {
  when: string
  goto: string
}

export interface PipelineParallelSpec {
  source: 'parallel-workstreams.md'
  maxConcurrency?: number
}

export interface PipelineTemplateSummary {
  name: string
  version: number
  description?: string
  stepCount: number
  source: 'org' | 'project'
}

export function validateTemplate(raw: unknown, sourcePath: string): PipelineTemplate {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`${sourcePath}: template root must be an object.`)
  }

  const obj = raw as Record<string, unknown>

  const name = requireString(obj, 'name', sourcePath)
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error(`${sourcePath}: name "${name}" must match [a-z][a-z0-9-]*`)
  }

  const version = requireNumber(obj, 'version', sourcePath)
  if (version !== 1) {
    throw new Error(`${sourcePath}: only version 1 is supported.`)
  }

  const description = optionalString(obj, 'description')

  let retry: PipelineRetryPolicy | undefined
  if (obj.retry !== undefined) {
    retry = validateRetry(obj.retry, `${sourcePath}.retry`)
  }

  const rawSteps = obj.steps
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    throw new Error(`${sourcePath}: steps must be a non-empty array.`)
  }

  const seenIds = new Set<string>()
  const steps = rawSteps.map((step, index) => validateStep(step, index, sourcePath, seenIds))

  // Cross-step validation: branch.goto must reference an existing step id or 'end'.
  const stepIds = new Set(steps.map((s) => s.id))
  for (const step of steps) {
    if (!step.onComplete?.branch) continue
    for (const rule of step.onComplete.branch) {
      if (rule.goto !== 'end' && !stepIds.has(rule.goto)) {
        throw new Error(`${sourcePath} step "${step.id}": branch goto "${rule.goto}" is not a known step id (or 'end').`)
      }
    }
  }

  return { name, version, description, steps, retry }
}

function validateStep(raw: unknown, index: number, sourcePath: string, seenIds: Set<string>): PipelineStep {
  const location = `${sourcePath} step[${index}]`
  if (!raw || typeof raw !== 'object') {
    throw new Error(`${location}: must be an object.`)
  }

  const obj = raw as Record<string, unknown>
  const id = requireString(obj, 'id', location)
  if (seenIds.has(id)) {
    throw new Error(`${location}: duplicate step id "${id}".`)
  }
  seenIds.add(id)

  const stageValue = requireString(obj, 'stage', location)
  if (!(stageValue in STAGE_DEFINITIONS)) {
    throw new Error(`${location}: unknown stage "${stageValue}". Valid: ${Object.keys(STAGE_DEFINITIONS).join(', ')}`)
  }
  const stage = stageValue as StageName

  const step: PipelineStep = { id, stage }

  if (obj.review !== undefined) {
    if (typeof obj.review !== 'boolean') throw new Error(`${location}: review must be boolean.`)
    step.review = obj.review
  }

  if (obj.humanGate !== undefined) {
    if (typeof obj.humanGate !== 'boolean') throw new Error(`${location}: humanGate must be boolean.`)
    step.humanGate = obj.humanGate
  }

  if (obj.requires !== undefined) {
    if (!Array.isArray(obj.requires) || obj.requires.some((v) => typeof v !== 'string')) {
      throw new Error(`${location}: requires must be an array of strings.`)
    }
    step.requires = obj.requires as string[]
  }

  if (obj.parallel !== undefined) {
    step.parallel = validateParallel(obj.parallel, location)
  }

  if (obj.maxIterations !== undefined) {
    if (typeof obj.maxIterations !== 'number' || obj.maxIterations < 1) {
      throw new Error(`${location}: maxIterations must be a positive number.`)
    }
    step.maxIterations = obj.maxIterations
  }

  if (obj.onComplete !== undefined) {
    step.onComplete = validateOnComplete(obj.onComplete, location)
  }

  if (obj.role !== undefined) {
    if (typeof obj.role !== 'string' || !(PIPELINE_ROLES as readonly string[]).includes(obj.role)) {
      throw new Error(`${location}.role: must be one of ${PIPELINE_ROLES.join(', ')}`)
    }
    step.role = obj.role as PipelineRole
  }

  if (obj.phase !== undefined) {
    if (typeof obj.phase !== 'string' || !(PIPELINE_PHASES as readonly string[]).includes(obj.phase)) {
      throw new Error(`${location}.phase: must be one of ${PIPELINE_PHASES.join(', ')}`)
    }
    step.phase = obj.phase as PipelinePhase
  }

  if (obj.model !== undefined) {
    if (typeof obj.model !== 'string' || !obj.model.trim()) throw new Error(`${location}.model: must be a non-empty string.`)
    step.model = obj.model.trim()
  }

  if (obj.thinking !== undefined) {
    const valid = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
    if (typeof obj.thinking !== 'string' || !valid.includes(obj.thinking)) throw new Error(`${location}.thinking: must be one of ${valid.join(', ')}`)
    step.thinking = obj.thinking
  }

  return step
}

function validateRetry(raw: unknown, location: string): PipelineRetryPolicy {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`${location}.retry: must be an object.`)
  }
  const obj = raw as Record<string, unknown>
  const max = obj.max
  if (typeof max !== 'number' || max < 0) {
    throw new Error(`${location}.retry.max: must be a non-negative number.`)
  }
  const policy: PipelineRetryPolicy = { max }
  if (obj.backoffMs !== undefined) {
    if (typeof obj.backoffMs !== 'number' || obj.backoffMs < 0) {
      throw new Error(`${location}.retry.backoffMs: must be a non-negative number.`)
    }
    policy.backoffMs = obj.backoffMs
  }
  return policy
}

function validateOnComplete(raw: unknown, location: string): PipelineOnComplete {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`${location}.onComplete: must be an object.`)
  }
  const obj = raw as Record<string, unknown>
  const oc: PipelineOnComplete = {}
  if (obj.branch !== undefined) {
    if (!Array.isArray(obj.branch)) {
      throw new Error(`${location}.onComplete.branch: must be an array.`)
    }
    oc.branch = obj.branch.map((rule, i) => {
      if (!rule || typeof rule !== 'object') {
        throw new Error(`${location}.onComplete.branch[${i}]: must be an object.`)
      }
      const r = rule as Record<string, unknown>
      const when = requireString(r, 'when', `${location}.onComplete.branch[${i}]`)
      const goto = requireString(r, 'goto', `${location}.onComplete.branch[${i}]`)
      return { when, goto }
    })
  }
  return oc
}

function validateParallel(raw: unknown, location: string): PipelineParallelSpec {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`${location}: parallel must be an object.`)
  }
  const obj = raw as Record<string, unknown>
  const source = requireString(obj, 'source', `${location}.parallel`)
  if (source !== 'parallel-workstreams.md') {
    throw new Error(`${location}.parallel.source: only 'parallel-workstreams.md' is supported.`)
  }

  const spec: PipelineParallelSpec = { source: 'parallel-workstreams.md' }
  if (obj.maxConcurrency !== undefined) {
    if (typeof obj.maxConcurrency !== 'number' || obj.maxConcurrency < 1) {
      throw new Error(`${location}.parallel.maxConcurrency: must be a positive number.`)
    }
    spec.maxConcurrency = obj.maxConcurrency
  }
  return spec
}

function requireString(obj: Record<string, unknown>, key: string, location: string): string {
  const value = obj[key]
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${location}: "${key}" is required and must be a non-empty string.`)
  }
  return value
}

function requireNumber(obj: Record<string, unknown>, key: string, location: string): number {
  const value = obj[key]
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`${location}: "${key}" is required and must be a number.`)
  }
  return value
}

function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new Error(`"${key}" must be a string when provided.`)
  }
  return value
}

export function requiredArgKeysForTemplate(template: PipelineTemplate): string[] {
  const keys = new Set<string>()
  for (const step of template.steps) {
    const argKey = STAGE_DEFINITIONS[step.stage].argKey
    if (argKey) keys.add(argKey)
  }
  return [...keys]
}
