# Research: Figma Integration, MCP Tooling, and Design System Knowledge Base

**Feature Branch**: `006-figma-integration`  
**Date**: 2026-09-23  
**Status**: Completed  

## Overview

This document resolves technical choices, architecture decisions, and external integration patterns for integrating Figma into Spaces as a first-class design integration, Model Context Protocol (MCP) server, autonomous agent toolset, and design system knowledge base.

---

## 1. Authentication & Credential Management

### Decision
Support both **Figma OAuth 2.0** and **Administrative Personal Access Tokens (PAT)** at the organization level, stored in encrypted format in PostgreSQL (`app_integrations.credentials_json`) using Spaces' standard `sealCredentials` / `unsealCredentials` AES-256-GCM vault.

### Rationale
- **OAuth 2.0**: Ideal for organizations that want single-click authorization without manual token generation. Figma supports OAuth 2.0 authorization code flow with standard endpoints:
  - Authorize URL: `https://www.figma.com/oauth`
  - Token URL: `https://www.figma.com/api/oauth/token`
  - Scopes: `files:read` (or `file_read`), `file_variables:read` (for variable collections).
- **Personal Access Tokens (PAT)**: Figma allows users to generate long-lived Personal Access Tokens in their account settings. Allowing direct PAT configuration gives immediate, zero-friction setup for teams that do not want to register a public OAuth application in Figma's developer console.
- **Unified Client Representation**: Both OAuth access tokens and PATs authenticate requests to the Figma REST API (`https://api.figma.com/v1/`) using `Authorization: Bearer <token>` or `X-Figma-Token: <token>`.
- **Health Verification**: Dedicated validation endpoint `GET https://api.figma.com/v1/me` verifies credential validity, retrieving user handle, email, and ID. If the call succeeds, `credentialsOk` is marked `true`; on 401/403, it transitions to `needs_reconnect`.

### Alternatives Considered
- *OAuth 2.0 Only*: Rejected because registering an OAuth app in Figma requires developer portal setup with callback URLs, which creates unnecessary barrier for teams wanting a quick token connection.
- *Personal Access Tokens Only*: Rejected because enterprise teams require centralized OAuth app governance and revocable token lifecycles.
- *Local Machine Env Vars*: Rejected because Spaces is multi-tenant and per-organization. All credentials must reside in encrypted database tables per tenant.

---

## 2. Integration Categorization: Design & Prototyping

### Decision
Add a canonical 4th category: `design` (label: "Design & Prototyping") to `src/lib/integration-categories.ts`, positioned logically between `project_management` and `communication`.

```typescript
export type IntegrationCategoryId =
  | 'source_control'
  | 'project_management'
  | 'design'
  | 'communication'
```

### Rationale
- Preserves the functional domain architecture established in feature `005-categorize-integrations`.
- Distinct domain separation: Design tools (Figma) serve a fundamentally different SDLC purpose from Source Control (GitHub), Project Management (Jira/Linear), or Communication (Slack).
- `PROVIDER_TEMPLATES['figma']` maps directly to `design`.
- `AppIntegrationKind` includes `'figma'`, mapping directly to `design`.
- Clean empty states: When Figma is not connected, the UI shows dedicated design guidance explaining why connecting Figma unlocks design-aware autonomous agents.

### Alternatives Considered
- *Grouping Figma under Project Management*: Rejected because Figma is not a ticketing or issue tracking tool; design files and design tokens require distinct visual and structural modeling.
- *Arbitrary Tagging*: Rejected because deterministic category models prevent UI drift between org settings and navigation modals.

---

## 3. Knowledge Base Ingestion & Design System Modeling

### Decision
Introduce `'figma'` as a first-class `KnowledgeSourceKind` in `src/lib/knowledge-store.ts` with a dedicated ingestion connector (`importFigma`) in `src/lib/knowledge-connectors.ts`.

### Extraction Strategy:
1. **Design Tokens**:
   - Query `/v1/files/:key/styles` to extract style definitions (fill styles/colors, text styles/typography, effect styles/elevation).
   - If available, query `/v1/files/:key/variables/local` to extract Figma variables (color, float, string tokens).
   - Transform into readable Markdown documentation summarizing color palettes (HEX, RGB, opacity), typography scales (font family, weight, size, line-height, letter-spacing), and shadows/radii.
2. **Components & Variant Sets**:
   - Query `/v1/files/:key/components` and `/v1/files/:key/component_sets`.
   - Extract component names, descriptions, variant attributes, and default properties.
   - Generate structured Markdown per component family with deep links (`https://www.figma.com/design/:key?node-id=:id`).
