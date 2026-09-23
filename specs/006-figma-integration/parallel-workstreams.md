# Parallel Execution Plan: Figma Integration, MCP Tooling, and Design System Knowledge Base

**Feature**: `006-figma-integration`  
**Application repository**: `rayedbajwa/spaces` (`/data/aidlc/workspaces/rayedbajwa/spaces`)  
**Governance repository**: `governance` (`/data/aidlc/workspaces/_governance/spaces-3f701200`)  
**Source**: [tasks.md](tasks.md) · [plan.md](plan.md) · [spec.md](spec.md) · [test-plan.md](test-plan.md) · [contracts/figma-integration.md](contracts/figma-integration.md) · [data-model.md](data-model.md) · [quickstart.md](quickstart.md)  
**Status**: Ready for implementation — tasks T001–T046 defined.

---

## Scope Note & Architecture

This feature establishes Figma as a first-class integration in Spaces across four core capabilities:
1. **Authentication & Categorization**: Connect Figma at the organization level via OAuth 2.0 or Personal Access Tokens (PAT) sealed with AES-256-GCM under a dedicated "Design & Prototyping" category in `src/lib/integration-categories.ts` and `src/web/integrations.tsx`.
2. **Knowledge Base Ingestion**: Ingest Figma design system files, design tokens (colors, typography scales, elevation), and component libraries into the Spaces Knowledge Base via a dedicated connector (`importFigma`) in `src/lib/knowledge-connectors.ts` with vector embeddings (`pgvector`) and full-text search.
3. **Autonomous Agent Tools & MCP**: Onboard a pre-approved read-only Figma MCP server in `data/org/mcp/servers.yml` and provide autonomous agents with lightweight inspection tools (`figma_inspect_node`, `figma_get_file_styles`, `figma_get_components`) in `src/lib/figma-tools.ts` that prune heavy vector geometry to fit within LLM token budgets.
4. **Delivery Workflow & Review Gates**: Link Figma frames to features and surface design fidelity checklists during Designer and Lead Engineer review gates in `src/lib/features.ts`, `src/lib/aidlc.ts`, and `src/web/shell.tsx`.

### Multi-Repository Architecture
- **Application Repository (`rayedbajwa/spaces`)**: Houses runtime code, database schema migrations, backend REST endpoints, frontend React components, agent tool suites, MCP configuration, and unit/integration tests.
- **Governance Repository (`governance`)**: Houses specification artifacts, architecture decisions, data models, interface contracts, tasks, and test plans in `specs/006-figma-integration/`.

---

## Workstream 1: Foundation, Schema Migration, and Provider Enums

### Repository

rayedbajwa/spaces

### Tasks

- **Task IDs**: T001, T002, T003, T004, T005, T006, T007
- T001: Initialize feature branch worktree tracking for `006-figma-integration` in `rayedbajwa/spaces`.
- T002 `[P]`: Register Figma MCP server configuration in `data/org/mcp/servers.yml`.
- T003: Update database schema constraints for `app_integrations_kind_check` and `knowledge_sources_kind_check` in `src/lib/db-schema.sql`.
- T004 `[P]`: Update canonical integration categories to add `design` ("Design & Prototyping") in `src/lib/integration-categories.ts`.
- T005 `[P]`: Register `figma` provider configuration in `src/lib/oauth.ts`.
- T006 `[P]`: Add `figma` to `AppIntegrationKind` and credential sealing in `src/lib/app-integrations.ts`.
- T007: Add `figma` to `KnowledgeSourceKind` and `KNOWLEDGE_KIND_LABEL` in `src/lib/knowledge-store.ts`.

**Proposed sub-agent assignment**: Foundation & Persistence Engineer.

### Inputs

- `specs/006-figma-integration/spec.md` (FR-001, FR-003, FR-006, FR-013).
- `specs/006-figma-integration/data-model.md` (§ Database Schema Constraints, § Taxonomy and Categories).
- `specs/006-figma-integration/contracts/figma-integration.md` (§ 1 Domain & Provider Contracts).
- Existing modules: `src/lib/db-schema.sql`, `src/lib/integration-categories.ts`, `src/lib/oauth.ts`, `src/lib/app-integrations.ts`, `src/lib/knowledge-store.ts`, `data/org/mcp/servers.yml`.

