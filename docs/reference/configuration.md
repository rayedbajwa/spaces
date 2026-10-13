# Configuration

All settings come from environment variables (loaded from `.env` by Bun; a
shell variable overrides the file). See `.env.example` for the annotated list.

## Required

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string (matches `docker-compose.yml`) |
| `ENCRYPTION_KEY` | 32+ random characters; derives the AES-256-GCM key that seals OAuth tokens. Rotating it invalidates every stored token. |

## Models (bring your own key)

Spaces ships without model access: you bring the keys of the providers you
pay for and usage is billed to those accounts.

| Provider | Get a key | Notes |
|---|---|---|
| **Anthropic** | [console.anthropic.com → API keys](https://console.anthropic.com/settings/keys) | Claude models directly (`sk-ant-…`) |
| **OpenAI** | [platform.openai.com → API keys](https://platform.openai.com/api-keys) | GPT models directly; also serves knowledge-base embeddings (`sk-…`) |
| **OpenRouter** | [openrouter.ai → Keys](https://openrouter.ai/settings/keys) | One key for every vendor; OpenRouter routes each request itself (`sk-or-…`) |

LLM provider keys are entered under
**Organization → Models**, stored encrypted with `ENCRYPTION_KEY` and verified
when saved; they are not environment variables. No model is configured by
name either. Spaces routes automatically for the provider in use: it scores that provider's chat models by price, generation and size
class and fills three tiers — **small** (review, chat, fast mode), **medium**
(planning and implementation) and **large** (quality mode, retry escalation).
The organization policy under **Organization → Models** tunes it: preference
(cost / balanced / quality), provider order, whether premium ("pro") models
may be used, and optional pins per tier. With OpenRouter first in the order
every tier is `openrouter/openrouter/auto` and OpenRouter routes each request
itself. Templates that still pin a model from a provider without a key fall
back to the same-size tier.

| Variable | Default | Purpose |
|---|---|---|
| `EMBEDDING_MODEL` | `openai/text-embedding-3-small` | Embedding model for the organization knowledge base; served by `OPENAI_API_KEY`, or through OpenRouter (`OPENROUTER_API_KEY`) for `openai/*` and `openrouter/<vendor>/<model>` ids. Without a usable key, knowledge search is full-text only. |
| `EMBEDDING_DIMENSIONS` | `1536` | Size of the `vector` column; must match the model's output |

## Optional

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Web UI + API port |
| `PUBLIC_URL` | unset | Public origin behind a TLS-terminating proxy, for OAuth callbacks, GitHub App manifests and invite links; the forwarded headers are honoured when unset |
| `WORKER_ID` | random UUID | Worker identity (per process) |
| `WORKER_MAX_CONCURRENT_JOBS` | `4` | Jobs one worker runs at once across projects |
| `SUPERVISOR_MAX_WORKERS` | `4` | `SPACES_ROLE=all`: cap on the supervisor's per-project job processes (each ~300–500 MB) |
| `WORKER_IDLE_EXIT_SECONDS` | `300` | `SPACES_ROLE=all`: idle time before a supervisor's job process exits |
| `PROJECT_WORKERS_MAX_AWAKE` | `5` | Worker per project: how many workers may run jobs at once |
| `PROJECT_WORKER_IDLE_SECONDS` | `300` | Worker per project: idle time before a worker's job process stops (and the service can sleep) |
| `AIDLC_WORKSPACE_ROOT` | `~/.aidlc/workspaces` | Where GitHub repos are cloned (`<owner>/<name>`) |
| `SPACES_BROWSER_PATH` | Playwright's bundled Chromium, else a system Chromium/Chrome | Override the Chromium binary for the agents' built-in browser tools |
| `PLAYWRIGHT_BROWSERS_PATH` | Playwright default (`~/.cache/ms-playwright`) | Where `playwright install chromium` puts browsers; the Docker image uses `/ms-playwright` |
| `AIDLC_GOVERNANCE_WORKSPACE` | `1` | `0` keeps specs inside the application repo instead of a governing workspace |
| `AIDLC_GOVERNANCE_ROOT` | `<workspace root>/_governance` | Location of governing workspaces |
| `AIDLC_WORKTREE_ROOT` | `<repo>/.aidlc-worktrees` | Where workstream worktrees are created |
| `AGENT_DATABASE_URL` | the application's database server | Server on which each checkout's test database (`agent_<checkout>`) is created |
| `AGENT_COMMAND_TIMEOUT_SECONDS` | `1200` | Longest any shell command an agent runs may take (minimum 60) |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | Railway default | How long a deploy lets a running stage finish before the old container stops (set it to about 900) |

The package-manager caches agents use (bun, npm, yarn, pnpm, pip, Go) live in
`<workspace root>/../cache`, on the same volume as the workspaces, unless a
project sets its own.

### Agent tracing (Arize Phoenix)

Every agent session can be traced to [Arize Phoenix](https://arize.com/phoenix/):
pipeline stages, tasks, workstreams, sub-agents, development setup and the
project assistant. Each agent turn is one trace: an agent span (the turn's
input and answer) with a child span for the model response (model, tokens,
cost, output) and one per tool call (arguments, result, errors), named like
`stage · implement · turn 12`. Turns are sent as they finish, so traces appear
while a stage runs; a turn cut off by a restart is sent marked interrupted.
Spans carry the organization, project, stage, prompt and turn, and the run is
the Phoenix session, so one run's turns read as one conversation (Sessions
tab). Text is masked
by the organization's data guardrails, secrets are always redacted, and long
text is cut to 16,000 characters.

| Variable | Default | Purpose |
|---|---|---|
| `PHOENIX_COLLECTOR_ENDPOINT` | unset (tracing off) | Phoenix base URL, e.g. `http://localhost:6006` or `http://phoenix.railway.internal:6006`; spans go to `<url>/v1/traces` |
| `PHOENIX_API_KEY` | unset | Phoenix API key, when Phoenix runs with authentication |
| `PHOENIX_PROJECT_NAME` | `spaces` | Phoenix project the traces land in |
| `PHOENIX_AUTO_PROVISION` | unset | `1` on a Railway web service with `RAILWAY_PROVISIONER_TOKEN`: Spaces creates Phoenix itself (below) |

**Phoenix on Railway, automatically.** With `PHOENIX_AUTO_PROVISION=1` the web
service makes sure, on each start, that the Railway project has a `phoenix`
service: the `arizephoenix/phoenix` image, a volume at `/mnt/data`,
authentication on, generated `PHOENIX_SECRET`, `PHOENIX_ADMIN_SECRET` and
`PHOENIX_DEFAULT_ADMIN_INITIAL_PASSWORD` (kept only as that service's
variables), a public domain for the UI, and the service in the web service's
region. The web service gets `PHOENIX_COLLECTOR_ENDPOINT` (the private
`http://phoenix.railway.internal:6006`) and `PHOENIX_API_KEY` as a reference to
the admin secret, and every project worker gets references to those; nothing
is redeployed (workers take them on their next deploy). Each step checks first,
so restarts change nothing. `bun run phoenix:provision` does the same by hand.
Log in to the UI as `admin@localhost` with the password from the `phoenix`
service's variables. Phoenix's docs suggest replacing the admin secret with a
system API key once the instance is set up.

Locally: `docker compose --profile tracing up -d phoenix`, then set
`PHOENIX_COLLECTOR_ENDPOINT=http://localhost:6006` and open
http://localhost:6006. Project workers created by the provisioner inherit
these variables from the web service (on Railway as references to it).

**Evaluating agents in Phoenix.** `bun run phoenix:evals` uploads the dataset
`spaces-agent-expectations` (a passing and a failing output for each
expectation Spaces places on agent output: the verify, review, delivery and
dev-setup status lines and sections, question, task, plan and workstream
formats, no git commit/push from workstream agents, conventional commits,
JSON-only suggestions, no secrets in the clear) and runs the code checks of
`src/lib/agent-evals.ts` on it as an experiment; `matches-expected` shows the
checks agree with each sample's verdict. `--traces 300` runs the same checks
on recent real agent outputs (dataset `spaces-agent-turns`, each example
linked to its span). `--judges` prints LLM-judge prompts for the rules that
need judgement, to add as evaluators in Phoenix's UI. Set
`PHOENIX_COLLECTOR_ENDPOINT` to the Phoenix URL and `PHOENIX_API_KEY` to a
system API key (Phoenix → Settings → API Keys).

### Running the test suite

`bun test` runs a preload (`tests/setup/db-guard.ts`) that keeps the suite off
databases that are not test databases:

| Variable | Purpose |
|---|---|
| `TEST_DATABASE_URL` | Used as the suite's database when set |
| `DATABASE_URL` | Used only when it is local, or its database is named for tests (`test`, `agent`, `ci`) |
| `ALLOW_TEST_DATABASE` | `1` accepts any `DATABASE_URL` (only for a disposable database) |

Anything else (a deployed application's database, such as Railway's `railway`)
makes the database suites skip with a message instead of writing to it.

## Authentication and teams

| Variable | Default | Purpose |
|---|---|---|
| `AUTH_DISABLED` | unset | `1` turns sign-in off (single-user local use); every route is open |
| `SUPERADMIN_EMAILS` | unset | Comma-separated emails of the deployment's super admins, who manage the waitlist; when unset, the first registered account is the super admin |
| `SPACES_ROLE` | `all` | `all` runs everything in one service. `web` is the public app with no workspace disk, forwarding project work to the project's worker. `project` is one project's worker (see specs/014-project-workers) |
| `SPACES_INTERNAL_TOKEN` | unset | Shared secret between the web service and project workers; required for `web` and `project` |
| `WORKER_PROJECT_ID` | unset | The project a `project`-role service serves |
| `PROJECT_WORKER_URL_TEMPLATE` | unset | `web` role: a project worker's address before provisioning records one, e.g. `http://spaces-proj-{code}.railway.internal:3000` (`{code}`, `{slug}`, `{projectId}`) |
| `RAILWAY_PROVISIONER_TOKEN` | unset | Railway **workspace** token used to create and remove each project's worker service and volume (a project token can create but not delete); set it sealed, with `RAILWAY_PROVISIONER_TOKEN_TYPE=workspace`. Check it under the account menu → Project workers |
| `RAILWAY_PROVISIONER_TOKEN_TYPE` | `project` | `workspace` or `account` if a broader token is used instead |
| `PROJECT_WORKER_VCPUS` / `PROJECT_WORKER_MEMORY_GB` | `2` / `2` | Size of each project worker |
| `PROJECT_WORKER_REPO` | `rayedbajwa/spaces` | Repository project workers are built from; they have no branch or deployment trigger (only Spaces deploys them). Set it to your fork |
| `PROJECT_WORKER_PLATFORM` | Railway when `RAILWAY_PROVISIONER_TOKEN` is set | `railway`, `kubernetes` or `docker`; every platform setting is in [Project workers → Settings](../operations/project-workers.md#settings) |
| `OPEN_REGISTRATION` | unset | `1` lets anyone register; otherwise only the first user, invitees and people let in from the waitlist can, and the landing page offers the waitlist |
| `DEFAULT_TEAM_NAME` | `Default team` | Name of the team created for the first user |
| `DEFAULT_ORG_NAME` | `Organization` | Name of the organization created for the first user |
| `GITHUB_SIGNIN_CLIENT_ID` | unset | Client id of the GitHub OAuth app used for "Continue with GitHub" |
| `GITHUB_SIGNIN_CLIENT_SECRET` | unset | Its client secret; both are needed or the button is not offered |

Sessions are HttpOnly cookies (30 days; `Secure` when served over HTTPS).
Signing in identifies a person to the whole deployment, so it uses its own
GitHub OAuth app from the two variables above, never an organization's
integration credentials. Register the app on GitHub with the callback
`<your origin>/api/oauth/github/callback`.

## Integrations (OAuth)

Not configured through the environment. A team owner or admin sets each
provider app up under **Organization → Integrations**; credentials are
stored encrypted with `ENCRYPTION_KEY`. GitHub is created for you as a GitHub
App (manifest flow) and Slack from a prefilled manifest; Atlassian and Linear
are registered by hand with callback
`http://<host>:<port>/api/oauth/<provider>/callback` and these scopes (the
card shows them ready to copy). The GitHub scopes below only apply when a
classic OAuth App is pasted in; a GitHub App carries its permissions itself.

| Provider | Scopes |
|---|---|
| GitHub | `repo`, `read:org`, `read:user` |
| Atlassian (Jira + Confluence) | `read:jira-user`, `read:jira-work`, `write:jira-work`, `read:confluence-content.all`, `read:confluence-content.summary`, `read:confluence-space.summary`, `search:confluence`, `write:confluence-content`, `offline_access` — enable the same scopes on the app's Permissions page, and reconnect after adding any |
| Linear | `read`, `write` |
| Slack | `channels:manage`, `channels:read`, `channels:join`, `chat:write`, `users:read`, `users:read.email`, `im:write` |

## Per-project settings (UI)

- **Orchestrator** (overview): autonomous mode (auto-approve gates), max
  concurrent runs, speed mode (fast / balanced / quality).
- **Knowledge scope** (Context tab): which integrations and repositories the
  project's agents may query, with Jira project keys, Linear teams/projects,
  Confluence spaces and GitHub repos.
- **Repositories** (overview): add, edit, make primary, relearn, retry clone.

## Files agents write

| File | Written by | Purpose |
|---|---|---|
| `.aidlc/dev-setup.md` | dev-environment setup | Install/build/test/lint commands, test baseline, blockers (local-only) |
| `specs/<feature>/code-review.md` | `review` | Review status and findings |
| `specs/<feature>/delivery-status.md` | before `deliver`/`review` | PR, CI, merge, deploy state from GitHub |
| `specs/<feature>/delivery-report.md` | `deliver` | Delivery status, UAT results, pending approvals |
