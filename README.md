# Spaces

**An open-source, agent-driven SDLC orchestrator for software development teams.**

Spaces runs an AI-driven Software Development Life Cycle — `specify → plan →
tasks → implement → verify` — across a fleet of specialized agents, with a web
UI to inspect every step, human-in-the-loop review gates, and app-wide OAuth
integrations for GitHub, Jira, Confluence, and Slack.

Think of it as a project board where every card is powered by a persistent
agent that knows the codebase, your team's conventions, and the artifacts of
every previous stage.

Built on the [AIDLC framework](https://github.com/awslabs/aidlc-workflows)
(AI-Driven Development Life Cycle) and the
[Pi Coding Agent SDK](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).

**Tags:** `agentic-workflows` · `aidlc` · `sdlc-automation` · `ai-development` ·
`llm-orchestration` · `pipeline-orchestrator` · `spec-kit` · `claude` ·
`developer-tools`

---

## Screenshots

### The board

Every project is a card with a readable code (`COMP-1`) on a kanban board that
derives its lane (Backlog → Initialized → Specified → Planned → Tasked →
Implementing → Done) from the artifacts the project has produced. The
**Integrations** chip shows connection status; the account menu switches
teams and opens team and organization pages.

![Spaces board with a project in flight](docs/screenshots/board.png)

### Project page with the agent output dock

Each project has its own page at `/spaces/<code>`. The live agent output is
docked at the bottom: stage progress, the streamed log, approval and
clarification prompts, and **Pause**, **Resume** and **Cancel** for the run.
Tabs cover specs, tests, implementation, QA, the assistant, context, memory
and lessons.

![Project page with a running pipeline and the docked agent output](docs/screenshots/project-page.png)

### Organization knowledge base

Import Confluence spaces, Jira projects, Linear teams, projects and
initiatives, GitHub repository docs and issues, web pages and notes. Content
is chunked and indexed in Postgres (full-text plus pgvector embeddings);
agents search it with `org_knowledge_search` and every stage starts with the
excerpts relevant to its project.

![Knowledge base with imported sources and the integration picker](docs/screenshots/knowledge-base.png)

### Team page

Members and roles, invite links, team memory and the knowledge defaults new
projects inherit, on a page of its own at `/teams/<slug>`.

![Team settings page](docs/screenshots/team-page.png)

### Self-serve integrations

OAuth app credentials are entered once at the organization level and stored
encrypted; each provider card shows the callback URL and scopes to register
and the connection state of the integrations it powers. Nothing lives in
`.env`.

![Integrations with credential cards](docs/screenshots/integrations.png)

### Generated artifacts, browsable in-app

Every stage produces markdown artifacts (`spec.md`, `plan.md`, `tasks.md`,
`test-plan.md`, `verification-report.md`, etc.) that render inline in the app.

![Generated spec.md rendered in the browser](docs/screenshots/generated-spec.png)

---

## Who is this for?

- **Engineering leads** who want AI to run the boilerplate steps of feature
  delivery — spec, plan, tasks, tests — while keeping human review gates at the
  points that matter.
- **Solo developers** and **small teams** who want an agentic workflow that
  spans multiple projects, remembers prior context per project, and reuses
  warm agent sessions across runs.
- **Anyone experimenting with agentic SDLC patterns** who wants a real,
  runnable reference implementation of the AIDLC framework backed by
  Postgres, a job queue, and a project-board UI.

Spaces is **not** a code generator you fire and forget. It's a workflow
runtime that puts explicit review gates between stages and gives you the
inspectable artifacts each stage produces.

## Highlights

- **AIDLC pipeline templates** — declarative YAML DSL for stage/role/model/branch/retry
- **Research before specify** — a `research` stage suggests and clones the
  repositories a feature needs, learns them, loads the organization knowledge
  base and repository briefs, and writes a research brief the specification
  builds on
- **Per-project orchestrator + warm agent pool** — sub-agents dispatched per
  workstream; agent sessions are reused across runs for lower latency
- **Cross-model handoff memory** — the last few stages' key outputs are
  injected as a preamble so the next model has context even when you swap
  Sonnet → Opus → Haiku mid-pipeline
- **Repo-local changes** — each implementation repository gets
  `specs/<initiative-id>/` (`change.yaml`, `tasks.md`, `spec.md`) committed with
  its code and PR, linked back to the initiative in the governing workspace by
  stable `github.com/org/repo` identifiers
- **Human-in-the-loop review gates** after `specify`, `plan`, `tasks`,
  `testplan`, `implement`, `verify`
- **Live streaming output** in a bottom dock with stage progress, approvals,
  answers, and pause / resume / cancel for the run
- **Kanban board** with automatic lane derivation from artifact state, plus a
  page per project (`/spaces/COMP-1`) with a readable code derived from the
  team name
- **Project lifecycle** — pause (queued work waits, runs stop at the next
  stage boundary), archive (cancels work, hides the project, reversible) and
  a guarded permanent delete that requires the archived project's code
- **Organization and team pages** — memory, knowledge base, promotions,
  teams and integrations for the organization; members, invites, memory and
  knowledge defaults per team
- **Accounts, teams and invites** — email/password or GitHub sign-in; teams
  (AIDLC "spaces") own projects, memory and knowledge, with owner/admin/member/
  viewer roles and invite links; organization memory is shared by every team
- **Self-serve OAuth integrations** — GitHub, Jira, Confluence, Linear, Slack.
  App credentials are entered in the UI at the organization level and stored
  encrypted (AES-256-GCM) along with the tokens; nothing in `.env`
- **Per-project long-term memory** and automatic memory summaries
- **Organization knowledge base (RAG)** — import Confluence spaces, Jira and
  Linear projects and initiatives, GitHub repository docs and issues, web pages
  and notes; chunked and indexed in Postgres (full-text + pgvector embeddings),
  searched by agents through `org_knowledge_search` and fed into every stage's
  context. Works with OpenAI or OpenRouter embeddings; degrades to keyword
  search without them
- **Automatic model routing** — no model names anywhere: for the provider in
  use, the catalog is scored by cost and speed into small / medium / large
  tiers, tuned by an organization policy (cost / balanced / quality, provider
  order, premium models, pins); with OpenRouter, OpenRouter routes each request
- **Postgres-backed** job queue with per-project concurrency (SKIP LOCKED),
  stale-job reaper, and LISTEN/NOTIFY for reactive workers

---

## Documentation

Full docs are published at **https://rayedbajwa.github.io/spaces/** (built from
`docs/` with MkDocs Material by the `Docs` workflow on every push to `main`).