### Outputs

- Idempotent database schema migration in `src/lib/db-schema.sql` permitting `'figma'` in `app_integrations.kind` and `knowledge_sources.kind`.
- Canonical category array updated in `src/lib/integration-categories.ts` (`source_control`, `project_management`, `design`, `communication`).
- OAuth provider entry `'figma'` in `src/lib/oauth.ts` with authorize URL, token URL, and scopes (`files:read`, `file_variables:read`).
- Integration kind enum update in `src/lib/app-integrations.ts`.
- Knowledge source kind enum update in `src/lib/knowledge-store.ts`.
- Approved MCP server registered in `data/org/mcp/servers.yml`.
- **Merge Checkpoint 1 (Foundation Merge Checkpoint)**: Core taxonomy, schema constraints, provider definitions, and MCP registrations established and typechecking cleanly. Unblocks Workstreams 2, 3, 4, and 5.

### Dependencies

- **Blocked by**: Nothing — this is the foundational entry point for implementation.
- **Can run in parallel with**: Within this workstream, tasks T002 `[P]`, T004 `[P]`, T005 `[P]`, and T006 `[P]` touch disjoint files and can proceed concurrently.
- **Blocks**: Workstream 2 (US1), Workstream 3 (US2), Workstream 4 (US3), and Workstream 5 (US4).

### Scoped Files

- `data/org/mcp/servers.yml`
- `src/lib/db-schema.sql`
- `src/lib/integration-categories.ts`
- `src/lib/oauth.ts`
- `src/lib/app-integrations.ts`
- `src/lib/knowledge-store.ts`

Do **not** modify `src/server.ts`, `src/lib/knowledge-connectors.ts`, `src/lib/figma-tools.ts`, `src/web/`, or `tests/`.

### QA Focus

- **Idempotent DDL**: Schema migration must apply safely via `bun run db:migrate` without errors on both clean and existing databases.
- **Canonical Ordering**: Category order must strictly be: `source_control` → `project_management` → `design` → `communication`.
- **Provider & Kind Resolution**: `getCategoryForProvider('figma')` and `getCategoryForKind('figma')` must return `'design'`.
- **Type Exhaustiveness**: All TypeScript unions (`OAuthProviderId`, `AppIntegrationKind`, `KnowledgeSourceKind`) must compile cleanly with zero diagnostics (`bun run typecheck`).

---

## Workstream 2: User Story 1 - Figma Authentication, Credential Verification, and Integrations UI

### Repository

rayedbajwa/spaces

### Tasks

- **Task IDs**: T008, T009, T010, T011, T012, T013, T014
- T008 `[P]` `[US1]`: Create unit tests for integration category taxonomy, mapping, and status calculations in `tests/integration-categories.test.ts`.
- T009 `[P]` `[US1]`: Create integration tests for Figma credential verification, PAT sealing, and RBAC admin gating in `tests/figma-api.test.ts`.
- T010 `[US1]`: Implement `POST /api/integrations/figma/verify` endpoint in `src/server.ts`.
- T011 `[US1]`: Implement `POST /api/integrations/figma/token` endpoint for PAT credential sealing in `src/server.ts`.
- T012 `[US1]`: Implement Figma OAuth callback exchange and token storage handling in `src/server.ts`.
- T013 `[US1]`: Update Integrations UI to render Design & Prototyping category, Figma OAuth button, and PAT modal in `src/web/integrations.tsx`.
- T014 `[US1]`: Add styling for Figma branding, status badges, and token entry forms in `src/web/styles.css`.

**Proposed sub-agent assignment**: Full-Stack Authentication & UI Engineer.

### Inputs

