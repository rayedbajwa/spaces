---
title: Human-in-the-Loop That Doesn't Slow You Down
description: Approval gates are what make AI agents safe to run on a team, and what makes people hate them. Three small UI changes turned our gates from friction into a 30-second decision.
date: 2026-10-31
image: /media/hitl-recommendations.png
---

### Approval gates make AI agents safe to run on a team. Badly designed, they're also why people turn them off. Here's what we changed to make each gate a 30-second decision.

Spaces runs every feature down a line of AI agents (specify, plan, tasks, implement, review, verify, deliver) and stops for a person's approval at the stages that matter. Those gates are the point: a person agrees on the spec before code exists, and says yes before anything merges.

They were also, for a while, the most annoying part of the product.

The problem wasn't the gates. It was what we asked people to do at them: read a wall of agent output, then type a reply into an empty box. Every gate was a small essay assignment.

Three changes fixed most of it.

---

## 1. When an agent offers options, show options

Agents ask questions in a predictable shape. A clarify step writes something like:

> **Question 1: Release channel and target scope**
> **Recommended:** Option A, a private beta on both platforms first
>
> | Option | Description |
> |---|---|
> | A | Private beta on both iOS and Android first |
> | B | Private beta on one platform first |
> | C | Public release directly |

We were rendering that as text and giving the person a blank box. They'd scroll up, read the table, scroll down, type "A".

Now the panel reads the options out of the agent's message and shows them as choices, with the recommended one already picked, an **Other** option for your own answer, and a box for anything extra you want the agent to know:

![The agent's options as choices, the recommended one preselected](/media/hitl-agent-options.png)

One click accepts the recommendation. The answer the agent receives is unambiguous ("A — Private beta on both iOS and Android first", plus any additional details), which matters more than it sounds: free-text answers were a steady source of misunderstandings downstream.

The parser handles the shapes agents actually write: clarify tables, lettered or numbered lists after a "which / choose" question, and plain yes/no approvals ("May I merge PR #77?"). It deliberately *doesn't* treat a numbered plan under "Do you approve:" as a set of alternatives. Open questions keep the plain answer box.

One bug worth sharing: the first version never matched anything in production. Every log line is stamped `[18:36:34Z specify]`, and the parser was anchored to the start of the line. Test fixtures without the stamps all passed. Now the stamps are stripped first, and a test uses a stamped log.

## 2. When a reviewer recommends changes, make them a checklist

Review stages end with a list: *recommended changes before moving on.* We used to expect the person to copy the ones they agreed with into a reply.

Now each recommendation is a card you tick, all ticked to start because the reviewer recommends them:

![A review's recommended changes as a checklist](/media/hitl-recommendations.png)

The buttons follow the ticks:

- **Approve with 3 changes**: apply the ticked ones (and your notes), then move on.
- **Approve as-is**: skip them.
- **Send back with 3 changes**: another pass, reviewed again.

What used to be a paragraph of typing is now three taps.

## 3. Always give people a way out

The third change was about the gates we *didn't* design: the ones the pipeline creates by itself.

An implement → review → verify loop once ran twelve times in three hours on one feature. Everything an agent could do was done; what was left needed a person with a phone. The pipeline kept recommending "Run implement", and the person watching had no button that said "this is going nowhere."

So every recommended step now has a **Skip** menu: run review, verify or implement instead, or go straight to **Accept and finish**, with a confirmation. And the pipeline now recommends Accept itself when nothing is left for an agent.

The principle: **a person should always be able to overrule the machine in one click,** and the machine should say why it's recommending what it recommends.

---

## What we learned

- **A gate's cost is the typing, not the decision.** People are happy to decide. They're not happy to compose.
- **Read structure out of agent output.** Agents already write options, recommendations and questions in consistent shapes. Render them as controls.
- **Make the default the recommendation,** but make the alternative one click away.
- **Every automated loop needs a human exit.**

Gates are what make it safe to let agents write, review and ship code on a team. They only survive if they take thirty seconds.

*Spaces is an AI software factory: specs go in, reviewed and tested pull requests come out. It's [on GitHub](https://github.com/rayedbajwa/spaces), source-available and free for personal use.*
