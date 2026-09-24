# Specify: write the feature specification

Feature description (the user's input; use it, never ask for it again):

```text
$ARGUMENTS
```

## Steps

1. **Short name**: 2–4 words, action-noun, keep technical terms (e.g. "add user authentication" → `user-auth`, "fix payment timeout bug" → `fix-payment-timeout`).
2. **Create the feature** — once per feature, never again:
   `.specify/scripts/bash/create-new-feature.sh --json --short-name "<short-name>" "<feature description>"`
   Do not pass `--number` (the script picks the next one). Use `BRANCH_NAME` and `SPEC_FILE` from its JSON. Escape single quotes as `'\''`.
3. **Write SPEC_FILE** from `.specify/templates/spec-template.md`: keep its section order and headings, replace every placeholder, delete optional sections that do not apply (no "N/A").
   - Actors, actions, data, constraints come from the description. Where it is silent, choose a reasonable default and record it under Assumptions.
   - User stories: prioritized (P1 first), each independently testable, with Given/When/Then acceptance scenarios.
   - Functional requirements: numbered (FR-001…), each testable and unambiguous.
   - Success criteria: numbered (SC-001…), measurable, technology-agnostic, user-facing ("checkout in under 3 minutes", not "API under 200ms").
   - Key entities only when data is involved. Edge cases: the boundaries and failures that matter.
   - WHAT and WHY only: no stack, APIs or code structure. Written for business stakeholders.
4. **Clarifications**: mark at most 3 `[NEEDS CLARIFICATION: <question>]`, and only where the choice changes scope, security/privacy or UX, has several reasonable readings, and no sensible default (priority: scope > security/privacy > UX > technical). Don't ask about things with standard defaults (retention, performance norms, error handling, auth for web apps, integration style).
5. **Validate** into `FEATURE_DIR/checklists/requirements.md`:

   ```markdown
   # Specification Quality Checklist: <feature>
   **Created**: <date> · **Feature**: [spec.md](../spec.md)
   ## Content Quality
   - [ ] No implementation details (languages, frameworks, APIs)
   - [ ] Focused on user value; written for non-technical stakeholders
   - [ ] All mandatory sections completed
   ## Requirement Completeness
   - [ ] No [NEEDS CLARIFICATION] markers remain
   - [ ] Requirements are testable and unambiguous
   - [ ] Success criteria are measurable and technology-agnostic
   - [ ] Acceptance scenarios, edge cases, scope, dependencies and assumptions are defined
   ## Feature Readiness
   - [ ] Every functional requirement has acceptance criteria
   - [ ] User scenarios cover the primary flows
   ```

   Check each item against the spec, fix the spec for any failure (up to 3 passes), tick what passes, and note what still fails.
6. **If markers remain**, ask them all at once and stop:

   ```markdown
   ## Question 1: <topic>
   **Context**: <quote from the spec>
   **What we need to know**: <the question>

   | Option | Answer | Implications |
   |--------|--------|--------------|
   | A | … | … |
   | B | … | … |
   | Custom | Your own answer | … |

   **Your choice**: _[Wait for user response]_
   ```

   Number them Question 1–3. When answered, replace each marker with the answer, and re-validate.
7. **Report**: branch, spec path, checklist result, and whether it is ready for clarify or plan.
