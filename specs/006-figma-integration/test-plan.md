# Test Plan: Figma Integration, MCP Tooling, and Design System Knowledge Base

**Feature Branch**: `006-figma-integration`  
**Date**: 2026-09-23  
**Status**: Ready for Implementation  

---

## 1. Strategy & Verification Objectives

This test plan defines the testing strategy, acceptance verification, test cases, and quality gates for the Figma Integration, MCP Tooling, and Design System Knowledge Base feature across both `rayedbajwa/spaces` and `governance`.

### Core Goals:
1. **Domain Taxonomy & Classification**: Ensure `design` category, `figma` provider, and `figma` kind integrate seamlessly into `integration-categories.ts` without breaking existing categories.
2. **Secure Credential Handling**: Ensure tokens (OAuth and PAT) are sealed in PostgreSQL via AES-256-GCM and never leaked in logs, API responses, or agent transcripts.
3. **Robust Tool Inspection**: Ensure agent inspection tools (`figma_inspect_node`, `figma_get_file_styles`, `figma_get_components`) reliably extract bounded design tokens and flexbox layout structures while pruning heavy vector geometry.
4. **Knowledge Base Ingestion**: Ensure the Figma knowledge connector correctly indexes styles and components as searchable vector and full-text documents.
5. **Resilient Failure Modes**: Verify that 401 unauthorized, 404 missing node, and 429 rate limit errors produce clean, actionable error messages.

---

## 2. Test Suites & Implementation Targets

### 2.1 Unit Test Suite: Integration Categories (`tests/integration-categories.test.ts`)
- **TC-CAT-001**: Verify `INTEGRATION_CATEGORIES` contains 4 categories in canonical order: `source_control`, `project_management`, `design`, `communication`.
- **TC-CAT-002**: Verify `figma` provider maps to `design`.
- **TC-CAT-003**: Verify `figma` kind maps to `design`.
- **TC-CAT-004**: Verify status calculation for `design` category across all states: `empty`, `configured_unconnected`, `connected`, and `needs_reconnect`.
- **TC-CAT-005**: Verify exhaustiveness: all providers in `PROVIDER_TEMPLATES` and all `AppIntegrationKind` values map to exactly one category.

### 2.2 Unit Test Suite: Figma Agent Tools & Parser (`tests/figma-tools.test.ts`)
- **TC-FIG-001 (URL Parsing)**:
  - Parse `https://www.figma.com/design/Vf123Abc456/Acme-UI?node-id=45-102` -> `fileKey: "Vf123Abc456"`, `nodeId: "45:102"`.
  - Parse `https://www.figma.com/file/Vf123Abc456/Acme-UI?node-id=45:102` -> `fileKey: "Vf123Abc456"`, `nodeId: "45:102"`.
  - Parse `https://www.figma.com/design/Vf123Abc456/Acme-UI` (file-level URL) -> `fileKey: "Vf123Abc456"`, `nodeId: undefined`.
  - Reject invalid or non-Figma URLs with a descriptive error.
- **TC-FIG-002 (Pruning & Geometry Filtering)**:
  - Verify `figma_inspect_node` strips vector coordinates (`vectorPaths`, `strokeGeometry`) while retaining `layoutMode`, `padding`, `itemSpacing`, `fills`, `strokes`, and `cornerRadius`.
- **TC-FIG-003 (Token Size Bounding)**:
  - Test deep node tree traversal: verify output is capped at 24,000 characters and does not overflow memory.
- **TC-FIG-004 (Styles & Token Extraction)**:
  - Verify `figma_get_file_styles` correctly formats color palettes (HEX, opacity) and typography scales.
- **TC-FIG-005 (Components & Variants)**:
  - Verify `figma_get_components` extracts component names, descriptions, variant attributes, and node links.
- **TC-FIG-006 (Graceful Error Handling)**:
  - Mock HTTP 401: returns `"Figma rejected credentials (401 Unauthorized)..."`.
  - Mock HTTP 404: returns `"Node not found in Figma file..."`.
  - Mock HTTP 429: executes backoff retry; if exhausted, returns clear rate limit message.

