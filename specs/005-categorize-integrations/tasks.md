---
description: "Task list for feature 005-categorize-integrations"
---

# Tasks: Categorize Integrations by Functional Domain

**Input**: Design documents from `/specs/005-categorize-integrations/`  
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/categorized-integrations.md, quickstart.md, test-plan.md

**Repositories**:
- `rayedbajwa/spaces` (`/data/aidlc/workspaces/rayedbajwa/spaces`): Application code (`src/lib/integration-categories.ts`, `src/web/integrations.tsx`, `src/web/styles.css`), unit tests (`tests/integration-categories.test.ts`), and frontend build assets.
- `governance` (`/data/aidlc/workspaces/_governance/spaces-3f701200`): Feature specification, plan, research, data-model, interface contracts, quickstart, test-plan, and tasks artifacts.

**Tests**: Every user story includes dedicated test tasks covering unit taxonomy verification, status calculation permutations, component read-only/management contracts, and full build/typecheck validation. CI updates are not needed per organization memory ("CI update is not necessary as long as it is working as expected").

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm workspace environment and establish a clean verification baseline.

- [X] T001 Confirm feature branch `005-categorize-integrations` in `rayedbajwa/spaces` and run `bun run typecheck` and `bun test tests/smoke.test.ts` to record a green baseline in `tests/smoke.test.ts`.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core taxonomy, status calculation logic, and base CSS classes that MUST be complete before ANY user story can be implemented.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T002 [P] Create unit test suite in `tests/integration-categories.test.ts` in `rayedbajwa/spaces` covering TC-CAT-001…TC-CAT-004 (canonical ordering `source_control`, `project_management`, `communication`, provider exhaustiveness, kind exhaustiveness, unknown provider/kind handling) and TC-STAT-001…TC-STAT-005 (status calculation permutations: empty, configured_unconnected, partial, connected, needs_reconnect). Run `bun test tests/integration-categories.test.ts` and verify test failure before implementation.
- [X] T003 Implement centralized categorization module in `src/lib/integration-categories.ts` in `rayedbajwa/spaces` exporting `IntegrationCategoryId`, `CategoryReadinessState`, `IntegrationCategoryDefinition`, `CategoryStatusSummary`, `INTEGRATION_CATEGORIES`, `getCategoryForProvider`, `getCategoryForKind`, and `calculateCategoryStatus`. Run `bun test tests/integration-categories.test.ts` to confirm unit tests pass.
- [X] T004 [P] Add base category layout and badge styling classes (`.integration-category`, `.integration-category-header`, `.integration-category-empty`, `.category-badge`) in `src/web/styles.css` in `rayedbajwa/spaces`.

**Checkpoint**: Foundation ready — canonical taxonomy, status calculation, and styles established. User story implementation can now begin.

---

## Phase 3: User Story 1 - Categorized Organization Integrations Management (Priority: P1) 🎯 MVP

**Goal**: As an organization administrator, view and manage external tools grouped into three distinct functional categories (Source Control, Project Management, and Message Channels / Communication) on the organization integrations page (`/organization?section=integrations`), with setup, connect, and disconnect actions working seamlessly within each category.

**Independent Test**: Navigate to the organization integrations page as an administrator. Verify that integrations are partitioned under the three category headers, that provider apps and connections appear under their correct category, and that credential setup, OAuth connect, and disconnect actions operate correctly within each category.

### Tests for User Story 1 ⚠️

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [X] T005 [P] [US1] Add component and taxonomy mapping verification tests in `tests/integration-categories.test.ts` in `rayedbajwa/spaces` ensuring all provider apps (`github`, `atlassian`, `linear`, `slack`) map to their respective category containers without orphaned items.

### Implementation for User Story 1

- [X] T006 [US1] Refactor `IntegrationsPanel` in `src/web/integrations.tsx` in `rayedbajwa/spaces` to iterate over `INTEGRATION_CATEGORIES`, rendering category sections with headers, descriptions, and provider cards (`github` under Source Control; `atlassian` and `linear` under Project Management; `slack` under Message Channels / Communication) while preserving `editing`, `SetupForm`, `connect()`, and `disconnect()` actions.
- [X] T007 [US1] Update category card layout and grid styles in `src/web/styles.css` in `rayedbajwa/spaces` to ensure clean card positioning and responsive vertical wrapping on narrow viewports.
- [X] T008 [US1] Verify organization integrations management view end-to-end by running `bun run build:web` in `rayedbajwa/spaces` and inspecting `/organization?section=integrations` in `src/web/integrations.tsx` to confirm category section rendering, provider grouping, and interactive controls.

