# Deploying to the cloud

Spaces runs in one of two layouts. Both use the same image and Postgres; see
[Architecture & scaling](../concepts/architecture.md) for how they work.

| Layout | `SPACES_ROLE` | What runs | Choose it when |
|---|---|---|---|
| **Web + a worker per project** (recommended) | `web` on the public service; `project` on each worker, which Spaces creates | A public web service with no disk, and one worker service with its own volume per project. Idle workers sleep | Production on **Railway** or **Kubernetes**: deploys never interrupt agents, projects don't share a machine, and idle projects cost nothing |
| **Single service** | `all` (the default) | Web server + supervisor + per-project job processes in one container, on one `/data` volume | One VM, Docker Compose, ECS/Cloud Run/Container Apps, Fly or Render, or a small team trying it out |

!!! warning "Authentication and exposure"
    Sign-in is on by default: the first account becomes owner and everyone
    else joins by invite link or the waitlist. Still, agents run code and hold
    repository tokens, so keep the deployment small and trusted: TLS in front
    (platforms do this for you), a strong `ENCRYPTION_KEY`, and consider an
    extra authenticating proxy (Cloudflare Access, Tailscale, IAP) for anything
    reachable from the internet. See `SECURITY.md`.

## The container images

| Image | Built from | Contents | Runs |
|---|---|---|---|
| Full | `Dockerfile` (about 2.5 GB) | Bun 1.4 on Debian, git, Chromium for the agents' browser tools, Docker CLI, psql | Project workers and the single-service layout |
| Web | `Dockerfile.web` (about 675 MB) | The server and the bundled frontend only | The web service in the worker layout (it runs no agents) |

Both run as the non-root `bun` user. The entrypoint starts as root only to fix
the ownership of a freshly mounted `/data` volume, then drops privileges. The
full image sets `HOME=/data/home` and `AIDLC_WORKSPACE_ROOT=/data/aidlc/workspaces`.
Pass `GIT_COMMIT` as a build argument: it's the version the web service moves
workers to (Railway provides `RAILWAY_GIT_COMMIT_SHA` itself).

The Dockerfile is ordered for build caches: system packages, then dependencies
and Chromium (cached until `bun.lock` changes), then the code, then the commit.
An update rebuilds only the last layers.

`bun run src/standalone.ts` is the start command for every role:

```bash
docker run … spaces:latest bun run src/standalone.ts                       # SPACES_ROLE=all: server + supervisor
docker run -e SPACES_ROLE=web … spaces-web:latest bun run src/standalone.ts # web only
docker run … spaces:latest bun run src/server.ts                           # server alone
docker run … spaces:latest bun run src/worker.ts                           # one shared job worker
```

## Database: an external, dedicated Postgres