- Merge Checkpoint 1 (Foundation Merge Checkpoint).
- `specs/006-figma-integration/spec.md` (FR-001 through FR-005, User Story 1).
- `specs/006-figma-integration/contracts/figma-integration.md` (§ 1 Domain & Provider Contracts, § 2 REST API & Credential Contracts).
- `specs/006-figma-integration/test-plan.md` (§ 2.1 Unit Test Suite: Integration Categories, § 2.4 Integration Suite: Server API Endpoints).

### Outputs

- Failing test suites confirmed red for T008 and T009 before implementation.
- REST endpoints in `src/server.ts` (`/api/integrations/figma/verify`, `/api/integrations/figma/token`, and OAuth callback handler).
- Integrations management UI in `src/web/integrations.tsx` supporting Figma OAuth connect and PAT entry dialogs.
- CSS visual enhancements in `src/web/styles.css` for Figma brand iconography, token dialog, and badge styles.
- Green test runs: `bun test tests/integration-categories.test.ts` and `bun test tests/figma-api.test.ts`.
- **Merge Checkpoint 2 (US1 MVP Checkpoint)**: Figma connection, credential encryption, health verification, and UI management fully verified and operational.

### Dependencies

- **Blocked by**: Merge Checkpoint 1 (requires foundation types and schema constraints).
- **Can run in parallel with**: Workstream 3 (US2 Knowledge Ingestion) and Workstream 4 (US3 Agent Tools). Disjoint files allow concurrent execution.
- **Blocks**: Full regression and delivery phases (Workstream 6).

### Scoped Files

- `tests/integration-categories.test.ts`
- `tests/figma-api.test.ts`
- `src/server.ts`
- `src/web/integrations.tsx`
- `src/web/styles.css`

Do **not** modify `src/lib/knowledge-connectors.ts`, `src/lib/figma-tools.ts`, `src/lib/features.ts`, `src/lib/aidlc.ts`, or `src/web/knowledge.tsx`.

### QA Focus

- **Red-to-Green Test Discipline**: Verify T008 and T009 fail prior to endpoint and UI implementation.
- **AES-256-GCM Protection**: All credentials (PATs, OAuth access/refresh tokens) must be sealed using `sealCredentials` before persistence. Raw tokens must never appear in server logs, API responses, or error traces.
- **RBAC Authorization**: Non-organization admins must receive `403 Forbidden` on credential verification, token storage, and disconnect actions.
- **Health Check & Disconnect**: `POST /verify` tests live Figma API credentials (`GET https://api.figma.com/v1/me`); disconnect deletes credentials cleanly without orphaned records.

---

## Workstream 3: User Story 2 - Knowledge Base Connector and Design System Ingestion

### Repository

rayedbajwa/spaces

### Tasks

- **Task IDs**: T015, T016, T017, T018, T019, T020, T021, T022
- T015 `[P]` `[US2]`: Create unit and integration tests for Figma knowledge connector validation, document transformation, and incremental cursor sync in `tests/knowledge-connectors.test.ts`.
- T016 `[US2]`: Implement `validateSourceConfig('figma', config)` validator in `src/lib/knowledge-connectors.ts`.
- T017 `[US2]`: Implement `importFigma` connector to fetch styles and components from Figma REST API in `src/lib/knowledge-connectors.ts`.
- T018 `[US2]`: Implement design token transformation into structured Markdown documents with deep links in `src/lib/knowledge-connectors.ts`.
- T019 `[US2]`: Implement component family and variant set Markdown formatting with property tables in `src/lib/knowledge-connectors.ts`.
- T020 `[US2]`: Implement incremental sync cursor tracking via file `lastModified` and version IDs in `src/lib/knowledge-connectors.ts`.
- T021 `[US2]`: Wire `importFigma` into `fetchSourceBatch` switch in `src/lib/knowledge-connectors.ts`.
- T022 `[US2]`: Update Knowledge UI to support Figma design system source creation and configuration in `src/web/knowledge.tsx`.

**Proposed sub-agent assignment**: Knowledge & Connector Engineer.

### Inputs

