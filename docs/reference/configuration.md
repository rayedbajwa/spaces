# Configuration

All settings come from environment variables (loaded from `.env` by Bun; a
shell variable overrides the file). See `.env.example` for the annotated list.

## Required

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string (matches `docker-compose.yml`) |
| `ENCRYPTION_KEY` | 32+ random characters; derives the AES-256-GCM key that seals OAuth tokens. Rotating it invalidates every stored token. |
| `ANTHROPIC_API_KEY` | Used by every agent step; verified at boot |

## Optional

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Web UI + API port |
| `OPENAI_API_KEY` | — | Alternative provider |
| `WORKER_ID` | random UUID | Worker identity (per process) |
| `WORKER_MAX_CONCURRENT_JOBS` | `4` | Jobs one worker runs at once across projects |
| `SUPERVISOR_MAX_WORKERS` | `4` | Cap on per-project workers (each ~300–500 MB) |
| `WORKER_IDLE_EXIT_SECONDS` | `300` | Idle time before a per-project worker exits |
| `AIDLC_WORKSPACE_ROOT` | `~/.aidlc/workspaces` | Where GitHub repos are cloned (`<owner>/<name>`) |
| `AIDLC_GOVERNANCE_WORKSPACE` | `1` | `0` keeps specs inside the application repo instead of a governing workspace |
| `AIDLC_GOVERNANCE_ROOT` | `<workspace root>/_governance` | Location of governing workspaces |
| `AIDLC_WORKTREE_ROOT` | `<repo>/.aidlc-worktrees` | Where workstream worktrees are created |

## Authentication and teams

| Variable | Default | Purpose |
|---|---|---|
| `AUTH_DISABLED` | unset | `1` turns sign-in off (single-user local use); every route is open |
| `OPEN_REGISTRATION` | unset | `1` lets anyone register; otherwise only the first user and invitees can |
| `DEFAULT_TEAM_NAME` | `Default team` | Name of the team created for the first user |

Sessions are HttpOnly cookies (30 days; `Secure` when served over HTTPS).
GitHub sign-in reuses the GitHub OAuth app configured below.

## Integrations (OAuth)

Each provider needs a registered OAuth app with callback
`http://<host>:<port>/api/oauth/<provider>/callback`:

| Provider | Variables | Scopes |
|---|---|---|
| GitHub | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | `repo`, `read:org`, `read:user` |
| Atlassian (Jira + Confluence) | `ATLASSIAN_CLIENT_ID`, `ATLASSIAN_CLIENT_SECRET` | read/write jira-work, read/write confluence-content, `offline_access` |
| Linear | `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET` | `read`, `write` |
| Slack | `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` | `channels:read`, `chat:write`, `users:read` |

## Per-project settings (UI)

- **Orchestrator** (overview): autonomous mode (auto-approve gates), max
  concurrent runs, speed mode (fast / balanced / quality).
- **Knowledge scope** (Context tab): which integrations and repositories the
  project's agents may query, with Jira project keys, Linear teams/projects,
  Confluence spaces and GitHub repos.
- **Repositories** (overview): add, edit, make primary, relearn, retry clone.

## Files agents write

| File | Written by | Purpose |
|---|---|---|
| `.aidlc/dev-setup.md` | dev-environment setup | Install/build/test/lint commands, test baseline, blockers (local-only) |
| `specs/<feature>/code-review.md` | `review` | Review status and findings |
| `specs/<feature>/delivery-status.md` | before `deliver`/`review` | PR, CI, merge, deploy state from GitHub |
| `specs/<feature>/delivery-report.md` | `deliver` | Delivery status, UAT results, pending approvals |
