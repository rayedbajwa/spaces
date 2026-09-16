# Getting started

## Prerequisites

- [Bun](https://bun.sh) 1.4+
- Docker (for Postgres)
- An Anthropic API key
- Optional: OAuth apps for GitHub, Atlassian (Jira + Confluence), Linear, Slack

## Install and run

```bash
git clone https://github.com/rayedbajwa/spaces.git
cd spaces
cp .env.example .env
# Edit .env — set ENCRYPTION_KEY (openssl rand -base64 48) and ANTHROPIC_API_KEY
bun install
bun run db:up            # Postgres in Docker
bun run db:migrate       # idempotent schema (the server also applies it at boot)
bun run web              # web UI + API on http://localhost:3000
bun run supervisor       # in a second terminal: one worker per active project
```

`bun run worker` starts a single shared worker instead of the supervisor; it
runs jobs from different projects concurrently while honouring each project's
concurrency limit.

### With the Makefile

```bash
make setup          # .env (fresh ENCRYPTION_KEY), bun install, Postgres, schema, frontend build
make up             # Postgres + web server + supervisor in the background; logs in .run/
make status         # processes, live workers, queue depth
make logs           # tail server + supervisor logs
make restart        # restart server + supervisor (runs are re-queued or stay paused)
make e2e            # bring the stack up and run the e2e suite for every pipeline template
make e2e-one T=aidlc-feature
make e2e-canary     # the smallest template only
make docs           # strict MkDocs build
make down           # stop everything
```

`make help` lists all targets.

!!! warning "Shell variables override `.env`"
    A placeholder `ANTHROPIC_API_KEY` exported in your shell silently wins over
    `.env` and makes every agent call fail with 401. Both server and worker
    verify the key at boot and log a clear warning when that happens.

## Connect GitHub

Open **Integrations** in the hero and press **Connect** for GitHub. Once
connected, every repository the account can see is indexed with its README use
case (the *repository catalog*), and the new-project wizard can autocomplete
repositories.

## Create a project

Click **New project** and walk through the wizard:

1. **Name and description.** You can also *Import from Jira / Linear*: pick a
   ticket, and it fills the name, description and first feature and is attached
   to the project as knowledge.
2. **Repositories (optional).** Specs and memory live in the project's
   *governing workspace*; code repositories can be added now (GitHub
   owner/name or local path) or left to onboarding and the plan.
3. **Integrations.** Optional.
4. **First feature.** Describe it and choose **Create + run AIDLC**.

Onboarding then runs while you watch: clone remote repos → initialise the Spec
Kit workspace → inventory and learn each repo → build project memory → suggest
repositories and work areas → set up the development environments. When it is
done you review the suggested repositories (Add & clone) and continue; the first
run starts in real checkouts.

## Follow a run

Open the project card. The run panel streams the agent's output live; the tabs
show specs, test plan, implementation workstreams, QA, the assistant, shared
context, memory and promotions. Paused runs show an answer box (**Approve and
continue** for review gates, **Continue** or a typed answer for clarifications).
Failed or interrupted runs offer **Rerun from &lt;stage&gt;**.

## Next steps

- Understand the [pipeline templates](reference/templates.md) and pick one per
  kind of work (feature, bugfix, refactor, infra, …).
- Scope the project's [knowledge sources](concepts/integrations-and-knowledge.md)
  in the Context tab.
- Read how [delivery](concepts/delivery.md) drives PRs, review, merge and UAT.
