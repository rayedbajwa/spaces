# Contributing to Spaces

Thanks for your interest in Spaces. This document is a quick guide to getting a
local dev environment running and the conventions we follow when reviewing
pull requests.

## Getting set up

Prerequisites:

- [Bun](https://bun.sh) 1.1+ (`curl -fsSL https://bun.sh/install | bash`)
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

```
Browser ── SSE / HTTP ──► src/server.ts (Bun.serve)
                              │
                              ▼
                        pipeline_runs, project_jobs (Postgres)
                              │
                              │ LISTEN/NOTIFY + poll floor
                              ▼
                          src/worker.ts
                              │
                              ├──► src/lib/agent-pool.ts   (warm SessionManagers)
                              ├──► src/lib/pipeline-engine.ts
                              │       └──► @earendil-works/pi-coding-agent
                              └──► src/lib/dispatcher.ts   (SKIP LOCKED SQL)
```

- `src/server.ts` — Bun HTTP server, routes for projects/runs/orchestrator/oauth
- `src/worker.ts` — dispatcher loop that claims jobs and runs pipelines
- `src/lib/aidlc.ts` — thin wrapper around Pi SDK's `AIDLCFlow`
- `src/lib/pipeline-engine.ts` — pipeline template execution (per-stage models,
  handoff memory, hooks)
- `src/lib/dispatcher.ts` — job queue with per-project concurrency limits
- `src/lib/agent-pool.ts` — cross-run warm agent pool
- `src/lib/oauth.ts` — generic OAuth 2.0 flow, provider registry
- `src/lib/crypto-vault.ts` — AES-256-GCM sealing for stored tokens
- `src/web/` — React frontend (single-page app, bundled by `Bun.build`)
- `data/pipelines/*.yml` — pipeline template DSL
- `data/personas/*.md` — persona system prompts

## Filing bugs and feature requests

Please use the issue templates in `.github/ISSUE_TEMPLATE/`. Include:

- What you expected to happen
- What actually happened
- Steps to reproduce (the smaller, the better)
- Relevant log output (redact any secrets)

## Security

If you discover a security issue, please **do not** open a public issue.
See [SECURITY.md](SECURITY.md).
