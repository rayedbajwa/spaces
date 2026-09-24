# Tasks to issues: one GitHub issue per task

User input (consider it if not empty): $ARGUMENTS

1. Run `.specify/scripts/bash/check-prerequisites.sh --json --require-tasks --include-tasks` and take the tasks path.
2. Get the remote: `git config --get remote.origin.url`. **Continue only if it is a GitHub URL.**
3. For each task in tasks.md, in dependency order, create an issue in **that repository only** — never in any repository that does not match the remote — with the task ID and description as the title, and its phase, story and dependencies in the body.
4. Report the issues created (number and task ID).