- Merge Checkpoint 1 (Foundation Merge Checkpoint).
- `specs/006-figma-integration/spec.md` (FR-006 through FR-012, User Story 2).
- `specs/006-figma-integration/contracts/figma-integration.md` (§ 3 Knowledge Connector Contract).
- `specs/006-figma-integration/test-plan.md` (§ 2.3 Unit & Integration Suite: Knowledge Connector).

### Outputs

- Failing test suite confirmed red for T015 before connector implementation.
- `src/lib/knowledge-connectors.ts` extended with `validateSourceConfig`, `importFigma`, token formatters, and cursor tracking.
- `src/web/knowledge.tsx` updated with Figma source configuration form and file URL validation.
- Green test run: `bun test tests/knowledge-connectors.test.ts`.
- **Merge Checkpoint 3 (Design System Ingestion Checkpoint)**: Figma design system ingestion, token document generation, component tables, and cursor sync fully functional.

### Dependencies

- **Blocked by**: Merge Checkpoint 1 (requires `KnowledgeSourceKind` and schema constraints).
- **Can run in parallel with**: Workstream 2 (US1 Auth & UI) and Workstream 4 (US3 Agent Tools). Completely disjoint file sets.
- **Blocks**: Full regression and delivery phases (Workstream 6).

### Scoped Files

- `tests/knowledge-connectors.test.ts`
- `src/lib/knowledge-connectors.ts`
- `src/web/knowledge.tsx`

Do **not** modify `src/server.ts`, `src/lib/figma-tools.ts`, `src/lib/features.ts`, `src/lib/aidlc.ts`, `src/web/integrations.tsx`, or `src/web/styles.css`.

### QA Focus

- **Red-to-Green Test Discipline**: Verify T015 fails prior to implementing connector methods.
- **Markdown Document Formatting**: Design tokens (colors, typography scales, elevation) and components must be emitted as structured Markdown tables containing deep origin links (`https://www.figma.com/design/:key?node-id=:id`).
- **Incremental Cursor Sync**: Ensure cursor stores `lastModified` timestamp and file version; unchanged files must yield `complete: true` without redundant downstream indexing.
- **Vector Indexing Compatibility**: Emitted documents must be formatted cleanly for chunking and `pgvector` embedding storage.

---

## Workstream 4: User Story 3 - Autonomous Agent Tools and MCP Inspection

### Repository

rayedbajwa/spaces

### Tasks

- **Task IDs**: T023, T024, T025, T026, T027, T028, T029, T030
- T023 `[P]` `[US3]`: Create unit tests for Figma URL parsing, geometry pruning, token bounds, and error handling in `tests/figma-tools.test.ts`.
- T024 `[US3]`: Implement URL parser and normalizer for Figma file and node links in `src/lib/figma-tools.ts`.
- T025 `[US3]`: Implement geometry pruning algorithm stripping `vectorPaths` and raw bezier strokes in `src/lib/figma-tools.ts`.
- T026 `[US3]`: Implement `figma_inspect_node` tool returning flexbox layout, dimensions, typography, and fills in `src/lib/figma-tools.ts`.
- T027 `[US3]`: Implement `figma_get_file_styles` tool extracting color tokens and typography scale in `src/lib/figma-tools.ts`.
- T028 `[US3]`: Implement `figma_get_components` tool listing published components and variant options in `src/lib/figma-tools.ts`.
- T029 `[US3]`: Add token budget capping (max 24,000 characters) and rate limit exponential backoff in `src/lib/figma-tools.ts`.
- T030 `[US3]`: Wire `buildFigmaTools` into Pi agent session creation alongside knowledge tools in `src/lib/aidlc.ts`.

**Proposed sub-agent assignment**: Agent Tools & LLM Systems Engineer.

### Inputs

- Merge Checkpoint 1 (Foundation Merge Checkpoint).
- `specs/006-figma-integration/spec.md` (FR-013 through FR-017, User Story 3).
- `specs/006-figma-integration/contracts/figma-integration.md` (§ 4 Agent Tools Contract).
- `specs/006-figma-integration/test-plan.md` (§ 2.2 Unit Test Suite: Figma Agent Tools & Parser).

