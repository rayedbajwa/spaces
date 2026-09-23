# Implementation Plan: Figma Integration, MCP Tooling, and Design System Knowledge Base

**Branch**: `006-figma-integration` | **Date**: 2026-09-23 | **Spec**: [spec.md](spec.md)  
**Input**: Feature specification to integrate Figma into Spaces as an external integration provider, Model Context Protocol (MCP) server, autonomous agent toolset, and design system knowledge base.

---

## Summary

Spaces currently integrates with GitHub (Source Control), Jira, Linear, Confluence (Project Management), and Slack (Communication), but lacks design tool integration. Autonomous agents and engineering teams must manually transcribe design specifications, resulting in visual drift, missing tokens, and fragmented workflows.

This feature establishes Figma as a first-class integration in Spaces:
1. **Authentication & Categorization**: Connect Figma at the organization level via OAuth 2.0 or Personal Access Tokens (PAT) sealed with AES-256-GCM under a dedicated "Design & Prototyping" category in `src/lib/integration-categories.ts` and `src/web/integrations.tsx`.
2. **Knowledge Base Ingestion**: Ingest Figma design system files, design tokens (colors, typography scales, elevation), and component libraries into the Spaces Knowledge Base via a dedicated connector (`importFigma`) in `src/lib/knowledge-connectors.ts` with vector embeddings (`pgvector`) and full-text search.
3. **Autonomous Agent Tools & MCP**: Onboard a pre-approved read-only Figma MCP server in `data/org/mcp/servers.yml` and provide autonomous agents with lightweight inspection tools (`figma_inspect_node`, `figma_get_file_styles`, `figma_get_components`) in `src/lib/figma-tools.ts` that prune heavy vector geometry to fit within LLM token budgets.
4. **Delivery Workflow & Review Gates**: Link Figma frames to features and surface design fidelity checklists during Designer and Lead Engineer review gates.

---

## Repositories

- `rayedbajwa/spaces` — application code (`src/lib/integration-categories.ts`, `src/lib/oauth.ts`, `src/lib/app-integrations.ts`, `src/lib/figma-tools.ts`, `src/lib/knowledge-connectors.ts`, `src/lib/knowledge-store.ts`, `src/lib/db-schema.sql`, `src/server.ts`, `src/web/integrations.tsx`), configuration (`data/org/mcp/servers.yml`), and test suites (`tests/integration-categories.test.ts`, `tests/figma-tools.test.ts`).
- `governance` — feature specification, implementation plan, research, data-model, interface contracts, quickstart guide, and test-plan artifacts; no application runtime code.

---

## Technical Context

**Language/Version**: TypeScript 5.9 on Bun 1.4+  
**Primary Dependencies**: React 18, React DOM, `@earendil-works/pi-coding-agent`, `postgres` (node-postgres / Bun postgres driver), vanilla CSS (`src/web/styles.css`)  
**Storage**: PostgreSQL 16 with `pgvector` extension; encrypted credentials in `app_integrations` via `crypto-vault.ts` (AES-256-GCM); idempotent schema updates for `app_integrations_kind_check` and `knowledge_sources_kind_check` constraints  
**Testing**: Bun test runner (`bun test`), Playwright headless browser check, and TypeScript typecheck (`bun run typecheck`)  
**Target Platform**: Linux server / Web SPA (Bun HTTP server)  
**Project Type**: Multi-tenant SDLC orchestrator SPA + REST API + agent runtime  
**Performance Goals**: Agent node inspection <5s; client-side category rendering <16ms; knowledge base token search <2s  
**Constraints**: 100% backward compatibility for existing OAuth providers and integrations; strictly read-only access to customer Figma assets; bounded node traversal and context output <=24,000 characters to protect LLM token budgets; multi-tenant isolation by `org_id`  
**Scale/Scope**: 1 new canonical category (`design`), 1 new OAuth provider (`figma`), 1 new app integration kind (`figma`), 1 new knowledge source kind (`figma`), 3 agent inspection tools, and 1 pre-approved MCP server  

