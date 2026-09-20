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
  it. The agent puts it in the checkout's `.env` and runs the project's own
  migration step, so tests that need a database run rather than skip. Set
  `AGENT_DATABASE_URL` to create those databases on a different server.
- **`psql`**, for projects whose scripts expect it.
- **A free port**, because the port serving Spaces is taken. The agent starts
  anything under test on that port and points smoke tests at it.
- **A headless Chromium**, already installed, so Playwright and the browser
  tools run without downloading anything.

The same description is written into `.aidlc/dev-setup.md` for the stages that
follow, and a test that genuinely cannot run is recorded as skipped with its
reason rather than as a failure.

## The agent output dock

On a project page the live agent output is docked at the bottom of the
screen. Its header always shows the run status, the stage progress dots and
the controls; click it to expand or collapse the streamed log. Waiting runs
surface their question or review request there, with **Approve and
continue**, **Continue** or a free-text answer. **Pause** lets a running run
finish its current stage and then stop (a queued run is held before it
starts), **Resume** continues a paused run from that stage, and **Cancel**
ends it — finished stages keep their artifacts.

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