### 2.3 Unit & Integration Suite: Knowledge Connector (`tests/knowledge-connectors.test.ts`)
- **TC-KNOW-001 (Config Validation)**:
  - `validateSourceConfig('figma', { fileUrls: ['https://figma.com/design/123/name'] })` passes.
  - `validateSourceConfig('figma', {})` fails with `"Add at least one Figma file URL or key."`.
- **TC-KNOW-002 (Document Extraction)**:
  - Ingest mock Figma file with 5 styles and 3 components.
  - Verify `importFigma` emits structured Markdown documents with headings, properties, and deep links.
- **TC-KNOW-003 (Incremental Sync & Cursor)**:
  - When `lastModified` matches cursor, connector returns `complete: true` without redundant re-fetch.
  - When file is modified, updated documents are emitted.

### 2.4 Integration Suite: Server API Endpoints (`tests/figma-api.test.ts`)
- **TC-API-001**: `POST /api/integrations/figma/verify` validates credentials against mock Figma API.
- **TC-API-002**: `POST /api/integrations/figma/token` securely seals PAT in `app_integrations`.
- **TC-API-003**: Verify role gate: non-admin requests are rejected with 403 Forbidden.
- **TC-API-004**: Database migration idempotent check: re-running `db:migrate` with the updated kind CHECK constraints applies cleanly without error.

---

## 3. Requirements Traceability Matrix

| Requirement | Test Cases | Verification Method |
|-------------|------------|---------------------|
| **FR-001** (Figma as external provider) | TC-CAT-002, TC-API-002 | Unit & Integration Test |
| **FR-002** (OAuth2 & PAT connection) | TC-API-001, TC-API-002 | API & Crypto Vault Test |
| **FR-003** (Design & Prototyping category) | TC-CAT-001, TC-CAT-004 | Domain Model Test |
| **FR-004** (Credential health check) | TC-API-001, TC-FIG-006 | API & Health Check Test |
| **FR-005** (Disconnect isolation) | TC-API-002 | Integration Test |
| **FR-006** (Figma knowledge source kind) | TC-KNOW-001 | Knowledge Model Test |
| **FR-007** (File URLs & keys config) | TC-KNOW-001, TC-FIG-001 | Validator Test |
| **FR-008** (Design tokens extraction) | TC-KNOW-002, TC-FIG-004 | Ingestion Test |
| **FR-009** (Component library metadata) | TC-KNOW-002, TC-FIG-005 | Ingestion Test |
| **FR-010** (Semantic vector embeddings) | TC-KNOW-002 | RAG & Chunker Test |
| **FR-011** (Incremental synchronization) | TC-KNOW-003 | Cursor & Sync Test |
| **FR-012** (Figma origin deep links) | TC-KNOW-002, TC-FIG-005 | Content Verification |
| **FR-013** (MCP server onboarding) | servers.yml inspection | Configuration Gate |
| **FR-014** (Autonomous agent tools) | TC-FIG-002, TC-FIG-004, TC-FIG-005 | Agent Tool Runner Test |
| **FR-015** (URL & node resolution) | TC-FIG-001 | URL Parser Test |
| **FR-016** (Geometry pruning & context cap) | TC-FIG-002, TC-FIG-003 | Token & String Bound Test |
| **FR-017** (Read-only enforcement) | Inspection & mock audit | Security Invariant Test |
| **FR-018** (Feature design references) | Review gate test | AIDLC Workflow Test |
| **FR-019** (Review gate design checklist) | Review gate test | AIDLC Workflow Test |

---

## 4. Success Criteria Gates

- **SC-001 (Connection in < 2 mins)**: Admin can enter PAT or complete OAuth; verified via UI flow.
- **SC-002 (100% tokens & components indexed)**: Verified by `TC-KNOW-002`.
- **SC-003 (Search in < 2s)**: Verified by knowledge base search benchmarks.
- **SC-004 (Agent inspects in < 5s)**: Verified by `TC-FIG-002` benchmark.
- **SC-005 (100% graceful error handling)**: Verified by `TC-FIG-006`.
- **SC-006 (Design fidelity in review gates)**: Verified by review gate artifact rendering.