**In production, run Postgres outside the app stack, on a dedicated instance**
— a managed service (Amazon RDS / Aurora, Google Cloud SQL, Azure Database for
PostgreSQL, Neon, Supabase, Railway's Postgres) or your own HA cluster. The
Postgres container in `docker-compose.yml` exists for local development only.

Postgres is not just storage. It is the **job queue** (`SKIP LOCKED` claims,
per-project concurrency), the **event bus** behind the live log and worker
wake-ups (`LISTEN/NOTIFY`), the **worker registry** (heartbeats, versions,
provisioning state) and the vault for sealed keys and OAuth tokens. Losing it
loses run history, memory and integrations; slowing it slows every agent step.

| Topic | Recommendation |
|---|---|
| Version | PostgreSQL 16 with **pgvector** (what the schema and CI test against). Without pgvector the knowledge base falls back to full-text search |
| Size | Start at 2 vCPU / 4–8 GB and 50 GB storage; the schema is small, but event rows grow with every run |
| Connections | Each process pools up to 10 (idle ones close after 30 s). Worker layout: 10 for web + 20 per awake worker, about 110 with `PROJECT_WORKERS_MAX_AWAKE=5`. Single service: 10 for the server + 10 for the supervisor + 10 per job process. Put PgBouncer in **session** mode in front if needed; transaction mode breaks `LISTEN/NOTIFY` and advisory locks |
| TLS | `DATABASE_URL=postgres://user:pass@host:5432/spaces?sslmode=require` |
| Users | A dedicated database and role owned by Spaces; the server applies DDL at boot, so the role must own the schema (or run `bun run db:migrate` with an owner role and give the app a lesser one) |
| Backups | Automated daily snapshots plus point-in-time recovery; test a restore once |
| Retention | Prune `pipeline_events` for runs older than your retention window if the database grows large |

The schema is idempotent DDL; a fresh database is initialised on the first
boot (or with `DATABASE_URL=… bun run db:migrate`).

## Option A — Railway, a worker per project (production)

This is how [spacesos.dev](https://spacesos.dev) runs. The Railway project
holds a `spaces` web service, Postgres, optionally a `phoenix` service, and one
`spaces-proj-<code>` service with a volume per project, all created by Spaces.

```mermaid
flowchart LR
  GH[GitHub main] -->|trigger| S[spaces<br/>Dockerfile.web · SPACES_ROLE=web]
  S -->|Railway API: create, deploy, wake| W1[spaces-proj-A<br/>Dockerfile · volume /data]
  S --> W2[spaces-proj-B<br/>sleeping]
  S & W1 & W2 --> PG[(Postgres)]
  S & W1 --> PX[phoenix]
```

### Steps

1. **Create a project** at railway.com → *New Project* → *Deploy from GitHub
   repo* and pick your fork. Name the service `spaces` (workers reference its
   variables by that name). Its deployment trigger stays on `main`.
2. **Add Postgres** with pgvector (search the template marketplace for
   *pgvector*). Workers reference it as `Postgres`; set
   `PROJECT_WORKER_POSTGRES_SERVICE` if you name it otherwise.
3. **Create a workspace token**: Account Settings → *Tokens* → *Create token*,
   for the workspace that holds the project. A project token can create
   services and volumes but can't delete them, so removing a worker would fail.
4. **Variables** on `spaces` (*Variables* → *Raw editor*; seal the secrets):

    ```ini
    SPACES_ROLE=web
    RAILWAY_DOCKERFILE_PATH=Dockerfile.web
    DATABASE_URL=${{Postgres.DATABASE_URL}}
    ENCRYPTION_KEY=<openssl rand -base64 48>
    SPACES_INTERNAL_TOKEN=<openssl rand -base64 48>
    PUBLIC_URL=https://<your-domain>
    HOST=::
    RAILWAY_PROVISIONER_TOKEN=<workspace token>
    RAILWAY_PROVISIONER_TOKEN_TYPE=workspace
    PROJECT_WORKER_REPO=<you>/<your-fork>
    # optional
    PROJECT_WORKERS_MAX_AWAKE=5
    PHOENIX_AUTO_PROVISION=1
    ```

    `PUBLIC_URL` is required here: workers reference it for OAuth callbacks and
    links. `railway.json` sets the start command (`bun run src/standalone.ts`),
    the `/health` check and the restart policy.
5. **Generate a domain** (*Settings* → *Networking*), or add a custom one.
   Railway terminates TLS.
6. **Open the URL**, register the first account (it becomes owner and super
   admin), add a provider key under Organization → Models, then integrations
   under Organization → Integrations.
7. **Check provisioning:** account menu → **Project workers** → **Check the
   token** and **Probe create and delete**.
8. **Create a project.** Spaces creates `spaces-proj-<code>`: built from
   `PROJECT_WORKER_REPO` with `Dockerfile`, 2 vCPU / 2 GB, a volume at `/data`,
   sleep enabled, no branch and no deployment trigger. Its secrets are
   references to the web service's variables, so they stay in one place. The
   first build takes a few minutes.

### Deploys

Merging to `main` deploys `spaces` only. Within a minute it starts moving
**idle** workers to the same commit, two at a time; a worker running a stage
keeps its version until the stage ends. Sleeping workers stay asleep and are
deployed on the current version when work next wakes them, which adds a
cached build (a minute or so) to that first start. Spaces removes any
deployment trigger Railway attaches to a worker, so there's one deployment
path: never redeploy workers by hand or give them a branch.

The web service runs no agents, so its deploys don't interrupt runs. Open
pages reconnect their live logs on their own.

### Sleep

A worker's job process exits after `PROJECT_WORKER_IDLE_SECONDS` (300) with
nothing to do, and Railway puts the service to sleep about ten minutes later.
Queued work, opening the project or answering a gate wakes it. The board and
other database-only reads don't. If workers never seem to sleep, check the
deployment history first: anything that deploys a worker starts it.

### Moving from a single service

An existing single-service deployment (`SPACES_ROLE=all` with one volume)
moves one project at a time from **Project workers** → **Existing projects**,
then switches to `SPACES_ROLE=web`. See
[Project workers → Moving existing projects](project-workers.md#moving-existing-projects).

## Option B — Kubernetes, a worker per project

`deploy/kubernetes` has a kustomization for the worker layout: the namespace,
the web Deployment (`SPACES_ROLE=web`), a ServiceAccount whose Role can manage
Deployments, Services and PersistentVolumeClaims in that namespace only, and a
development Postgres.

```bash
cp deploy/kubernetes/secrets.env.example deploy/kubernetes/secrets.env
# DATABASE_URL, ENCRYPTION_KEY, SPACES_INTERNAL_TOKEN, PUBLIC_URL
kubectl apply -k deploy/kubernetes
```

For a real cluster:

- Push the image to a registry; set the web container's `image` and
  `PROJECT_WORKER_IMAGE` to it (`PROJECT_WORKER_IMAGE_PULL_POLICY=Always` if
  the tag moves).
- Point `DATABASE_URL` at a managed Postgres 16 with pgvector and drop
  `postgres.yaml` from the kustomization.
- Set `PROJECT_WORKER_STORAGE_CLASS` for the workers' disks (ReadWriteOnce is
  enough: each volume belongs to one worker).
- Expose `spaces-web` through an Ingress with TLS and set `PUBLIC_URL`. SSE
  needs proxy idle timeouts of a few minutes or more.
- Deploy by building the image with `--build-arg GIT_COMMIT=<sha>` and rolling
  the web Deployment to it. The web service then moves idle workers to that
  version, patching each worker's Deployment with the image and a
  `spaces.dev/version` annotation.

Pods don't sleep on their own, so the web service scales a quiet worker to 0
after `PROJECT_WORKER_SLEEP_SECONDS` (600) and back to 1 when it's needed.
Details, minikube and k3s steps: [Project workers](project-workers.md).

## Option C — single VM with Docker Compose

One VM (4 vCPU / 8 GB is comfortable for 3–4 concurrent projects), Docker, the
production compose file and a managed Postgres.

```bash
git clone https://github.com/rayedbajwa/spaces.git && cd spaces
cp .env.example .env
# set DATABASE_URL to the external instance (…?sslmode=require),
# and ENCRYPTION_KEY (provider keys and integrations are set up in the UI)
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml logs -f app supervisor
```

`docker-compose.prod.yml` starts the **app** (bound to `127.0.0.1:3000`) and
the **supervisor**, sharing the `spaces-data` volume at `/data`, with stop
grace periods that let job processes hand runs back on restart. Put Caddy,
nginx or Cloudflare Tunnel in front for TLS and authentication, and point the
OAuth apps' callbacks at `https://<your-host>/api/oauth/<provider>/callback`.

To try the worker layout on one machine, `docker-compose.workers.yml` runs the
web service with `PROJECT_WORKER_PLATFORM=docker`: each project gets its own
container and volume. It drives the Docker socket (root on that machine), so
use it for development only. See [Project workers → Local: Docker](project-workers.md#local-docker).

## Option D — managed containers (AWS ECS/Fargate, Google Cloud Run, Azure Container Apps)

These platforms run the **single-service layout**: Spaces can't create
services on them, so there are no per-project workers.

- **Database:** an external, dedicated Postgres 16 (RDS, Cloud SQL, Azure
  Database) with `sslmode=require`.
- **app service:** the image with `bun run src/server.ts`, 1 task, 1 vCPU /
  2 GB, health check `GET /health`, behind a load balancer that terminates TLS
  and enforces authentication (ALB + Cognito/OIDC, IAP, Front Door). SSE needs
  idle timeouts of a few minutes or more.
- **supervisor service:** the image with `bun run src/supervisor.ts`, 1 task,
  2 vCPU / 4–8 GB depending on `SUPERVISOR_MAX_WORKERS` (job processes are
  children of it). Avoid platforms that kill idle containers (Cloud Run jobs,
  Fargate Spot) for it; runs interrupted by a stop are re-queued.
- **Storage:** a shared file system at `/data` on both services (EFS,
  Filestore, Azure Files). Repositories and governing workspaces must be
  visible to the app and the job processes.
- **Secrets:** `DATABASE_URL` and `ENCRYPTION_KEY` from the platform's secret
  manager. Provider keys and OAuth apps are entered in the app and stored
  encrypted; rotating `ENCRYPTION_KEY` invalidates them.
- **Egress:** HTTPS to the model providers, `api.github.com`, `github.com`,
  Atlassian and Linear APIs, and the package registries the projects use.

## Option E — Railway, Fly.io or Render as one service

The quickest hosted setup: one service built from the `Dockerfile`, started
with `bun run src/standalone.ts` (`SPACES_ROLE=all`), a Postgres and a volume
at `/data`. A volume attaches to exactly one service, which is why the server
and the supervisor run together in one container.

On Railway: deploy the repository, add Postgres and a 10–20 GB volume at
`/data`, then set

```ini
DATABASE_URL=${{Postgres.DATABASE_URL}}
ENCRYPTION_KEY=<openssl rand -base64 48>
SUPERVISOR_MAX_WORKERS=2
RAILWAY_DEPLOYMENT_DRAINING_SECONDS=900
```

`PUBLIC_URL` is optional: the app honours Railway's forwarded headers. Size
the service for the job processes (about 300–500 MB each, plus their tests):
2 GB covers two concurrent projects, 4 GB covers four.

**Deploys interrupt agents in this layout.** By default Railway stops the old
container at once, and a run killed mid-stage repeats that stage.
`RAILWAY_DEPLOYMENT_DRAINING_SECONDS` (or `SPACES_DRAIN_SECONDS` elsewhere)
gives running stages time to finish: job processes stop claiming, finish their
stage and hand the run back at the stage boundary, and the old server keeps
serving until they're gone. 900 seconds covers most stages. The worker layout
avoids this altogether.

Fly.io and Render work the same way when they allow one persistent disk per
service.

## Environment for cloud deployments

| Variable | Layout | Recommendation |
|---|---|---|
| `DATABASE_URL` | both | External Postgres 16 with pgvector, TLS |
| `ENCRYPTION_KEY` | both | From a secret manager; back it up with the database |
| `PUBLIC_URL` | both | Public `https://` origin; required on the Railway web service, optional elsewhere when the proxy sends `X-Forwarded-Proto` / `X-Forwarded-Host` |
| `PORT` | both | `3000` (or what the platform injects) |
| `SPACES_ROLE` | both | `web` on the public service of the worker layout; `all` (default) for a single service |
| `SPACES_INTERNAL_TOKEN` | workers | Long random secret shared with workers |
| `PROJECT_WORKER_PLATFORM` | workers | `railway`, `kubernetes` or `docker` (Railway when `RAILWAY_PROVISIONER_TOKEN` is set) |
| `RAILWAY_PROVISIONER_TOKEN`, `RAILWAY_PROVISIONER_TOKEN_TYPE=workspace` | workers, Railway | Workspace token for creating, deploying and removing workers |
| `PROJECT_WORKER_REPO` | workers, Railway | Your fork; workers are built from it |
| `PROJECT_WORKERS_MAX_AWAKE` | workers | Workers that may run jobs at once (5) |
| `PROJECT_WORKER_VCPUS`, `PROJECT_WORKER_MEMORY_GB`, `PROJECT_WORKER_DISK_GB` | workers | Worker size (2, 2, 5) |
| `PROJECT_WORKER_IDLE_SECONDS`, `PROJECT_WORKER_SLEEP_SECONDS` | workers | Idle time before a job process stops (300); before Kubernetes scales a worker to 0 (600) |
| `SUPERVISOR_MAX_WORKERS` | single | Job processes at once; 3–4 per 8 GB |
| `WORKER_IDLE_EXIT_SECONDS` | single | Idle time before a job process exits (300) |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` / `SPACES_DRAIN_SECONDS` | single | About 900, so deploys let running stages finish |
| `PHOENIX_COLLECTOR_ENDPOINT`, `PHOENIX_API_KEY`, `PHOENIX_AUTO_PROVISION` | both | Agent tracing to Arize Phoenix; workers on Railway inherit the web service's |
| Provider keys, integrations | both | Not variables: added in the app (Organization → Models / Integrations) and stored encrypted |

The full list is in [Configuration](../reference/configuration.md) and
[Project workers → Settings](project-workers.md#settings).

## Operations

- **Health:** `GET /health` on every service. **Project workers** (account
  menu, super admin) shows each worker's state, version, awake count, pending
  updates and projects waiting at the cap; `GET /api/workers` lists live job
  processes with heartbeats. Alert when a project has queued jobs and no awake
  worker for more than a few minutes.
- **Logs:** JSON lines on stdout from every process; `mod` names the module
  (`worker-wake`, `worker-rollout`, `worker-sleep`, `project-forward`,
  `worker-provisioner`, …). Ship them to your log platform.
- **Traces:** Arize Phoenix, one trace per agent turn and a session per run,
  with run status, cost and gate decisions as annotations. See
  [Configuration → Agent tracing](../reference/configuration.md#agent-tracing-arize-phoenix).
- **Backups:** Postgres (runs, events, sessions, tokens) and the volumes.
  Repositories can be cloned again; governing workspaces hold specs, reports
  and memory, and their documents are also kept in the database.
- **Upgrades:** the server applies idempotent schema changes at boot. In the
  worker layout deploy the web service; it moves idle workers. In the single
  layout restart the service with a drain window.
