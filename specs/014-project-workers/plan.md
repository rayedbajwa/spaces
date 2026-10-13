# Implementation Plan: A worker service per project

**Spec**: [spec.md](./spec.md) · **Created**: 2026-10-13

## Where we start

`src/standalone.ts` runs `server.ts` and `supervisor.ts` in one Railway service with one volume (`/data`). The supervisor starts a `worker.ts` process per project. The server is not a thin API. In-process, outside the job queue, it:

- reads workspace files for about 25 routes: artifacts, QA, the task tracker, context bundles, run snapshots (`tasks.md`), plan repos and suggestions
- writes to the workspace from 17 routes: project creation (governing workspace), onboarding and Spec Kit init, clone and learn, export, intent rename, delete, activate and accept, project delete
- runs git directly in 9 places: clone, governance commits, branch switch, `rev-parse` for open-PR lookups, worktrees, commit and push
- runs agents in the request or as in-memory jobs: chat, `tasks/:id/run`, `workstreams/run`, sub-agents, onboarding, repository learning, dev setup
- runs a boot import of intents for every project and an hourly disk sweep

Only `/api/runs`, `execute-step`, resume, answer and rerun go through `project_jobs`.

So the line between web and worker is not "API vs. queue". **Anything project-scoped that touches the workspace has to run where the volume is.**

## Approach: the same server code on each project worker, with the web service forwarding to it

Rather than rewrite those ~45 call sites into RPCs, each project worker runs the same `server.ts` in `project` role, scoped to its project, on the private network. The web service authenticates the user and then forwards project-scoped requests to the project's worker. The handler code stays the same; only where it runs changes.

```
                    ┌──────────────── spaces-web (public, no volume) ────────────────┐
 browser ──HTTPS──▶ │ auth · board · orgs · integrations · approvals · admin         │
                    │ project-scoped workspace routes ──forward──┐                   │
                    │ provisioner · rollout · wake-on-enqueue    │                   │
                    └────────────────────────────────────────────┼───────────────────┘
                                                                 │ private network + internal token
          ┌────────────────────────────┬─────────────────────────┴──┐
          ▼                            ▼                            ▼
 spaces-proj-defa-1 (/data)   spaces-proj-taasq (/data)     … one per project
 server.ts role=project + worker.ts loop for its project
                 ▲
                 └──── Postgres (shared): project_jobs, runs, intents, project_state
```

### Roles (`SPACES_ROLE`)

| Role | Runs | Volume | Used by |
|---|---|---|---|
| `all` (default) | server + supervisor + per-project worker processes, as today | yes | local, docker compose, self-hosted, and production until migration |
| `web` | server only; forwards project routes; provisioner, rollout, waking | no | `spaces-web` |
| `project` | server limited to `WORKER_PROJECT_ID` (internal routes only) + the `worker.ts` loop for that project | yes | `spaces-proj-<code>` |

## Phases

Each phase is its own PR against `main`, and production behaviour stays the same until Phase 5 switches it on.

### Phase 1: roles and request forwarding (no infrastructure yet)

1. Add `src/lib/role.ts`: reads `SPACES_ROLE`, plus `isWeb()` and `isProjectWorker()`. `all` keeps today's behaviour exactly.
2. Add a route table, `src/lib/project-routes.ts`, that classifies every `/api/projects/:slug/*` and `/api/runs/*` route as **workspace** (forward) or **database** (serve locally). The tests fail if a route is unclassified.
3. Add `src/lib/project-forward.ts`, used by the web role:
   - resolve the project's worker URL from `project_workers`
   - forward method, path, body and the stream (SSE) with `x-spaces-internal: <token>` and `x-spaces-user: <signed identity>`
   - retry 502/503/connection errors with backoff for up to 30 s (waking)
   - return a `{ code: 'worker_waking' | 'worker_unavailable' }` error the UI can render
4. In the project role:
   - accept only internal-token requests for `WORKER_PROJECT_ID`
   - rebuild `auth` from the signed identity header
   - start `worker.ts` in-process for its project (no supervisor)
   - run the disk sweep and intent import for its own project only
5. Make the multi-project views database-only in the web role:
   - board and project list from `project_state`, with the file fallback skipped
   - run snapshots' task progress from `project_state`/intents instead of `tasks.md`
   - open-PR lookups use the GitHub API by branch name from the database, not `git rev-parse`
6. Tests: route classification; forwarding (headers, SSE, retry on 502, waking error); the project role refuses other projects and missing tokens; an end-to-end check with two local processes (web + project) on one machine.

### Phase 2: Railway provisioning

