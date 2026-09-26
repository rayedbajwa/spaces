# Intents

An **intent** is one piece of work a project takes on: a bug fix, a feature, an
MVP. Underneath it is a Spec Kit feature, a numbered directory under `specs/`
(`001-login`, `002-billing`) with its spec, plan, tasks, test plan, code review,
verification report and delivery record. A project works on one intent at a
time; the others are history.

## The record lives in the database

Agents work in files, so the files are the **working copy**. The **record** of
each intent is in Postgres:

- `intents`: title, scope, status, code review, verification and its summary,
  delivery, acceptance, task progress, and which intent is active.
- `intent_documents`: every document's content, with a hash, who changed it
  last and when.
- `intent_status_events`: every status change, what it changed from and to,
  and who made it (`agent`, `import`, or `person:<name>`).

After every stage (and at every pause or finish) the intent's directory is
synced in: changed documents are stored and their statuses recomputed with the
same parsers the board uses. The first time a project is seen its intents are
imported. The board, the Intents list, project memory, the QA and Releasing
previews and every document link read the database, so an intent stays
readable when its files are on another branch or gone.

Person actions write the database first and then the files, under a
per-project lock, so a sync and an action never overwrite each other:

| Action | What changes |
|---|---|
| **Accept** / withdraw | `acceptance.md` is recorded (or removed) and the status recomputed |
| **Rename** | the spec's first heading; the directory and branch keep their names |
| **Continue** | the intent becomes the active one (`intents.active`); `specs/.active-feature` is written as a copy for the agents |
| **Delete** | the record is marked deleted (kept with its history) and its directory removed; a copy of it on another branch never brings it back |

Before a stage runs, the current intent's documents that are missing from the
working copy (a fresh clone, a new worker, a lost volume) are written back from
the database. Files that exist are never overwritten, and nothing is written
through a symbolic link.

## Starting an intent

**＋ New intent** asks for a description (a sentence, not a word) and a
**scope**:

| Scope | The spec it gets |
|---|---|
| **Auto** (default) | the agent decides from the description |
| **Bug fix** | the defect, steps to reproduce, expected and actual behaviour, the fix and a regression test |
| **Feature** | user stories with priorities, requirements, measurable acceptance criteria |
| **MVP** | only the P1 stories; everything else listed as out of scope for later |
| **Improvement** | what exists, what changes and why, without breaking what works |
| **Chore** | maintenance with no user-facing change, and how to confirm nothing changed |
| **Spike** | a time-boxed question, the options, and what a useful answer looks like |
| **Other…** | a label of your own |

The scope is recorded as a `**Scope**: <scope>` line under the spec's title and
shown as a badge in the Intents list, on board cards and in the project header.

When the current intent isn't delivered, accepted or verified, Spaces asks
first; the unfinished intent stays in the list and the project moves on. Before
`specify` opens an intent after an earlier one, the run pulls the latest code,
re-learns repositories whose code moved, and rebuilds project memory with the
intent history (see [Pipelines & stages](pipelines-and-stages.md#starting-a-new-intent-refreshes-the-project)).

## Reviewing an intent

Click an intent's title in **Overview → Intents** to open the **intent viewer**:

- **Documents**, grouped by pipeline phase (Specification, Planning, Build,
  Quality, Delivery), each with who changed it last and when, previewed in
  place: markdown rendered (task lists as check marks), other files as text.
  **Open raw ↗** opens the file. Previous/next and ↑/↓ (or j/k) move through
  them.
- **History**: every status change (status, review, verification,
  acceptance, delivery, scope, current intent, deletion) with who made it and
  when, and when each document last changed.

![The intent viewer on a spec](../screenshots/generated-spec.png)

## In implementation repositories

When the code lives outside the governing workspace, each implementation
repository working on the intent gets only its repo-local change, under the
same numbered `specs/<intent>/` (e.g. `specs/003-search/`) with `change.yaml`,
the tasks it owns and its delta spec, committed at every code stage, and its own pull request linking back to
the governing one. The rest of the intent's documents stay in Spaces. See
[Delivery](delivery.md#the-intents-documents-in-implementation-repositories).
