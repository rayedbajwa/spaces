# HTTP API

The web UI is a thin client over this JSON API (`http://localhost:3000`). Ids
in paths are UUIDs unless the route says `:slug`.

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