1. Add a `project_workers` table: `project_id`, `railway_service_id`, `volume_id`, `internal_url`, `state`, `version`, `last_seen_at`, `disk_used`, `last_error`.
2. Add `src/lib/worker-provisioner.ts` (Railway GraphQL, using the deployment's own `RAILWAY_API_TOKEN` and `RAILWAY_PROJECT_ID`/`RAILWAY_ENVIRONMENT_ID`):
   - `serviceCreate` from the repository image or source, with no public domain
   - `volumeCreate` at `/data`
   - set the variables: `SPACES_ROLE=project`, `WORKER_PROJECT_ID`, a `DATABASE_URL` reference, `ENCRYPTION_KEY`, the internal token, `PORT`
   - enable sleeping
   - deploy at the current version
   - poll until healthy
   - one provisioner per project at a time (advisory lock)
3. Provision on project creation and lazily on first forwarded request or job. Remove the service and volume on project delete.
4. Size each service at 2 vCPU / 2 GB (`serviceInstanceLimitsUpdate`), with a 5 GB volume.
5. Awake cap (default 5, `PROJECT_WORKERS_MAX_AWAKE`): before waking or provisioning, count the workers that are awake. At the cap, the job stays queued and the project shows "waiting for a free worker". The first time the cap is hit, the super admin gets a Slack DM and a banner in the Workers view, then at most once an hour while it stays hit.
6. Tests: a mock Railway GraphQL API, covering the happy path, retries, a partial failure being cleaned up, and the lock.

### Phase 3: jobs and waking

1. Enqueueing a job in the web role pings the project worker's `/internal/wake` (forwarding with retry) after `pg_notify`.
2. The project worker's `worker.ts` loop LISTENs only on its own project; the supervisor is not used in `web`/`project` roles.
3. While a stage runs, the worker keeps sending traffic (database queries, a heartbeat) so Railway does not sleep it.
4. The reaper runs in the web role for jobs whose worker stopped heartbeating, and hands them back to the queue.
5. Tests: enqueue wakes a stopped worker; the reaper returns a job from a dead worker.

### Phase 4: rollout only when idle

1. Project worker services are created **without** an automatic deploy trigger. CI publishes the image (`ghcr.io/rayedbajwa/spaces:<sha>`), or the rollout deploys a commit SHA.
2. The web role runs a rollout loop: for each worker on an older version with no running stage, deploy the new version. A busy worker is deferred until it is idle.
3. The internal API carries a version header. The web service supports workers one version behind.
4. Tests: a busy worker is deferred and an idle one is updated; a version mismatch within the window still works.

### Phase 5: migration of existing projects and switch-over

1. While production still runs as `all` with the shared volume, add `/internal/migrate/:projectId/export`. It streams a tar of the project's repositories, governing workspace and agent sessions, with checksums.
2. For each project, while idle:
   - provision its worker
   - the worker imports the tar on first boot, verifies the checksums, and rewrites `project_repos.local_path` to its own volume paths
   - set `project_workers.state = ready`
3. Once every project is `ready`:
   - start a `spaces-web` service (`SPACES_ROLE=web`, no volume)
   - move the public domain to it
   - keep the old service for one week as a fallback, then delete it and its volume
4. Runbook in `docs/operations/project-workers.md`: the switch-over, rollback, and adding a worker by hand.

### Phase 6: operator view

In the super admin's account menu, a **Workers** view lists each project's worker (state, version, disk, last error) with retry, update and remove.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| A route that touches the workspace is missed and runs on the web service with no volume, silently reading "missing" files | The route classification is exhaustive, with a test. In the web role the workspace root points at a path that does not exist, and file helpers throw instead of returning empty. |
| Cold start 502s | Forwarding retries for up to 30 s, and the UI shows "waking". |
| Railway API limits or changes | One module for provisioning, mocked in tests; failures leave the project on its current worker. |
| Cost of one service per project | Workers sleep when idle; at most 5 awake, with the super admin notified when the cap is hit. |
| SSE through the forwarder | Streamed passthrough with a heartbeat at least every 5 minutes, which also fits Railway's 15-minute request cap. |
| In-memory job state (onboarding, sub-agent jobs, chat history) lost on a worker redeploy | Same as today, but per project; the rollout only runs when the worker is idle. |

## Out of scope

- More than one worker per project (a project's stages are serial).
- Moving workspaces to object storage.
- Autoscaling worker size.

## Verification

- Phases 1–4: `bun test` (new suites), typecheck, CI, and a local two-process test (`SPACES_ROLE=web` + `SPACES_ROLE=project`).
- Phase 5: a dry run on a copy of one project in a Railway staging environment before production.
