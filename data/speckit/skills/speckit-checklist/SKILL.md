# Checklist: unit tests for the requirements

Checklist focus (consider it if not empty): $ARGUMENTS

A checklist tests whether the **requirements are well written** — complete, clear, consistent, measurable, covering the scenarios — not whether the implementation works.

- ✅ "Is 'prominent display' quantified with specific sizing? [Clarity, Spec §FR-4]"
- ✅ "Are error responses specified for every failure mode? [Completeness, Gap]"
- ❌ "Verify the button works" / "Test error handling" / "Confirm the API returns 200"

## Steps

1. Run `.specify/scripts/bash/check-prerequisites.sh --json`; use `FEATURE_DIR` and `AVAILABLE_DOCS`.
2. **Scope**: from the focus above and the spec/plan/tasks, decide the domain (e.g. api, ux, security, performance; the focus above names it when given), depth (default: standard) and audience (default: PR reviewer). Ask only when the answer changes the checklist materially — at most 3 questions, as `## Question N: <topic>` with a short options table (Option | Candidate | Why it matters), then stop and wait. Otherwise use the defaults and the top two focus areas.
3. Read the parts of `spec.md` (and `plan.md`, `tasks.md` when they exist) that matter for the focus.
4. Write `FEATURE_DIR/checklists/<domain>.md` from `.specify/templates/checklist-template.md`. If the file exists, append and continue its CHK numbering; never delete items.
   - Group by: Requirement Completeness · Clarity · Consistency · Acceptance Criteria Quality · Scenario Coverage (primary, alternate, exception, recovery) · Edge Cases · Non-Functional · Dependencies & Assumptions · Ambiguities & Conflicts.
   - Each item: `- [ ] CHK001 <question about the requirement> [<dimension>, Spec §X]`. At least 80% cite a spec section or a marker: `[Gap]`, `[Ambiguity]`, `[Conflict]`, `[Assumption]`.
   - Phrase items as "Are … defined/specified for …?", "Is … quantified?", "Are … consistent between … and …?", "Can … be objectively measured?". Never start with Verify/Test/Confirm/Check an implementation behaviour, and no implementation details.
   - Rollback/recovery requirements when state changes. Merge near-duplicates; at most ~40 items, highest risk first; fold minor edge cases into one item.
5. **Report**: checklist path, item count, created or appended, focus areas, depth and audience.
