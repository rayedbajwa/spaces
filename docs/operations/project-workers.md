# Project workers

Each project can run on its own **worker**: a separate service with its own disk for the project's repositories, governing workspace and agent sessions. The public **web** service has no workspace disk. It forwards a project's work to that project's worker over a private network, so a deploy of the web service does not stop agent work, and projects don't compete for one machine. The design is in `specs/014-project-workers`; [Architecture & scaling](../concepts/architecture.md) shows how the pieces fit, and [Deploying to the cloud](cloud-deployment.md#option-a-railway-a-worker-per-project-production) sets up Railway from scratch.

Three platforms run the same layout:

| Platform | Use it for | The worker is | Its disk |
|---|---|---|---|
| Railway | production | a service `spaces-proj-<code>` (sleeps when idle) | a Railway volume |
| Kubernetes | clusters, and minikube for engineers | a Deployment and Service `spaces-proj-<code>` | a PersistentVolumeClaim |
| Docker | one machine, for engineers | a container `spaces-proj-<code>` | a named volume |

`SPACES_ROLE` decides what a process runs: `all` (the default: everything in one service, as before), `web`, or `project`. A worker is created the first time its project needs one: when the project is created, or when it is first opened or run. The super admin sees every worker under the account menu → **Project workers**. That page also has a check (can Spaces reach the platform?) and a probe (may it create what a worker needs?).

## Local: Docker

You need Docker and about 4 GB of free memory per busy project.

```sh
docker compose -f docker-compose.workers.yml up --build
open http://localhost:3000
```

1. Create the first account, then add an LLM key under **Organization → Models**.
2. Create a project. The web service starts its worker:

   ```sh
   docker ps --filter label=spaces.dev/role=project-worker
   docker logs -f spaces-proj-<code>
   ```

3. Open the project and start a run. The run happens in the worker container, on its own volume (`spaces-proj-<code>-data`).

`docker compose … down` stops the web service and Postgres but leaves the workers running, because compose didn't create them. To remove them, use **Project workers → Remove**, or:

```sh
docker rm -f $(docker ps -aq --filter label=spaces.dev/role=project-worker)
docker volume rm $(docker volume ls -q --filter label=spaces.dev/role=project-worker)
```

The web container uses the Docker socket, which gives it root on your machine. Use this setup only for local development.

## Kubernetes, and minikube

`deploy/kubernetes` contains:

- the `spaces` namespace
- a development Postgres
- the web Deployment with `SPACES_ROLE=web`
- a ServiceAccount with a Role limited to this namespace: Deployments, Services and PersistentVolumeClaims

The web service uses that account to create each project's worker.

### minikube

```sh
minikube start --cpus 4 --memory 8g --disk-size 40g
eval "$(minikube docker-env)"          # build straight into minikube's Docker
docker build --build-arg GIT_COMMIT="$(git rev-parse HEAD)" -t spaces:local .

cp deploy/kubernetes/secrets.env.example deploy/kubernetes/secrets.env
# edit secrets.env: ENCRYPTION_KEY and SPACES_INTERNAL_TOKEN (long random strings)
kubectl apply -k deploy/kubernetes
kubectl -n spaces rollout status deploy/spaces-web

kubectl -n spaces port-forward svc/spaces-web 3000:3000
open http://localhost:3000
```

After creating a project:

```sh
kubectl -n spaces get deploy,svc,pvc -l spaces.dev/role=project-worker
kubectl -n spaces logs -f deploy/spaces-proj-<code>
```

Workers request 250m CPU and 512 MiB and may use up to 2 vCPU and 2 GiB, so a few fit on a 4-CPU minikube. Change the limits with `PROJECT_WORKER_VCPUS`, `PROJECT_WORKER_MEMORY_GB` and `PROJECT_WORKER_DISK_GB` on the web Deployment. Change the requests with `PROJECT_WORKER_CPU_REQUEST` and `PROJECT_WORKER_MEMORY_REQUEST`.

To rebuild after a code change, build again with the new `GIT_COMMIT` (using minikube's Docker) and restart the web service. It updates each worker when that worker is idle:

```sh
docker build --build-arg GIT_COMMIT="$(git rev-parse HEAD)" -t spaces:local .
kubectl -n spaces rollout restart deploy/spaces-web
```

### k3s in Docker (when minikube will not start)

minikube's binary crashes on start on some recent macOS versions. k3s runs a single-node cluster in a container, and its kubeconfig goes in its own file:

```sh
docker run -d --privileged --name k3s-spaces --tmpfs /run --tmpfs /var/run -p 16443:6443 \
  rancher/k3s:v1.31.4-k3s1 server --disable traefik --disable metrics-server --tls-san 127.0.0.1
docker exec k3s-spaces cat /etc/rancher/k3s/k3s.yaml | sed 's#:6443#:16443#' > k3s.kubeconfig
export KUBECONFIG=$PWD/k3s.kubeconfig

docker build --build-arg GIT_COMMIT="$(git rev-parse HEAD)" -t spaces:local .
docker save spaces:local | docker exec -i k3s-spaces ctr -n k8s.io images import -
kubectl apply -k deploy/kubernetes
```

To try sleeping quickly, set `PROJECT_WORKER_IDLE_SECONDS=30` and `PROJECT_WORKER_SLEEP_SECONDS=60` on `spaces-web`. A worker then scales to 0 about a minute and a half after its last job. A request to the project, or queued work, starts it again.

### Other clusters

- Push the image to a registry the cluster can pull from. Set `PROJECT_WORKER_IMAGE` and the web container's `image` to it, and set `PROJECT_WORKER_IMAGE_PULL_POLICY=Always` if the tag moves.
- Point `DATABASE_URL` in `secrets.env` at a managed Postgres 16 with pgvector, and remove `postgres.yaml` from `kustomization.yaml`.
- Set `PROJECT_WORKER_STORAGE_CLASS` if the default StorageClass is not the one you want for worker disks.
- Expose `spaces-web` through your Ingress with TLS, and set `PUBLIC_URL` to that address.
- To run the web service outside the cluster, give it `KUBE_API_URL`, `KUBE_TOKEN` (a token for the `spaces-provisioner` account) and `KUBE_CA_FILE`.

## Railway (production)

1. Create a **workspace** token: Account Settings → **Tokens** → **Create token**, for the workspace that holds the Spaces project. A project token isn't enough: it can create services and volumes but not delete them, so removing a worker fails. Set `RAILWAY_PROVISIONER_TOKEN_TYPE=workspace`.
2. Add it to the web service as `RAILWAY_PROVISIONER_TOKEN`, and seal it.
3. Set `SPACES_INTERNAL_TOKEN` on the web service.

Workers are built from `PROJECT_WORKER_REPO` (default `rayedbajwa/spaces`). They get references to the web service's `DATABASE_URL`, `ENCRYPTION_KEY`, `SPACES_INTERNAL_TOKEN` and `PUBLIC_URL`, so those values stay in one place. They are sized 2 vCPU and 2 GB, with a volume at `/data`, and sleep when idle. A sleeping worker wakes when the web service sends it a request.

## Sleeping, waking and the awake limit

A worker's job process exits after `PROJECT_WORKER_IDLE_SECONDS` (default 300) with nothing to do. That includes runs waiting on a person at a gate: answering restarts the stage on the next worker. The worker's server then makes no network traffic, so Railway puts the service to sleep. Docker keeps the container, but it uses almost no CPU.

On Kubernetes nothing sleeps a pod, so Spaces does it: once a worker has been quiet for `PROJECT_WORKER_SLEEP_SECONDS` (default 600; 0 turns it off), the web service scales its Deployment to 0 and marks it `sleeping`. Quiet means no job process running, nothing queued or running, not being moved, and not just started. The PersistentVolumeClaim keeps the files. Anything that needs the worker scales it back to 1 and waits for the pod: queued work, someone opening the project, or an approval. On a local cluster the pod is answering within about ten seconds. A sleeping worker gets new Spaces versions in its pod template without starting, so it wakes on the current version.

Reads that only decorate the board never wake a worker on any platform. They use what the worker stored the last time it was up.

When work is queued for a project, the web service wakes that project's worker, whichever path queued it: a run, an approval link, a Slack answer, or an intake conversion. It catches every job as it's added, and also checks every 30 seconds for queued work whose worker isn't running.

At most `PROJECT_WORKERS_MAX_AWAKE` (default 5) workers run jobs at once. Work for another project waits until one goes idle. The super admin gets a Slack DM the first time the limit is hit, then at most once an hour while it stays hit. The **Project workers** page shows how many workers are awake and which projects are waiting.

## Updates only when idle

The web service runs the version every worker should run: the git commit it was built from. Every minute it updates workers on another version that have nothing running, at most two at a time. A worker that's busy stays on its version until its stage ends. While a worker is being updated it isn't woken; queued work runs on the new version, which starts its job process when it boots. The **Project workers** page shows each worker's version and when an update is waiting for it to go idle.

One deployment path on every platform: **a push to `main` deploys the web service, and only the web service deploys workers**, each with the web service's exact commit once it's idle. A worker never deploys by itself.

- **Railway:** the web service deploys on a push to `main` (its GitHub trigger). Workers are built from the same repository but have no branch and no deployment trigger. Spaces removes any trigger Railway attaches, when it creates a worker and on each update. Spaces deploys a commit to each worker through the API. A worker Railway has put to sleep isn't deployed just to update it, because that would start it. The rollout leaves it asleep, and when work wakes it, it's deployed on the current version, so the work runs on current code. That first start takes a build, a minute or so with Railway's cache.

- **Kubernetes:** the worker's Deployment is patched with the image and a `spaces.dev/version` annotation, so its pod is replaced even when the tag (`spaces:local`) stays the same.
- **Docker:** the container is recreated from the image, on the same volume.

Locally, build with `GIT_COMMIT` so the web service knows its version. Without it the version is "unknown" and nothing is updated:

```sh
GIT_COMMIT="$(git rev-parse HEAD)" docker compose -f docker-compose.workers.yml up --build
```

## Moving existing projects

Projects created before workers live on the shared service's disk. Move them one at a time from the account menu → **Project workers** → **Existing projects**. The shared service stays in `SPACES_ROLE=all` throughout: a moved project's requests and jobs go to its worker, and every other project carries on as before.

- **Copy (dry run)** creates the project's worker, copies the project's files to it (repositories, governing workspace, worktrees, agent sessions), and checks every path has the same files and bytes. The shared service keeps running the project.
- **Move** holds the project's jobs, copies again (so anything written since the dry run arrives), checks, then hands the project to its worker. A project with a stage running can't be moved: wait for the stage to end.
- **Move back** copies the worker's files back, checks them, and returns the project to the shared service.

Files keep their paths, since both sides mount `/data`, so nothing in the database changes.

### On Railway, before the first move

1. On the **spaces** service, set `SPACES_INTERNAL_TOKEN` (a long random string, sealed) and `HOST=::`. Workers pull the files from the shared service over Railway's private network, which uses IPv6. Railway sets `RAILWAY_PRIVATE_DOMAIN`, which gives the shared service's address. Set `MIGRATION_SOURCE_URL` only to override it.
2. Check that `RAILWAY_PROVISIONER_TOKEN` passes **Check the token** and **Probe create and delete**.
3. Run a **Copy (dry run)** on one project and check the result, then **Move** it and use it for a while before moving the others.

### Switching over

Once every project has moved, set `SPACES_ROLE=web` on the shared service. Nothing changes for moved projects, but the shared service stops running workers and stops sweeping its disk. Keep its volume for a week as a fallback. To go back, set `SPACES_ROLE=all` again and **Move back** the projects that need it.

## Faster builds

Each Railway worker builds its own image from the repository with the `Dockerfile`. Railway has no shared registry between services, so there's no building once and pulling everywhere. Instead, the Dockerfile is ordered for Railway's build cache:

1. system packages
2. dependencies, then Chromium (about 1.7 GB, cached until `bun.lock` changes)
3. the code
4. the commit, last

A worker's first build takes a few minutes. After that, an update rebuilds only the code layers.

The web service runs no agents, so it uses `Dockerfile.web`: 675 MB instead of 2.5 GB, with no Chromium, Docker CLI or psql. On Railway, set `RAILWAY_DOCKERFILE_PATH=Dockerfile.web` on the web service only.

Spaces sets each worker's build and start explicitly: `dockerfilePath: Dockerfile` and `startCommand: bun run src/standalone.ts`. Railway doesn't apply `railway.json` to services created through its API, so without these a worker builds with Railpack (no Chromium, psql or gosu) and starts only the server, and its job process never runs.

## Settings

| Variable | Platform | Meaning |
|---|---|---|
| `SPACES_ROLE` | all | `all`, `web` or `project` |
| `SPACES_INTERNAL_TOKEN` | all | Shared secret between the web service and workers |
| `MIGRATION_SOURCE_URL` | all | The shared service's private address, which workers pull a moved project from (Railway: from `RAILWAY_PRIVATE_DOMAIN`) |
| `HOST` | all | Address to listen on; `::` on Railway so workers can reach the shared service privately |
| `PROJECT_WORKER_PLATFORM` | all | `railway`, `kubernetes` or `docker` (Railway is assumed when `RAILWAY_PROVISIONER_TOKEN` is set) |
| `PROJECT_WORKER_IMAGE` | Kubernetes, Docker | Image the workers run |
| `PROJECT_WORKER_VCPUS`, `PROJECT_WORKER_MEMORY_GB`, `PROJECT_WORKER_DISK_GB` | all | Worker size (2, 2, 5) |
| `PROJECT_WORKER_PORT` | all | Port workers listen on (8080) |
| `PROJECT_WORKER_IDLE_SECONDS` | all | Idle time before a worker's job process stops (300) |
| `PROJECT_WORKER_SLEEP_SECONDS` | Kubernetes | Quiet time before the web service scales a worker to 0 (600; 0 keeps workers running) |
| `PROJECT_WORKERS_MAX_AWAKE` | all | Workers allowed to run jobs at once (5) |
| `PROJECT_WORKER_DATABASE_URL` | Kubernetes, Docker | Database address as the workers see it, if it differs from the web service's |
| `RAILWAY_PROVISIONER_TOKEN`, `RAILWAY_PROVISIONER_TOKEN_TYPE` | Railway | Provisioning token, and its type (`project` by default) |
| `PROJECT_WORKER_REPO` | Railway | Repository workers are built from (no branch: only Spaces deploys them) |
| `PROJECT_WORKER_POSTGRES_SERVICE` | Railway | Name of the Postgres service workers reference for `DATABASE_URL` (`Postgres`) |
| `PROJECT_WORKER_NAMESPACE`, `PROJECT_WORKER_SECRET`, `PROJECT_WORKER_STORAGE_CLASS`, `PROJECT_WORKER_IMAGE_PULL_POLICY`, `PROJECT_WORKER_CPU_REQUEST`, `PROJECT_WORKER_MEMORY_REQUEST` | Kubernetes | Where workers go and how they are scheduled |
| `KUBE_API_URL`, `KUBE_TOKEN`, `KUBE_CA_FILE`, `KUBE_INSECURE` | Kubernetes | API access from outside the cluster |
| `PROJECT_WORKER_DOCKER_NETWORK`, `DOCKER_SOCKET` | Docker | Network the workers join, and the engine's socket |
