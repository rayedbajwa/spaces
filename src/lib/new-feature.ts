import { buildContextBundle } from './context-builder'
import { isGovernanceRepo } from './governance'
import { composeProjectMemory, refreshRepositoryKnowledge } from './project-onboarding'
import { getProject, listRepos, pickRunnableRepo } from './project-registry'
import { syncDefaultBranch } from './pull-requests'

/**
 * Getting a project ready for its next feature.
 *
 * A project moves from feature to feature, and between them the code moves
 * on: the last feature's pull requests merged, other people pushed. Starting
 * the next feature from a stale checkout and last month's memory produces a
 * spec and plan against code that no longer exists. So before `specify` opens
 * a new feature (when an earlier one exists), every repository is brought to
 * the latest default branch, repositories whose code changed are learned again
 * (inventory and agent brief), project memory is rebuilt with the feature
 * history, and the run gets the refreshed shared context.
 */

export interface NewFeaturePreparation {
  sharedContextPrompt?: string
  projectMemory?: string
}

const defaultDeps = { getProject, listRepos, syncDefaultBranch, refreshRepositoryKnowledge, composeProjectMemory, buildContextBundle }
/** What preparation calls out to; tests pass fakes. */
export type NewFeatureDeps = typeof defaultDeps

export async function prepareForNewFeature(input: {
  projectId?: string
  orgId: string
  model?: string
  print: (line: string) => void
}, overrides: Partial<NewFeatureDeps> = {}): Promise<NewFeaturePreparation | undefined> {
  const { getProject, listRepos, syncDefaultBranch, refreshRepositoryKnowledge, composeProjectMemory, buildContextBundle } = { ...defaultDeps, ...overrides }
  if (!input.projectId) return undefined
  const project = await getProject(input.projectId)
  if (!project) return undefined
  const repos = (await listRepos(input.projectId)).filter((r) => Boolean(r.localPath))

  input.print(`\n[new intent] Pulling the latest code and refreshing what Spaces knows about ${project.name} before the next intent…\n`)
  const changed: typeof repos = []
  for (const repo of repos) {
    // The governing workspace holds specs and memory, not application code.
    if (!repo.githubRepo || isGovernanceRepo(repo)) continue
    try {
      const sync = await syncDefaultBranch(input.orgId, repo.localPath!, repo.githubRepo)
      if (sync.skipped) {
        input.print(`[new intent] ${repo.githubRepo}: left as it is (${sync.skipped}).\n`)
      } else if (sync.before !== sync.after) {
        input.print(`[new intent] ${repo.githubRepo}: updated ${sync.branch} ${sync.before?.slice(0, 7) ?? '?'} → ${sync.after?.slice(0, 7)}.\n`)
        changed.push(repo)
      } else {
        input.print(`[new intent] ${repo.githubRepo}: ${sync.branch} is already up to date.\n`)
      }
    } catch (error) {
      input.print(`[new intent] ${repo.githubRepo}: could not pull (${error instanceof Error ? error.message.split('\n')[0] : String(error)}); continuing with the checkout as it is.\n`)
    }
  }

  // Learn again only what changed: a brief is an agent run per repository.
  for (const repo of changed) {
    input.print(`[new intent] Learning ${repo.githubRepo ?? repo.label} again (its code changed)…\n`)
    await refreshRepositoryKnowledge(input.projectId, repo.repoId, { model: input.model }).catch((error) => {
      input.print(`[new intent] Learning ${repo.githubRepo ?? repo.label} failed: ${error instanceof Error ? error.message : String(error)}\n`)
    })
  }
  // Memory is rebuilt either way: it carries the feature history.
  await composeProjectMemory(input.projectId).catch(() => undefined)

  const primary = pickRunnableRepo(await listRepos(input.projectId))
  if (!primary?.localPath) return undefined
  const bundle = await buildContextBundle({ projectId: input.projectId, projectSlug: project.slug, projectPath: primary.localPath }).catch(() => undefined)
  input.print(`[new intent] Memory and context refreshed${changed.length ? `; ${changed.length} repositor${changed.length === 1 ? 'y' : 'ies'} learned again` : ''}.\n`)
  return bundle ? { sharedContextPrompt: bundle.promptBundle, projectMemory: bundle.project.memory } : undefined
}
