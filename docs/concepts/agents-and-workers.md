# Agents, workers and context

## Agents act, not advise

Every agent session runs under shared directives: when a problem is within
reach — a lint or type error, a failing test it touched, a missing dependency,
a red CI job, a conflict to rebase, a missing pull request — it fixes it, runs
the commands and re-checks. It asks for approval (a `## Question N:` heading,
then a pause) only before irreversible or costly actions: merging a PR,
deploying, deleting or migrating data, touching repositories outside the
project.

Every session has the built-in Pi tools (`read`, `bash`, `edit`, `write`,
`grep`, `find`, `ls` as appropriate) plus:

- `web_fetch(url)` and `web_search(query)` for documentation and error messages;
- `integration_search(source, query)` and `integration_get(source, id)` for
  connected Jira, Confluence, Linear and GitHub, scoped per project.

The project assistant additionally has action tools — rerun a run, answer or
approve a paused run, run a step, start implementation agents, retry a clone,
restart onboarding, open a pull request — and uses them once you say yes.

## Models and speed

Runs default to `anthropic/claude-sonnet-4-5`; templates can pin a model and
thinking level per step, and the project's **speed mode** (fast / balanced /
quality) feeds a model router that picks Haiku, Sonnet or Opus per stage. The
API key in the environment overrides `.env` and is verified at boot.

## Workers

Jobs land in a Postgres queue (`project_jobs`) with per-project concurrency.
Two ways to run them:

- **Shared worker** — `bun run worker`: one process running jobs from different
  projects concurrently (`WORKER_MAX_CONCURRENT_JOBS`, default 4).
- **Supervisor** — `bun run supervisor`: watches the queue and spawns one
  worker per project with work; each claims only its project's jobs, heartbeats
  (**hot** while running, **warm** while idle) and exits after
  `WORKER_IDLE_EXIT_SECONDS`. `SUPERVISOR_MAX_WORKERS` (default 4) caps the
  fleet; each worker is a Bun process holding live agent sessions
  (~300–500 MB).

Workers register in a `workers` table. The server only routes an answer to the
worker that owns a paused run when that worker is alive; otherwise it
re-queues the paused stage so a new worker restarts it.

## Failure handling

| Situation | Behaviour |
|---|---|
| Worker restarts while a run is executing | Run re-queued from the interrupted stage |
| Worker restarts while a run is paused | Stays paused; answering restarts the stage on a new worker |
| Transient provider error (socket closed, 5xx, overloaded) | Retried from the same stage, twice, before failing |
| Second answer while the first is being processed | Ignored with a timeline note (previously failed the run) |
| Job whose worker stopped heartbeating | Closed and its run handed off (no fixed 10-minute timeout) |
| Failed or finished run | **Rerun from &lt;stage&gt;** / **Rerun from start**, resuming the previous session |

## Memory and knowledge

Each repository's brief and inventory is stored as a record; the project's auto
summary is composed from them and includes a repository map. Manual notes live
in the Memory tab. Adding, editing or removing a repository updates memory,
context and the knowledge scope. `Rebuild from code` regenerates the summary.
