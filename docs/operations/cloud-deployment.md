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

!!! warning "Authentication and exposure"
    Sign-in is on by default: the first account becomes owner and everyone
    else joins by invite link. Still, agents run code and hold repository
    tokens, so keep the deployment small and trusted: TLS in front (platforms
    do this for you), a strong `ENCRYPTION_KEY`, and consider an extra
    authenticating proxy (Cloudflare Access, Tailscale, IAP) for anything
    reachable from the internet. See `SECURITY.md`.

## The container image

The repository ships a multi-stage `Dockerfile` (Bun 1.4 on Debian, which
Playwright's Chromium needs) that bundles the frontend, installs Chromium and
its libraries for the agents' browser tools, and runs as the non-root `bun`
user (the entrypoint
starts as root only to fix the ownership of a freshly mounted `/data`
volume, then drops privileges). The image includes `git` (agents clone,
branch, commit and push), sets `HOME=/data/home` and
`AIDLC_WORKSPACE_ROOT=/data/aidlc/workspaces`; mount a volume at `/data`.
The same image runs every role:

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
# and ENCRYPTION_KEY (provider keys and integrations are set up in the UI)
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
- **Secrets:** inject `DATABASE_URL` and `ENCRYPTION_KEY` from the
  platform's secret manager; never bake them into the image. Provider keys and
  OAuth apps are entered in the app and stored encrypted. Rotating
  `ENCRYPTION_KEY` invalidates every stored key and token.
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

## Option D — Railway

Railway is the quickest path to a hosted Spaces: one service built from the
repository's `Dockerfile`, one Postgres database and one volume. The
repository ships a `railway.json` that sets the start command, the health
check and the restart policy, so the dashboard needs almost no configuration.

**Why one service.** A Railway volume attaches to exactly one service, and
the app and the workers must share `/data` (cloned repositories, governing
workspaces, agent sessions). `bun run src/standalone.ts` therefore runs the
web server and the supervisor together in one container: the supervisor
still spawns one worker per active project, and if either process dies the
service exits and Railway restarts it.

### Steps

1. **Create a project** at railway.com → *New Project* → *Deploy from GitHub
   repo* and pick your fork of Spaces. Railway detects the `Dockerfile` and
   `railway.json` (builder, start command `bun run src/standalone.ts`, health
   check `/health`).
2. **Add Postgres:** *Create* → *Database* → *PostgreSQL*. For vector search
   over the knowledge base pick a pgvector-enabled template instead (search
   the template marketplace for *pgvector*); without the extension the
   knowledge base falls back to full-text search and everything else works.
3. **Add a volume** to the Spaces service (*right-click the service* →
   *Attach volume*) mounted at `/data`. 10–20 GB is plenty to start; it holds
   clones and governing workspaces.
4. **Variables** on the Spaces service (*Variables* tab, *Raw editor*):

    ```ini
    DATABASE_URL=${{Postgres.DATABASE_URL}}
    ENCRYPTION_KEY=<openssl rand -base64 48>
    PUBLIC_URL=https://<your-service>.up.railway.app
    SUPERVISOR_MAX_WORKERS=2
    WORKER_IDLE_EXIT_SECONDS=300
    RAILWAY_DEPLOYMENT_DRAINING_SECONDS=900
    ```

    Railway mounts volumes owned by root; the image's entrypoint hands
    `/data` to the non-root `bun` user at start-up and drops privileges, so
    no `RAILWAY_RUN_UID` override is needed. `PORT` is injected by Railway and
    picked up automatically. `PUBLIC_URL`
    can be left out: the app honours Railway's `X-Forwarded-Proto` and
    `X-Forwarded-Host` headers, so OAuth callbacks and GitHub App manifests
    already use the public `https://` origin. Set it when you serve Spaces on
    a custom domain through another proxy.
5. **Generate a domain** (*Settings* → *Networking* → *Generate Domain*, or
   add a custom one). Railway terminates TLS; the container listens on plain
   HTTP.
6. **Open the URL** and register the first account (it becomes owner). Add a
   provider key under Organization → Models, then set up integrations under
   Organization → Integrations: *Create GitHub App* works as on localhost, and
   the manifest now carries your public callback URL.

Sizing: the container runs the web server, the supervisor and up to
`SUPERVISOR_MAX_WORKERS` workers at roughly 300–500 MB each, so 2 GB covers
two concurrent project runs and 4 GB covers four.

**Deploys and running agents.** Every deploy stops the old container, and by
default Railway gives it no time at all (SIGTERM, then SIGKILL at once). A run
killed mid-stage starts that stage again on the new deployment, so a long
review or implement stage repeats on every merge.
`RAILWAY_DEPLOYMENT_DRAINING_SECONDS` gives the old container time to drain.
With 60 seconds or more, a worker that gets SIGTERM:

- stops claiming new jobs;
- lets its running stages finish, then hands each run back to the queue at
  its next stage (a run that reaches an approval gate stays paused; one that
  finishes completes);
- after the window, minus a margin, hands back anything still running from
  its current stage, as before.

The web server keeps serving the old version until the workers have gone. A
service with a volume cannot run two deployments at once, so the new version
starts only when the old container exits: a deploy waits for the longest
running stage, up to the window. 900 seconds covers most stages; raise it if
your implement stages run longer, lower it if deploys must land quickly.
`SPACES_DRAIN_SECONDS` overrides the value on other platforms (for example,
set it together with `docker stop --time`). Without either, runs are re-queued
from their current stage right away, and paused runs stay paused.

Railway CLI equivalent:

```bash
railway init                                  # new project in this directory
railway add --database postgres               # Postgres with DATABASE_URL
railway volume add --mount-path /data
railway variables --set ENCRYPTION_KEY="$(openssl rand -base64 48)" --set SUPERVISOR_MAX_WORKERS=2
railway up                                    # build the Dockerfile and deploy
railway domain                                # public URL
```

## Option E — Fly.io, Render

Same shape as Railway: build the `Dockerfile`, start `bun run src/standalone.ts`
when the platform allows one persistent disk per service (Render, Fly with a
single volume), or run **app** (default command, public) and **supervisor**
(`bun run src/supervisor.ts`, private) as two services when a shared file
system is available. Add a managed Postgres, mount the disk at `/data`, and
set the variables from `.env.example` as secrets.

## Environment for cloud deployments

| Variable | Recommendation |
|---|---|
| `DATABASE_URL` | External, dedicated Postgres 16 (managed service or HA cluster), TLS (`?sslmode=require`); never the bundled dev container |
| `ENCRYPTION_KEY` | From a secret manager; back it up with the database |
| `PORT` | `3000` (or what the platform injects) |
| `PUBLIC_URL` | Public `https://` origin when a proxy in front does not send `X-Forwarded-Proto` / `X-Forwarded-Host`; used for OAuth callbacks, GitHub App manifests and invite links |
| `AIDLC_WORKSPACE_ROOT` | `/data/aidlc/workspaces` (image default) |
| `AIDLC_GOVERNANCE_ROOT` | leave default (`<workspace root>/_governance`) |
| `SUPERVISOR_MAX_WORKERS` | 3–4 per 8 GB |
| `WORKER_IDLE_EXIT_SECONDS` | `300`; raise if cold-starting workers is slow |
| Provider keys | Not variables: add Anthropic / OpenAI / OpenRouter keys under Organization → Models; stored encrypted |
| Integrations | Not variables: add OAuth app credentials under Organization → Integrations once the public host is up (callbacks point at it) |

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