3. **Bounded Frame Extraction**:
   - Allow optional extraction of top-level frames/documentation pages.
   - Bound node depth (`depth=2`) to prevent massive JSON payloads and memory bloat.
   - Strip all vector curves, bezier coordinates, and raw stroke geometry.
4. **Vector Embeddings & Chunker**:
   - Ingest generated Markdown documents into `knowledge_documents`.
   - Chunk by headings (`# Component`, `## Variants`, `## Design Tokens`) using existing `chunkText`.
   - Generate vector embeddings with pgvector (`embeddings.ts`) alongside Postgres full-text search (`content_tsv`).

### Incremental Synchronization
- Store `lastModified` or file version ID in `knowledge_sources.cursor_json`.
- On sync, inspect file metadata: if `lastModified` matches cursor, skip heavy extraction and update sync status.
- When updated, replace documents whose contents or tokens changed and prune deleted components.

### Alternatives Considered
- *Full Canvas JSON Dump*: Rejected. Production Figma files can be 50MB+ of raw vector points (`vectorNetwork`, `strokeGeometry`), which would exhaust memory and fill the knowledge base with useless coordinate noise.
- *Image Rendering & Multi-modal Vision Only*: Rejected. Rendering frames as PNGs requires complex vision models for text extraction and cannot provide precise CSS token values (e.g., `font-size: 14px`, `color: #1E293B`, `gap: 12px`). Structured token extraction is faster, cheaper, and exact.

---

## 4. Agent Tools & Model Context Protocol (MCP)

### Decision
1. **Approved MCP Server Definition**: Register Figma in `data/org/mcp/servers.yml`:
   ```yaml
   servers:
     - id: figma
       purpose: figma-file-nodes-and-design-tokens
       approved: true
       default_mode: read-only
   ```
2. **Direct Pi Coding Agent Tools (`src/lib/figma-tools.ts`)**:
   Provide lightweight, read-only tools dynamically exposed to agent sessions whenever Figma is connected (matching the pattern of `buildKnowledgeTools` in `src/lib/integration-sources.ts`):
   - `figma_inspect_node`: Given a Figma URL (e.g., `https://www.figma.com/design/:key/:title?node-id=1-2`) or fileKey + nodeId, fetches the specific node hierarchy, bounding box, CSS layout properties (direction, padding, gap, alignment), visual fills, borders, typography, and child component names. Prunes raw geometry.
   - `figma_get_file_styles`: Fetches all design tokens (colors, typography styles, elevation) defined in a file.
   - `figma_get_components`: Lists published components, variant sets, and descriptions in a file.

### Safety & Guardrails:
- **Strictly Read-Only**: The tools only issue GET requests against Figma endpoints. No modifications or writes are permitted.
- **Context Size Guardrail**: Output is capped at 24,000 characters per call, filtering internal SVG coordinates and focusing on CSS-relevant layout properties (`layoutMode`, `primaryAxisAlignItems`, `itemSpacing`, `paddingLeft`, etc.).
- **URL Parsing & Normalization**: Automatically extracts `fileKey` and `nodeId` from standard Figma URLs (e.g. `figma.com/file/:key/...`, `figma.com/design/:key/...?node-id=123:456` or `?node-id=123-456`).

### Alternatives Considered
- *External Stdio Subprocess MCP Server*: While external stdio MCP processes are supported by Pi SDK, bundling direct TypeScript tools inside Spaces avoids external daemon crashes, process management overhead, and Docker container dependencies, while remaining 100% protocol-compatible with MCP server definitions.

---

## 5. Review Gates & Design Fidelity Workflow

### Decision
- Allow feature specifications (`spec.md`) and initiatives to capture associated Figma URLs in frontmatter/metadata.
- In AIDLC review gates (particularly for `Designer` and `QA` responsibilities), surface linked Figma designs and an automated design fidelity verification checklist comparing implemented styles with extracted tokens.

---

## Summary of Architectural Decisions

| Area | Decision | Key Justification |
|------|----------|-------------------|
| **Auth** | OAuth 2.0 + Personal Access Token (PAT) | Supports both enterprise org apps and fast developer PAT setup |
| **Category** | `design` ("Design & Prototyping") | Preserves functional domain taxonomy cleanly |
| **Storage** | Encrypted in `app_integrations` via `crypto-vault` | Multi-tenant isolation and security compliance |
| **Knowledge** | Structured Markdown of tokens & components + pgvector | High signal-to-noise RAG without vector geometry bloat |
| **Agent Tools** | Direct read-only tools (`figma_inspect_node`, etc.) | Low-latency, bounded context, seamless integration |
| **MCP** | Pre-approved read-only server in `servers.yml` | Governed by org constitution & MCP registry |
