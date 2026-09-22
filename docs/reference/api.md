# HTTP API

The web UI is a thin client over this JSON API (`http://localhost:3000`). Ids
in paths are UUIDs unless the route says `:slug`.

## Authentication, organizations and teams

All `/api/*` routes except the ones marked public require a session cookie
(unless `AUTH_DISABLED=1`). Unauthenticated calls return `401`.

| Method & path | Purpose |
|---|---|
| `GET /api/auth/status` | public: `{ authEnabled, needsBootstrap, githubLogin }` |
| `GET /api/version` | public: package name, version, and startup-resolved commit metadata |
| `POST /api/auth/register` | public: `{ email, password, name?, organizationName?, inviteToken? }`; the first user bootstraps the default organization and team, a registration without an invite starts its own organization, and otherwise an invite (or `OPEN_REGISTRATION=1`) is required. Sets the session cookie |
| `POST /api/auth/login` · `POST /api/auth/logout` | public: `{ email, password, inviteToken? }` / clear session |
| `GET /api/oauth/github/authorize?mode=login[&invite=token]` | public: GitHub sign-in (same OAuth app as the integration) |
| `GET /api/invites/:token` | public: invite preview (team, role, email) |
| `POST /api/invites/:token/accept` | Join the team the invite is for (email must match) |
| `GET /api/me` · `POST /api/me/team` | Current user, teams, active team and the active `organization` / switch active team `{ teamId }` |
| `GET /api/teams` · `POST /api/teams` | My teams / create a team in the caller's organization (creator becomes owner) |
| `GET /api/teams/:id` · `PATCH /api/teams/:id` | Team detail (members, invites, memory) / rename (admin) |
| `GET/PATCH/DELETE /api/teams/:id/members[/:userId]` | Members; role changes need admin, owner grants need owner; a team keeps ≥ 1 owner |
| `GET/POST /api/teams/:id/invites` · `DELETE …/invites/:inviteId` | Invites (admin): `{ email, role }` → `{ link }` |
| `GET/PUT /api/teams/:id/memory` | Team memory (members edit) |
| `GET/PUT /api/teams/:id/knowledge` | Team default knowledge scope (admin) |
| `GET/PUT /api/org/memory` | Memory of the caller's organization, shared by its teams (owners/admins edit) |

Authorization: viewers get `403` on any non-GET route (except chat, invites
and their own session); project routes return `403` when the project belongs
to a team the caller is not a member of. `GET /api/projects`, `/api/board` and
`/api/history` are scoped to the active team.

Tenancy: every `/api/org/*` route, along with provider keys, model routing,
OAuth apps, integrations, knowledge, the GitHub catalog, promotions and usage,
reads and writes only the caller's organization — the one its active team
belongs to. An account without a team gets `403 no_team` everywhere except its
own session, team creation and invites.

## Projects

| Method & path | Purpose |
|---|---|
| `GET /api/projects` | List projects |
| `POST /api/projects` | Create: `{ name, description?, repos?, model?, feature? }`. Creates the governing workspace and starts onboarding; `409 no_provider_key` when no model key is stored |
| `GET /api/projects/:id` | Detail with repos, integrations and suggestions |
| `PATCH /api/projects/:id` | Update |
| `POST /api/runs/:id/pause` · `POST …/resume` · `POST …/cancel` | Pause a running run at its next stage boundary (a queued run is held before start), resume a user-paused run, or cancel a queued/running/paused run; each returns the run snapshot |
| `POST /api/projects/:id/pause` · `POST …/resume` | Pause: queued jobs are held, running runs stop before their next stage (`pausingRuns`, `heldJobs`) / resume: dispatch continues and user-paused runs are re-queued (`resumedRuns`) |
| `POST /api/projects/:id/archive` · `POST …/unarchive` | Archive: cancels queued, running and paused work (`cancelled` on the response), hides the project from the board, refuses new runs and jobs, keeps everything / restore |
| `GET /api/projects/:id/deletion-check` | What deleting would remove (runs, jobs, snapshots, per-repository action), whether the project is archived, the confirmation phrase, and whether the caller may delete |
| `DELETE /api/projects/:id` | Permanently delete an archived project and everything it owns. Body `{ "confirm": "delete <project-key>" }` (the key is the project code, e.g. `delete plat-12`; the `deletion-check` response carries the exact phrase); owner/admin of the project's team; `409` unless archived and idle |
| `GET /api/board?archived=1` | Include archived projects (cards carry `archivedAt`); the default response omits them and reports `archivedCount` |
| `GET /api/projects/:id/onboarding` · `POST …/onboarding` | Onboarding progress / restart |
| `GET /api/projects/:id/suggestions` · `POST …/suggestions` | Suggested repositories & work areas / regenerate (`{ basis: 'project' | 'plan' }`) |
| `POST /api/projects/:id/export` | Export memory, knowledge and manifest into the governing workspace |
| `GET /api/projects/:id/responsibilities` | Read the six project accountability responsibilities and their `explicit`, `owner-fallback`, or `unresolved` resolution state; owning-team members only |
| `PUT /api/projects/:id/responsibilities/:responsibilityId/assignments` | Replace ordered assignees with `{ userIds: string[] }`; owning-team owners/admins only; rejects invalid members and empty Owner assignments |
| `POST /api/projects/:id/responsibilities/migrate` | Idempotently seed/repair standard responsibilities; owning-team owners/admins only |

## Repositories

