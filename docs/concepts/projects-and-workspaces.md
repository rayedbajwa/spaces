# Projects and the governing workspace

A **project** is the unit you work with on the board. It can span several
repositories and draws on app-wide integrations. Runs belong to a project and
target its primary checkout.

## The governing workspace

Every new project gets a **governing workspace**: a local git repository
(`~/.aidlc/workspaces/_governance/<slug>` by default) that is the project's
primary repo. It owns:

| Path | Contents |
|---|---|
| `.specify/` | The Spec Kit workspace (templates, scripts, constitution) |
| `specs/<feature>/` | `spec.md`, `plan.md`, `tasks.md`, `test-plan.md`, `parallel-workstreams.md`, `code-review.md`, `verification-report.md`, `delivery-status.md`, `delivery-report.md`, sub-agent reports |
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

Nothing has to be selected up front:

- With GitHub connected, every visible repository is indexed into the
  **repository catalog** (name, language, topics, README-derived use case),
  refreshed on connect and every six hours.
- **Onboarding suggests** repositories and *work areas* from the description,
  the first feature and the catalog; the wizard lets you add them before the
  first run.
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

## Memory and context

Each run receives a **shared context bundle**: org context, AIDLC directives,
project memory (auto summary + your notes), the current feature's artifacts,
imported knowledge snapshots, the repository catalog and a note about the
knowledge tools available. It is capped at roughly 8k tokens; lower-priority
sections are dropped first.

The **assistant** (Assistant tab) sees the same bundle plus a live operations
snapshot — runs with timelines and log tails, jobs, workers, repositories,
onboarding — and keeps the conversation per project.