### Outputs

- Failing test suite confirmed red for T023 before tool implementation.
- New module `src/lib/figma-tools.ts` exporting `buildFigmaTools`, URL parser, geometry pruner, and rate limiter.
- Agent tool registration wired into `src/lib/aidlc.ts`.
- Green test run: `bun test tests/figma-tools.test.ts`.
- **Merge Checkpoint 4 (Agent Tools Checkpoint)**: Agent tools verified green with URL normalization, vector pruning, 24k token capping, and error backoff.

### Dependencies

- **Blocked by**: Merge Checkpoint 1.
- **Can run in parallel with**: Workstream 2 (US1 Auth & UI) and Workstream 3 (US2 Knowledge Ingestion).
- **Blocks**: Workstream 5 (US4 Workflow & Review Gates) which also touches `src/lib/aidlc.ts`.

### Scoped Files

- `tests/figma-tools.test.ts`
- `src/lib/figma-tools.ts`
- `src/lib/aidlc.ts` (agent session tool registration section)

Do **not** modify `src/server.ts`, `src/lib/knowledge-connectors.ts`, `src/lib/features.ts`, `src/web/`, or `src/lib/db-schema.sql`.

### QA Focus

- **Red-to-Green Test Discipline**: Verify T023 fails prior to writing `src/lib/figma-tools.ts`.
- **Strict Read-Only Enforcement**: Agent tools must only issue HTTP `GET` requests; never call mutating Figma API endpoints.
- **Geometry Pruning**: Raw vector coordinates (`vectorPaths`, `strokeGeometry`) must be stripped to prevent context bloat.
- **Context Cap**: Serialized response payload must never exceed 24,000 characters.
- **Resilient URL Parsing**: Robustly extract `fileKey` and `nodeId` from `/design/:key/:title?node-id=X-Y` and `/file/:key/...` formats, replacing `-` with `:` for node IDs.
- **Graceful Error Recovery**: Return human-readable strings on 401 Unauthorized, 404 Node Not Found, and 429 Rate Limit backoff exhaustion without throwing unhandled exceptions.

---

## Workstream 5: User Story 4 - Feature Workflow Design Linking and Review Gates

### Repository

rayedbajwa/spaces

### Tasks

- **Task IDs**: T031, T032, T033, T034
- T031 `[P]` `[US4]`: Create workflow tests for feature design artifact association and review gate checklist rendering in `tests/acceptance.test.ts`.
- T032 `[US4]`: Update feature artifact parser to extract linked Figma URLs from specifications in `src/lib/features.ts`.
- T033 `[US4]`: Add design fidelity checklist generation to review gate preambles for Designer responsibility in `src/lib/aidlc.ts`.
- T034 `[US4]`: Update review gate UI to display linked Figma design preview links and compliance checks in `src/web/shell.tsx`.

**Proposed sub-agent assignment**: Workflow & Review Gate Engineer.

### Inputs

- Merge Checkpoint 1 (Foundation Merge Checkpoint).
- Merge Checkpoint 4 (Agent Tools wired in `src/lib/aidlc.ts` from Workstream 4).
- `specs/006-figma-integration/spec.md` (FR-018, FR-019, User Story 4).
- `specs/006-figma-integration/contracts/figma-integration.md` (§ 5 Review Gate & Workflow Contract).
- `specs/006-figma-integration/test-plan.md` (§ 3 Requirements Traceability Matrix, FR-018 & FR-019).

### Outputs

- Failing workflow tests confirmed red for T031 before implementation.
- Feature specification URL extraction routines in `src/lib/features.ts`.
- Review gate checklist generation logic in `src/lib/aidlc.ts`.
- Modal review gate rendering updates in `src/web/shell.tsx`.
- Green test run: `bun test tests/acceptance.test.ts`.
- **Merge Checkpoint 5 (Review Gates Checkpoint)**: Feature workflows link Figma frames and display design fidelity checklists during review gates.

