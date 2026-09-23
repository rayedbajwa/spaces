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
  connected Jira, Confluence, Linear and GitHub, scoped per project;
- a real browser, `browser_open(url)`, `browser_act(action, selector, value)`,
  `browser_read(what)`, `browser_screenshot(name)` and `browser_close()`,
  backed by headless Chromium through Playwright. Implement and QA agents start
  the app with `bash`, drive it like a user, read visible text, evaluate
  JavaScript for assertions, and save screenshots under `.aidlc/qa/` in the
  checkout as evidence for their reports. Console errors and failed requests
  are reported with every read;
- the `playwright-browser` skill from the [pi-playwright](https://pi.dev/packages/pi-playwright)
  package, loaded into every session: a CLI-first workflow over
  `@playwright/cli` (`pw.js open / snapshot / click / fill / screenshot / pdf`,
  saved auth state, console and network logs) that agents invoke through
  `bash`, with artifacts under `/tmp/pi-playwright/<session>/`.

Both need a Chromium: `make setup` runs `playwright install chromium` (also
`bun run setup:browsers`), and the Docker image ships it. `SPACES_BROWSER_PATH`
points the built-in tools at another Chromium binary.

The project assistant additionally has action tools — rerun a run, answer or
approve a paused run, run a step, start implementation agents, retry a clone,
restart onboarding, open a pull request — and uses them once you say yes.

## Models and speed

No model is named anywhere. For the provider in use (the first in the
organization's provider order that has a key), Spaces scores the catalog by
cost and speed and fills a small, medium and large tier; the project's **speed
mode** (fast / balanced / quality) and the stage family pick the tier per
stage, retries escalate a tier, and oversized prompts skip the small tier.
**Organization → Models** shows the choices and tunes the policy (cost /
balanced / quality, provider order, premium models, pins). With OpenRouter
every tier is OpenRouter's own auto-router. Templates may still pin a model
and thinking level per step; a pin from a provider without a key falls back to
the same-size tier.

## Advisory project responsibilities

When a project has responsibility assignments, stage prompts include an advisory
contact: Product Owner for specify/review, Lead Engineer for plan/implement,
Designer for design, QA for verify, and Release Manager for delivery. Explicit
assignments take precedence; an unassigned non-Owner role is labeled as an
**Owner fallback**. If no valid Owner exists, agents receive a repair-needed
note rather than a guessed contact. These contacts never grant access, approve
a gate, or change the existing human review process.

## What an agent's machine offers

Before an agent installs, builds or tests a checkout it is told what the
machine it runs on actually provides, so it verifies the work instead of
skipping checks it assumes are impossible:

- **Docker**, only when a daemon answers. The image ships the client and the
  Compose plugin, but a container cannot run a daemon: point `DOCKER_HOST` at
  an engine, or mount `/var/run/docker.sock`, to make containers usable. When
  no daemon answers, the agent is told to use the database below instead.
- **A Postgres database for the checkout**, created on demand and named after
  it (`agent_<checkout>`). The agent puts it in the checkout's `.env` and runs
  the project's own migration step, so tests that need a database run rather
  than skip. Set `AGENT_DATABASE_URL` to create those databases on a different
  server. Every checkout a run works in, the governing one and each registered
  repository, has its own database (and port, below) for the life of the
  worker; the stage prompt lists which is whose.
- **`psql`**, for projects whose scripts expect it.
- **A port of its own** in 3100–3900, because the port serving Spaces is
  taken. Checkouts start at different points of the range and a port handed
  out is not handed out again, so two workers do not collide. The agent starts
  anything under test on that port and points smoke tests at it.
- **A headless Chromium**, already installed, so Playwright and the browser
  tools run without downloading anything.

**Spaces' own secrets never reach the agent's shell.** Every command runs after
a prefix that unsets the application's `DATABASE_URL` (and its variants),
`TEST_/AGENT_DATABASE_URL`, `PG*`, `ENCRYPTION_KEY`, `SESSION_SECRET`, Railway
tokens and any `*_API_KEY` or `*_SECRET`. Without this, an agent testing Spaces
itself ran its suite against the production database (Bun does not let a
checkout's `.env` override a variable already set). The same prefix puts the
package-manager caches (bun, npm, yarn, pnpm, pip, Go) on the persistent volume
beside the workspaces, where a project has not set its own, turns on BuildKit,
and names Docker Compose stacks after the checkout (`COMPOSE_PROJECT_NAME`).

Those values are written into the checkout's own `.env` before the stage runs,
for the variables the project declares, so its ordinary tooling picks them up:
an agent cannot accidentally migrate the application's own database because it
forgot to override one. The description is also written into
`.aidlc/dev-setup.md` for the stages that follow, and a test that genuinely
cannot run is recorded as skipped with its reason rather than as a failure.

Both reach the agent the way Pi delivers standing instructions: appended to
its system prompt through the resource loader, so they hold for every turn and
survive compaction, rather than being repeated on top of each stage's prompt.

Stages whose output is evidence — orchestrate, review and verify — get the
rules that make it worth reading: name the database a result came from, commit
any probe the result rests on or mark it unverified, map every identifier in a
results table to a real test, tick a task off only when all of it is done,
keep test data separate per run and clean it up, and refresh the delivery
record in the same cycle.

## Tests by stage

Each code stage is told which tests to run, so long suites, container builds
and full-application runs happen once, where they give the answer:

| Stage | Runs |
|---|---|
| implement / orchestrate | only the tests covering what changed (`bun test <path>`, `vitest related`, `jest --findRelatedTests`, `pytest <path>`, `go test ./pkg/...`) |
| review | the full unit and integration suite, once |
| verify | the full suite, the application started with smoke/end-to-end tests against it, and the container build when the project ships a Dockerfile |

## Time limits and cleanup

- Every shell command an agent runs has a maximum time
  (`AGENT_COMMAND_TIMEOUT_SECONDS`, default 20 minutes); a longer or missing
  timeout is capped.
- When a code stage ends, what it left running is stopped: anything still
  listening on each checkout's test port, and each checkout's Compose
  containers. The run log says what (`[cleanup] …`).

## What the log shows

A stage's log carries what the agent did, not only what it said: a line per
tool call (`▸ $ bun test tests/x.test.ts`, `▸ edit src/x.ts`) and, for commands
and failures, how it ended (`✓ 2.1s · 12 pass`, `✗ 1.4s · <last line>`).
Sub-agents' logs carry the same, and their lines are mirrored into the run's
output marked with their workstream.

Every line is stamped with the time and the agent that wrote it:
`[03:41:05Z implement/developer] ▸ $ bun test`. The stage (and its role) marks
a stage's lines, `spaces` marks the orchestrator's own (setup, guards, pull
requests), and sub-agents, the merge orchestrator and task runs use their own
names. The interface shows the time in your time zone and the agent as a
coloured tag. Secrets are masked in every log, a whole line at a time.

## The agent output dock

On a project page the live agent output is docked at the bottom of the
screen. Its header always shows the run status, the stage progress dots and
the controls; click it to expand or collapse the streamed log. Waiting runs
surface their question or review request there, with **Approve and
continue**, **Continue** or a free-text answer. **Pause** lets a running run
finish its current stage and then stop (a queued run is held before it
starts), **Resume** continues a paused run from that stage, and **Cancel**
ends it — finished stages keep their artifacts.

**Interrupt** (while a run is working) opens a box for feedback: the agent reads
it after the step it is on (its current tool calls finish first) and adjusts,
without the stage being stopped; between stages it goes with the next stage's
prompt. It appears in the log as `[feedback from <name>] …` and in the run's
timeline (`feedback`, then `feedback_delivered` with when it took effect), and
is masked by the data guardrails like any prompt. Use **Pause** or **Cancel** to
stop the run instead.

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

Workers register in a `workers` table. **No worker holds a paused run.** When a
run stops at an approval gate or a question, the worker records the pause,
keeps the agent's session file on the run and lets the engine go, so it can go
idle and free its slot. Answering queues a job that any worker takes: it
reopens that session in the same paused state and continues from your answer,
exactly as if the run had never stopped.

The session file lives on the worker's disk, so a gzip-compressed copy is kept
in Postgres (`run_sessions`), refreshed after every stage and at every pause
and finish. A run that resumes where the file is missing (a new volume, another
worker host) gets it back from that copy first, and the current intent's
missing documents are restored from the database (see [Intents](intents.md)).
If there is no copy either, an approval moves on to the next stage and any
other answer re-runs the stage with the answer in its context.

**Slots go where the work is.** When a project waits at
`SUPERVISOR_MAX_WORKERS`, a worker whose project has no work left gives its
slot up at once instead of waiting out its idle timeout; one whose project has
queued jobs but runs none gives it up after a minute. A worker running a job is
never stopped.

**Force kill.** In **Recent jobs**, a job that has done nothing for 10 minutes
(or whose worker stopped heartbeating for 2) gets **Force kill**: its run is
cancelled and the worker holding it is killed (the supervisor SIGKILLs it and
starts a fresh one when there is work; a standalone worker exits and must be
restarted). Use it when a hung worker would never act on a normal **Cancel**.

## Failure handling

| Situation | Behaviour |
|---|---|
| Worker restarts while a run is executing | Run re-queued from the interrupted stage |
| Worker restarts while a run is paused | Nothing to lose: no worker holds it; answering continues it on any worker |
| Worker disk lost (new volume, other host) | The agent session is restored from its Postgres copy before the run continues |
| Transient provider error (socket closed, 5xx, overloaded) | Retried from the same stage, twice, before failing |
| Second answer while the first is being processed | Refused: the first answer takes the run out of paused |
| Job whose worker stopped heartbeating | Closed and its run handed off (no fixed 10-minute timeout) |
| Job stuck with a hung worker | **Force kill** in Recent jobs: run cancelled, worker killed and replaced |
| A command that never returns | Capped at `AGENT_COMMAND_TIMEOUT_SECONDS` (default 20 minutes) |
| A deploy while a stage runs | The worker finishes the stage (up to the drain budget) and hands the run back at the stage boundary |
| Failed or finished run | **Rerun from &lt;stage&gt;** / **Rerun from start**, resuming the previous session |

## Memory and knowledge

Each repository's brief and inventory is stored as a record; the project's auto
summary is composed from them and includes a repository map. Manual notes live
in the Memory tab. Adding, editing or removing a repository updates memory,
context and the knowledge scope. `Rebuild from code` regenerates the summary.
