---
title: "Parallel Coding Agents and Stacked PRs: What Breaks When You Merge"
description: Splitting a feature across parallel agents is the easy part. Getting their branches back into main is where it goes wrong, especially with squash merges and stacked pull requests.
date: 2026-11-14
image: /media/software-factory-orchestrator.png
---

### Running four coding agents at once is easy. Landing their four pull requests is where the trouble starts.

For larger features, Spaces doesn't run one implementing agent. It splits the work into **workstreams** and runs an agent per workstream, in parallel:

![An orchestrator splitting a plan into parallel workstreams, each with its own branch and pull request](/media/software-factory-orchestrator.png)

The splitting turned out to be the easy part. This post is about the part that wasn't.

---

## How the work is split

A parallelize stage reads the task list and writes `parallel-workstreams.md`. Each workstream has a fixed set of sections:

```markdown
## Workstream 2: Search UI
### Repository
acme/web
### Tasks
T007, T008, T009
### Scoped Files
src/search/SearchPage.tsx, src/search/useSearch.ts
### Dependencies
Workstream 1
### QA Focus
Empty results, slow responses
```

**Scoped files** are what keep agents from colliding: each agent is told to change only its files and not touch other workstreams. **Dependencies** decide the order: workstreams with none run at once; a workstream that depends on another waits for it, in waves.

Each agent runs in its own git worktree on its own branch, writes tests for its part, and opens its own pull request. A workstream that depends on another is branched from *that* workstream's branch, and its PR targets it. That's a stacked PR.

You can watch it happen: the run's dock shows a chip per agent, with its status, branch, PR, and live output.

## Where it broke: squash merges and stacks

Stacked PRs are elegant on paper. Each PR shows only its own diff; reviewers see small changes. Then a person merges them.

Here's what happened to us, more than once:

1. PR A targets `main`. PR B is stacked on A's branch.
2. Someone merges A with **squash merge**. Main gets one new commit. A's branch is left behind.
3. Someone merges B, which GitHub happily does, **into A's branch**.
4. B shows "Merged." Its code is not on main.

The person merging reads "merged" as done. Nobody notices until something is missing in production. We had to re-land two PRs this way, and a stack of six needed one combined PR because GitHub refused to retarget PRs that were part of a stack.

## What we do now

- **Open every PR against `main`.** If work depends on an unmerged PR, either wait for it to merge, or branch from it but target `main` and say the PR includes the earlier commits. The diff is bigger; the code arrives.
- **If PRs are stacked, merge only the bottom one,** then retarget or rebuild the next one on main before merging it.
- **After any merge, check the change is actually on main.** Not "the PR says merged." The commit is on main.
- **Dependencies are a smell.** If the parallelize step produces long chains, the workstreams aren't really parallel. Fewer, wider, independent workstreams merge better than a tall stack.

## Should you run agents in parallel?

For a feature with genuinely separate parts (an API, a UI, a migration, a test suite), yes. The wall-clock time drops, and smaller PRs are easier to review.

But the cost of parallelism isn't compute. It's **integration**: scoped files that turn out to overlap, a shared type both agents changed, and a merge order that has to be right. Plan for that like you would for a team of people, because that's what it is.

*Spaces is an AI software factory: specs go in, reviewed and tested pull requests come out. It's [on GitHub](https://github.com/rayedbajwa/spaces), source-available and free for personal use.*
