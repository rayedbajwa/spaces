# Data Model: Figma Integration, MCP Tooling, and Design System Knowledge Base

**Feature Branch**: `006-figma-integration`  
**Date**: 2026-09-23  
**Status**: Completed  

## 1. Domain Entities & Database Extensions

### 1.1 App Integration (`app_integrations` Table)

Stores organization-level connection metadata and encrypted credentials for external integrations.

```sql
-- Updated kind check constraint
ALTER TABLE app_integrations DROP CONSTRAINT IF EXISTS app_integrations_kind_check;
ALTER TABLE app_integrations ADD CONSTRAINT app_integrations_kind_check
  CHECK (kind IN ('github', 'jira', 'confluence', 'slack', 'linear', 'figma'));
```

**Row Schema for Figma**:
- `org_id` (`UUID`): Tenant identifier owning the connection.
- `kind` (`TEXT`): `'figma'`.
- `status` (`TEXT`): `'not_connected' | 'pending' | 'connected' | 'error'`.
- `display_name` (`TEXT`): Connected account handle, user email, or team name (e.g. `Figma: Design System Team (acme-corp)`).
- `config_json` (`JSONB`):
  ```json
  {
    "authType": "oauth" | "pat",
    "clientId": "optional_oauth_client_id",
    "teamId": "optional_figma_team_id",
    "userHandle": "jane@acme.com"
  }
  ```
- `credentials_json` (`JSONB`, encrypted): Sealed with AES-256-GCM via `sealCredentials`:
  ```json
  {
    "access_token": "figd_xxx... or personal_access_token",
    "token_type": "bearer",
    "refresh_token": "optional_refresh_token",
    "expires_at": 1758672000000,
    "isPat": true
  }
  ```
- `last_synced_at` (`TIMESTAMPTZ`): Timestamp of last successful API validation or knowledge sync.
- `last_sync_error` (`TEXT`): Human-readable error message on failure (e.g. HTTP 401 unauthorized or rate limit).

---

### 1.2 Integration Category Domain Model (`src/lib/integration-categories.ts`)

Adds the canonical `design` category into the centralized taxonomy.

```typescript
export type IntegrationCategoryId =
  | 'source_control'
  | 'project_management'
  | 'design'
  | 'communication'

export const INTEGRATION_CATEGORIES: readonly IntegrationCategoryDefinition[] = [
  // 1. Source Control
  {
    id: 'source_control',
    label: 'Source Control',
    description: 'Repository catalog, cloning, branch synchronization, pull request generation, and Git sign-in.',
    emptyGuidance: 'Connect source control so autonomous agents can clone repositories, inspect codebase structure, and deliver verified pull requests.',
    providers: ['github'],
    kinds: ['github'],
  },
  // 2. Project Management
  {
    id: 'project_management',
    label: 'Project Management',
    description: 'Issue tracking, sprint planning, project initiatives, and specification documents for agent context and knowledge base ingestion.',
    emptyGuidance: 'Connect project management tools to link specs with active issues, sync initiatives, and ingest product knowledge.',
    providers: ['atlassian', 'linear'],
    kinds: ['jira', 'confluence', 'linear'],
  },
  // 3. Design & Prototyping (NEW)
  {
    id: 'design',
    label: 'Design & Prototyping',
    description: 'Figma files, design tokens, style definitions, and component libraries for agent visual inspection and knowledge base ingestion.',
    emptyGuidance: 'Connect Figma so autonomous agents can inspect design mockups, extract layout tokens, and match components to design specs.',
    providers: ['figma'],
    kinds: ['figma'],
  },
  // 4. Communication
  {
    id: 'communication',
    label: 'Message Channels / Communication',
    description: 'Dedicated channels per project (#spaces-<code>) with run progress, verification summaries, and human-in-the-loop review alerts.',
    emptyGuidance: 'Connect message channels to receive stage updates, review notifications, and pipeline approval gates directly in your team\'s chat.',
    providers: ['slack'],
    kinds: ['slack'],
  },
] as const
```

---

### 1.3 Knowledge Sources (`knowledge_sources` Table)

Extends knowledge source kinds to support Figma design systems.

```sql
-- Updated kind check constraint
ALTER TABLE knowledge_sources DROP CONSTRAINT IF EXISTS knowledge_sources_kind_check;
ALTER TABLE knowledge_sources ADD CONSTRAINT knowledge_sources_kind_check
  CHECK (kind IN ('confluence', 'jira', 'linear', 'github_repo', 'github_issues', 'url', 'manual', 'figma'));
```

**Row Schema for Figma Knowledge Source**:
- `source_id` (`UUID`): Primary key.
- `org_id` (`UUID`): Owning organization.
- `team_id` (`UUID`, nullable): Optional team scope; `null` signifies organization-wide design system.
- `kind` (`TEXT`): `'figma'`.
- `label` (`TEXT`): Name of the design system (e.g. `Acme UI Design System`).
- `config_json` (`JSONB`):
  ```json
  {
    "fileUrls": [
      "https://www.figma.com/design/Vf123Abc456/Acme-Design-System"
    ],
    "fileKeys": [
      "Vf123Abc456"
    ],
    "extractTokens": true,
    "extractComponents": true,
    "extractFrames": false,
    "includedPages": ["Styles", "Components", "Tokens"]
  }
  ```
