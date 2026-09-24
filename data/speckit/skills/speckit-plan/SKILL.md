# Plan: design how the feature is built

Planning input (consider it if not empty): $ARGUMENTS

## Steps

1. Run `.specify/scripts/bash/setup-plan.sh --json`; use `FEATURE_SPEC`, `IMPL_PLAN`, `SPECS_DIR`, `BRANCH`. It copies the plan template to IMPL_PLAN.
2. Read FEATURE_SPEC and `.specify/memory/constitution.md`.
3. Fill IMPL_PLAN, following its structure:
   - **Technical Context**: the real stack, dependencies, storage, testing, platform, constraints — from the repository, not guesses. Mark real unknowns `NEEDS CLARIFICATION`.
   - **Constitution Check**: each relevant principle → pass, or a justified violation in Complexity Tracking. An unjustified violation is an error: stop and report it.
   - **Project Structure**: the actual directories this feature touches (drop the template's unused options).
4. **Research** → `research.md`, only for the unknowns, dependencies and integration choices that exist: for each, `Decision / Rationale / Alternatives considered`. Resolve every `NEEDS CLARIFICATION`.
5. **Design**:
   - `data-model.md` when the feature has data: entities, fields, relationships, validation rules, state transitions.
   - `contracts/` when it exposes interfaces (API endpoints, CLI commands, events, UI contracts); skip for purely internal work.
   - `quickstart.md`: the few steps to run and check the feature end to end.
   - Run `.specify/scripts/bash/update-agent-context.sh generic` to record new technology.
6. Re-check the constitution after design. Stop after design: tasks are the next stage.
7. **Report**: branch, plan path, and the files generated.

Keep each document as short as its content allows: decisions and facts, no restated spec text, no boilerplate.
