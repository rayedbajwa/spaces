# Project workers

Each project can run on its own **worker**: a separate service with its own disk for the project's repositories, governing workspace and agent sessions. The public **web** service has no workspace disk. It forwards a project's work to that project's worker over a private network, so a deploy of the web service does not stop agent work, and projects don't compete for one machine. The design is in `specs/014-project-workers`.

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
docker build -t spaces:local .

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

To rebuild after a code change, run `docker build -t spaces:local .` again (with minikube's Docker), then:

```sh
kubectl -n spaces rollout restart deploy/spaces-web
kubectl -n spaces rollout restart deploy -l spaces.dev/role=project-worker
```

### Other clusters

- Push the image to a registry the cluster can pull from. Set `PROJECT_WORKER_IMAGE` and the web container's `image` to it, and set `PROJECT_WORKER_IMAGE_PULL_POLICY=Always` if the tag moves.
- Point `DATABASE_URL` in `secrets.env` at a managed Postgres 16 with pgvector, and remove `postgres.yaml` from `kustomization.yaml`.
- Set `PROJECT_WORKER_STORAGE_CLASS` if the default StorageClass is not the one you want for worker disks.
- Expose `spaces-web` through your Ingress with TLS, and set `PUBLIC_URL` to that address.
- To run the web service outside the cluster, give it `KUBE_API_URL`, `KUBE_TOKEN` (a token for the `spaces-provisioner` account) and `KUBE_CA_FILE`.

## Railway (production)

1. In the Railway project, go to **Settings → Tokens** and create a project token for the production environment.
2. Add it to the web service as `RAILWAY_PROVISIONER_TOKEN`, and seal it.
3. Set `SPACES_INTERNAL_TOKEN` on the web service.

Workers are built from `PROJECT_WORKER_REPO` (default `rayedbajwa/spaces`). They get references to the web service's `DATABASE_URL`, `ENCRYPTION_KEY`, `SPACES_INTERNAL_TOKEN` and `PUBLIC_URL`, so those values stay in one place. They are sized 2 vCPU and 2 GB, with a volume at `/data`, and sleep when idle. A sleeping worker wakes when the web service sends it a request.

## Sleeping, waking and the awake limit

A worker's job process exits after `PROJECT_WORKER_IDLE_SECONDS` (default 300) with nothing to do. That includes runs waiting on a person at a gate: answering restarts the stage on the next worker. The worker's server then makes no network traffic, so Railway puts the service to sleep. Kubernetes and Docker keep the container, but it uses almost no CPU.

When work is queued for a project, the web service wakes that project's worker, whichever path queued it: a run, an approval link, a Slack answer, or an intake conversion. It catches every job as it's added, and also checks every 30 seconds for queued work whose worker isn't running.

At most `PROJECT_WORKERS_MAX_AWAKE` (default 5) workers run jobs at once. Work for another project waits until one goes idle. The super admin gets a Slack DM the first time the limit is hit, then at most once an hour while it stays hit. The **Project workers** page shows how many workers are awake and which projects are waiting.

## Settings

| Variable | Platform | Meaning |
|---|---|---|
| `SPACES_ROLE` | all | `all`, `web` or `project` |
| `SPACES_INTERNAL_TOKEN` | all | Shared secret between the web service and workers |
| `PROJECT_WORKER_PLATFORM` | all | `railway`, `kubernetes` or `docker` (Railway is assumed when `RAILWAY_PROVISIONER_TOKEN` is set) |
| `PROJECT_WORKER_IMAGE` | Kubernetes, Docker | Image the workers run |
| `PROJECT_WORKER_VCPUS`, `PROJECT_WORKER_MEMORY_GB`, `PROJECT_WORKER_DISK_GB` | all | Worker size (2, 2, 5) |
| `PROJECT_WORKER_PORT` | all | Port workers listen on (8080) |
| `PROJECT_WORKER_IDLE_SECONDS` | all | Idle time before a worker's job process stops (300) |
| `PROJECT_WORKERS_MAX_AWAKE` | all | Workers allowed to run jobs at once (5) |
| `PROJECT_WORKER_DATABASE_URL` | Kubernetes, Docker | Database address as the workers see it, if it differs from the web service's |
| `RAILWAY_PROVISIONER_TOKEN`, `RAILWAY_PROVISIONER_TOKEN_TYPE` | Railway | Provisioning token, and its type (`project` by default) |
| `PROJECT_WORKER_REPO`, `PROJECT_WORKER_BRANCH` | Railway | What workers are built from |
| `PROJECT_WORKER_NAMESPACE`, `PROJECT_WORKER_SECRET`, `PROJECT_WORKER_STORAGE_CLASS`, `PROJECT_WORKER_IMAGE_PULL_POLICY`, `PROJECT_WORKER_CPU_REQUEST`, `PROJECT_WORKER_MEMORY_REQUEST` | Kubernetes | Where workers go and how they are scheduled |
| `KUBE_API_URL`, `KUBE_TOKEN`, `KUBE_CA_FILE`, `KUBE_INSECURE` | Kubernetes | API access from outside the cluster |
| `PROJECT_WORKER_DOCKER_NETWORK`, `DOCKER_SOCKET` | Docker | Network the workers join, and the engine's socket |
