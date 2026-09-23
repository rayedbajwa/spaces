# Projects and the governing workspace

A **project** is the unit you work with on the board. It can span several
repositories and draws on app-wide integrations. Runs belong to a project and
target its primary checkout.

## Codes and pages

Every project has a readable code such as `PLAT-12`: a prefix derived from
its team's name (initials of the words, or the first letters of a single
word) and a counter per prefix. The code appears on cards and opens the
project's own page at `/spaces/PLAT-12`, so it can be linked, bookmarked and
refreshed. Click the code on the page to copy its link; **← Board** or Esc
returns to the board. `GET /api/projects/by-code/PLAT-12` resolves a code.

## The governing workspace

Every new project gets a **governing workspace**: a local git repository
(`~/.aidlc/workspaces/_governance/<slug>` by default) that is the project's
primary repo. It owns:

| Path | Contents |
|---|---|
| `.specify/` | The Spec Kit workspace (templates, scripts, constitution) |
| `specs/<feature>/` | `spec.md`, `plan.md`, `tasks.md`, `test-plan.md`, `parallel-workstreams.md`, `code-review.md`, `verification-report.md`, `delivery-status.md`, `delivery-report.md`, sub-agent reports |
| `specs/<feature>/initiative.yaml`, `links.yaml` | The feature as an **initiative**: which implementation repositories carry a repo-local change (`<repo>/specs/<NNN-intent>/`) and how they link — see [Delivery](delivery.md) |
| `memory/` | Exported project memory (auto summary + manual notes) |
| `knowledge/` | Imported tickets and docs |
| `project.json` | Repositories, knowledge scope and status |

State is exported and committed after every stage pause or completion, so the
workspace's git history is the project's long-term store. Push it to a remote
if you want an off-machine copy. Disable the workspace with
`AIDLC_GOVERNANCE_WORKSPACE=0` to keep specs inside the application repo.

## Repositories

Repositories are registered on the project as **local paths** or **GitHub
owner/name**. GitHub repositories are cloned into `~/.aidlc/workspaces/<owner>/<name>`
(`AIDLC_WORKSPACE_ROOT`) with the token passed per git command, never written to
the clone.

## Tokens and cost

Every model call a run makes is stored with its provider, model, stage,
tokens (input, output, cache reads and writes) and cost. The agent output bar
shows the running cost of the live run, board cards and the project hero show
the project's total, the project overview has a *Tokens & cost* panel (by
stage, by model, by run, refreshing while a run is live), and the organization
overview shows spend over the last 30 days and by project.

Nothing has to be selected up front:

- With GitHub connected, every visible repository is indexed into the
  **repository catalog** (name, language, topics, README-derived use case),
  refreshed on connect and every six hours.
- **Onboarding suggests** repositories and *work areas* from the description,
  the first feature and the catalog; the wizard lets you add them before the
  first run. If nothing matches, it **proposes a new repository** (name,
  description, visibility) that can be created through the connected GitHub
  account and attached in one step, or created by hand from a prefilled GitHub
  link. Creating repositories needs the GitHub App's *Administration* permission
  or a classic OAuth app with the `repo` scope; without it the manual path is
  offered.
- The **plan stage names** the repositories a feature touches in a
  `## Repositories` section; unregistered ones are added, cloned, learned and
  set up automatically after the plan completes.
- The overview's **Repositories** block shows plan and onboarding suggestions
  with *Add & clone*, plus add/edit/make-primary/relearn actions.

Multi-repo projects get a repository map in memory; workstreams name their
repository and run inside that checkout.

## Onboarding

Creating a project starts onboarding, which the wizard waits on:

1. **Clone** remote repositories.
2. **Init** the Spec Kit workspace in the primary repo.
3. **Sync** — inventory each code repo (stack, layout, scripts, README).
4. **Learn** — a read-only agent writes a brief per repo.
5. **Memory** — briefs are stored per repository and composed into the auto
   summary; the context bundle is warmed.
6. **Suggest** — repositories and work areas.
7. **Setup** — each checkout is prepared for development (see
   [Pipelines & stages](pipelines-and-stages.md#development-environment-setup)).

Adding, re-cloning or editing a repository later re-learns it, sets it up and
recomposes memory; removing one drops its brief and prunes the knowledge scope.
`Rebuild from code` in the Memory tab does the same for projects created before
onboarding existed.

## Pausing, archiving and deleting a project

**Pause** (Overview tab) holds the project without losing anything: queued
jobs stay queued but are not dispatched, and running runs finish the stage
they are in, then stop (`paused`, kind `user`). **Resume** lets jobs dispatch
again and re-queues those runs from the stage they stopped before.

**Archive** (Overview tab) is the recommended way to retire a project: it
cancels anything queued, running or paused (jobs and runs end as
`cancelled`, live agent sessions are disposed), keeps every run, artifact,
memory and snapshot, removes the project from the board, and refuses new runs
and jobs until you **Unarchive**. Archived projects are listed in the
**Archived** dropdown above the board; pick one to open it.

**Delete permanently…** is offered only for archived projects and cannot be
undone. It shows what would go and requires typing `delete <project-key>`,
where the key is the project's code (for example `delete plat-12`); the exact
phrase is shown above the field and can be copied.
Deletion is refused while the project is active: queued, running or paused
runs, queued or running jobs, busy agents, or onboarding still in progress.

What is removed: every run with its steps, events, gates, artifacts and
handoff memory; jobs; project memory; imported snapshots; agents and
orchestrator settings; the governing workspace on disk; GitHub clones that no
other project uses, with their worktrees; and agent session files. A local
repository you registered yourself is never deleted — only the worktrees
Spaces created inside it. A clone shared with another project is kept.
`DELETE /api/projects/:id` with `{ "confirm": "delete" }` does the same.

## Memory and context

Each run receives a **shared context bundle**: org context, AIDLC directives,
project memory (auto summary + your notes), the current feature's artifacts,
imported knowledge snapshots, the repository catalog and a note about the
knowledge tools available. It is capped at roughly 8k tokens; lower-priority
sections are dropped first.

The **assistant** (Assistant tab) sees the same bundle plus a live operations
snapshot — runs with timelines and log tails, jobs, workers, repositories,
onboarding — and keeps the conversation per project.
