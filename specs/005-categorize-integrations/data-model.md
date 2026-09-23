# Data Model: Categorized Integrations

This feature introduces a structured domain taxonomy for integrations without altering persistent database schemas. The entities defined here represent domain concepts, metadata groupings, and runtime state aggregations used by both the backend services and the frontend client.

## Entities

### 1. IntegrationCategory (Canonical Domain Taxonomy)

Represents one of the three primary functional pillars of the software development life cycle.

| Field | Type | Description |
|---|---|---|
| `id` | `IntegrationCategoryId` | Unique identifier (`'source_control'`, `'project_management'`, `'communication'`) |
| `label` | `string` | Human-readable section heading (e.g., `"Source Control"`) |
| `description` | `string` | Narrative explanation of the category's role for agents and human teams |
| `emptyGuidance` | `string` | Actionable guidance rendered when no tools are connected in this category |
| `providers` | `readonly OAuthProviderId[]` | List of OAuth provider keys associated with this domain |
| `kinds` | `readonly AppIntegrationKind[]` | List of integration kinds associated with this domain |

#### Category Definitions

1. **`source_control`**:
   - `label`: `"Source Control"`
   - `description`: `"Repository catalog, cloning, branch synchronization, pull request generation, and Git sign-in."`
   - `emptyGuidance`: `"Connect source control so autonomous agents can clone repositories, inspect codebase structure, and deliver verified pull requests."`
   - `providers`: `['github']`
   - `kinds`: `['github']`

2. **`project_management`**:
   - `label`: `"Project Management"`
   - `description`: `"Issue tracking, sprint planning, project initiatives, and specification documents for agent context and knowledge base ingestion."`
   - `emptyGuidance`: `"Connect project management tools to link specs with active issues, sync initiatives, and ingest product knowledge."`
   - `providers`: `['atlassian', 'linear']`
   - `kinds`: `['jira', 'confluence', 'linear']`

3. **`communication`**:
   - `label`: `"Message Channels / Communication"`
   - `description`: `"Dedicated channels per project (#spaces-<code>) with run progress, verification summaries, and human-in-the-loop review alerts."`
   - `emptyGuidance`: `"Connect message channels to receive stage updates, review notifications, and pipeline approval gates directly in your team's chat."`
   - `providers`: `['slack']`
   - `kinds`: `['slack']`

---

### 2. CategoryStatusSummary (Aggregated Domain Health)

Represents the computed connection health and readiness state of an individual functional category for an organization.

| Field | Type | Description |
|---|---|---|
| `categoryId` | `IntegrationCategoryId` | Category identifier |
| `state` | `CategoryReadinessState` | Aggregate readiness state (`'connected'`, `'partial'`, `'needs_reconnect'`, `'configured_unconnected'`, `'empty'`) |
| `summaryBadge` | `string` | Human-readable badge text (e.g. `"✓ Connected"`, `"✓ 1 connected"`, `"⚠ Reconnect needed"`, `"App set up"`, `"Not connected"`) |
| `badgeVariant` | `'completed' \| 'idle' \| 'error'` | UI styling variant matching existing mini-badges |
| `totalProviders` | `number` | Number of providers in this category |
| `configuredProviders` | `number` | Number of providers whose app credentials are saved |
| `totalKinds` | `number` | Number of distinct services/kinds in this category |
| `connectedKinds` | `number` | Number of services with active, valid access credentials |
| `reconnectNeededCount` | `number` | Number of services where credentials exist but are expired/invalid |

---

### 3. Existing Persistent Entities (Unchanged)

Existing PostgreSQL tables remain unchanged and retain their exact schema:
- **`oauth_apps`**:
  - `org_id`: UUID
  - `provider`: `'github' | 'atlassian' | 'slack' | 'linear'`
  - `client_id`: string
  - `client_secret_enc`: string
  - `config_json`: JSON object (app slug, installation IDs, etc.)
- **`app_integrations`**:
  - `org_id`: UUID
  - `kind`: `'github' | 'jira' | 'confluence' | 'slack' | 'linear'`
  - `status`: `'not_connected' | 'pending' | 'connected' | 'error'`
  - `display_name`: string (e.g., workspace name, site URL)
  - `config_json`: JSON object
  - `credentials_json`: encrypted credentials

---

## Entity Relationships

```text
+-------------------------------------------------------+
|                 IntegrationCategory                   |
|  - id: 'source_control'|'project_management'|'comm'   |
|  - label: string                                      |
|  - description: string                                |
|  - emptyGuidance: string                              |
+--------------------------+----------------------------+
                           | 1 : N
        +------------------+-------------------+
        |                                      |
        v                                      v
+------------------------+          +-------------------------+
|     OAuthProvider      |          |    AppIntegrationKind   |
|  (github, atlassian,   |          |  (github, jira, linear, |
|    linear, slack)      |          |    confluence, slack)   |
+-----------+------------+          +------------+------------+
            | 1 : 1                              | 1 : 1
            v                                    v
+------------------------+          +-------------------------+
|  oauth_apps (Postgres) |          | app_integrations (SQL)  |
|  provider credentials  |          | organization connection |
+------------------------+          +-------------------------+
```

### Cardinality and Mapping Rules

1. **Category Exhaustiveness**: Every `OAuthProviderId` in `OAUTH_PROVIDER_IDS` MUST belong to exactly one `IntegrationCategory`.
2. **Kind Exhaustiveness**: Every `AppIntegrationKind` MUST belong to exactly one `IntegrationCategory`.
3. **No Orphans**: No provider or kind may exist without a parent category.
4. **Deterministic Mapping**: Given a provider or kind, its category can be resolved in O(1) time without database lookups.
5. **Multi-Kind Providers**: Atlassian maps to `project_management`. Its two constituent kinds, `jira` and `confluence`, both map to `project_management`.

---

## State Transitions & Status Derivation

The `CategoryReadinessState` of a category is deterministically derived as follows:

```text
Has any kind with credentialsOk === false?
  ├── YES ──▶ state = 'needs_reconnect'
  └── NO
        ├── connectedKinds > 0 AND connectedKinds === totalKinds
        │     └──▶ state = 'connected' ("All connected" or "Connected")
        │
        ├── connectedKinds > 0 AND connectedKinds < totalKinds
        │     └──▶ state = 'partial' ("X connected" or "1 of Y connected")
        │
        ├── connectedKinds === 0 AND configuredProviders > 0
        │     └──▶ state = 'configured_unconnected' ("App set up")
        │
        └── connectedKinds === 0 AND configuredProviders === 0
              └──▶ state = 'empty' ("Not connected")
```
