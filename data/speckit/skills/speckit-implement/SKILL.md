# Implement: carry out the tasks

User input (consider it if not empty): $ARGUMENTS

## Steps

1. Run `.specify/scripts/bash/check-prerequisites.sh --json --require-tasks --include-tasks`; use `FEATURE_DIR` and `AVAILABLE_DOCS`. If tasks.md is missing, say to run tasks first and stop.
2. **Checklists**: if `FEATURE_DIR/checklists/` has files, count `- [ ]` vs `- [x]` per file. Open items do not block (the run's review gates decide): keep them in view while implementing, and list in your report the ones still open, with why.
3. Read `tasks.md` and `plan.md`; read `data-model.md`, `contracts/`, `research.md`, `quickstart.md` only when a task needs them.
4. **Ignore files**: for a git repository, make sure `.gitignore` (and, when the tool is in use, `.dockerignore`, `.eslintignore`/eslint `ignores`, `.prettierignore`, `.npmignore` when publishing, `.terraformignore`, `.helmignore`) covers the stack's build output, dependencies, logs, env files and secrets. Append missing patterns only; never remove lines.
5. **Execute phase by phase**, in task order:
   - Finish a phase before the next. `[P]` tasks may run together; tasks touching the same file run in sequence.
   - Tests before the code they cover, when the tasks include tests.
   - After each task, tick it in tasks.md (`- [x] T012 …`) and run the tests for what it changed.
   - A failing non-parallel task stops the phase: fix it, or report the error with context and what is needed.
6. **Finish**: every required task done and ticked, the implementation matches the spec and plan, and the tests you ran pass. Report what was completed and anything left.
