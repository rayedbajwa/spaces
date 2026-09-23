---
description: "Task list for Figma Integration, MCP Tooling, and Design System Knowledge Base"
---

# Tasks: Figma Integration, MCP Tooling, and Design System Knowledge Base

**Input**: Design documents from `/specs/006-figma-integration/`  
**Prerequisites**: [plan.md](plan.md) (required), [spec.md](spec.md) (required for user stories), [research.md](research.md), [data-model.md](data-model.md), [contracts/figma-integration.md](contracts/figma-integration.md), [test-plan.md](test-plan.md)  
**Repositories**: `rayedbajwa/spaces` (application code, UI, agent runtime), `governance` (specifications, plans, tasks, test plans)  

**Tests**: Every user story includes explicit verification and test tasks covering acceptance criteria, edge cases, error modes, and schema integrity per `test-plan.md`.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (`[US1]`, `[US2]`, `[US3]`, `[US4]`)
- Include exact file paths in descriptions

## Path Conventions

- Application source code and runtime: `rayedbajwa/spaces` (`src/`, `tests/`, `data/`)
- Governance and specification artifacts: `governance` (`specs/006-figma-integration/`)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization, branch tracking, and MCP configuration

- [x] T001 Initialize feature branch worktree tracking for 006-figma-integration in rayedbajwa/spaces
- [x] T002 [P] Register Figma MCP server configuration in data/org/mcp/servers.yml

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core schema migrations, category taxonomy, and provider enums that MUST be complete before ANY user story can be implemented

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T003 Update database schema constraints for app_integrations_kind_check and knowledge_sources_kind_check in src/lib/db-schema.sql
- [x] T004 [P] Update canonical integration categories to add design ("Design & Prototyping") in src/lib/integration-categories.ts
- [x] T005 [P] Register figma provider configuration in src/lib/oauth.ts
- [x] T006 [P] Add figma to AppIntegrationKind and credential sealing in src/lib/app-integrations.ts
- [x] T007 Add figma to KnowledgeSourceKind and KNOWLEDGE_KIND_LABEL in src/lib/knowledge-store.ts

**Checkpoint**: Foundation ready — user story implementation can now begin in parallel or sequentially.

---

## Phase 3: User Story 1 - Connect and Manage Figma Integration (Priority: P1) 🎯 MVP

**Goal**: Enable organization administrators to connect, verify, and disconnect Figma via OAuth 2.0 or Personal Access Token (PAT) under the Design & Prototyping category with AES-256-GCM encrypted credentials.

**Independent Test**: Navigate to the Organization Integrations view as an administrator. Configure Figma credentials (via OAuth application or personal access token). Authorize the connection and verify that the Figma card reports an active, healthy status and displays connected account details. Disconnecting the integration cleans up credentials and marks the integration disconnected.

### Tests for User Story 1 ⚠️

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [x] T008 [P] [US1] Create unit tests for integration category taxonomy, mapping, and status calculations in tests/integration-categories.test.ts
- [x] T009 [P] [US1] Create integration tests for Figma credential verification, PAT sealing, and RBAC admin gating in tests/figma-api.test.ts

### Implementation for User Story 1

- [x] T010 [US1] Implement POST /api/integrations/figma/verify endpoint in src/server.ts
- [x] T011 [US1] Implement POST /api/integrations/figma/token endpoint for PAT credential sealing in src/server.ts
- [x] T012 [US1] Implement Figma OAuth callback exchange and token storage handling in src/server.ts
- [x] T013 [US1] Update Integrations UI to render Design & Prototyping category, Figma OAuth button, and PAT modal in src/web/integrations.tsx
- [x] T014 [US1] Add styling for Figma branding, status badges, and token entry forms in src/web/styles.css

**Checkpoint**: At this point, User Story 1 is fully functional and testable independently (MVP ready).

---

## Phase 4: User Story 2 - Ingest Design Systems and Component Libraries into Knowledge Base (Priority: P2)

**Goal**: Allow product teams to ingest Figma files, styles (colors, typography, elevation), and components into Spaces Knowledge Base with vector embeddings and full-text search.

**Independent Test**: Add a Figma design file URL or component library key as a Knowledge Source. Trigger synchronization. Verify that styles (colors, typography, elevation), components (variants, properties, descriptions), and documentation frames are indexed and return accurate results in knowledge searches.

### Tests for User Story 2 ⚠️

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [x] T015 [P] [US2] Create unit and integration tests for Figma knowledge connector validation, document transformation, and incremental cursor sync in tests/knowledge-connectors.test.ts

### Implementation for User Story 2

