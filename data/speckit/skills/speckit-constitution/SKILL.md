# Constitution: create or amend the project's principles

Principles input (consider it if not empty): $ARGUMENTS

Work on `.specify/memory/constitution.md` in place (never a new file). It may still hold template tokens like `[PROJECT_NAME]` or `[PRINCIPLE_1_NAME]`.

## Steps

1. Read the constitution and find every `[ALL_CAPS]` token. Use the number of principles the input asks for, even if it differs from the template.
2. Fill the values from the input, else from the repository (README, docs, earlier versions). Dates are ISO `YYYY-MM-DD`: `RATIFICATION_DATE` is the original adoption (unknown → `TODO(RATIFICATION_DATE): <why>`), `LAST_AMENDED_DATE` is today when anything changes.
3. Version (`CONSTITUTION_VERSION`, semver): MAJOR for removed or redefined principles, MINOR for a new principle or materially expanded guidance, PATCH for wording. State the reasoning when it is not obvious.
4. Write each principle as a name plus declarative, testable MUST/SHOULD rules with a rationale where not obvious. The Governance section covers the amendment procedure, versioning policy and compliance review. Keep the template's heading levels; no unexplained tokens left.
5. Keep dependents in line: update `.specify/templates/plan-template.md` (Constitution Check), `spec-template.md` and `tasks-template.md` where a principle adds or removes a mandatory section or task type, and runtime guidance (README, docs) that names changed principles.
6. Prepend an HTML comment **Sync Impact Report**: version old → new, principles changed/added/removed, templates updated (✅) or pending (⚠), deferred TODOs.
7. Write the file, then report the new version and why, files needing manual follow-up, and a commit message such as `docs: amend constitution to vX.Y.Z (…)`.
