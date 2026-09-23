# Delivery: pull requests, review, merge, deploy, UAT

## Pull requests

When the target repository is GitHub-hosted, the `implement`, `orchestrate`,
`review` and `verify` stages commit the feature branch, push it and open or
update a pull request against the default branch. `review` posts the code
review as a PR comment; `verify` adds a comment with the verification status.

Parallel workstreams each run in an isolated git worktree on their own branch
and get their own PR. A workstream whose `### Dependencies` names another
workstream is branched from that workstream's branch and its PR targets it — a
**stacked PR** — and workstreams run in dependency order.

Every commit message and PR title the pipeline writes follows
**Conventional Commits**: `type(scope): subject`, lowercase subject, no trailing
period, header ≤ 72 characters. `implement` uses `feat`, `verify` uses `test`,
`orchestrate` uses `chore`; the scope is the feature branch or workstream.

While a feature is implementing or releasing, its board card and project page
link to each open pull request on GitHub (`PR #12`, or `repo#12` when the
feature spans repositories).

## Identity: the app bot opens pull requests

With a GitHub App set up through Organization → Integrations, every push,
pull request, review comment and merge an agent performs uses a short-lived
installation token, so it is attributed to `<app>[bot]` rather than to the
person who connected GitHub. Agent shells receive the same identity through
`GH_TOKEN` and git's `http.extraheader`, so `gh` and `git push` inside a run
behave the same way. Reads (repository catalog, cloning) still use the user.

The app asks for repository contents, pull requests, issues and **workflows**
(read and write), plus metadata, checks and actions (read). Workflows matters:
GitHub refuses any push that touches `.github/workflows` from an app without
it, so a run asked to wire its tests into CI cannot deliver the change at all.
An app created before that permission was requested keeps working for
everything else; Organization → Integrations says which permissions are
missing and links to the app's page on GitHub, where adding them raises a
request to accept on the installation.

Because the bot is a separate identity, a maintainer can approve the agent's
pull requests, and branch protection on `main` (a pull request with one
approval and green checks, stale reviews dismissed, no force pushes,
administrators not included) means the agent can never merge on its own
while the owner keeps direct access. The `deliver` stage asks before merging
and then merges only once the protection rules are satisfied.

## What is committed to implementation repositories

Planning stays in the governing workspace; each implementation repository
gets a **repo-local change**, committed with the code on the same branch and
pull request, in the same `specs/` directory Spec Kit uses:

```
<repo>/specs/<initiative-id>/
  change.yaml   schema, created, initiative, repository, links to sibling changes
  tasks.md      the tasks this repository owns (its workstreams), as a checklist
  spec.md       the delta spec as seen from this repository
```

The governing workspace's feature directory is the **initiative**: alongside
`spec.md`, `plan.md`, `tasks.md` and the rest it carries `initiative.yaml` and
`links.yaml` naming every implementation repository and its change. Links use
stable project identifiers (`github.com/org/repo`, or `local/<dir>` for
unhosted checkouts), never filesystem paths, and are informational: a missing
sibling never fails anything. Sub-agents tick `tasks.md` as work lands and
leave `change.yaml` and `spec.md` alone; PR bodies name the change and the
initiative. The pattern follows OpenSpec's workspace architecture design
decisions (initiative-first planning with linked repo-local changes).

## The intent's documents in implementation repositories

At every code stage (implement, orchestrate, review, verify) the intent's
directory in the governing workspace, `specs/<intent>/` (spec, plan, tasks,
test plan, contracts, research, review and verification reports), is mirrored
into each implementation repository that is on the feature branch and has work
there, and committed with that stage's changes. Only that directory is touched,
and documents no longer in the governing workspace are removed from the copy.
If the source directory cannot be listed, nothing changes; a single document
that cannot be read is skipped (the others still sync). Nothing is written or
removed through a symbolic link.

Those repositories are then pushed and get their own pull request
(`feat(<intent>): <spec title>`), which links to the governing workspace's pull
request and lists exactly the documents it carries. This also happens when the
governing workspace has no GitHub repository. Review and verification results
are posted to every pull request on the feature branch. Work on the branch is
measured against each repository's real default branch (as GitHub reports it),
so `develop` or `trunk` repositories are included. The run log shows
`[specs] <repo>: specs/<intent> synced for implement (3 updated)` and
`[pr] <repo>: opened pull request #N …`.

## Code review loop

The `review` stage refreshes CI and PR state from GitHub, reviews the diff
against the spec, plan and test plan, runs lint and tests itself, and writes
`code-review.md`:

```
Code Review Status: CHANGES_REQUESTED
## Summary
## Findings
- [BLOCKER|MAJOR|MINOR|NIT] path:line — what is wrong — what to do
## Tests & checks
## Spec coverage
```

`CHANGES_REQUESTED` loops back to `implement`, which must address every
blocker and major finding (and any failing CI) before continuing; `APPROVED`
proceeds to `verify`.

## Deliver stage

`tasks` ends with a per-repository **## Delivery** group in dependency order.
Before the `deliver` stage runs, `delivery-status.md` is refreshed from
GitHub: every PR the feature opened, its review, CI, merge and deployment
state, ordered by stack, with a suggested next action.

The agent then:

1. fixes what blocks a PR itself — rebase, CI, review comments, missing PRs;
2. asks for approval and pauses before **merging** or **deploying**;
3. confirms deployments reached their environment;
4. runs the UAT scenarios from `test-plan.md` against the deployed environment
   (or the full suite on the merged base and says UAT still needs an
   environment);
5. writes `delivery-report.md` with `Delivery Status: MERGED | PARTIAL | BLOCKED`.

Templates loop `deliver` on `delivery_status != 'merged'` after the human gate,
so each approval refreshes the status and re-checks until everything is merged.