- [x] T016 [US2] Implement validateSourceConfig('figma', config) validator in src/lib/knowledge-connectors.ts
- [x] T017 [US2] Implement importFigma connector to fetch styles and components from Figma REST API in src/lib/knowledge-connectors.ts
- [x] T018 [US2] Implement design token transformation into structured Markdown documents with deep links in src/lib/knowledge-connectors.ts
- [x] T019 [US2] Implement component family and variant set Markdown formatting with property tables in src/lib/knowledge-connectors.ts
- [x] T020 [US2] Implement incremental sync cursor tracking via file lastModified and version IDs in src/lib/knowledge-connectors.ts
- [x] T021 [US2] Wire importFigma into fetchSourceBatch switch in src/lib/knowledge-connectors.ts
- [x] T022 [US2] Update Knowledge UI to support Figma design system source creation and configuration in src/web/knowledge.tsx

**Checkpoint**: At this point, User Stories 1 AND 2 both work independently and design system knowledge can be queried.

---

## Phase 5: User Story 3 - Onboard Figma Tools and MCP Server for Autonomous Agents (Priority: P3)

**Goal**: Equip autonomous agents with read-only inspection tools (`figma_inspect_node`, `figma_get_file_styles`, `figma_get_components`) that parse URLs, retrieve flexbox layout attributes, and prune heavy vector geometry within LLM token budgets.

**Independent Test**: Configure an agent session with Figma tools enabled. Issue a prompt referencing a Figma frame URL. Confirm the agent invokes the Figma inspection tool, retrieves the structural node hierarchy and styling properties, and correctly uses them in the task output.

### Tests for User Story 3 ⚠️

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [x] T023 [P] [US3] Create unit tests for Figma URL parsing, geometry pruning, token bounds, and error handling in tests/figma-tools.test.ts

### Implementation for User Story 3

- [x] T024 [US3] Implement URL parser and normalizer for Figma file and node links in src/lib/figma-tools.ts
- [x] T025 [US3] Implement geometry pruning algorithm stripping vectorPaths and raw bezier strokes in src/lib/figma-tools.ts
- [x] T026 [US3] Implement figma_inspect_node tool returning flexbox layout, dimensions, typography, and fills in src/lib/figma-tools.ts
- [x] T027 [US3] Implement figma_get_file_styles tool extracting color tokens and typography scale in src/lib/figma-tools.ts
- [x] T028 [US3] Implement figma_get_components tool listing published components and variant options in src/lib/figma-tools.ts
- [x] T029 [US3] Add token budget capping (max 24,000 characters) and rate limit exponential backoff in src/lib/figma-tools.ts
- [x] T030 [US3] Wire buildFigmaTools into Pi agent session creation alongside knowledge tools in src/lib/aidlc.ts

**Checkpoint**: At this point, User Stories 1, 2, and 3 are functional; autonomous agents can autonomously inspect designs and tokens during pipeline stages.

---

## Phase 6: User Story 4 - Design Context Association in Feature Workflows and Review Gates (Priority: P4)

**Goal**: Link Figma frames to features and present design fidelity checklists during Designer and Lead Engineer review gates in the AIDLC delivery workflow.

**Independent Test**: Associate a Figma frame URL with a feature initiative. Progress through the `implement` and `verify` stages. Verify that the review gate displays the linked design artifact and highlights design system compliance checks for the reviewer.

### Tests for User Story 4 ⚠️

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [x] T031 [P] [US4] Create workflow tests for feature design artifact association and review gate checklist rendering in tests/acceptance.test.ts

### Implementation for User Story 4

- [x] T032 [US4] Update feature artifact parser to extract linked Figma URLs from specifications in src/lib/features.ts
- [x] T033 [US4] Add design fidelity checklist generation to review gate preambles for Designer responsibility in src/lib/aidlc.ts
- [x] T034 [US4] Update review gate UI to display linked Figma design preview links and compliance checks in src/web/shell.tsx

**Checkpoint**: All user stories are complete; design fidelity loops are closed across planning, implementation, and review gates.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: System-wide verification, type checking, asset compilation, and quickstart documentation validation

- [x] T035 [P] Run typecheck across all modified files (bun run typecheck) in rayedbajwa/spaces
- [x] T036 [P] Build web production bundle (bun run build:web) in rayedbajwa/spaces
- [x] T037 Run complete test suite (bun test) including new and existing integration tests in rayedbajwa/spaces
- [x] T038 Validate developer quickstart instructions and tool behaviors in specs/006-figma-integration/quickstart.md

---

## Phase 8: Delivery

**Purpose**: Pull requests, review approval, dependency-ordered merging, deployment verification, and acceptance testing across repositories

### Workstream 1: Governance Repository (`governance`)
- [ ] T039 Open pull request for governance repository with specification, plan, tasks, and test-plan artifacts in specs/006-figma-integration/
- [ ] T040 Merge pull request for governance repository

