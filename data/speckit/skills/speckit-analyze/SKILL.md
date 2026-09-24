# Analyze: check spec, plan and tasks against each other

User input (consider it if not empty): $ARGUMENTS

**Read-only**: change no files. The constitution (`.specify/memory/constitution.md`) is non-negotiable: a conflict with it is always CRITICAL and is fixed in spec, plan or tasks, never by reinterpreting the principle.

## Steps

1. Run `.specify/scripts/bash/check-prerequisites.sh --json --require-tasks --include-tasks`; use `FEATURE_DIR`. If spec.md, plan.md or tasks.md is missing, say which stage to run and stop.
2. Read only what the analysis needs: the spec's requirements, stories and edge cases; the plan's stack, data model, phases and constraints; the task IDs, descriptions, phases, `[P]` markers and paths; the constitution's MUST/SHOULD rules.
3. Build (internally) a requirements inventory with stable keys, and map each task to the requirements and stories it serves.
4. Find, at most 50 findings (summarize the overflow):
   - **Duplication**: near-duplicate requirements.
   - **Ambiguity**: vague adjectives without a measure; unresolved placeholders (TODO, ???, `<…>`).
   - **Underspecification**: requirements without a measurable outcome; stories without acceptance criteria; tasks naming files or components absent from spec/plan.
   - **Constitution**: conflicts with a MUST; missing mandated sections or gates.
   - **Coverage**: requirements with no task; tasks with no requirement; non-functional requirements with no task.
   - **Inconsistency**: terminology drift; entities in one document but not the other; task order contradictions; conflicting requirements.
5. Severity: **CRITICAL** constitution MUST violation, missing core artifact, or a blocking requirement with no coverage · **HIGH** duplicate/conflicting requirement, ambiguous security or performance attribute, untestable criterion · **MEDIUM** terminology drift, missing non-functional coverage, underspecified edge case · **LOW** wording.
6. Output the report:

   ```markdown
   ## Specification Analysis Report
   | ID | Category | Severity | Location(s) | Summary | Recommendation |
   |----|----------|----------|-------------|---------|----------------|

   **Coverage**: | Requirement | Has task? | Task IDs | Notes |
   **Constitution issues** · **Unmapped tasks** (if any)
   **Metrics**: requirements, tasks, coverage %, ambiguities, duplications, critical issues
   ```

   IDs are stable and prefixed by category (A1, D2…). With no issues, report the coverage statistics.
7. **Next actions**: resolve CRITICAL issues before implementing; otherwise proceeding is fine, with the improvements named. Offer concrete remediation edits for the top issues, and do not apply them.