### Dependencies

- **Blocked by**: Merge Checkpoint 1 (Foundation) and Merge Checkpoint 4 (Workstream 4 must complete its modifications to `src/lib/aidlc.ts` first to avoid merge conflicts).
- **Can run in parallel with**: Documentation validation in Workstream 7.
- **Blocks**: Final verification in Workstream 6.

### Scoped Files

- `tests/acceptance.test.ts`
- `src/lib/features.ts`
- `src/lib/aidlc.ts` (review gate preamble section)
- `src/web/shell.tsx`

Do **not** modify `src/server.ts`, `src/lib/knowledge-connectors.ts`, `src/lib/figma-tools.ts`, `src/web/integrations.tsx`, or `src/web/knowledge.tsx`.

### QA Focus

- **Red-to-Green Test Discipline**: Verify T031 fails prior to implementation.
- **Regex Robustness**: Feature artifact parser reliably extracts Figma URLs from specification Markdown headers and bodies.
- **Review Gate Preamble**: Features with associated design URLs generate explicit design fidelity checklists for the `Designer` and `Lead Engineer` roles.
- **Safe Link Target**: Review gate modal in `src/web/shell.tsx` opens external Figma URLs with `target="_blank"` and `rel="noopener noreferrer"`.

---

## Workstream 6: System Verification, Polish, and Application Delivery

### Repository

rayedbajwa/spaces

### Tasks

- **Task IDs**: T035, T036, T037, T041, T042, T043, T044, T045, T046
- T035 `[P]`: Run typecheck across all modified files (`bun run typecheck`) in `rayedbajwa/spaces`.
- T036 `[P]`: Build web production bundle (`bun run build:web`) in `rayedbajwa/spaces`.
- T037: Run complete test suite (`bun test`) including new and existing integration tests in `rayedbajwa/spaces`.
- T041: Open pull request for `rayedbajwa/spaces` repository on branch `006-figma-integration`.
- T042: Verify continuous integration checks pass on `rayedbajwa/spaces` pull request.
- T043: Conduct code review and obtain required approval for `rayedbajwa/spaces` pull request.
- T044: Merge pull request for `rayedbajwa/spaces` repository (waits on governance merge).
- T045: Confirm automated deployment pipeline completes successfully for `rayedbajwa/spaces`.
- T046: Execute UAT and acceptance verification against deployed environment per `specs/006-figma-integration/test-plan.md`.

**Proposed sub-agent assignment**: Release & Application Delivery Engineer.

### Inputs

- Merge Checkpoints 1, 2, 3, 4, and 5 (all user story implementations landed in `rayedbajwa/spaces`).
- Merged pull request from Workstream 7 in `governance` (specification source of truth).
- `specs/006-figma-integration/test-plan.md` (§ 4 Success Criteria Gates).

### Outputs

- Zero TypeScript compiler errors (`bun run typecheck`).
- Production bundle compiled to `public/main.js` and `public/styles.css` (`bun run build:web`).
- Full test suite passing green (`bun test`).
- GitHub Pull Request in `rayedbajwa/spaces`, CI check pass, code review sign-off, merge commit, automated deployment confirmation, and UAT verification report.
- **Merge Checkpoint 6 (Application Release Complete)**: Feature fully verified, merged, deployed, and validated.

### Dependencies

- **Blocked by**: All application workstreams (WS1–WS5) and Workstream 7 (governance PR must merge first before application PR merge).
- **Human Review Gate**: Tasks T043, T044, T045, and T046 are strictly human-gated per AIDLC Directives. Merging and deploying require explicit human approval.

### Scoped Files

- `public/*` (compiled assets)
- Repository build, test, and release targets in `rayedbajwa/spaces`

Do **not** modify runtime application logic or governance specifications during this workstream.

### QA Focus

