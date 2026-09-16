# Running and troubleshooting

## Processes

| Command | Runs |
|---|---|
| `bun run web` | Web UI + API (applies the schema at boot, verifies the API key, syncs the GitHub catalog) |
| `bun run supervisor` | One worker per active project, scaled on demand |
| `bun run worker` | A single shared worker (alternative to the supervisor) |
| `bun run db:migrate` | Apply `src/lib/db-schema.sql` by hand (idempotent) |
| `bun run e2e` | End-to-end run per pipeline template |
| `bun test` | Unit and smoke tests (smoke tests need a running server) |

Code changes take effect only after restarting the affected process. A
restart is safe: running runs are re-queued from their stage and paused runs
stay paused.

## Symptoms and causes

**Every agent call fails with `401 invalid x-api-key`.**
A placeholder `ANTHROPIC_API_KEY` in the shell overrides `.env`. Both server and
worker log a warning at boot; restart them from a shell that uses the real key.

**"Your credit balance is too low to access the Anthropic API".**
Top up the account, then **Rerun from &lt;stage&gt;**; the run kept its stage.

**A run stays queued.**
No worker is running, or the shared worker is busy. Check `GET /api/workers`
or the worker indicator in the project overview; start `bun run supervisor`.

**Approve / answer does nothing.**
The worker that paused the run has gone. The server now re-queues the stage
when the owner is not alive; make sure a worker is running.

**Run shows "interrupted".**
A worker restarted mid-stage. Nothing else went wrong; **Rerun from &lt;stage&gt;**
resumes the previous agent session.

**Integration shows "⚠ reconnect needed".**
The stored token no longer decrypts (`ENCRYPTION_KEY` changed or was saved by a
process with a different key). Reconnect the provider via OAuth.

**"column … does not exist" in the UI.**
The database is behind the code. The server applies the schema at boot; run
`bun run db:migrate` if you cannot restart it.

**Jira returns 403 "app is not installed on this instance", Confluence 401
"scope does not match".**
The Atlassian OAuth app is not installed on the site or lacks the granted
scopes; fix it in the Atlassian developer console and reconnect.

**Sub-agents finish in a second with "Completed" and one token.**
Fixed: provider errors are now surfaced per workstream and the sub-agent route
uses the same authenticated runtime and model as runs.

## Where things live

| Path | Contents |
|---|---|
| `~/.aidlc/workspaces/<owner>/<name>` | Cloned GitHub repositories |
| `~/.aidlc/workspaces/_governance/<slug>` | Governing workspaces (specs, memory, knowledge) |
| `<repo>/.aidlc/dev-setup.md` | Dev-environment notes (local-only) |
| `<repo>/.aidlc-worktrees/` | Workstream worktrees |
| `~/.pi/agent/sessions/` | Pi agent session files (resumed on rerun) |