---

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- [x] Specification has a problem statement, acceptance scenarios, and measurable success criteria.
- [x] Repositories and cross-repository contracts are named above.
- [x] Security, authorization, tenant boundaries, auditability, and data protection impacts are addressed.
- [x] State changes have an idempotent migration, rollback, or repair path.
- [x] Test planning maps changed behavior, security boundaries, migrations, and failure modes to verification.
- [x] Parallel work, if used, has machine-readable workstreams and merge checkpoints.

### Evidence & Gates Evaluation:
- **Problem Statement & Scenarios**: `spec.md` details problem statement, 4 prioritized User Stories with independent test criteria, edge cases, and measurable success criteria (SC-001 through SC-006).
- **Repositories & Contracts**: `rayedbajwa/spaces` and `governance` listed under `## Repositories`. Interface contracts established in `contracts/figma-integration.md`.
- **Security & Tenant Boundaries**: Stored Figma credentials (OAuth tokens and PATs) are encrypted via AES-256-GCM (`sealCredentials`) and isolated by `org_id`. Non-admin access to credential mutation is blocked (`requireOrgAdmin`). Read-only scope is enforced across all API endpoints, agent tools, and MCP definitions; customer canvases cannot be modified.
- **State Changes & Rollback**: Schema constraint updates in `db-schema.sql` are strictly additive and idempotent (`DROP CONSTRAINT IF EXISTS ... ADD CONSTRAINT ...`). Rollback is fully supported by schema reversal without data loss.
- **Test Planning**: Comprehensive test matrix created in `test-plan.md` mapping FR-001…FR-019 to unit tests (`tests/integration-categories.test.ts`, `tests/figma-tools.test.ts`), connector tests, and API verification.
- **Parallel Work**: The feature is organized into decoupled workstreams (Taxonomy & Authentication, Knowledge Connector & Ingestion, Agent Tools & MCP Server, UI & Review Gates) with unified verification checkpoints.

---

## Architecture and Component Plan

### 1. Integration Taxonomy & Categorization (`src/lib/integration-categories.ts`)
- Add `design` to `IntegrationCategoryId`:
  - `id: 'design'`
  - `label: 'Design & Prototyping'`
  - `description: 'Figma files, design tokens, style definitions, and component libraries for agent visual inspection and knowledge base ingestion.'`
  - `emptyGuidance: 'Connect Figma so autonomous agents can inspect design mockups, extract layout tokens, and match components to design specs.'`
  - `providers: ['figma']`
  - `kinds: ['figma']`
- Update canonical category array order: `source_control`, `project_management`, `design`, `communication`.
- Ensure provider and kind lookups (`getCategoryForProvider`, `getCategoryForKind`) resolve `figma` accurately.

### 2. OAuth & Credential Handling (`src/lib/oauth.ts`, `src/lib/app-integrations.ts`, `src/server.ts`)
- Add `'figma'` to `OAuthProviderId` in `src/lib/oauth.ts`:
  - `authorizeUrl`: `https://www.figma.com/oauth`
  - `tokenUrl`: `https://www.figma.com/api/oauth/token`
  - `scopes`: `['files:read', 'file_variables:read']`
  - `consoleUrl`: `https://www.figma.com/developers/apps`
- Add `'figma'` to `AppIntegrationKind` in `src/lib/app-integrations.ts`.
- Update DB schema check constraints in `src/lib/db-schema.sql`.
- Add REST endpoints in `src/server.ts`:
  - `POST /api/integrations/figma/verify`: validates credentials against `GET https://api.figma.com/v1/me`.
  - `POST /api/integrations/figma/token`: accepts and seals PAT credentials.