## Quickstart

Prerequisites: [Bun](https://bun.sh) 1.4+, Docker (for Postgres), an
Anthropic API key.

```bash
git clone https://github.com/<you>/spaces.git
cd spaces
cp .env.example .env
# Edit .env — set ENCRYPTION_KEY (openssl rand -base64 48) + an LLM key
#   (ANTHROPIC_API_KEY, OPENROUTER_API_KEY or OPENAI_API_KEY)
bun install
bun run db:up
bun run db:migrate
bun run dev       # web UI on http://localhost:3000
bun run worker    # in a second terminal
```

Open [http://localhost:3000](http://localhost:3000), click **New project**,
walk through the 4-step wizard, and you'll have an AI-managed pipeline
running.

Or let the Makefile do it:

```bash
make setup        # .env with a fresh ENCRYPTION_KEY, bun install, Postgres, schema, frontend
make up           # web server + supervisor in the background (.run/*.log)
make status       # processes, live workers, queue depth
make e2e          # bring the stack up and run the end-to-end suite for every pipeline
make e2e-one T=aidlc-express
make down
```

---

## Architecture

```
┌─────────┐     SSE + HTTP     ┌──────────────┐
│ Browser │ ─────────────────► │  src/server  │  (Bun.serve)
└─────────┘                    └──────┬───────┘
                                      │
                                      ▼
                              ┌──────────────┐
                              │   Postgres   │  pipeline_runs, project_jobs,
                              │              │  app_integrations, artifacts…
                              └──────┬───────┘
                                     │  LISTEN/NOTIFY + 5s poll floor
                                     ▼
                              ┌──────────────┐
                              │  src/worker  │  claims jobs via SKIP LOCKED
                              └──────┬───────┘
                                     │
              ┌──────────────────────┼──────────────────────┐
              ▼                      ▼                      ▼
     ┌───────────────┐     ┌──────────────────┐    ┌─────────────────┐
     │  agent-pool   │     │  pipeline-engine │    │   dispatcher    │
     │ warm sessions │◄───►│  per-stage model │    │ per-project     │
     │ + reaper      │     │  + handoff memo  │    │ concurrency SQL │
     └───────┬───────┘     └────────┬─────────┘    └─────────────────┘
             │                      │
             └──────────┬───────────┘
                        ▼
              @earendil-works/pi-coding-agent (Pi SDK)
                        │
                        ▼
                    LLM provider
                    (Anthropic / OpenAI)
```

Key files:

- `src/server.ts` — Bun HTTP server, routes for projects/runs/orchestrator/oauth
- `src/worker.ts` — dispatcher loop that claims jobs and runs pipelines
- `src/lib/aidlc.ts` — thin wrapper around Pi SDK's `AIDLCFlow`
- `src/lib/pipeline-engine.ts` — pipeline template execution (per-stage models, handoff memory)
- `src/lib/dispatcher.ts` — job queue with per-project concurrency limits
- `src/lib/agent-pool.ts` — cross-run warm agent pool
- `src/lib/oauth.ts` — generic OAuth 2.0 flow, provider registry
- `src/lib/crypto-vault.ts` — AES-256-GCM sealing for stored tokens
- `data/pipelines/*.yml` — pipeline template DSL
- `data/personas/*.md` — persona system prompts
- `data/org/*` — shared org context injected into every run

---

## Configuring integrations

Each integration is optional. When configured, agents can pull context from
the connected system (issues, tickets, docs, messages) and integrations show
as connected dots in the hero.

Everything is self-serve from **Organization → Integrations** (or the
**Integrations** chip in the top bar). For each provider:

1. Press **Add credentials**. The card shows the callback URL and the scopes to
   register, with a link to the provider's developer console.
2. Register an OAuth app there (Jira **and** Confluence share one Atlassian
   app), paste its client id and secret into the card and save. Secrets are
   stored encrypted; an owner or admin of any team can do this.
3. Press **Connect** and approve. The connection is shared by every team.

Nothing about integrations lives in `.env`.

Tokens are encrypted with `ENCRYPTION_KEY` and stored in the `app_integrations`
Postgres table. Rotating `ENCRYPTION_KEY` invalidates every stored token.

### GitHub-hosted repositories

Repos can be registered as local paths or as `owner/name` GitHub repos. With
GitHub connected, the new-project wizard autocompletes from the repos the
account can see. GitHub repos are cloned into `~/.aidlc/workspaces/<owner>/<name>`
(override with `AIDLC_WORKSPACE_ROOT`) as the **first** step of project
onboarding, and every run targets that clone. The token is passed to git as a
per-command header and never written into the clone.

### Governing workspace, repository catalog and long-term storage

Every new project gets a **governing workspace**: a local git repository
(`~/.aidlc/workspaces/_governance/<slug>`, override with
`AIDLC_GOVERNANCE_ROOT`, disable with `AIDLC_GOVERNANCE_WORKSPACE=0`) that is
the project's primary repo. It owns the Spec Kit workspace and every feature's
specs, plans, tasks and reports, plus exported project memory (`memory/`),
imported knowledge (`knowledge/`) and a `project.json` manifest. Exports are
committed after each stage pause/completion, so the workspace's git history on
local disk is the project's long-term store (push it to a remote of your
choosing if you want an off-machine copy).

No code repository has to be selected up front. When GitHub is connected, all
repositories the account can see are indexed into a **repository catalog**
(name, language, topics, README-derived use case; refreshed on connect and
every 6 hours) that is part of the shared context. The `plan` stage names the
repositories a feature touches from that catalog; after the plan completes,
unregistered ones are added to the project, cloned, learned and set up
automatically, so implementation runs in real checkouts.

### Reruns keep their context

Re-running or resuming a run from a stage reopens the previous attempt's agent
session (the same conversation, tool results and files read) and seeds the
cross-stage handoff thread from what earlier stages recorded, instead of
starting the worker from scratch.

### Suggested repositories and work areas

Onboarding ends by suggesting which repositories the project should span and
which work areas (services, modules, flows) the work will touch, using the
project description, the first feature and the synced GitHub catalog. The
suggestions are refreshed from `plan.md` after each plan stage. The project
overview shows them with reasons, confidence and role; unregistered repos get
an **Add & clone** button, work areas list the repos, likely paths and risks,
and **refresh** regenerates them (`POST /api/projects/:id/suggestions`).

### Repositories a feature depends on

The `plan` stage writes a `## Repositories` section in `plan.md` naming every
repository the feature changes (using the project's repository map) and
flags any it needs that is `(not registered)`. The project overview compares
that list with the registered repos: missing GitHub repos get an **Add &
clone** button, others an add form, and registered repos can be edited,
re-cloned or made primary. Workstreams then run in the right checkout via
their `### Repository` field.

### Project onboarding

Creating a project runs an onboarding job the wizard waits on: clone remote
repos → initialize the Spec Kit `.specify/` workspace in the primary repo →
inventory every repo (stack, layout, scripts) → a read-only agent writes a
project brief per repo → the result is stored as the project's auto-summary
memory and fed to every later stage. Multi-repo projects get a repository map
so plans and workstreams can name the repo they touch.

### Integrations as knowledge

Connected Jira, Confluence, Linear and GitHub are exposed to agents as two
tools, `integration_search(source, query)` and `integration_get(source, id)`,
plus a "Knowledge Sources" note in the shared context that tells agents to
fetch referenced tickets/docs rather than guess. Per project, the **Context**
tab lets you choose which sources and repos are in scope and narrow them
(Jira project keys, Linear teams/projects, Confluence spaces, GitHub repos);
agents only see what you selected. The wizard's **Import from Jira / Linear**
pulls a ticket into the project as a source snapshot and pre-fills the first
feature.

[pi-knowledge](https://pi.dev/packages/pi-knowledge) (`pi install npm:pi-knowledge`)
is complementary: it adds local semantic search over files, PDFs and URLs. The
tool names here were chosen not to collide with it.

### Dev-environment setup before code stages

Every registered repository — primary and secondary — is set up, first during
onboarding and again whenever a repo is added or its setup record is stale.
Before `implement`, `orchestrate` and `verify` (and before parallel
sub-agents run in a checkout), an agent reviews the README, CONTRIBUTING,
manifests and CI config, installs dependencies, prepares `.env` from its
example with safe defaults, runs the build, tests and linter once, and records
the working commands and test baseline in `.aidlc/dev-setup.md` (local-only,
excluded via `.git/info/exclude`). Later stages read that file for the exact
commands; the step is skipped while a READY/PARTIAL record under a week old
exists.

### Delivery: review → merge → deploy → UAT

The `tasks` stage ends with a "## Delivery" group per repository in dependency
order, and the new `deliver` stage drives it. Before the stage runs, the
pipeline refreshes `delivery-status.md` from GitHub: every PR the feature
opened, its review, CI, merge and deployment state, ordered by stack. The
agent then fixes what blocks a PR itself (rebase, CI, review comments, missing
PRs), asks for approval with a `## Question` and pauses before merging or
deploying, confirms deployments, runs the UAT scenarios from `test-plan.md`
against the deployed environment, and writes `delivery-report.md` with a
`Delivery Status: MERGED | PARTIAL | BLOCKED` line. Templates can loop
`deliver` on `delivery_status != 'MERGED'` after the human gate to keep
polling until everything is merged.

Agents in general are directed to act rather than advise: fix lint, tests,
dependencies and CI themselves and re-check, asking for approval only before
irreversible or costly actions. The project assistant follows the same rule
and can open PRs, rerun or approve runs and run steps once you say yes.

### Implementation harness: tasks → PR + CI → code review → QA

In the feature template the code stages form a loop: `implement` executes the
tasks and opens or updates the PR (Conventional Commits title); the new
`review` stage refreshes CI state from GitHub, reviews the diff against the
spec, plan and test plan, runs lint/tests itself, writes `code-review.md`
(`Code Review Status: APPROVED | CHANGES_REQUESTED`, findings with severity
and file:line) and posts it as a comment on the PR. `CHANGES_REQUESTED` loops
back to `implement`, which must address every blocker/major finding before
continuing; `APPROVED` proceeds to `verify` (QA) and then `deliver`. Every
commit and PR title the pipeline writes follows Conventional Commits
(`type(scope): subject`).

### Pull requests

When the target repo is GitHub-hosted, the `implement`, `orchestrate` and
`verify` stages commit the feature branch, push it and open or update a pull
request against the default branch (verify adds a comment with the
verification status). Parallel workstreams each run in an isolated git
worktree on their own branch and get their own PR; a workstream whose
`### Dependencies` names another workstream is branched from that workstream's
branch and its PR targets it — a stacked PR — and workstreams run in
dependency order.

### Workers: shared or one per project

`bun run src/worker.ts` starts one shared worker that runs jobs from different
projects concurrently (`WORKER_MAX_CONCURRENT_JOBS`, default 4) while still
honouring each project's `max_concurrent`.

`bun run src/supervisor.ts` scales instead: it watches the job queue and spawns
a dedicated worker for every project that has work, each claiming only its own
project's jobs. A worker is **hot** while running jobs, **warm** while alive but
idle (it keeps paused runs' engines in memory), and exits after
`WORKER_IDLE_EXIT_SECONDS` (default 300) of idleness; the supervisor respawns it
the moment new work appears. `SUPERVISOR_MAX_WORKERS` (default 4) caps the
fleet; each worker is a Bun process holding live agent sessions, roughly
300–500 MB, so size the cap to the host's memory. Workers
heartbeat into the `workers` table, which drives the worker indicator in the
project overview and lets the server detect a dead owner when routing answers.

### Runs that fail or get interrupted

A worker restart no longer marks in-flight runs as failed: running runs are
re-queued from the interrupted stage and paused runs stay paused (answering
restarts the stage on a new worker). Transient provider errors (socket closed,
5xx, overloaded) retry from the same stage automatically. Any failed or
finished run can be re-run from the stage it stopped at, or from the start,
with `POST /api/runs/:id/rerun` or the buttons in the run panel.

---

## Authoring pipeline templates

Templates in `data/pipelines/*.yml` describe the stages, personas, and gates
of a pipeline. A minimal example:

```yaml
name: my-mvp
description: Fast MVP pipeline
stages:
  - id: specify
    role: architect
    model: claude-sonnet-4-5
  - id: plan
    role: architect
    model: claude-sonnet-4-5
    thinking: extended
  - id: tasks
    role: developer
    model: claude-haiku-4-5
  - id: implement
    role: developer
    model: claude-sonnet-4-5
    branch:
      onComplete: verify
  - id: verify
    role: qa
    model: claude-sonnet-4-5
    maxIterations: 3
```

See the shipped templates (`aidlc-mvp.yml`, `aidlc-feature.yml`,
`aidlc-enterprise.yml`) for full-featured examples with branching, retry, and
per-stage model selection.

---

## Deployment note

Spaces is designed for **local, single-user development** by default. There
is no built-in authentication on the web UI. **Do not expose it to the
public internet** without putting an authenticating reverse proxy in front
(Cloudflare Access, Tailscale, Caddy basic-auth, etc.).

See [SECURITY.md](SECURITY.md) for the full list of caveats before deploying,
and the [cloud deployment guide](https://rayedbajwa.github.io/spaces/operations/cloud-deployment/)
for running the app, supervisor and Postgres with Docker Compose, managed
containers (ECS/Cloud Run/Container Apps), Kubernetes, or Railway/Fly/Render.
The shipped image includes git and stores repos, governing workspaces and agent
sessions under a `/data` volume. For production use an **external, dedicated
Postgres 16** (managed service or HA cluster) and
`docker compose -f docker-compose.prod.yml up -d --build`, which runs only the
app and the supervisor; the Postgres container in `docker-compose.yml` is for
local development.

---

## Contributing

PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, conventions,
and areas where contributions are especially useful.

---

## License

[MIT](LICENSE)