**Checkpoint**: At this point, User Story 1 is fully functional and testable independently as the core MVP.

---

## Phase 4: User Story 2 - Categorized Read-Only Status & Modal Inspection (Priority: P2)

**Goal**: As a team member inspecting integrations from the top navigation bar or settings modal, view integrations organized by functional category in read-only mode with administrative action buttons hidden.

**Independent Test**: Open the integrations modal from the top-level status chip as a non-administrative user. Confirm that the display is categorized into the three functional domains, displays accurate read-only connection statuses, and omits administrative controls (setup forms, edit triggers, and disconnect buttons).

### Tests for User Story 2 ⚠️

- [X] T009 [P] [US2] Add unit test assertions in `tests/integration-categories.test.ts` in `rayedbajwa/spaces` verifying the read-only contract (confirming that non-admin and `readOnly: true` configurations suppress credential management and mutation controls).

### Implementation for User Story 2

- [X] T010 [US2] Update `IntegrationsPanel` in `src/web/integrations.tsx` in `rayedbajwa/spaces` to support read-only mode across categories when `readOnly === true`, hiding credential configuration forms, setup buttons, and disconnect actions while rendering clean connection status badges and display names.
- [X] T011 [US2] Verify top navigation integration chip and modal dialog interactions in `src/web/shell.tsx` and `src/web/integrations.tsx` in `rayedbajwa/spaces` ensuring the modal opens the categorized read-only view while maintaining the aggregate status counter on the top strip.

**Checkpoint**: At this point, User Stories 1 AND 2 both work independently; administrative management and read-only inspection views are fully categorized.

---

## Phase 5: User Story 3 - Category Health Summary and Empty States (Priority: P3)

**Goal**: As an administrator or team lead evaluating toolchain readiness, see a clear readiness badge for each category (e.g. `✓ Connected`, `1 of 2 connected`, `⚠ Reconnect needed`, `App set up`, `Not connected`) and a dedicated empty state explaining the capability gap when no services are connected in that domain.

**Independent Test**: In an organization with zero integrations connected, verify that each category displays a helpful empty state explaining its purpose in the SDLC. Connect one service in a category and verify that the category summary transitions from "Not connected" to "Connected".

### Tests for User Story 3 ⚠️

- [X] T012 [P] [US3] Add unit tests in `tests/integration-categories.test.ts` in `rayedbajwa/spaces` verifying empty state determination, reconnect-needed detection (`credentialsOk: false`), and category badge text generation across all permutations.

### Implementation for User Story 3

- [X] T013 [US3] Implement category status summary badges and empty-state guidance cards in `src/web/integrations.tsx` in `rayedbajwa/spaces` using `calculateCategoryStatus()` and `category.emptyGuidance`, providing setup call-to-actions in management mode and informational guidance in read-only mode.
- [X] T014 [US3] Add empty-state card and category badge variant styling (`.integration-category-empty`, `.category-badge-completed`, `.category-badge-error`, `.category-badge-idle`) in `src/web/styles.css` in `rayedbajwa/spaces`.
- [X] T015 [US3] Verify category health badge transitions and empty states end-to-end in `src/web/integrations.tsx` in `rayedbajwa/spaces` (simulating 0 connected services, partial connectivity, and invalid credential reconnect alerts).

**Checkpoint**: All user stories (US1, US2, US3) are fully functional, responsive, and verifiable independently.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, bundle compilation, and full test suite verification.