### 3. Knowledge Base Ingestion Connector (`src/lib/knowledge-connectors.ts`, `src/lib/knowledge-store.ts`)
- Add `'figma'` to `KnowledgeSourceKind` in `src/lib/knowledge-store.ts`.
- Implement `validateSourceConfig('figma', config)` in `src/lib/knowledge-connectors.ts`.
- Implement `importFigma(source: KnowledgeSourceRow)`:
  - Fetches style definitions from `/v1/files/:key/styles`.
  - Fetches component definitions from `/v1/files/:key/components` and `/v1/files/:key/component_sets`.
  - Transforms tokens and components into structured Markdown documents with deep links (`https://www.figma.com/design/:key?node-id=:id`).
  - Supports incremental sync by persisting file `lastModified` / version ID in `cursor_json`.

### 4. Autonomous Agent Tools & MCP Server (`src/lib/figma-tools.ts`, `src/lib/aidlc.ts`, `data/org/mcp/servers.yml`)
- Register approved MCP server in `data/org/mcp/servers.yml`:
  ```yaml
  - id: figma
    purpose: figma-file-nodes-and-design-tokens
    approved: true
    default_mode: read-only
  ```
- Implement `buildFigmaTools({ orgId, projectId })` in `src/lib/figma-tools.ts`:
  - `figma_inspect_node`: Parses Figma URL / node ID, fetches frame structure via Figma REST API, extracts layout flexbox rules (padding, gap, alignment), typography, and colors, while pruning raw vector geometry. Caps output at 24,000 characters.
  - `figma_get_file_styles`: Lists color tokens and typography scale.
  - `figma_get_components`: Lists published components and variants.
- Wire Figma tools into Pi agent session creation in `src/lib/aidlc.ts`.

### 5. Frontend UI & Review Gates (`src/web/integrations.tsx`, `src/web/styles.css`)
- In `src/web/integrations.tsx`, render the `Design & Prototyping` category card:
  - Support OAuth connection button and direct PAT entry modal.
  - Display account handle / team name and credential health badge.
- Surface linked Figma design links and fidelity checklists during Designer / Lead Engineer review gates.

---

## Project Structure

### Documentation (this feature)

```text
specs/006-figma-integration/
├── plan.md                                  # Implementation plan (this file)
├── research.md                              # Phase 0 decisions & alternatives
├── data-model.md                            # Phase 1 data entities and database schema
├── quickstart.md                            # Phase 1 developer and verification guide
├── contracts/
│   └── figma-integration.md                 # Phase 1 API, tool, and connector contracts
├── test-plan.md                             # Phase 1 test strategy and acceptance matrix
└── checklists/
    └── requirements.md                      # Quality checklist
```

### Source Code (`rayedbajwa/spaces`)

```text
src/
├── lib/
│   ├── integration-categories.ts            # Canonical category definitions including 'design'
│   ├── oauth.ts                             # Figma OAuth provider configuration
│   ├── app-integrations.ts                  # AppIntegrationKind 'figma' support
│   ├── figma-tools.ts                       # Autonomous agent inspection tools (read-only)
│   ├── knowledge-connectors.ts              # importFigma connector and validator
│   ├── knowledge-store.ts                   # KnowledgeSourceKind 'figma' support
│   ├── aidlc.ts                             # Tool wiring for agent sessions
│   └── db-schema.sql                        # Schema constraints update
├── server.ts                                # Verification and PAT REST endpoints
└── web/
    ├── integrations.tsx                     # UI category rendering and Figma credential dialog
    └── styles.css                           # Design category styling

data/
└── org/
    └── mcp/
        └── servers.yml                      # Approved Figma MCP server registration

tests/
├── integration-categories.test.ts           # Taxonomy, mapping, and status calculations test
└── figma-tools.test.ts                      # URL parsing, geometry pruning, token bounds test
```

**Structure Decision**: Extending existing domain modules (`integration-categories.ts`, `knowledge-connectors.ts`, `aidlc.ts`) and adding a dedicated `figma-tools.ts` ensures zero architectural bloat, maximum code reuse, and seamless integration into the agent loop.

---

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

*No violations. All constitution gates pass.*
