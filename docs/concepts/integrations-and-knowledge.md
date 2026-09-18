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

Setup is self-serve under **Organization → Integrations**: press **Add
credentials** on a provider card, register an OAuth app in the provider's
console with the callback URL and scopes the card shows, paste the client id
and secret (stored encrypted with `ENCRYPTION_KEY`), then press **Connect**.
Credentials are organization-wide and required before a provider can be
connected; nothing about integrations is read from `.env`.

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

## Organization knowledge base (RAG)

Beyond on-demand lookups, whole bodies of knowledge can be **imported** into a
searchable knowledge base from **Organization memory & knowledge** in the user
menu:

| Import | Picks from | What is indexed |
|---|---|---|
| Confluence | spaces | every page of the space |
| Jira | projects (or a JQL filter) | issues with description and comments |
| Linear | teams, projects, initiatives | initiative and project descriptions, then their issues with comments |
| GitHub | repositories | documentation files (`*.md`, `*.rst`, `*.txt`, … or your own include patterns) on a branch, or issues and pull requests |
| Web pages | URLs | the page text |
| Notes | — | free text typed or pasted in |

Each import is a **source** owned by the organization (visible to every team)
or by one team. Importing runs inside the server; re-import is incremental
(only pages, issues or files changed since the last import are re-read) and a
*full re-import* re-enumerates the source and prunes items that disappeared.

Documents are split into heading-aware chunks and indexed twice: a Postgres
full-text index, and a pgvector embedding (`EMBEDDING_MODEL`) when an
embedding key is configured. Search fuses both rankings, so results degrade
gracefully to keyword search without embeddings or without the `vector`
extension.

Agents get the base in two ways: every stage's shared context starts with the
excerpts most relevant to the project and current feature, and the
`org_knowledge_search(query)` tool answers ad-hoc questions with cited
excerpts. The panel has a search box to try queries yourself.

API: `GET /api/org/knowledge/catalog?integration=…` lists what can be
imported, `POST /api/org/knowledge/sources` creates and imports a source,
`POST /api/org/knowledge/sources/:id/import` re-imports (`{"full": true}` to
re-enumerate), `POST /api/org/knowledge/notes` adds a note, and
`GET /api/org/knowledge/search?q=…` searches.

## Repository catalog

With GitHub connected, every visible repository is indexed with its
README-derived use case into a catalog that the plan stage and onboarding use
to name repositories. It refreshes on connect and every six hours
(`POST /api/github/catalog/sync` forces it).

## pi-knowledge

[pi-knowledge](https://pi.dev/packages/pi-knowledge) adds local semantic search
over files, PDFs and URLs and complements the integration tools; our tool names
were chosen not to collide with it.
