# Feature Specification: A worker service per project

**Feature Branch**: `014-project-workers` · **Created**: 2026-10-13 · **Status**: Draft (for review)
**Input**: "I need scalable workers with its own workspace, since it should be for each project." Today one Railway service runs the web app, the supervisor and every project's workers, and holds every project's workspace on one volume. Any deploy stops all of them, and one machine and one disk limit how many projects can run.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Each project runs on its own worker with its own disk (Priority: P1)

The first time a project needs agent work (onboarding, a run, chat, a task), Spaces creates that project's worker service on Railway, with its own volume holding the project's repositories, governing workspace, agent sessions and dev environment. All agent and workspace work for the project runs there. **Why P1**: it is the feature: isolation and capacity per project. **Independent test**: create a project and check that a `spaces-proj-<code>` service with a volume exists in Railway, that onboarding ran there, and that no workspace files for the project were written on the web service.

**Acceptance Scenarios**:

1. **Given** a new project, **When** it is created, **Then** its worker service and volume are provisioned and onboarding runs on that worker.
2. **Given** two projects running stages at the same time, **When** both are busy, **Then** neither waits for the other and each uses its own CPU, memory and disk.
3. **Given** provisioning fails (Railway error, quota), **When** the user starts work, **Then** the project shows why and offers a retry; nothing runs on the web service instead.

### User Story 2 - Deploying Spaces does not interrupt running work (Priority: P1)

Merging to `main` redeploys the web service right away. Each project worker is updated to the new version only when it has no stage running; a busy worker keeps the old version until its stage ends. **Why P1**: today every merge interrupts every run (DEFA-1 waited 15 minutes on 2026-10-13). **Independent test**: start a long stage, merge a change, and check that the stage finishes uninterrupted and the worker moves to the new version afterwards.

**Acceptance Scenarios**:

1. **Given** a running stage, **When** a new version is released, **Then** the stage is not interrupted and its worker is updated after the stage ends.
2. **Given** an idle worker, **When** a new version is released, **Then** it is updated within one rollout cycle.
3. **Given** a worker on an older version, **When** the web app sends it a request, **Then** the request still works (the internal API is versioned and backward compatible for one release).

### User Story 3 - Idle projects cost little (Priority: P2)

A project worker sleeps when it has had no work for a while and wakes when Spaces sends it a request. Opening a project or starting a run wakes it; the user sees a short "waking the project's worker" state rather than an error. **Why P2**: one service per project must not mean paying for every idle project. **Independent test**: leave a project idle past the sleep window, open it, and check that its pages load (after a short wake) and a run starts.

**Acceptance Scenarios**:

1. **Given** a sleeping worker, **When** a member opens the project, **Then** the page shows a waking state and then the project, without an error.
2. **Given** a sleeping worker, **When** a run is started, **Then** the worker wakes and picks the job up.
3. **Given** a worker with a stage running, **When** time passes, **Then** it never sleeps mid-stage.

### User Story 4 - Existing projects move over without losing anything (Priority: P1)

Projects created before this change are moved, one at a time, from the shared volume to their own worker: repositories, governing workspace, agent sessions and dev setup. Until a project is moved it keeps working as today. **Why P1**: production has live projects (DEFA-1 and others). **Independent test**: migrate a project and check that its specs, memory, branches and run history are intact and a new run continues from where it was.

**Acceptance Scenarios**:

1. **Given** an unmigrated project, **When** migration runs, **Then** its files are copied to its worker's volume, verified, and the project switches to that worker.
2. **Given** a project with a stage running, **When** migration is due, **Then** it waits until the project is idle.
3. **Given** a failed copy, **When** verification fails, **Then** the project stays on the shared volume and the failure is shown to the super admin.

### User Story 5 - Operators can see and manage project workers (Priority: P3)

The super admin sees each project's worker: state (provisioning, sleeping, awake, busy, updating, failed), version, disk use, and can retry provisioning, update, or remove a worker. **Why P3**: needed to operate it, not to use it. **Independent test**: open the workers view and check the states match Railway.

### Edge Cases

- Project deleted → its worker service and volume are removed; nothing is left in Railway.
- Project archived → its worker is stopped but the volume is kept until the project is deleted.
- Railway rate limits or is down → provisioning and rollout retry with backoff; existing workers keep running.
- Volume full → the worker reports it; the housekeeping sweep runs on that worker only.
- Self-hosted and local development (docker compose, single container) → keep working as today, with everything in one process and one disk.
- A worker woken by a request returns 502 while starting → the web service retries for up to a set time before showing an error.
- Two web replicas → provisioning and rollout for a project are done by one of them (database lock).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Spaces MUST run in one of three roles, chosen by configuration: `all` (today's single process, the default for local and self-hosted), `web` (no workspace disk), and `project` (one project's worker).
- **FR-002**: In `web` role, every request that reads or writes a project's workspace, runs git, or runs an agent outside the job queue (chat, tasks, workstreams, sub-agents, onboarding, repository learning, export, intent rename/delete/activate/accept, file artifacts) MUST be handled by that project's worker.
- **FR-003**: Views that list many projects (board, project list) MUST be served by the web service from the database without calling project workers.
- **FR-004**: Spaces MUST create a project's worker service and volume through the Railway API when the project first needs one, with the variables it needs, private networking only, and sleeping when idle.
- **FR-005**: Only the web service MUST be able to call a project worker's API (shared secret over the private network), and a worker MUST refuse requests for any other project.
- **FR-006**: Queued jobs for a project MUST be picked up by that project's worker; enqueueing MUST wake a sleeping worker.
- **FR-007**: A new Spaces version MUST be rolled out to each project worker only when that worker has no stage running.
- **FR-008**: Existing projects MUST be migrated from the shared volume to their own worker with verification, one at a time, and only while idle.
- **FR-009**: Deleting a project MUST remove its worker service and volume.
- **FR-010**: The super admin MUST see each worker's state, version and disk use, and retry, update or remove it.
- **FR-011**: The web service MUST keep working (board, settings, approvals from the database) while a project worker is asleep, waking or failed, and say which project is unavailable.

### Key Entities

- **Project worker**: one per project — Railway service and volume ids, internal URL, state, version, last seen, disk use, last error.
- **Rollout**: a released version and, per worker, whether it has been updated.
- **Migration**: per project — state (pending, copying, verifying, done, failed), sizes and checksums.

## Success Criteria *(mandatory)*

- **SC-001**: A merge to `main` interrupts no running stage.
- **SC-002**: Two projects run stages concurrently without either waiting on the other.
- **SC-003**: Opening a sleeping project shows its pages within 30 seconds.
- **SC-004**: Every existing project is migrated with its specs, memory, branches and run history intact.
- **SC-005**: The web service starts and serves the board with no volume attached.

## Assumptions

- The queue stays in Postgres (`project_jobs` with `pg_notify`); no Redis.
- A project's work is serial (one stage at a time), so one worker per project is enough; scaling is across projects.
- Railway allows one volume per service and no replicas with volumes; private-network requests wake sleeping services; the first request may return 502.
- Spaces gets a Railway API token for its own Railway project, separate from users' Railway connections used for deployment targets.

## Open questions

- [NEEDS CLARIFICATION: Railway token — an account/workspace token that can create services and volumes in the `spaces` project. A project token may not be allowed to create volumes; to verify before Phase 2.]
- [NEEDS CLARIFICATION: worker size and volume size per project (Hobby defaults to 5 GB per volume; the shared volume is 4.4 GB today).]
- [NEEDS CLARIFICATION: cost ceiling — a maximum number of awake workers, beyond which new work queues?]
