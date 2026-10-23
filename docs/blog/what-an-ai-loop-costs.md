---
title: "Our Cost Dashboard Said $0. The Loop Had Made 3,466 Model Calls."
description: One feature looped through implement, review and verify twelve times in three hours. Here's what that cost, why our numbers undercounted it, and what actually drives the bill for agent pipelines.
date: 2026-11-11
image: /screenshots/agent-output.png
---

### Agent pipelines don't get expensive because one call is expensive. They get expensive because nobody notices the loop.

One evening, a feature in a mobile app project went through Spaces' implement → review → verify loop **twelve times between 19:16 and 22:24 UTC.**

In those three hours it made **3,466 model calls** and read **99 million input tokens**. The calls we could price came to **$3.08**.

That last number is the interesting one, because it's wrong.

---

## Why the number was wrong

Most of those calls went through an auto-routing model, which picks a model per request and bills whatever that model costs. Our usage records stored the router's price for each call, and the router's listed price is **$0**.

So the dashboard showed a few dollars for three hours of continuous agent work. The real cost was higher, and for a while we didn't know by how much.

**Lesson one: if you use a router, record the cost of the model it actually used,** from the provider's response or its billing API, not the router's price. Otherwise your cheapest-looking runs are the ones you know least about.

## Where the tokens went

99 million input tokens over 3,466 calls is about 28,000 tokens per call. Almost none of that is new information. It's the agent re-reading:

- the system prompt and tool definitions, every call
- the spec, plan and task list
- files it already read, after its context was compacted
- the previous stages' handoffs

Output is a rounding error next to it. **For agent pipelines, input tokens are the bill,** and the main lever is how many times a stage starts over and re-reads the world.

Prompt caching helps a lot here (most of that prefix is identical between calls), and so does keeping handoffs short. But the biggest saving is not running the stage at all.

## Why the loop ran twelve times

Nothing was broken. The code review had approved. Verification reported the same result every time: **5 of 15 criteria met, 0 critical failures.** All sixteen verify runs that evening said exactly that.

The remaining criteria needed a person with a real phone. The pipeline recommends "implement" while any implementation task is open, and those tasks were open because no agent could do them. So it implemented, reviewed and verified again, and again.

## What we changed

- **Stop when verification stops moving.** If a verify meets the same number of criteria as the one before, the loop ends and a person decides. We now [score that on every run](/blog/evals-for-agent-pipelines) as `loop-progress`.
- **Know when only people can help.** When the review is approved and the only open tasks are ones a person has to do, the pipeline recommends accepting and handing those to a person, instead of another implement pass.
- **Give people a Skip button.** Any recommended step can be skipped, straight to Accept, in one click.

## How to think about the cost of an AI-built feature

1. **Price per feature, not per call.** A run is the unit a team can reason about.
2. **Count the loops.** Loop count times stage cost is most of the bill. A feature that verifies first time is cheap; one that loops is not.
3. **Watch input tokens.** Re-reading dominates. Cache, and keep context lean.
4. **Distrust $0.** Free-looking calls are usually unpriced calls.
5. **Make "stop" a first-class outcome.** The cheapest call is the one a pipeline knows not to make.

Three hours of an agent spinning is cheap compared with three hours of an engineer. But it's waste all the same, and it hides problems you'd want to know about.

*Spaces is an AI software factory: specs go in, reviewed and tested pull requests come out. It's [on GitHub](https://github.com/rayedbajwa/spaces), source-available and free for personal use.*