### Workstream 2: Application Repository (`rayedbajwa/spaces`)
- [ ] T041 Open pull request for rayedbajwa/spaces repository on branch 006-figma-integration
- [ ] T042 Verify continuous integration checks pass on rayedbajwa/spaces pull request
- [ ] T043 Conduct code review and obtain required approval for rayedbajwa/spaces pull request
- [ ] T044 Merge pull request for rayedbajwa/spaces repository (waits on governance merge)
- [ ] T045 Confirm automated deployment pipeline completes successfully for rayedbajwa/spaces
- [ ] T046 Execute UAT and acceptance verification against deployed environment per specs/006-figma-integration/test-plan.md

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately.
- **Foundational (Phase 2)**: Depends on Setup completion — BLOCKS all user stories.
- **User Stories (Phases 3–6)**: All depend on Foundational phase completion.
  - Can proceed sequentially in priority order (P1 → P2 → P3 → P4).
  - Or in parallel once Foundation is merged.
- **Polish (Phase 7)**: Depends on completion of desired user story phases.
- **Delivery (Phase 8)**: Depends on Polish completion and clean CI passing.

### User Story Dependencies

- **User Story 1 (P1 - Connect & Auth)**: Can start after Foundational (Phase 2). No dependencies on other stories. Essential for live API calls.
- **User Story 2 (P2 - Knowledge Base)**: Can start after Foundational (Phase 2). Requires valid credentials from US1 when connecting live Figma files.
- **User Story 3 (P3 - Agent Tools & MCP)**: Can start after Foundational (Phase 2). Works with mock payloads or credentials established in US1.
- **User Story 4 (P4 - Workflow & Review Gates)**: Can start after Foundational (Phase 2). Consumes design links and tokens produced by US2/US3.

### Within Each User Story

- Tests MUST be written FIRST and fail before implementation begins.
- Models and schemas before service endpoints.
- Backend endpoints and connectors before frontend UI views.
- Core tool routines before agent session wiring.
- Checkpoint validation before marking a story complete.

### Parallel Opportunities

- Within Phase 1: `T002` can proceed in parallel with `T001`.
- Within Phase 2: `T004`, `T005`, and `T006` can proceed in parallel.
- Within User Story 1: `T008` and `T009` (tests) can run in parallel before backend endpoints.
- Within User Story 2: `T015` test writing can run in parallel with connector scaffolding.
- Within User Story 3: `T023` test suite can run in parallel with URL parser scaffolding.
- Within Polish: `T035` (typecheck) and `T036` (web build) can run in parallel.

---

## Parallel Example: User Story 1

```bash
# Launch test definitions in parallel:
Task: "T008 [P] [US1] Create unit tests for integration category taxonomy, mapping, and status calculations in tests/integration-categories.test.ts"
Task: "T009 [P] [US1] Create integration tests for Figma credential verification, PAT sealing, and RBAC admin gating in tests/figma-api.test.ts"

# Once failing tests are committed, implement server endpoints:
Task: "T010 [US1] Implement POST /api/integrations/figma/verify endpoint in src/server.ts"
Task: "T011 [US1] Implement POST /api/integrations/figma/token endpoint for PAT credential sealing in src/server.ts"
```

---

## Parallel Example: User Story 3

```bash
# Launch test suite creation:
Task: "T023 [P] [US3] Create unit tests for Figma URL parsing, geometry pruning, token bounds, and error handling in tests/figma-tools.test.ts"

# Once failing tests are committed, implement parser and pruning algorithms:
Task: "T024 [US3] Implement URL parser and normalizer for Figma file and node links in src/lib/figma-tools.ts"
Task: "T025 [US3] Implement geometry pruning algorithm stripping vectorPaths and raw bezier strokes in src/lib/figma-tools.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (`T001`, `T002`).
2. Complete Phase 2: Foundational (`T003`–`T007`) — **CRITICAL**: blocks all stories.
3. Complete Phase 3: User Story 1 (`T008`–`T014`).
4. **STOP and VALIDATE**: Verify Figma connection via PAT and OAuth, credential encryption, and category status in UI.
5. Deploy/demo the MVP increment.

### Incremental Delivery

1. Setup + Foundational → Core schema & taxonomy ready.
2. Add User Story 1 → Test independently → Deploy/Demo (MVP: Figma Connected!).
3. Add User Story 2 → Ingest design system styles & components → Search Knowledge Base.
4. Add User Story 3 → Onboard agent tools & MCP → Autonomous agents inspect designs.
5. Add User Story 4 → Review gates & fidelity checklists → Complete design-to-delivery lifecycle.
6. Polish + Delivery → Cross-repo merge and production release.

### Parallel Team Strategy

With multiple developers or sub-agents:

1. Team completes Setup + Foundational together.
2. Once Foundational is done:
   - Developer A: User Story 1 (Authentication, Categories & UI)
   - Developer B: User Story 2 (Knowledge Connector & Ingestion)
   - Developer C: User Story 3 (Agent Tools & MCP Inspection)
   - Developer D: User Story 4 (Review Gates & Workflow Artifacts)
3. Stories integrate and verify independently at designated checkpoints.

---

## Notes

- `[P]` tasks = different files, no dependencies
- `[Story]` label maps task to specific user story for traceability
- Each user story is independently completable and testable
- All tasks strictly follow `- [ ] [TaskID] [P?] [Story?] Description with file path`
