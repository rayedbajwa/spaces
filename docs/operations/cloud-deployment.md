# Deploying to the cloud

Spaces is three long-running pieces plus Postgres:

```mermaid
flowchart LR
  U[Browser] -->|HTTPS via authenticating proxy| A[app<br/>bun run src/server.ts]
  A --> P[(Postgres 16)]
  S[supervisor<br/>bun run src/supervisor.ts] --> P
  S -->|spawns| W1[worker: project A]
  S -->|spawns| W2[worker: project B]
  A & W1 & W2 --> D[/data volume<br/>repos · governing workspaces · agent sessions/]
  W1 & W2 --> LLM[Anthropic API]
  W1 & W2 --> GH[GitHub · Jira · Linear …]
```

| Component | Role | Scale |
|---|---|---|
| **app** | Web UI + JSON API, SSE streams, OAuth callbacks, applies the DB schema at boot | 1 instance (no sticky sessions needed) |
| **supervisor** (or **worker**) | Executes runs; the supervisor spawns one worker per active project and reaps idle ones | 1 supervisor; `SUPERVISOR_MAX_WORKERS` bounds memory (~300–500 MB per worker) |
| **Postgres** | Projects, runs, events, job queue, sealed tokens, worker heartbeats | Managed service recommended |
| **/data volume** | Cloned repositories, governing workspaces (specs, memory, reports), Pi agent sessions | Persistent disk shared by app and workers |

!!! danger "Authentication"
    The web UI has **no built-in authentication**. Never expose port 3000
    directly. Put an authenticating reverse proxy in front (Cloudflare
    Access, Tailscale, Google IAP, Caddy/nginx with OIDC or basic auth) and
    keep the app and workers on a private network. See `SECURITY.md`.

## The container image

The repository ships a multi-stage `Dockerfile` (Bun 1.4 on Alpine) that
bundles the frontend and runs as the non-root `bun` user. The image includes
`git` (agents clone, branch, commit and push), sets `HOME=/data/home` and
`AIDLC_WORKSPACE_ROOT=/data/aidlc/workspaces`, and declares `/data` as a
volume. The same image runs every role:

```bash
docker build -t spaces:latest .
docker run … spaces:latest                              # app (default CMD)
docker run … spaces:latest bun run src/supervisor.ts    # per-project workers
docker run … spaces:latest bun run src/worker.ts        # single shared worker
```

## Database: an external, dedicated Postgres

**In production, run Postgres outside the app stack, on a dedicated instance**
— a managed service (Amazon RDS / Aurora, Google Cloud SQL, Azure Database for
PostgreSQL, Neon, Supabase) or your own HA cluster. The Postgres container in
`docker-compose.yml` exists for local development only: it shares the app
host's CPU, memory and disk, has no backups, no failover and default
credentials.

Why it matters here: Postgres is not just storage. It is the **job queue**
(`SKIP LOCKED` claims, per-project concurrency), the **event stream** behind the
live log (`LISTEN/NOTIFY`), the **worker heartbeat** registry that decides
whether an answer can be delivered, and the vault for sealed OAuth tokens.
Losing it loses run history, memory and integrations; slowing it slows every
agent step.

Recommendations:

| Topic | Recommendation |
|---|---|
| Version | PostgreSQL 16 (what the schema and CI test against) |
| Size | Start at 2 vCPU / 4–8 GB and 50 GB storage; the schema is small, but event rows grow with every run (thousands of log chunks per stage) |
| Connections | Each process opens up to 10 connections (`max: 10`). Budget: app 10 + supervisor 10 + 10 per active worker; with `SUPERVISOR_MAX_WORKERS=4` allow ~70, or put PgBouncer in **session** mode in front (transaction mode breaks `LISTEN/NOTIFY` and advisory locks) |
| TLS | `DATABASE_URL=postgres://user:pass@host:5432/spaces?sslmode=require` |
| Users | A dedicated database and role owned by Spaces; the app applies DDL at boot, so the role must own the schema (or run `bun run db:migrate` with an owner role and give the app a lesser one) |
| Backups | Automated daily snapshots plus point-in-time recovery; test a restore once |
| Retention | Prune `pipeline_events` for runs older than your retention window if the database grows large |

The schema is idempotent DDL; a fresh database is initialised on the first
boot of the app (or with `DATABASE_URL=… bun run db:migrate`).

## Option A — single VM with Docker Compose + external Postgres

One VM (4 vCPU / 8 GB is comfortable for 3–4 concurrent project workers),
Docker, the production compose file and a managed Postgres.

```bash
git clone https://github.com/rayedbajwa/spaces.git && cd spaces
cp .env.example .env
# set DATABASE_URL to the external instance (…?sslmode=require),
# ENCRYPTION_KEY, ANTHROPIC_API_KEY and the OAuth client ids/secrets
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml logs -f app supervisor
```

