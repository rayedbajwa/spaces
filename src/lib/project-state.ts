import { getDb } from './db'

/**
 * The board's view of each project, stored instead of recomputed per request.
 *
 * A card's lane and next step come from the project's feature files (spec,
 * plan, tasks, reports). Reading them for every project on every board poll
 * does not survive many projects, so the derived artifacts are kept here and
 * recomputed only when they can have changed:
 *
 *   - a run of the project was updated after they were computed (runs bump
 *     updated_at at every stage start, pause and finish);
 *   - something wrote feature files outside a run and marked them stale
 *     (accepting or withdrawing an acceptance);
 *   - they are older than MAX_AGE_MS, as a backstop for edits made elsewhere.
 */

export const PROJECT_STATE_MAX_AGE_MS = 10 * 60_000

export interface StoredProjectState<T> {
  artifacts: T
  tasksDone: number
  stale: boolean
  computedAt: string
}

export function isProjectStateFresh(
  state: Pick<StoredProjectState<unknown>, 'stale' | 'computedAt'>,
  latestRunUpdatedAt?: string | null,
  now = Date.now(),
): boolean {
  if (state.stale) return false
  const computed = Date.parse(state.computedAt)
  if (!Number.isFinite(computed) || now - computed > PROJECT_STATE_MAX_AGE_MS) return false
  if (latestRunUpdatedAt && Date.parse(latestRunUpdatedAt) >= computed) return false
  return true
}

export async function loadProjectStates<T>(projectIds: string[]): Promise<Map<string, StoredProjectState<T>>> {
  if (projectIds.length === 0) return new Map()
  const rows = await getDb()<Array<{ projectId: string; artifacts: T; tasksDone: number; stale: boolean; computedAt: Date }>>`
    SELECT project_id AS "projectId", artifacts_json AS artifacts, tasks_done AS "tasksDone", stale, computed_at AS "computedAt"
      FROM project_state WHERE project_id = ANY(${projectIds}::uuid[])
  `
  return new Map(rows.map((r) => [r.projectId, { artifacts: r.artifacts, tasksDone: r.tasksDone, stale: r.stale, computedAt: new Date(r.computedAt).toISOString() }]))
}

/**
 * Store freshly computed artifacts. `computedAt` is when reading the files
 * started, so a run that changed while they were being read still counts as newer.
 */
export async function saveProjectState(projectId: string, artifacts: unknown, tasksDone: number, computedAt: Date): Promise<void> {
  const sql = getDb()
  await sql`
    INSERT INTO project_state (project_id, artifacts_json, tasks_done, stale, computed_at)
    VALUES (${projectId}, ${sql.json(artifacts as never)}, ${tasksDone}, false, ${computedAt})
    ON CONFLICT (project_id) DO UPDATE
      SET artifacts_json = EXCLUDED.artifacts_json,
          tasks_done = EXCLUDED.tasks_done,
          -- Marked stale after these files were read: keep it stale for the next read.
          stale = project_state.stale AND project_state.stale_since >= EXCLUDED.computed_at,
          computed_at = EXCLUDED.computed_at
  `
}

/** Feature files changed outside a run: the next board read recomputes this project. */
export async function markProjectStateStale(projectId: string): Promise<void> {
  await getDb()`UPDATE project_state SET stale = true, stale_since = now() WHERE project_id = ${projectId}`
}
