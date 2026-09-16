# HTTP API

The web UI is a thin client over this JSON API (`http://localhost:3000`). Ids
in paths are UUIDs unless the route says `:slug`.

## Authentication, teams, organization

All `/api/*` routes except the ones marked public require a session cookie
(unless `AUTH_DISABLED=1`). Unauthenticated calls return `401`.

| Method & path | Purpose |
|---|---|
| `GET /api/auth/status` | public: `{ authEnabled, needsBootstrap, githubLogin }` |
| `POST /api/auth/register` | public: `{ email, password, name?, inviteToken? }`; first user bootstraps the default team, otherwise an invite (or `OPEN_REGISTRATION=1`) is required. Sets the session cookie |
| `POST /api/auth/login` · `POST /api/auth/logout` | public: `{ email, password, inviteToken? }` / clear session |
| `GET /api/oauth/github/authorize?mode=login[&invite=token]` | public: GitHub sign-in (same OAuth app as the integration) |
| `GET /api/invites/:token` | public: invite preview (team, role, email) |
| `POST /api/invites/:token/accept` | Join the team the invite is for (email must match) |
| `GET /api/me` · `POST /api/me/team` | Current user, teams and active team / switch active team `{ teamId }` |
| `GET /api/teams` · `POST /api/teams` | My teams / create a team (creator becomes owner) |
| `GET /api/teams/:id` · `PATCH /api/teams/:id` | Team detail (members, invites, memory) / rename (admin) |
| `GET/PATCH/DELETE /api/teams/:id/members[/:userId]` | Members; role changes need admin, owner grants need owner; a team keeps ≥ 1 owner |
| `GET/POST /api/teams/:id/invites` · `DELETE …/invites/:inviteId` | Invites (admin): `{ email, role }` → `{ link }` |
| `GET/PUT /api/teams/:id/memory` | Team memory (members edit) |
| `GET/PUT /api/teams/:id/knowledge` | Team default knowledge scope (admin) |
| `GET/PUT /api/org/memory` | Organization memory shared by all teams (owners/admins edit) |

Authorization: viewers get `403` on any non-GET route (except chat, invites
and their own session); project routes return `403` when the project belongs
to a team the caller is not a member of. `GET /api/projects`, `/api/board` and
`/api/history` are scoped to the active team.

## Projects

| Method & path | Purpose |
|---|---|
| `GET /api/projects` | List projects |
| `POST /api/projects` | Create: `{ name, description?, repos?, model?, feature? }`. Creates the governing workspace and starts onboarding |
| `GET /api/projects/:id` | Detail with repos, integrations and suggestions |
| `PATCH /api/projects/:id` · `DELETE /api/projects/:id` | Update / delete |
| `GET /api/projects/:id/onboarding` · `POST …/onboarding` | Onboarding progress / restart |
| `GET /api/projects/:id/suggestions` · `POST …/suggestions` | Suggested repositories & work areas / regenerate (`{ basis: 'project' | 'plan' }`) |
| `POST /api/projects/:id/export` | Export memory, knowledge and manifest into the governing workspace |

## Repositories

| Method & path | Purpose |
|---|---|
| `POST /api/projects/:id/repos` | Add `{ label, kind: 'local' | 'github', localPath?, githubRepo?, isPrimary? }`; GitHub repos clone, learn and set up in the background |
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
| `GET /api/oauth/:provider/authorize` · `…/callback` | OAuth flow |
| `GET /api/board` · `GET /api/history` | Board columns / run history |