- `cursor_json` (`JSONB`):
  ```json
  {
    "fileVersions": {
      "Vf123Abc456": "184920492"
    },
    "lastModified": "2026-09-23T10:00:00Z"
  }
  ```
- `sync_interval_minutes` (`INT`): Default 360 (6 hours), configurable.

---

### 1.4 Knowledge Documents & Chunks (`knowledge_documents` & `knowledge_chunks`)

Structured design artifacts transformed into search documents with pgvector embeddings and full-text search.

**Document Format**:
- `document_id` (`UUID`): Document ID.
- `source_id` (`UUID`): Foreign key to `knowledge_sources`.
- `external_id` (`TEXT`): Unique identifier within Figma:
  - Tokens: `figma:<fileKey>:token:<styleIdOrVariableKey>`
  - Components: `figma:<fileKey>:component:<nodeId>`
  - Style Guide: `figma:<fileKey>:styles:overview`
- `title` (`TEXT`): E.g., `Component: Primary Button` or `Color Palette: Brand & Semantic Tokens`.
- `url` (`TEXT`): Deep link directly into Figma: `https://www.figma.com/design/<fileKey>?node-id=<nodeId>`.
- `content` (`TEXT`): High-density Markdown representation:
  ```markdown
  # Component: Button
  **Category**: Input Controls
  **Figma Node ID**: 45:102
  **Description**: Standard action button with Primary, Secondary, and Ghost variants.

  ## Variants
  - Variant `Intent`: Primary, Secondary, Danger, Ghost
  - Variant `Size`: Small (32px), Medium (40px), Large (48px)
  - Variant `State`: Default, Hover, Pressed, Disabled

  ## Design Tokens
  - Background (Primary/Default): `#2563EB` (tokens.color.brand.primary)
  - Text Color: `#FFFFFF`
  - Border Radius: `8px`
  - Padding: `10px 16px`
  - Font: `Inter`, `600` weight, `14px` size, `20px` line-height
  ```
- `metadata_json` (`JSONB`):
  ```json
  {
    "fileKey": "Vf123Abc456",
    "nodeId": "45:102",
    "docType": "component",
    "name": "Button",
    "componentSet": "Button",
    "variants": { "Intent": ["Primary", "Secondary", "Danger"], "Size": ["Sm", "Md", "Lg"] },
    "tokensUsed": ["color.brand.primary", "radius.md", "typography.button-label"]
  }
  ```
- `content_tsv` (Generated `TSVECTOR`): Full-text index over tokens, component names, and descriptions.
- Embedding vector (`vector(1536)` or `vector(768)`): Embeddings generated via `embeddings.ts`.

---

### 1.5 Organization MCP Server Configuration

Configuration stored in `data/org/mcp/servers.yml` and context builder:

```yaml
servers:
  - id: github
    purpose: repos-pulls-issues-files
    approved: true
    default_mode: read-only
  - id: jira
    purpose: tickets-epics-workflows
    approved: true
    default_mode: read-only
  - id: figma
    purpose: figma-file-nodes-and-design-tokens
    approved: true
    default_mode: read-only
```

---

### 1.6 Agent Tool Schema Entities (`src/lib/figma-tools.ts`)

#### `FigmaNodeRef`
```typescript
export interface FigmaNodeRef {
  fileKey: string
  nodeId: string
  url?: string
}
```

#### `FigmaLayoutSummary` (Pruned Node Representation)
```typescript
export interface FigmaLayoutSummary {
  id: string
  name: string
  type: string
  visible: boolean
  width?: number
  height?: number
  layoutMode?: 'NONE' | 'HORIZONTAL' | 'VERTICAL'
  primaryAxisAlignItems?: string
  counterAxisAlignItems?: string
  paddingTop?: number
  paddingRight?: number
  paddingBottom?: number
  paddingLeft?: number
  itemSpacing?: number
  fills?: Array<{ type: string; colorHex?: string; opacity?: number }>
  strokes?: Array<{ type: string; colorHex?: string; weight?: number }>
  cornerRadius?: number | number[]
  typography?: {
    fontFamily: string
    fontWeight: number
    fontSize: number
    lineHeightPx?: number
    letterSpacing?: number
  }
  characters?: string
  children?: FigmaLayoutSummary[]
}
```

---

## 2. Validation Rules & Constraints

1. **Figma URL Normalization**:
   - Accepted URL formats:
     - `https://www.figma.com/design/:fileKey/:fileName?node-id=:nodeId`
     - `https://www.figma.com/file/:fileKey/:fileName?node-id=:nodeId`
     - `https://figma.com/design/:fileKey/:fileName`
   - Node IDs in URLs format `:` as `-` (e.g. `?node-id=102-45`); must be normalized to `102:45` for API calls.
2. **Context Size Limitation**:
   - Ingested documents capped at 30,000 characters before chunking.
   - Agent tool responses capped at 24,000 characters per call to avoid token buffer overflow.
3. **Read-Only Invariant**:
   - Zero mutating operations permitted on customer Figma assets.
4. **Tenant Boundary Invariant**:
   - Figma credentials and knowledge sources are isolated strictly by `org_id` and optional `team_id`.
