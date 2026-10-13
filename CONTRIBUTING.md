# Contributing to Spaces

Thanks for your interest in Spaces. This document is a quick guide to getting a
local dev environment running and the conventions we follow when reviewing
pull requests.

## Getting set up

Prerequisites:

- [Bun](https://bun.sh) 1.4+ (`curl -fsSL https://bun.sh/install | bash`)
- Docker + Docker Compose (for Postgres)
- An Anthropic (or OpenAI) API key

```bash
git clone https://github.com/<your-fork>/spaces.git
cd spaces
cp .env.example .env    # fill in ENCRYPTION_KEY + ANTHROPIC_API_KEY at minimum
bun install
bun run db:up           # start Postgres via docker compose
bun run db:migrate      # apply schema
bun run dev             # web UI on http://localhost:3000
bun run worker          # in a second terminal
```

Open http://localhost:3000, create a project, and run a pipeline end-to-end.

## Development workflow

- **One PR per logical change.** If you're touching multiple areas, split them.
- **Typecheck must pass:** `bun run typecheck`
- **Tests must pass:** `bun test`
- **No committed secrets.** Anything sensitive belongs in `.env`, not source.
- **Follow existing conventions.** Match the code style, naming, and structure
  of the files near the code you're changing.
- **Keep PRs focused.** Refactors that aren't necessary for the change should
  land separately.

## Areas we especially welcome contributions in

- Additional pipeline templates in `data/pipelines/`
- Additional personas in `data/personas/`
- New integrations (Linear, Notion, GitLab, Bitbucket) — the `oauth.ts`
  provider registry makes this a small change
- Test coverage — especially for `src/lib/dispatcher.ts`, `agent-pool.ts`, and
  `pipeline-engine.ts`
- Documentation improvements

## Architecture at a glance

One image, three roles (`SPACES_ROLE`): `all` (local default: server +
supervisor), `web` (public app, no disk, runs no agents) and `project` (one
project's server + job worker on its own volume). Postgres is the database,
the job queue (`SKIP LOCKED`) and the event bus (`LISTEN/NOTIFY`). The full
picture, with scaling and failure modes, is in
[docs/concepts/architecture.md](docs/concepts/architecture.md).

```
Browser ── HTTPS / SSE ──► web (src/server.ts)
                              │  forwards project routes, wakes, deploys idle workers
                              ▼
                  project worker (src/standalone.ts, SPACES_ROLE=project)
                              │
                              ├──► src/worker.ts ── claims jobs (src/lib/dispatcher.ts)
                              │       └──► src/lib/pipeline-engine.ts ──► Pi SDK agents
                              └──► Postgres: runs, events, project_jobs, run_sessions
```

- `src/standalone.ts` — entry point for every role
- `src/server.ts` — Bun HTTP server: UI, API, SSE, OAuth
- `src/worker.ts`, `src/supervisor.ts` — job worker; per-project supervisor (`all` role)
- `src/lib/project-forward.ts` — which routes the web service forwards to a worker
- `src/lib/worker-provisioner.ts`, `src/lib/worker-platform-*.ts` — workers on Railway, Kubernetes, Docker
- `src/lib/worker-wake.ts`, `worker-sleep.ts`, `worker-rollout.ts` — wake, sleep, idle updates
- `src/lib/pipeline-engine.ts`, `src/lib/aidlc.ts` — pipeline templates on the Pi SDK
- `src/lib/dispatcher.ts` — job queue with per-project concurrency limits
- `src/lib/agent-pool.ts` — cross-run warm agent pool
- `src/lib/tracing.ts`, `src/lib/phoenix-annotations.ts`, `src/lib/agent-evals.ts` — Arize Phoenix
- `src/lib/oauth.ts` — generic OAuth 2.0 flow, provider registry
- `src/lib/crypto-vault.ts` — AES-256-GCM sealing for stored tokens
- `src/web/` — React frontend (single-page app, bundled by `Bun.build`)
- `data/pipelines/*.yml` — pipeline template DSL
- `data/personas/*.md` — persona system prompts

To test the worker layout locally, use `docker-compose.workers.yml` or a local
Kubernetes cluster (see [Project workers](docs/operations/project-workers.md)).

## Filing bugs and feature requests

Please use the issue templates in `.github/ISSUE_TEMPLATE/`. Include:

- What you expected to happen
- What actually happened
- Steps to reproduce (the smaller, the better)
- Relevant log output (redact any secrets)

## Security

If you discover a security issue, please **do not** open a public issue.
See [SECURITY.md](SECURITY.md).

## Licensing of contributions

Spaces is source-available under a personal-use license (see
[LICENSE](LICENSE)), not an open-source one. By submitting a contribution, you
confirm you have the right to submit it, and you grant the copyright holder a
perpetual, worldwide, royalty-free license to use, modify, sublicense and
relicense it, including under the terms in [LICENSE](LICENSE).
