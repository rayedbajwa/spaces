# Tasks: break the plan into executable tasks

Context (consider it if not empty): $ARGUMENTS

## Steps

1. Run `.specify/scripts/bash/check-prerequisites.sh --json`; use `FEATURE_DIR` and `AVAILABLE_DOCS`.
2. Read `plan.md` (stack, structure) and `spec.md` (user stories and priorities). Use `data-model.md`, `contracts/`, `research.md` and `quickstart.md` only when they exist and add something.
3. Write `FEATURE_DIR/tasks.md` from `.specify/templates/tasks-template.md`:
   - **Phase 1 Setup** and **Phase 2 Foundational** (what blocks every story) — only the tasks that are really needed.
   - **One phase per user story**, in priority order, each with its goal and an independent test. Order inside a story: tests (when requested) → models → services → endpoints/UI → integration.
   - **Final phase**: polish and cross-cutting work.
   - Map each entity and contract to the story that needs it (the earliest one, or Foundational when several do).
   - Test tasks only when the spec asks for tests or TDD, or the project's acceptance tests need them.
4. Every task is exactly one line in this format (Spaces tracks progress from it):

   `- [ ] T001 [P] [US1] <action> in <exact/file/path>`

   - `T001…`: sequential in execution order. `[P]`: only when it touches different files and depends on nothing unfinished. `[USn]`: required in story phases, absent in setup, foundational and polish.
   - Specific enough that an agent can do it without further context. One file concern per task.
5. After the phases, add a short **Dependencies** section (story order, what blocks what) and name the MVP (usually User Story 1). No parallel-execution examples, team strategies or other boilerplate.
6. **Report**: tasks.md path, total tasks and per story, parallel opportunities, the MVP, and that every task follows the format.
