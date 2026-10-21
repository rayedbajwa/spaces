---
title: What Broke When I Let AI Agents Run My Software Process for a Month
description: Twelve loops in three hours, summaries that forget commit hashes, and a token in my logs. Lessons from building an assembly line of coding agents with human gates.
date: 2026-10-21
image: /screenshots/board.png
---

### Twelve loops in three hours, summaries that forget commit hashes, and a token in my logs: lessons from building an assembly line of coding agents

![The Spaces board: each card is a feature moving down the line](/screenshots/board.png)

Coding agents are good at writing code. They are bad at process.

On a real team, code is the easy part. Someone has to agree on what we're building. Someone writes a plan. Someone reviews the change, someone tests it, and someone says "yes, ship it" before anything touches main. An agent in your editor does none of that. It writes code and hands you a diff.

So I built [Spaces](https://github.com/rayedbajwa/spaces): an assembly line of agents that takes a ticket, or a sentence in plain English, and turns it into a spec, a plan, tasks, code, a code review, a QA report and a merged pull request. Each stage is its own agent with one job. A person approves the work between stages.

```
research → specify → plan → tasks → implement → review → verify → deliver
              ↑         ↑       ↑          ↑                  ↑
            you       you     you        you                you
```

I've been running it on my own projects for a month, with every agent turn traced. Here is what broke, how I found out, and what I'd tell anyone building agent pipelines.

---

## The setup

Each feature in Spaces is an **intent**. It moves down the line one stage at a time:

- **Research** clones the repositories involved and reads the knowledge base: Jira, Linear, Confluence, the repo's own docs.
- **Specify, plan, tasks** write `spec.md`, `plan.md` and `tasks.md`, built on GitHub's [Spec Kit](https://github.com/github/spec-kit). You approve each one.
- **Implement** writes the code and opens a pull request. It then loops through **review** and **verify** on its own until both are nearly done.
- **Verify** runs the tests, drives the app in a headless browser, and writes a verification report: which acceptance criteria are met and which aren't.
- **Deliver** fixes what blocks the pull request (CI, review comments, rebase), and merges once you approve.

Every stage leaves a file you can read, and the spec is committed next to the code. Postgres is the database, the job queue and the event bus, and each project gets its own worker. Every agent turn is traced to [Arize Phoenix](https://phoenix.arize.com/), so I can see what each agent did and what it cost.

![A spec written by the specify agent, waiting for approval](/screenshots/generated-spec.png)

That last part is what made this post possible. In one week, 96 runs produced 303 stage-to-stage handoffs, and I could look at every one.

---

## Lesson 1: Agents loop, and a loop looks exactly like progress

One afternoon a mobile feature ran **implement → review → verify twelve times in three hours**.

Each run looked fine on its own. The code review approved. Verify ran the tests, found nothing an agent could fix, and wrote its report. Then the pipeline sent it back to implement, which changed a little documentation, and around it went again.

The verification report said the same thing all sixteen times: **5 of 15 acceptance criteria met, nothing critical open.** The other ten criteria were things like "run the checklist on an iPhone with a home indicator" and "confirm the tab bar in dark mode on an Android phone." No agent can do those. They need a person holding a phone.

The bug was one line of logic: *while any implementation task is open, the next step is implement.* The pipeline had no idea that a task could belong to a person.

Three fixes, in order of how much they matter:

1. **Stop when a pass changes nothing.** If a verify meets the same number of criteria as the one before it, the loop ends and a person decides. Another pass would land in the same place.
2. **Make person-only work explicit.** The tasks stage now marks tasks like on-device checks, sign-offs and approvals with `[OWNER]`. They become the person's checklist instead of the agent's to-do list.
3. **Recommend the human decision.** When the review approved and nothing is left for an agent, the next step is "Accept and finish", not "Run implement." A **Skip** button lets you override any recommendation.

The general lesson: **an agent loop needs a progress measure, not just an exit condition.** "Stop when it passes" isn't enough when "passing" is impossible for the agent.

---

## Lesson 2: Summaries forget exactly the things you need

Each stage hands the next one a summary of what it did. Raw output can run to thousands of lines, so a small model compresses it to a few hundred characters.

I wrote six checks for those handoffs and ran them on the week's 303:

| Check | Failures |
| --- | --- |
| Keeps the commits, PRs and spec files the stage named | 43 |
| Was actually summarized (not the raw output passed on) | 24 |
| Keeps a question the stage was waiting on | 3 |
| Isn't over-redacted | 2 |
| Has output at all | 1 |
| Keeps the status line (e.g. "Verification Status: PARTIAL") | 0 |

**73 of 303 handoffs failed at least one check.** Of the references they dropped, 68 were commit hashes, 10 were PR numbers and 6 were spec files.

That makes sense once you see it. Tell a model to be brief and it drops the parts that look like noise, and `42460e4` looks like noise. It is also the one thing the next stage cannot reconstruct.

The 24 raw-output failures had a sillier cause. I used `openrouter/auto` for summaries, and it sometimes picked a reasoning model that spent its whole token budget thinking and returned nothing.

The fix is to **not trust a summary with an identifier**:

- After the model summarizes, read the status lines, commit hashes, PR numbers and spec files straight from the stage's raw output, and append any the summary dropped: `Refs: 42460e4, PR #78, tasks.md`. The same goes for a pending question.
- If the summarizer fails, try a small model that doesn't reason. If that fails too, build a summary in code from those facts plus the last few lines of output. Passing on 3,000 characters of raw log is never the answer.

The general lesson: **let the model summarize prose; extract identifiers deterministically.**

---

## Lesson 3: Your auth header is in your logs

This one is less fun.

Spaces pushes branches with a GitHub App installation token, passed to git the common way: `git -c http.extraheader="AUTHORIZATION: basic <token>" push`. One evening a push failed, and the run log showed the error: `Command failed: git -c http.extraheader=AUTHORIZATION: basic <the token, base64> push …`.

Two problems were stacked:

1. **Long runs outlive tokens.** Installation tokens last one hour. The worker set the token once when the run started, and this run lasted longer. The publish step fetched a fresh token, but git also sent the expired one it inherited from the environment, and GitHub read the stale header.
2. **Arguments end up in error messages.** `execFile` puts the full command line in the error. The error went into the run log, and my secret masking knew about `Bearer` tokens and `ghs_` tokens but not base64 inside `basic`.

The token had already expired, so the damage was limited. The fix:

- Pass credentials through the environment (`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_0`, `GIT_CONFIG_VALUE_0`), never as command arguments.
- Refresh the token every ten minutes while a run is working.
- Retry once with a fresh token when GitHub rejects one.
- Log git's stderr, scrubbed, instead of the command line.
- Teach the secret masking about `basic <base64>`.

The general lesson: **anything long-running will outlive its credentials, and anything in argv will end up in a log.**

---

## Lesson 4: You can't fix what you can't see, so chart it

All of this showed up because every agent turn was traced. Traces alone weren't enough, though. I found the twelve-loop afternoon by reading logs, which doesn't scale.

So every run now gets scored as it goes, and the scores are written onto the run in Phoenix:

- **handoff-quality:** the share of the six handoff checks each handoff passes.
- **report-format:** whether the verification report and code review are in the form the pipeline parses.
- **loop-progress:** whether each verify moved the criteria count compared with the previous one.

Phoenix's Metrics page charts those scores over time, next to cost, latency and errors. Before the fixes, loop-progress was **82% "no change."** A loop going nowhere is now a flat line on a chart instead of a surprise on the bill.

The general lesson: **evaluate your pipeline continuously, on real runs, with checks a machine can score.** LLM-as-judge is useful, but most of what broke here was checkable with a regex.

---

## What I'd tell anyone building agent pipelines

1. **Make progress measurable.** Every loop needs a "did this pass change anything?" check, not just a success condition.
2. **Make person-only work explicit.** Agents will keep retrying tasks they can't do unless the task says it's a person's.
3. **Never trust a summary with an identifier.** Extract hashes, numbers, paths and statuses in code.
4. **Assume credentials expire mid-run and leak through argv.** Pass them through the environment, refresh them, scrub errors.
5. **Put a person at the gates that matter, and make the gates convenient.** When an agent asks a question, show its options as choices with a box for more detail. When it recommends changes, make them a checklist you can tick, not something to retype.
6. **Score every run.** Traces tell you what happened; scores tell you when it's going wrong.

---

## Try it

<video controls preload="metadata" poster="/media/spaces-demo-poster.png" src="/media/spaces-demo.mp4" width="1280" height="720"></video>

Spaces is on GitHub: **[github.com/rayedbajwa/spaces](https://github.com/rayedbajwa/spaces)**. It's source-available and free for personal use.

You can self-host it with Bun and Postgres (`make setup && make up`) and bring your own key from Anthropic, OpenAI or OpenRouter. There's a hosted version at [spacesos.dev](https://spacesos.dev), invite-only for now with a waitlist.

If you're building something similar, I'd love to compare notes, especially on where the human gates belong and where they're just friction. Issues and discussions on the repo are open.

