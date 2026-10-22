---
title: Coding Agents Are Not Enough. Your Team Needs a Software Factory.
description: AI made writing code cheap, not shipping software. Why teams need a software factory — specs, review and QA as stations, an orchestrator, deploy verification and a record — and not just a smarter agent.
date: 2026-10-22
image: /media/software-factory-line.png
---

### AI made writing code cheap. It didn't make shipping software cheap. Here's the missing layer, and why it's a factory and not a smarter agent.

![The line: one agent per station, your approval at the gates](/media/software-factory-line.png)

Every team I talk to has the same story. They gave developers an AI coding agent. Output went up. And then something odd happened: the pull request queue got longer, reviews got shallower, and nobody could say with confidence what had shipped or why.

That isn't a failure of the agents. They do exactly what they're built to do: write code, fast. The failure is that **code was never the bottleneck.**

The bottleneck is everything around the code. Agreeing on what to build. Breaking it into pieces. Reviewing the change. Testing it against what was agreed. Getting a person to say "ship it." Knowing, three weeks later, why a decision was made.

Coding agents sped up one station on a line that has eight. The other seven are now the bottleneck, and most teams are running them on vibes.

That's the case for a software factory.

---

## What I mean by a "software factory"

Not a code generator you fire and forget. A factory is a **process with stations, inspection points and a record**:

```
ticket → research → specify → plan → tasks → implement → review → verify → deliver → merged
                       ↑         ↑       ↑          ↑                   ↑          ↑
                      you       you     you        you                 you        you
```

Each station is an agent with one job. Between stations are **gates**, where a person approves the work before it moves on. Every station leaves a **document** you can read: the spec, the plan, the task list, the code review, the verification report, the delivery report.

The output isn't just a pull request. It's a pull request with its paperwork: why it exists, what it was supposed to do, how it was checked, and who approved it.

I've been building one, called [Spaces](https://github.com/rayedbajwa/spaces), on GitHub's Spec Kit and AWS's AI-Driven Development Life Cycle (AIDLC). Here's why I think this shape matters more than any individual model upgrade.

---

## 1. Speed without a spec is just faster rework

A coding agent will happily build the wrong thing at 10× speed.

The cheapest place to catch a misunderstanding is before any code exists. So the first thing a factory does is turn "add search to the notes list" into a **spec with acceptance criteria**: what counts as done, in words a person can check. A human approves it. Then a plan, then tasks, each approved.

This feels slow for about a day. Then you notice the review conversations change. Instead of "is this what you meant?", it's "does this meet criterion 4?" That's a much shorter conversation.

![A spec written by the specify agent, waiting for approval](/screenshots/generated-spec.png)

## 2. Review and testing have to be stations, not afterthoughts

In most AI-assisted workflows, review and QA are something a tired human does at the end. In a factory, they're stations with their own agents and their own outputs:

- A **review** agent checks the diff against the spec, the conventions and the tests, and writes `code-review.md` with findings by severity. A blocker sends the work back to implement automatically.
- A **verify** agent runs the tests, drives the app in a real browser, and writes `verification-report.md`: each acceptance criterion, met or not, with evidence.

The loop (implement → review → verify → back to implement) runs on its own. The human isn't the quality-control step anymore. The human is the *decision* step.

There's a catch I learned the hard way: **a loop needs a progress measure, not just an exit condition.** One of my early features looped twelve times because what was left (on-device testing) needed a person with a phone. Now the loop stops when a pass changes nothing, and work only a person can do is marked as a person's. A factory is only as good as its ability to know when to stop and ask.

## 3. Parallelism needs an orchestrator

Once work is broken into tasks, a lot of it can run side by side. An API change, a UI change and their tests don't have to wait for each other.

A factory has an **orchestrator** that splits the plan into workstreams, gives each its own agent, its own branch and its own pull request, and stacks the PRs when one depends on another. Each project runs on its own isolated worker, with its own disk and its own test database.

Without that, "parallel agents" means three agents editing the same files and you resolving the conflicts.

![The orchestrator splits a plan into parallel workstreams, each with its own branch and pull request](/media/software-factory-orchestrator.png)

## 4. "Done" should mean running, not merged

Most pipelines stop at "merged". But merged isn't shipped.

The last station in a factory watches the deploy, checks the live environment's health, and runs the acceptance tests **against production**. Done means running. And the agent asks before it merges or deploys, never after.

## 5. The record is the product

This is the reason I care most about.

When an agent writes code in someone's editor, the reasoning evaporates. The prompt is gone, the back-and-forth is gone, the "we tried X and it broke Y" is gone. Six weeks later, you have code nobody fully understands, written by a process nobody can replay.

A factory keeps the record by design: every stage's document, every gate decision with who made it, every tool call as a log line with the time and the agent, and **the cost of every run**. The spec is committed next to the code.

That record is what makes AI-written software *maintainable*. It's also what makes it auditable, which matters the moment you work anywhere with compliance, customers or a security team.

## 6. You can only improve what you measure

A factory gives you something an editor plugin never will: a line you can instrument.

In Spaces, every run is traced, and every stage is scored as it hands off: did the handoff keep the facts the next stage needs, is the report in the expected format, did this pass actually move the needle. In one week, those scores told me that 24% of handoffs between agents were losing facts, mostly commit hashes, and that 82% of verify passes in one loop made no progress. Both were fixable in an afternoon *once I could see them*.

You can't run a factory floor by feel. You shouldn't run an AI one that way either.

---

## "Isn't this just process for the sake of process?"

It's a fair worry. Here's how I'd answer it.

- **The gates are cheap when they're convenient.** When an agent asks a question, show its options as choices with a box for detail. When a review recommends changes, make them a checklist you tick, not something you retype. A gate should take thirty seconds, not a meeting.
- **Not everything needs the full line.** A typo fix doesn't need a spec. A factory should let you skip stations, and record that you did.
- **The alternative isn't "no process."** It's process that lives in people's heads and Slack threads. AI didn't remove the need for a spec, a review and a test. It removed the time you used to spend writing the code, which is exactly the time you now have for doing those properly.

---

## Where this is going

I think we're heading toward a split. Individual developers will keep using coding agents in their editors, and they should. But **teams** will need something more: a shared line where work is specified, built, checked and shipped the same way every time, with people at the gates that matter and a record of everything.

That's not a smarter agent. It's a factory.

---

## Try it

<video controls preload="metadata" poster="/media/spaces-demo-poster.png" src="/media/spaces-demo.mp4" width="1280" height="720"></video>

[Spaces](https://github.com/rayedbajwa/spaces) is source-available and free for personal use. Self-host it with Bun and Postgres and bring your own Anthropic, OpenAI or OpenRouter key, or join the waitlist for the hosted version at [spacesos.dev](https://spacesos.dev).

If you've read the companion post, [What Broke When I Let AI Agents Run My Software Process for a Month](/blog/what-broke-when-ai-agents-ran-my-software-process), this is the "why" behind it. I'd love to hear where you think the gates belong, and where they're just friction.

