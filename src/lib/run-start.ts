/**
 * Shared run-start helper (012-inbound-outbound-slack, T021).
 *
 * `startSpecifyRun` lifts the guards that the ad-hoc `/execute-step` route uses
 * (clone-in-progress, runnable repo, in-flight work) so converting an Intake
 * item starts the *existing* `specify` stage through one path rather than a
 * second creation route. It creates the run and queues the job; it never
 * bypasses human gates or changes stage semantics.
 */

import { buildContextBundle } from './context-builder'
import { enqueueJob } from './dispatcher'
import { log } from './logger'
import { defaultModel } from './model-policy'
import { orgIdForProject } from './orgs'
import {
  describeUnrunnableRepos,
  getProjectBySlug,
  listRepos,
  pickRunnableRepo,
  primaryStillCloning,
} from './project-registry'
import { createRun, getLatestRunForProject } from './run-store'
import { resolveCwd } from './aidlc'
import type { PipelineTemplate } from './pipeline-template'

const runStartLog = log.child({ mod: 'run-start' })

export type StartSpecifyResult =
  | { ok: true; runId: string; model: string }
  | { ok: false; error: string; status: number; code?: string }

/**
 * Start a `specify` run for a project. `scope` maps to the spec's Scope line
 * (`feature` or `bugfix`). The caller is responsible for authorization.
 */
export async function startSpecifyRun(input: {
  projectId: string
  projectSlug: string
  feature: string
  scope?: 'feature' | 'bugfix' | 'auto' | null
  actorUserId?: string | null
  actorName?: string | null
  force?: boolean
}): Promise<StartSpecifyResult> {
  const project = await getProjectBySlug(input.projectSlug)
  if (!project || project.projectId !== input.projectId) return { ok: false, error: 'Project not found.', status: 404 }
  if (!input.feature.trim()) return { ok: false, error: 'A feature description is required to start specify.', status: 400 }

  const repos = await listRepos(project.projectId)
  const cloning = primaryStillCloning(repos)
  if (cloning) return { ok: false, error: `${cloning.githubRepo ?? cloning.label} is still being cloned. The run starts once the clone finishes.`, status: 409, code: 'primary_cloning' }
  const repo = pickRunnableRepo(repos)
  if (!repo?.localPath) return { ok: false, error: describeUnrunnableRepos(repos), status: 400 }

  const sql = (await import('./db')).getDb()
  if (!input.force) {
    const inflight = await sql<Array<{ kind: string; status: string; runStatus: string | null; runStage: string | null; pauseKind: string | null }>>`
      SELECT j.kind, j.status, r.status AS "runStatus", r.current_stage AS "runStage", r.pause_kind AS "pauseKind"
        FROM project_jobs j
        LEFT JOIN pipeline_runs r ON r.run_id = j.run_id
       WHERE j.project_id = ${project.projectId} AND j.status IN ('queued','claimed','running')
       ORDER BY j.created_at ASC LIMIT 1
    `
    if (inflight.length > 0) {
      const blocking = inflight[0]!
      return {
        ok: false,
        status: 409,
        code: 'project_busy',
        error: blocking.runStatus === 'paused' && blocking.pauseKind && blocking.pauseKind !== 'user'
          ? `This project's run is waiting for a human on ${blocking.runStage ?? 'a stage'}.`
          : `This project already has ${blocking.kind.replace('_', ' ')} queued or running.`,
      }
    }
  }

  const cwd = resolveCwd(repo.localPath)
  const contextBundle = await buildContextBundle({ projectId: project.projectId, projectSlug: project.slug, projectPath: cwd })
  const latest = await getLatestRunForProject(project.slug)
  const inherited = latest?.optionsJson?.model
  const model = inherited && inherited.trim() ? inherited.trim() : await defaultModel(await orgIdForProject(project.projectId))

  const template: PipelineTemplate = {
    name: 'adhoc-specify',
    version: 1,
    description: 'Specify run started from an Intake conversion.',
    steps: [{ id: 'specify', stage: 'specify', review: true, humanGate: true }],
  }

  const options = {
    cwd,
    model,
    projectId: project.projectId,
    ...(repo.githubRepo ? { pullRequests: { githubRepo: repo.githubRepo } } : {}),
    projectMemory: contextBundle.project.memory,
    sharedContextPrompt: contextBundle.runPromptBundle,
    persistSession: true,
    nonInteractive: false,
    verbose: false,
    feature: input.feature,
    ...(input.scope && input.scope !== 'auto' ? { intentScope: input.scope } : {}),
    ...(input.force ? { allowNewFeature: true } : {}),
  }

  const row = await createRun({
    projectNamespace: project.slug,
    projectLabel: project.name,
    projectPath: cwd,
    pipelineName: template.name,
    feature: input.feature,
    options: options as never,
    template,
    projectId: project.projectId,
    repoId: repo.repoId,
  })
  await enqueueJob({ projectId: project.projectId, kind: 'task_run', triggerSource: 'user', payload: { runId: row.runId }, runId: row.runId })
  runStartLog.info('specify run started', { runId: row.runId, projectId: project.projectId, by: input.actorUserId ?? input.actorName ?? 'system' })
  return { ok: true, runId: row.runId, model }
}
