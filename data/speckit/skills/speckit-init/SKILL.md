# Init: set up the Spec Kit workspace

Input: $ARGUMENTS

Spaces sets up `.specify/` when the project is onboarded, so this is normally a check.

1. Find the repository root (`git rev-parse --show-toplevel`). Not a git repository: run `git init` there first.
2. If `.specify/` exists, list its top level, say it is already initialized, and stop.
3. Otherwise copy the templates and make the scripts executable:

   ```bash
   root="$(git rev-parse --show-toplevel)"
   cp -r "SPECKIT_ROOT/specify-templates/." "$root/.specify/"
   chmod +x "$root/.specify/scripts/bash/"*.sh
   ```

4. Make sure `AGENTS.md` at the root has a `## Spec-Kit` section (append it, or create the file): the repository follows the [spec-kit](https://github.com/github/spec-kit) workflow; `.specify/templates/` holds the spec, plan, task and checklist templates, `.specify/memory/` long-lived context such as `constitution.md`, `.specify/scripts/` the helper scripts, `.specify/hooks.yml` the hook definitions.
5. Report what was created and whether AGENTS.md changed.
