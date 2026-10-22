---
title: "Evals for Agent Pipelines: Scoring Every Handoff in Phoenix"
description: Unit tests can't tell you a multi-agent pipeline is quietly losing facts between stages. We score every handoff, report and loop on real runs and chart it next to cost and latency.
date: 2026-11-04
image: /media/software-factory-line.png
---

### You can't unit-test whether one agent handed the next everything it needed. You can score it on every real run, and chart it.

A multi-agent pipeline fails in ways a single agent doesn't. Each stage can do its job well and the run still goes wrong, because something got lost *between* stages.

In Spaces, every stage (specify, plan, tasks, implement, review, verify, deliver) is its own agent. When a stage finishes, its output is summarized and handed to the next one as context. That handoff is the pipeline's memory, and for a while we had no idea how good it was.

Then we started scoring it.

---

## Three things worth scoring

We trace every agent turn to [Arize Phoenix](https://phoenix.arize.com/). Each run is a Phoenix session. As each stage hands off, the worker scores it and writes the scores onto the session as annotations:

**1. `handoff-quality`**: six checks on what the next stage received, scored 0–1:

| Check | What it catches |
|---|---|
| complete | the stage's output was cut off or empty |
| compacted | a long output went on raw instead of summarized |
| keeps-status | "Verification Status: PARTIAL" didn't survive the summary |
| keeps-references | commit hashes, PR numbers or spec files were dropped |
| keeps-question | the stage stopped on a question, and the handoff doesn't say so |
| not-over-redacted | secret-masking hid more than the stage's output had |

**2. `report-format`**: whether the verification report and code review are in the form the pipeline parses. The pipeline branches on lines like `Code Review Status: APPROVED`; a report that drifts from the format is a silent bug.

**3. `loop-progress`**: whether each verify moved the count of acceptance criteria met, compared with the previous verify. `same` means an implement pass changed nothing that mattered.

All three are plain code, not LLM judges. Most of what goes wrong in a pipeline is checkable with a regex.

## What a week of real runs showed

We backfilled a week: 303 handoffs from 96 runs.

- **73 of 303 handoffs failed at least one check.** 43 dropped references (68 commit hashes, 10 PR numbers, 6 spec files). Told to be brief, a summarizer drops exactly the strings that look like noise, and `42460e4` looks like noise.
- **24 handoffs passed raw output on.** The summarizer used an auto-routing model that sometimes picked a reasoning model, which spent its budget thinking and returned nothing.
- **82% of verify passes in one project made no progress.** One feature ran implement → review → verify twelve times; what was left needed a person.

None of that was visible in logs unless you went looking. All of it was obvious on a chart.

## The fixes the scores pointed to

- **Never trust a summary with an identifier.** After the model summarizes, status lines, commit hashes, PR numbers, spec files and pending questions are read from the raw output in code and appended if missing.
- **A fallback model, then an extractive summary.** If the summarizer returns nothing, try a non-reasoning model; if that fails, build a short summary in code instead of passing thousands of characters on.
- **Stop loops that stop progressing.** If a verify meets the same number of criteria as the last one, the loop ends and a person decides.

## Why annotations, not a dashboard

Phoenix's project Metrics page already charts session annotation scores over time, next to traces, errors, latency, tokens and cost. So we didn't build a dashboard. We wrote scores onto runs and let Phoenix chart them.

That has a nice property: when a score drops, you click through to the exact session, see which stage failed which check, and read the trace.

## How to start

1. **Trace every agent turn**, grouped by run.
2. **Write down what each handoff must keep.** For us: status, references, open questions.
3. **Check it in code** on every handoff. Score 0–1, explain failures in plain words.
4. **Write the scores where your traces are,** so a bad score is one click from its cause.
5. **Backfill a week** before you trust your intuition about where the pipeline is weak. Ours was wrong.

*Spaces is an AI software factory: specs go in, reviewed and tested pull requests come out. It's [on GitHub](https://github.com/rayedbajwa/spaces), source-available and free for personal use.*