- **Zero Typecheck Errors**: Strict TypeScript check with no `any` casts or unhandled union types.
- **Asset Integrity**: `bun run build:web` succeeds without warnings or bundle bloat.
- **Test Suite Completeness**: All unit, integration, and smoke tests pass cleanly. E2E tests requiring live third-party keys are ignored per Organization Memory.
- **Safe CI Policy**: Do not modify CI workflows (`.github/workflows/*.yml`) per Organization Memory.

---

## Workstream 7: Governance Documentation and Artifact Delivery

### Repository

governance

### Tasks

- **Task IDs**: T038, T039, T040
- T038: Validate developer quickstart instructions and tool behaviors in `specs/006-figma-integration/quickstart.md`.
- T039: Open pull request for `governance` repository with specification, plan, tasks, and test-plan artifacts in `specs/006-figma-integration/`.
- T040: Merge pull request for `governance` repository.

**Proposed sub-agent assignment**: Governance Lead & Technical Writer.

### Inputs

- All completed feature artifacts in `specs/006-figma-integration/` (`spec.md`, `plan.md`, `tasks.md`, `test-plan.md`, `quickstart.md`, `data-model.md`, `contracts/figma-integration.md`, `parallel-workstreams.md`).
- Working application behavior verified from Checkpoint 2 (US1 MVP).

### Outputs

- Validated developer walkthrough and troubleshooting steps in `specs/006-figma-integration/quickstart.md`.
- Governance Pull Request opened and merged to main in `governance`.
- **Merge Checkpoint 7 (Governance Merge Complete)**: Specification and plan artifacts permanently recorded and merged into governance history prior to application PR merge.

### Dependencies

- **Blocked by**: T038 requires working endpoints and tools from Workstreams 2, 3, and 4 to validate quickstart curl and CLI commands.
- **Can run in parallel with**: Workstream 5 and Polish tasks (T035–T037) in Workstream 6.
- **Blocks**: Task T044 (Application pull request merge waits on governance merge).
- **Human Review Gate**: Task T040 is human-gated per AIDLC Directives.

### Scoped Files

- `specs/006-figma-integration/quickstart.md`
- `specs/006-figma-integration/*`

Do **not** modify files in `rayedbajwa/spaces`.

### QA Focus

- **Quickstart Fidelity**: Ensure curl commands, endpoint paths, and payload formats match the implemented contracts.
- **Artifact Completeness**: Confirm all checklists, requirements traceability tables, and test cases are synchronized.
- **Review Approval**: Ensure human approval is recorded before PR merge.

---

## Sequential Work and Merge Checkpoints

The following tasks, transitions, and human gates **MUST remain strictly sequential**:

1. **Phase 1 Baseline & Worktree Setup (T001)**: Must execute first to establish branch tracking on `006-figma-integration` in `rayedbajwa/spaces`.
2. **Foundational Prerequisites (Phase 2, T003–T007)**:
   - Must complete before User Stories 1, 2, 3, and 4 begin implementation.
   - Database schema constraint migration (`T003`) and category/provider enums (`T004`–`T007`) define the shared contracts needed by all downstream services.
   - **Merge Checkpoint 1**: Unblocks Workstreams 2, 3, and 4.
3. **Red-to-Green Test Discipline**:
   - Within Workstream 2: T008 and T009 test suites must be written and confirmed **failing** before endpoints and UI are implemented (`T010`–`T014`).
   - Within Workstream 3: T015 tests must be confirmed **failing** before connector logic is implemented (`T016`–`T022`).
   - Within Workstream 4: T023 tests must be confirmed **failing** before tool logic is implemented (`T024`–`T030`).
   - Within Workstream 5: T031 tests must be confirmed **failing** before workflow logic is implemented (`T032`–`T034`).
4. **File Concurrency Constraint on `src/lib/aidlc.ts`**:
   - Workstream 4 (T030) wires agent inspection tools in `src/lib/aidlc.ts`.
   - Workstream 5 (T033) adds review gate checklist preambles in `src/lib/aidlc.ts`.
   - Workstream 5 must wait for Workstream 4's changes to `src/lib/aidlc.ts` to merge (Merge Checkpoint 4) before applying checklist preambles to avoid merge collisions.