| Method & path | Purpose |
|---|---|
| `POST /api/projects/:id/repos` | Add `{ label, kind: 'local' | 'github', localPath?, githubRepo?, isPrimary? }`; GitHub repos clone, learn and set up in the background |
| `POST /api/projects/:id/repos/create` | Create `{ name, owner?, description?, visibility? }` on GitHub and attach it (`403 insufficient_permissions` / `409 github_not_connected` with a `manualUrl` fallback) |
| `PATCH /api/projects/:id/repos/:repoId` | Edit label / path / owner-name / primary |
| `DELETE /api/projects/:id/repos/:repoId` | Remove (drops its brief, recomposes memory, prunes knowledge scope) |
| `POST /api/projects/:id/repos/:repoId/clone` · `…/learn` | Re-clone / re-learn |
| `GET /api/projects/:slug/plan-repos` | Repositories the current plan names, matched against registered ones |
| `GET /api/github/repos` | Repos visible to the connected GitHub account (wizard autocomplete) |
| `GET /api/github/catalog` · `POST /api/github/catalog/sync` | Synced repository catalog / force sync |

## Runs

| Method & path | Purpose |
|---|---|
| `POST /api/runs` | Start: `{ projectId, pipeline, feature?, constitution?, planContext?, checklistDomain?, model?, thinking?, targetRepoId? }` |
| `GET /api/runs/:id` | Snapshot: status, stage, log, timeline, `interrupted`, `queued`, `rerunnable` |
| `GET /api/runs/:id/events` | Server-sent events stream |
| `POST /api/runs/:id/answer` | `{ answer }` for a paused run (`approve` / `continue` / text); falls back to re-queueing when the owning worker is gone |
| `POST /api/runs/:id/rerun` | `{ fromStage?: string | 'start' }`; resumes the previous agent session |
| `POST /api/projects/:slug/execute-step` | Run one stage: `{ step, force?, feature? }` |
| `POST /api/projects/:slug/accept` | Accept a feature whose verification did not pass: `{ note? }`. Records who accepted it, the verification status at the time and the reason in `acceptance.md`, and the board counts the feature as done. `409 not_verified` when there is no report yet, `409 already_passed` when verification passed |
| `DELETE /api/projects/:slug/accept` | Withdraw that acceptance; the feature returns to whatever its verification says |
| `GET /api/projects/:slug/pull-requests` | The feature's pull requests in the project's repositories, open first, with CI and review state, plus the decisions recorded in Spaces and the overall decision (`approved`, `changes_requested` or `null`) |
| `GET /api/projects/:slug/pull-requests/:owner/:repo/:number` | One pull request for review: changed files with their patches, review comments and reviews. `404` when the repository is not the project's |
| `POST /api/projects/:slug/pull-requests/:owner/:repo/:number/review` | Post a review: `{ event: 'APPROVE' \| 'REQUEST_CHANGES' \| 'COMMENT', summary?, headSha?, comments?: [{ path, line, side: 'LEFT' \| 'RIGHT', body }] }`. Approve and request changes are recorded in `human-review.json` and, once they settle the feature, written to `code-review.md`. Returns `postedAs` (a comment when GitHub refuses the author's own review), `overall` and `nextStep`. `409 stale_head` when the pull request has new commits since `headSha` |
| `GET /api/projects/:slug/latest-run` · `/jobs` · `/task-tracker` | Latest run, job queue with run-aware status, tracker |

## Sub-agents

| Method & path | Purpose |
|---|---|
| `POST /api/projects/:slug/subagents/run` | Start parallel workstreams `{ maxAgents?, model? }` (branches + stacked PRs on GitHub repos) |
| `GET …/subagents` · `GET …/subagents/events` | Snapshot / stream |
| `POST …/subagents/retry` · `…/subagents/cancel` | Retry / cancel |

## Knowledge and memory

| Method & path | Purpose |
|---|---|
| `GET /api/knowledge/sources` | Connected sources |
| `GET /api/knowledge/search?source=&q=` · `GET /api/knowledge/item?source=&id=` | Search / fetch across Jira, Confluence, Linear, GitHub |
| `POST /api/projects/:id/sources/import` | Attach a ticket/doc to a project `{ source, id }` |
| `GET /api/projects/:id/knowledge` · `PUT …/knowledge` | Per-project knowledge scope |
| `GET /api/projects/:slug/memory` · `POST …/memory` · `POST …/memory/rebuild` | Memory read / save manual text / rebuild from repositories |
| `GET /api/projects/:slug/context` | The shared context bundle |

## Assistant, workers, integrations

| Method & path | Purpose |
|---|---|
| `POST /api/projects/:slug/chat` | `{ message }` → `{ answer, history, actions }`; full context + action tools |
| `GET/DELETE /api/projects/:slug/assistant/history` | Conversation memory |
| `GET /api/workers` · `GET /api/projects/:id/worker` | Live workers / the one serving a project |
| `GET /api/integrations` · `DELETE /api/integrations/:kind` | Integration status (with `credentialsOk`) / disconnect |
| `GET /api/oauth/:provider/authorize[?return=/path]` · `…/callback` | OAuth flow; `return` sends the browser back to a page in the app |
| `GET /api/oauth-apps` · `PUT/DELETE /api/oauth-apps/:provider` | Provider app credentials and setup state / paste or remove credentials (admin) |
| `GET /api/oauth-apps/github/manifest[?org=name]` | Page that posts the GitHub App manifest to GitHub (admin) |
| `GET /api/oauth-apps/github/manifest/callback` · `…/installed` | GitHub returns here after creating / installing the app |
| `GET /api/board` · `GET /api/history` | Board columns / run history (cards carry `usage`: tokens and cost across the project's runs) |
| `GET /api/projects/:slug/usage` | Tokens and cost for a project: totals, by stage, by model, by run |
| `GET /api/org/usage?days=30` | Organization spend in the window and all time, by project, plus the GitHub actor (`app` bot or `user`) |