- [X] T016 [P] Update documentation in `docs/concepts/organization-teams-and-access.md` in `rayedbajwa/spaces` describing the three functional integration categories (Source Control, Project Management, and Message Channels / Communication).
- [X] T017 Run `bun run typecheck` in `rayedbajwa/spaces` to ensure zero TypeScript errors across `src/lib/integration-categories.ts`, `src/web/integrations.tsx`, and `tests/integration-categories.test.ts`.
- [X] T018 Run `bun run build:web` via `src/build-web.ts` in `rayedbajwa/spaces` to verify client-side bundle compilation succeeds with zero warnings.
- [X] T019 Execute full test suite via `bun test` in `rayedbajwa/spaces` and validate all quickstart scenarios in `specs/005-categorize-integrations/quickstart.md`.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately.
- **Foundational (Phase 2)**: Depends on Setup completion — **BLOCKS** all user stories.
- **User Stories (Phase 3+)**: All depend on Foundational phase completion.
  - User Story 1 (P1): Depends on Phase 2. Can proceed immediately.
  - User Story 2 (P2): Depends on Phase 2 and US1 refactored panel structure.
  - User Story 3 (P3): Depends on Phase 2 status calculation logic and US1 panel layout.
- **Polish (Phase 6)**: Depends on completion of all desired user stories.
- **Delivery (Phase 7)**: Depends on Polish and passing verification suites.

### User Story Dependencies

- **User Story 1 (P1)**: Foundational taxonomy (`src/lib/integration-categories.ts`) and CSS classes (`src/web/styles.css`).
- **User Story 2 (P2)**: Integrates with `IntegrationsPanel` from US1, adding `readOnly` branch handling.
- **User Story 3 (P3)**: Integrates with `IntegrationsPanel` from US1/US2, adding aggregate category badge and empty-state rendering.

### Within Each User Story

- Tests MUST be written and fail before implementation.
- Core data/taxonomy logic before UI rendering.
- UI rendering before responsive styling adjustments.
- Story complete and verified before declaring checkpoint complete.

### Parallel Opportunities

- T002 (unit tests) and T004 (CSS styles) can run in parallel in Phase 2.
- T005 (US1 tests) can run in parallel before T006 implementation.
- T009 (US2 tests) can run in parallel before T010 implementation.
- T012 (US3 tests) can run in parallel before T013 implementation.
- T016 (documentation update) can run in parallel with T017 (typecheck).

---

## Parallel Example: User Story 1

```bash
# Launch test definition for User Story 1:
Task: "T005 [P] [US1] Add component and taxonomy mapping verification tests in tests/integration-categories.test.ts"

# Once test fails, implement panel refactoring:
Task: "T006 [US1] Refactor IntegrationsPanel in src/web/integrations.tsx"
Task: "T007 [US1] Update category card layout and grid styles in src/web/styles.css"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup baseline check.
2. Complete Phase 2: Foundational taxonomy module `src/lib/integration-categories.ts` and base CSS.
3. Complete Phase 3: User Story 1 (Categorized organization integrations management page).
4. **STOP and VALIDATE**: Confirm the organization page displays the three distinct category sections and that GitHub, Atlassian, Linear, and Slack render in their expected domains with functional management controls.

### Incremental Delivery

1. Complete Setup + Foundational → Foundation taxonomy and unit tests green.
2. Add User Story 1 → Categorized admin page works (MVP).
3. Add User Story 2 → Read-only modal inspection works for all members.
4. Add User Story 3 → Category status summary badges and empty-state cards active.
5. Complete Polish → Docs updated, TypeScript check clean, web build verified, full test suite passing.

### Parallel Team Strategy

With multiple developers:
1. One developer implements Phase 2 Foundational taxonomy `src/lib/integration-categories.ts` while another drafts base CSS in `src/web/styles.css`.
2. Once Foundational completes:
   - Developer A: Implements User Story 1 admin panel categorization (`src/web/integrations.tsx`).
   - Developer B: Prepares User Story 2 read-only modal assertions and User Story 3 empty-state components.
3. Integrate and run full test suite and web build.

---

## Delivery

Tasks below are for `rayedbajwa/spaces` (the runtime repository). `governance` contributes only feature artifacts (specification, plan, research, data-model, contracts, quickstart, test-plan, and tasks) committed to the workspace.

- [ ] T020 Open a pull request for `005-categorize-integrations` targeting `main` with Conventional Commit title (e.g., `feat(integrations): categorize integrations into source control, project management, and communication`) in `rayedbajwa/spaces`.
- [ ] T021 Verify CI check-runs (`build & test`, `docker build`) pass and obtain review approval, then merge the pull request into `main` in `rayedbajwa/spaces`.
- [ ] T022 Confirm deployment pipeline succeeds and perform live acceptance verification of categorized integrations on the deployed environment against `specs/005-categorize-integrations/test-plan.md` (verifying SC-001 through SC-005).