5. **System Verification & Bundle Build (T035–T037)**:
   - Typecheck (`T035`), production bundle build (`T036`), and full test suite (`T037`) must run sequentially after all application workstreams (WS1–WS5) have merged.
6. **Delivery and Governance Ordering (T039–T046)**:
   - **T040 (Governance Merge)** must merge **before** **T044 (Application Merge)**, guaranteeing the specification record of truth exists before code lands on main.
   - **Human Authorization Required**: Tasks T040 (merge governance PR), T043/T044 (review and merge application PR), and T045/T046 (deploy and verify UAT) require explicit human approval under AIDLC Directives. Never merge or deploy autonomously.

---

## QA Coordination Notes

- **Disjoint File Isolation**:
  - Each workstream is strictly scoped to non-overlapping files. Sub-agents must never edit files outside their designated `Scoped Files` list.
- **Port Allocation**:
  - Port 3000 is reserved for the agent runtime environment and must never be bound. If a local test server is started for smoke testing or Playwright inspection, use `PORT=3369` (`http://127.0.0.1:3369`).
- **Database Safety & Idempotent Migrations**:
  - The PostgreSQL instance is available at the checkout's declared `DATABASE_URL`.
  - Schema migrations in `src/lib/db-schema.sql` use idempotent `DROP CONSTRAINT IF EXISTS ... ADD CONSTRAINT ...` syntax. Never run destructive `DROP TABLE` or mutating operations on existing data.
- **Credential Protection**:
  - All test cases and assertions must use mock or encrypted dummy tokens (`figd_mock_pat_token`, `sealed_token_xyz`).
  - Plaintext tokens, client secrets, or sensitive Figma URLs must never appear in test assertions, logs, or error dumps.
- **Third-Party Keys Policy**:
  - Per Organization Memory ("Tasks and tests: E2E tests that require keys can be ignored"), automated suites in CI must rely on mocked HTTP responses (`fetch` interceptors or mock servers) and unit test assertions. Do not block CI on live Figma API availability.
- **CI Configuration Stability**:
  - Per Organization Memory ("CI update is not necessary as long as its working as expected"), **do not modify `.github/workflows/*.yml`**. All tests run together under the existing pipeline.

---

## Concurrency Recommendation

**Safe concurrency: Up to 3 concurrent workstreams.**

1. **Foundational Phase (Phase 1 & 2)**:
   - Run **Workstream 1** as a single coordinated stream. Within Workstream 1, tasks T002 `[P]`, T004 `[P]`, T005 `[P]`, and T006 `[P]` touch disjoint files and can execute concurrently by sub-tasks.
2. **Core Feature Implementation Phase (Phases 3–5)**:
   - Once Merge Checkpoint 1 is met, launch **3 workstreams concurrently**:
     - **Workstream 2** (US1: Figma Authentication, Endpoints, Integrations UI & Styling)
     - **Workstream 3** (US2: Knowledge Connector & Design System Ingestion)
     - **Workstream 4** (US3: Agent Inspection Tools & MCP Registration)
   - These 3 workstreams touch mutually disjoint file boundaries (`server.ts`/`integrations.tsx`/`styles.css` vs `knowledge-connectors.ts`/`knowledge.tsx` vs `figma-tools.ts`/`aidlc.ts`) with zero merge collision risk.
3. **Workflow Integration & Governance Phase (Phase 6)**:
   - Once Workstream 4 completes its edits to `src/lib/aidlc.ts`, launch **Workstream 5** (US4: Workflow Linking & Review Gates) concurrently with **Workstream 7** (Governance Quickstart Validation).
4. **Validation & Delivery Phase (Phases 7 & 8)**:
   - Run **Workstream 6** (Typecheck, Web Build, Full Test Suite) sequentially, followed by the dependency-ordered PR merge and deployment flow.

A **3-workstream concurrency profile** maximizes parallel development velocity while ensuring strict file isolation, zero git merge conflicts, and flawless integration integrity.
