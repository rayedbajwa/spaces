# Integrations as knowledge

Integrations are connected once, app-wide, through OAuth. Tokens are sealed
with AES-256-GCM using `ENCRYPTION_KEY` and stored in Postgres.

| Provider | OAuth provider id | What agents get |
|---|---|---|
| GitHub | `github` | Repository catalog, cloning, PRs, issue/PR search |
| Jira | `atlassian` (shared with Confluence) | Issue search (JQL or text) and full issues with comments |
| Confluence | `atlassian` | Page search (CQL or text) and page content |
| Linear | `linear` | Issue search and full issues with comments |
| Slack | `slack` | Reserved for notifications |

Register an OAuth app with each provider, set the callback to
`http://<host>:<port>/api/oauth/<provider>/callback`, put the client id and
secret in `.env` and press **Connect** in the Integrations panel.

!!! note "Reconnect needed"
    If the stored token can no longer be decrypted (for example the
    `ENCRYPTION_KEY` changed, or a process with a different key re-saved it),
    the panel shows **⚠ reconnect needed** instead of *connected*, and token
    lookups fail with a message naming that cause.

## Agent tools

Connected sources are exposed to every agent session as two tools:

- `integration_search(source, query)` — free text, an exact key (`PROJ-123`,
  `ENG-45`, `owner/name#12`), or a native query (JQL, CQL, GitHub search).
- `integration_get(source, id)` — the full item: description, status, comments.

The shared context carries a *Knowledge Sources* note telling agents to fetch
referenced tickets and docs rather than guess, to be efficient (one targeted
search, then one to three items in full) and to cite ids in artifacts.

## Per-project scope

In the project's **Context** tab you choose which connected sources the
project may use and narrow them: Jira project keys, Linear teams and projects,
Confluence spaces, GitHub repositories. Agents only see the selected sources,
and their queries are filtered accordingly.

## Importing tickets

The new-project wizard's **Import from Jira / Linear** searches a source, pulls
a ticket in as the name, description and first feature, and attaches it to the
project as a *source snapshot* that appears in every stage's context.
`POST /api/projects/:id/sources/import` does the same for existing projects.

## Repository catalog

With GitHub connected, every visible repository is indexed with its
README-derived use case into a catalog that the plan stage and onboarding use
to name repositories. It refreshes on connect and every six hours
(`POST /api/github/catalog/sync` forces it).

## pi-knowledge

[pi-knowledge](https://pi.dev/packages/pi-knowledge) adds local semantic search
over files, PDFs and URLs and complements the integration tools; our tool names
were chosen not to collide with it.