`docker-compose.prod.yml` starts only the **app** (bound to `127.0.0.1:3000`)
and the **supervisor**, sharing the `spaces-data` volume at `/data`, with stop
grace periods that let workers re-queue or pause runs on restart. Put Caddy,
nginx or Cloudflare Tunnel in front for TLS and authentication, and point the
OAuth apps' callback URLs at `https://<your-host>/api/oauth/<provider>/callback`.

(`docker compose --profile full up` in `docker-compose.yml` bundles a Postgres
container — use that for local development and demos, not production.)

Back up the managed database (snapshots + PITR) and `/data` (or push the
governing workspaces to a git remote of your own).

## Option B — managed containers (AWS ECS/Fargate, Google Cloud Run, Azure Container Apps)

- **Database:** an external, dedicated Postgres 16 as described above (RDS,
  Cloud SQL, Azure Database). Set `DATABASE_URL` with `sslmode=require`. The
  app applies the schema at boot; you can also run `bun run db:migrate` as a
  one-off task.
- **app service:** the image with the default command, 1 task, 1 vCPU / 2 GB,
  health check `GET /health`, behind a load balancer that terminates TLS and
  enforces authentication (ALB + Cognito/OIDC, IAP, Front Door). SSE needs
  idle timeouts of a few minutes or more on the proxy.
- **supervisor service:** the image with `bun run src/supervisor.ts`, 1 task,
  2 vCPU / 4–8 GB depending on `SUPERVISOR_MAX_WORKERS`. Workers are child
  processes, so size the task for the fleet rather than one worker. On
  platforms that scale to zero or kill idle containers (Cloud Run jobs, Fargate
  Spot) prefer a shared `bun run src/worker.ts` service that stays up; runs
  interrupted by a stop are re-queued automatically.
- **Storage:** mount a persistent file system at `/data` on both services
  (EFS on ECS, Filestore on Cloud Run/GKE, Azure Files). Cloned repositories
  and governing workspaces must be visible to the app (artifact browsing,
  plan-repo matching) and to the workers (runs).
- **Secrets:** inject `ENCRYPTION_KEY`, `ANTHROPIC_API_KEY` and the OAuth
  client secrets from the platform's secret manager; never bake them into the
  image. Rotating `ENCRYPTION_KEY` invalidates every stored OAuth token.
- **Egress:** workers need HTTPS to `api.anthropic.com`, `api.github.com`,
  `github.com`, Atlassian and Linear APIs, and the package registries the
  projects use (dev-environment setup installs dependencies).

## Option C — Kubernetes

One `Deployment` per role (`app`, `supervisor`), a `Service` + authenticated
`Ingress` for the app only, a `PersistentVolumeClaim` with `ReadWriteMany`
mounted at `/data` on both, and an external or operator-managed Postgres.
Give the supervisor pod a memory request sized for `SUPERVISOR_MAX_WORKERS`
and set `terminationGracePeriodSeconds` to ~60 s so workers can re-queue or
pause their runs cleanly on rollout.

## Option D — Railway, Fly.io, Render

Create two services from the same repository (Dockerfile build): **app** with
the default command and a public domain behind an auth proxy, **supervisor**
with the start command `bun run src/supervisor.ts` and no public port. Add a
Postgres plugin/add-on and a persistent volume mounted at `/data` on both
services (on Railway, one volume can be attached to one service — attach it to
the supervisor and give the app its own smaller volume, or run app and
supervisor as one service with a process manager). Set the environment
variables from `.env.example` as service secrets.

## Environment for cloud deployments

| Variable | Recommendation |
|---|---|
| `DATABASE_URL` | External, dedicated Postgres 16 (managed service or HA cluster), TLS (`?sslmode=require`); never the bundled dev container |
| `ENCRYPTION_KEY` | From a secret manager; back it up with the database |
| `ANTHROPIC_API_KEY` | From a secret manager; verified at boot |
| `PORT` | `3000` (or what the platform injects) |
| `AIDLC_WORKSPACE_ROOT` | `/data/aidlc/workspaces` (image default) |
| `AIDLC_GOVERNANCE_ROOT` | leave default (`<workspace root>/_governance`) |
| `SUPERVISOR_MAX_WORKERS` | 3–4 per 8 GB |
| `WORKER_IDLE_EXIT_SECONDS` | `300`; raise if cold-starting workers is slow |
| `*_CLIENT_ID` / `*_CLIENT_SECRET` | OAuth apps with callbacks on the public host |

## Operations

- **Zero-downtime-ish restarts:** stop the supervisor first (SIGTERM). Running
  runs are re-queued from their stage and paused runs stay paused; the new
  supervisor picks them up. Then restart the app.
- **Health:** `GET /health` on the app; `GET /api/workers` lists live workers
  with heartbeats. Alert when a project has queued jobs and no hot/warm worker
  for more than a few minutes.
- **Logs:** JSON lines on stdout from every process (`mod` field names the
  module); ship them to your log platform.
- **Backups:** Postgres (runs, events, tokens) and `/data` (repos are
  re-clonable; governing workspaces hold specs, reports and memory — back those
  up or push them to a git remote).
- **Upgrades:** pull the new image; the app applies idempotent schema changes
  at boot, so rolling the app first, then the supervisor, is safe.
