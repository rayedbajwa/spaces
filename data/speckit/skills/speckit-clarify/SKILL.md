# Clarify: resolve the spec's open decisions

User input (consider it if not empty): $ARGUMENTS

Goal: find the ambiguities and missing decisions in the active spec that would change the plan or tests, ask about the most important ones (at most 5 questions), and write the answers into the spec.

## Steps

1. Run `.specify/scripts/bash/check-prerequisites.sh --json --paths-only` once; use `FEATURE_DIR` and `FEATURE_SPEC`. If it fails, the spec is missing: say to run specify first and stop.
2. Read the spec and rate each area Clear / Partial / Missing (keep this internal):
   scope & out-of-scope · roles · entities, identity, lifecycle, volume · key journeys, error/empty/loading states · performance, scale, reliability, observability · security, privacy, compliance · external dependencies and their failure modes · edge cases (negative flows, rate limits, concurrency) · constraints & tradeoffs · terminology · testable acceptance criteria · TODOs and vague adjectives ("fast", "robust").
3. Queue up to 5 questions, highest (impact × uncertainty) first. Ask only what materially changes architecture, data model, tasks, tests, UX, operations or compliance. Skip what is already answered, stylistic, or better decided in the plan. Each must be answerable by one option (2–5) or a short answer (≤ 5 words).
4. Ask **one question at a time**, then stop and wait:

   ```markdown
   ## Question N: <topic>
   **Recommended:** Option B — <1–2 sentences why>

   | Option | Description |
   |--------|-------------|
   | A | … |
   | B | … |
   | Short | A different short answer (≤ 5 words) |

   Reply with a letter, "yes" to accept the recommendation, or your own short answer.
   ```

   For a short-answer question use `**Suggested:** <answer> — <why>` instead of the table. "yes"/"recommended"/"suggested" means the recommendation. If a reply is ambiguous, ask again (same number). Never reveal later questions. Stop early when the rest no longer matter or the user says done/stop/proceed.
5. After **each** accepted answer, update the spec file right away:
   - Add `## Clarifications` (after the overview section) and `### Session YYYY-MM-DD` if missing, then `- Q: <question> → A: <answer>`.
   - Apply it where it belongs (functional requirements, user stories, entities, success/quality criteria as a metric, edge cases, or a normalized term), replacing any statement it contradicts. Keep changes minimal and testable; no other new headings.
6. **Report**: questions asked/answered, spec path, sections touched, and a compact table of the areas as Resolved / Deferred / Clear / Outstanding, with whether to proceed to plan.

If nothing is worth asking, say "No critical ambiguities detected worth formal clarification." with the compact table, and proceed.
