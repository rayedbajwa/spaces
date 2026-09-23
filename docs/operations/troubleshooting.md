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
The stored provider key was revoked or replaced. Open **Organization →
Models**, press **Verify** on the provider to confirm, then **Replace** it. Keys
in `.env` or the shell are ignored (the boot log names any leftovers).

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

**A job has done nothing for a long time.**
Open the project's **Recent jobs**: a job idle for 10 minutes (or whose worker
stopped heartbeating) shows **Force kill**, which cancels its run and kills the
worker holding it. Start the run again afterwards if it should continue.

**"worker cap reached; project waits" in the logs.**
All `SUPERVISOR_MAX_WORKERS` slots are busy. A worker whose project has no work
left hands its slot over at once; raise the cap (or add a worker host) when
projects genuinely run in parallel.

**Projects named `test-probe-*`, `test-dispatcher-*` or `cross-a/b-*` appear.**
Test data from Spaces' own suite written into this database. Agents' shells no
longer carry the application's `DATABASE_URL` and the suite refuses non-test
databases, so new ones should not appear; archive or delete the ones left.

**A log shows `<SECRET_1>` or `<EMAIL_2>` instead of a value.**
The data guardrails at work: the model only ever saw the token. The real value
was used where the agent needed it (the command it ran, the file it wrote). See
[Data guardrails](../concepts/data-guardrails.md).

**Strict mode: "Blocked by the organization's AI data guardrails".**
The agent tried to read a secret file or print the environment. It should use
the variable by name instead (`$DATABASE_URL` in a command).

## Where things live

| Path | Contents |
|---|---|
| `~/.aidlc/workspaces/<owner>/<name>` | Cloned GitHub repositories |
| `~/.aidlc/workspaces/_governance/<slug>` | Governing workspaces (specs, memory, knowledge) |
| `<repo>/.aidlc/dev-setup.md` | Dev-environment notes (local-only) |
| `<repo>/.aidlc-worktrees/` | Workstream worktrees |
| `~/.pi/agent/sessions/` | Pi agent session files (resumed on rerun) |
