# Parallel Execution Plan: Categorize Integrations by Functional Domain

**Feature**: `005-categorize-integrations`  
**Implementation repository**: `rayedbajwa/spaces` (`/data/aidlc/workspaces/rayedbajwa/spaces`)  
**Governance repository**: `governance` (`/data/aidlc/workspaces/_governance/spaces-3f701200` — feature artifacts only, no runtime code)  
**Source**: [tasks.md](tasks.md) · [plan.md](plan.md) · [spec.md](spec.md) · [test-plan.md](test-plan.md) · [contracts/categorized-integrations.md](contracts/categorized-integrations.md) · [quickstart.md](quickstart.md)  
**Status**: Ready for implementation — tasks T001–T022 defined.

---

## Scope Note & Architecture

This feature reorganizes external integrations and OAuth provider credentials across both the organization management view (`/organization?section=integrations`) and the top-navigation read-only status modal into three canonical functional categories:
1. **Source Control** (`source_control`): GitHub
2. **Project Management** (`project_management`): Jira, Linear, Confluence
3. **Message Channels / Communication** (`communication`): Slack

### Key Constraints & Blast Radius
- **Zero Database Changes**: No database schema migrations or data migrations. Categorization is deterministic metadata.
- **Zero API Breakages**: Existing REST endpoints (`GET /api/oauth-apps`, `GET /api/integrations`, `DELETE /api/integrations/:kind`) remain 100% backward compatible.
- **Strict File Isolation**: Tasks are partitioned across disjoint files so parallel workstreams can proceed without git merge conflicts:
  - Workstream 1: `src/lib/integration-categories.ts` and `tests/integration-categories.test.ts`
  - Workstream 2: `src/web/styles.css`
  - Workstream 3: `src/web/integrations.tsx` and `src/web/shell.tsx`
  - Workstream 4: `docs/concepts/organization-teams-and-access.md` and verification runs

---

## Workstream 1: Central Taxonomy Domain and Unit Verification

### Repository

rayedbajwa/spaces

### Tasks

- **Task IDs**: T002, T003, T005, T009, T012
- T002 `[P]`: Create unit test suite in `tests/integration-categories.test.ts` covering TC-CAT-001…TC-CAT-004 (canonical ordering `source_control`, `project_management`, `communication`, provider exhaustiveness, kind exhaustiveness, unknown provider/kind handling) and TC-STAT-001…TC-STAT-005 (status calculation permutations: empty, configured_unconnected, partial, connected, needs_reconnect). Run `bun test tests/integration-categories.test.ts` and confirm failure before implementation.
- T003: Implement centralized categorization module in `src/lib/integration-categories.ts` exporting `IntegrationCategoryId`, `CategoryReadinessState`, `IntegrationCategoryDefinition`, `CategoryStatusSummary`, `INTEGRATION_CATEGORIES`, `getCategoryForProvider`, `getCategoryForKind`, and `calculateCategoryStatus`. Confirm unit tests pass.
- T005 `[P]` `[US1]`: Add component and taxonomy mapping verification tests in `tests/integration-categories.test.ts` ensuring all provider apps (`github`, `atlassian`, `linear`, `slack`) map to their respective category containers without orphaned items.
- T009 `[P]` `[US2]`: Add unit test assertions in `tests/integration-categories.test.ts` verifying the read-only contract (confirming non-admin and `readOnly: true` configurations suppress credential management and mutation controls).
- T012 `[P]` `[US3]`: Add unit tests in `tests/integration-categories.test.ts` verifying empty state determination, reconnect-needed detection (`credentialsOk: false`), and category badge text generation across all permutations.

**Proposed sub-agent assignment**: Taxonomy & Unit Test Engineer.

### Inputs

- `specs/005-categorize-integrations/spec.md` (FR-001, FR-002, FR-004, FR-007, FR-008, FR-009).
- `specs/005-categorize-integrations/contracts/categorized-integrations.md` (§ 1 Domain Module Interface).
- `specs/005-categorize-integrations/data-model.md` (§ Taxonomy, Entities, and Status Model).
- Existing `src/lib/oauth.ts` (`OAUTH_PROVIDER_IDS`) and `src/lib/app-integrations.ts` (`AppIntegrationKind`).

### Outputs

- New module `src/lib/integration-categories.ts` exporting the canonical taxonomy and status calculation functions.
- Exhaustive unit test suite in `tests/integration-categories.test.ts` passing green.
- **Merge Checkpoint A**: Domain taxonomy and unit verification green; exports available for UI consumption.

### Dependencies

- **Blocked by**: T001 baseline verification check.
- **Can run in parallel with**: Workstream 2 (CSS styling).
- **Blocks**: Workstream 3 (UI component implementation requires types and functions from `src/lib/integration-categories.ts`).

### Scoped Files

- `src/lib/integration-categories.ts`
- `tests/integration-categories.test.ts`

Do **not** modify `src/web/`, `docs/`, `Dockerfile`, or database schema files.

### QA Focus

- Canonical ordering must strictly be: `source_control` → `project_management` → `communication`.
- Provider exhaustiveness: `github`, `atlassian`, `slack`, `linear` each belong to exactly one category.
- Kind exhaustiveness: `github`, `jira`, `confluence`, `slack`, `linear` each map to their expected domain; `jira` and `confluence` both map to `project_management`.
- Fail-safe handling: `getCategoryForProvider` and `getCategoryForKind` must safely return `undefined` for unexpected strings without throwing.
- Status calculation permutations:
  - Empty: 0 apps and 0 connections → `empty` (`Not connected`, variant `idle`).
  - Configured but not connected: app setup present → `configured_unconnected` (`App set up`, variant `idle`).
  - Partial: subset of kinds connected → `partial` (`N connected`, variant `completed`).
  - Fully connected: all kinds connected → `connected` (`Connected`, variant `completed`).
  - Reconnect priority: any kind with `credentialsOk === false` takes precedence → `needs_reconnect` (`Reconnect needed`, variant `error`).

---

## Workstream 2: Category Layout and Visual Styling

### Repository

rayedbajwa/spaces

### Tasks

- **Task IDs**: T004, T007, T014
- T004 `[P]`: Add base category layout and badge styling classes (`.integration-category`, `.integration-category-header`, `.integration-category-empty`, `.category-badge`) in `src/web/styles.css`.
- T007 `[US1]`: Update category card layout and grid styles in `src/web/styles.css` ensuring clean card positioning and responsive vertical wrapping on narrow viewports.
- T014 `[US3]`: Add empty-state card and category badge variant styling (`.category-badge-completed`, `.category-badge-error`, `.category-badge-idle`, `.integration-category-empty`) in `src/web/styles.css`.

**Proposed sub-agent assignment**: UI / CSS Styling Specialist.

### Inputs

- `specs/005-categorize-integrations/contracts/categorized-integrations.md` (§ 2 UI Component Contract).
- `specs/005-categorize-integrations/spec.md` (FR-003, FR-004, FR-007).
- Existing `src/web/styles.css` baseline styling for `.integration`, `.card`, and `.mini-badge`.

### Outputs

- Complete CSS rules in `src/web/styles.css` providing category section grouping, category header typography, badge variant color coding, empty-state card presentation, and responsive flex/grid layouts.
- **Merge Checkpoint B**: Styles compiled and visually defined; classes ready for consumption by React components.

### Dependencies

- **Blocked by**: T001 baseline verification check.
- **Can run in parallel with**: Workstream 1 (disjoint files).
- **Blocks**: Visual styling aspects of Workstream 3.

### Scoped Files

- `src/web/styles.css`

Do **not** modify `src/lib/`, `src/web/*.tsx`, `tests/`, or `docs/`.

### QA Focus

- Visual hierarchy: category headers (`<h3>`) and summary badges must clearly separate domains without overwhelming the card content.
- Badge color variants: completed (green/teal accent), error (warning/red accent for reconnects), and idle (muted neutral).
- Responsive behavior: category cards must flex-wrap or grid-align cleanly on mobile viewports (<768px) and wide desktop viewports (>1200px) without horizontal clipping.
- Regression safety: existing `.card` and `.integration` styling classes must remain functional for setup forms and credential inputs.

---

## Workstream 3: Categorized UI Panels and Component Views

### Repository

rayedbajwa/spaces

### Tasks

- **Task IDs**: T006, T008, T010, T011, T013, T015
- T006 `[US1]`: Refactor `IntegrationsPanel` in `src/web/integrations.tsx` to iterate over `INTEGRATION_CATEGORIES`, rendering category sections with headers, descriptions, and provider cards (`github` under Source Control; `atlassian` and `linear` under Project Management; `slack` under Message Channels / Communication) while preserving `editing`, `SetupForm`, `connect()`, and `disconnect()` actions.
- T008 `[US1]`: Verify organization integrations management view end-to-end by running `bun run build:web` and inspecting `/organization?section=integrations` in `src/web/integrations.tsx` to confirm category section rendering, provider grouping, and interactive controls.
- T010 `[US2]`: Update `IntegrationsPanel` in `src/web/integrations.tsx` to support read-only mode across categories when `readOnly === true`, hiding credential configuration forms, setup buttons, and disconnect actions while rendering clean connection status badges and display names.
- T011 `[US2]`: Verify top navigation integration chip and modal dialog interactions in `src/web/shell.tsx` and `src/web/integrations.tsx` ensuring the modal opens the categorized read-only view while maintaining the aggregate status counter on the top strip.
- T013 `[US3]`: Implement category status summary badges and empty-state guidance cards in `src/web/integrations.tsx` using `calculateCategoryStatus()` and `category.emptyGuidance`, providing setup call-to-actions in management mode and informational guidance in read-only mode.
- T015 `[US3]`: Verify category health badge transitions and empty states end-to-end in `src/web/integrations.tsx` (simulating 0 connected services, partial connectivity, and invalid credential reconnect alerts).

**Proposed sub-agent assignment**: Frontend React Engineer.

### Inputs

- Merge Checkpoint A (Workstream 1 exports from `src/lib/integration-categories.ts`).
- Merge Checkpoint B (Workstream 2 styling classes from `src/web/styles.css`).
- Existing `src/web/integrations.tsx` and `src/web/shell.tsx`.
- `contracts/categorized-integrations.md` (§ 2 UI Component Contract, § 3 Top Navigation Status Contract).

### Outputs

- Refactored `IntegrationsPanel` in `src/web/integrations.tsx` rendering categorized domains with full management controls (admin mode) and clean read-only inspection (modal mode).
- Integration modal wiring verified in `src/web/shell.tsx`.
- Successful web asset bundle compilation (`bun run build:web`).
- **Merge Checkpoint C**: Interactive React UI fully categorized and validated against User Stories 1, 2, and 3.

### Dependencies

- **Blocked by**: Merge Checkpoint A (domain module exports) and Merge Checkpoint B (CSS classes).
- **Can run in parallel with**: Workstream 4 (documentation task T016).
- **Blocks**: Final end-to-end system verification (T017–T019).

### Scoped Files

- `src/web/integrations.tsx`
- `src/web/shell.tsx`

Do **not** modify `src/lib/integration-categories.ts`, `src/web/styles.css`, `tests/`, or backend API endpoints.

### QA Focus

- Category ordering: strictly Source Control → Project Management → Message Channels / Communication.
- Administrative controls: OAuth `SetupForm`, credential secrets, `connect()` redirect triggers, and `disconnect()` confirmations must operate identically to legacy behavior.
- Read-only protection: when `readOnly === true`, secret fields, edit buttons, and disconnect buttons must NOT be present in the DOM.
- Multiprovider presentation: Atlassian card correctly displays Jira and Confluence child rows under Project Management.
- Top strip chip: aggregate counter `Integrations X/Y` in `src/web/shell.tsx` remains functional and clicking it opens the modal dialog with `<IntegrationsPanel readOnly />`.

---

## Workstream 4: Documentation and System Integration Verification

### Repository

rayedbajwa/spaces

### Tasks

- **Task IDs**: T016, T017, T018, T019
- T016 `[P]`: Update documentation in `docs/concepts/organization-teams-and-access.md` describing the three functional integration categories (Source Control, Project Management, and Message Channels / Communication).
- T017: Run `bun run typecheck` to ensure zero TypeScript errors across `src/lib/integration-categories.ts`, `src/web/integrations.tsx`, and `tests/integration-categories.test.ts`.
- T018: Run `bun run build:web` via `src/build-web.ts` to verify client-side bundle compilation succeeds with zero warnings.
- T019: Execute full test suite via `bun test` and validate all quickstart scenarios in `specs/005-categorize-integrations/quickstart.md`.

**Proposed sub-agent assignment**: Documentation & QA Release Engineer.

### Inputs

- Merge Checkpoint A, B, and C (all domain logic, CSS styles, and UI components landed).
- `docs/concepts/organization-teams-and-access.md`.
- `specs/005-categorize-integrations/quickstart.md`.
- `specs/005-categorize-integrations/test-plan.md`.

### Outputs

- Updated concept documentation reflecting the three categories and their roles in the SDLC.
- Clean TypeScript verification (`bun run typecheck`).
- Production-ready web assets in `public/` (`bun run build:web`).
- Clean test suite execution evidence across all unit and smoke tests (`bun test`).
- **Merge Checkpoint D**: All code, styles, docs, and automated verification suites passing green.

### Dependencies

- **Blocked by**: T016 can proceed once taxonomy definition is established (Checkpoint A); T017–T019 require Checkpoints A, B, and C to be merged.
- **Can run in parallel with**: T016 in parallel with UI work; T017–T019 sequential at the end.
- **Blocks**: Phase 7 Delivery.

### Scoped Files

- `docs/concepts/organization-teams-and-access.md`

Read-only execution allowed on repository build and test targets (`bun run typecheck`, `bun run build:web`, `bun test`). Do **not** modify application code files.

### QA Focus

- Documentation accurately describes each category and which external tools belong to it.
- Full type-safety verification with no `any` casts or unhandled null/undefined branches.
- Bundle size and build performance: `build:web` generates valid client assets without regressions.
- Regression verification: existing integration tests (`tests/smoke.test.ts`, `tests/oauth.test.ts`, `tests/integration-token.test.ts`) must pass without error.

---

## Sequential Work and Merge Checkpoints

The following tasks and phase transitions **MUST remain sequential**:

1. **T001 (Phase 1 Setup Baseline)**: Must be executed first to verify that the branch is clean, `bun run typecheck` succeeds, and `bun test tests/smoke.test.ts` passes before introducing changes.
2. **Within Workstream 1 (Red-to-Green Test Discipline)**: T002 unit tests must be written and confirmed to **FAIL** before T003 implements `src/lib/integration-categories.ts`.
3. **Foundational Checkpoint (Merge Checkpoints A & B)**:
   - Workstream 1 (domain module) and Workstream 2 (base CSS) must both reach their merge checkpoints before Workstream 3 (React UI) can begin.
   - UI code depends on types, constants, and helper functions exported by `src/lib/integration-categories.ts` and CSS class names defined in `src/web/styles.css`.
4. **Within Workstream 3 (User Story Increments)**:
   - T006 (US1 Admin Panel refactoring) establishes the categorized markup structure.
   - T010 (US2 read-only branch) and T013 (US3 badges/empty-state rendering) build directly upon that structure and must be applied sequentially or in coordinated commits.
5. **System Validation (T017–T019)**:
   - Must run after Workstream 1, 2, 3, and T016 have merged.
   - Type check (`T017`), web bundle build (`T018`), and full test suite (`T019`) guarantee integration integrity.
6. **Delivery Phase (T020–T022)**:
   - **T020**: Open pull request for `005-categorize-integrations` in `rayedbajwa/spaces`.
   - **T021**: Verify CI check-runs pass and obtain human review approval before merging.
   - **T022**: Confirm deployment pipeline succeeds and execute post-deploy acceptance verification.
   - **Strictly sequential and human-gated**: Merging a PR and deploying require human authorization per AIDLC Directives.

---

## QA Coordination Notes

- **No Database Migrations or Data Mutating Operations**:
  - The feature operates purely on deterministic metadata and in-memory status aggregation.
  - Test runs and local verification must never execute database migrations or mutate existing organization records.
- **Provider Secrets & Credentials Protection**:
  - All test cases and assertions must use mock or dummy credential representations (`configured: true`, `credentialsOk: false`).
  - Never log, commit, or display OAuth client secrets or integration tokens in test output or console messages.
- **CI Pipeline Stability**:
  - In accordance with Organization Memory ("CI update is not necessary as long as its working as expected"), **do not modify CI configuration files** (`.github/workflows/*.yml`).
  - Per Organization Memory, E2E tests requiring live third-party keys are ignored; verification relies on unit tests, mock state assertions, and client bundle compilation.
- **Port Allocation**:
  - If a local test server is booted for smoke testing or Playwright inspection, use `PORT=3100` (`http://127.0.0.1:3100`). Port 3000 is reserved for the agent runtime environment and must never be bound.
- **File Exclusivity**:
  - Each workstream strictly owns its scoped files. No two sub-agents may simultaneously edit the same source file.

---

## Concurrency Recommendation

**Safe concurrency: 2 concurrent workstreams.**

1. **Foundational Phase (Phase 2)**:
   - Run **Workstream 1** (Taxonomy Domain & Tests) and **Workstream 2** (CSS Layout & Styles) in parallel.
   - They touch completely disjoint files (`src/lib/` + `tests/` vs `src/web/styles.css`) and have zero overlapping merge surface.
2. **Implementation & Documentation Phase (Phases 3–6)**:
   - Once Merge Checkpoints A and B are met, run **Workstream 3** (React UI implementation in `src/web/integrations.tsx`) concurrently with **Workstream 4's documentation task** (T016 in `docs/concepts/organization-teams-and-access.md`).
   - Workstream 3 sequentially progresses through US1 → US2 → US3 within `src/web/integrations.tsx` to prevent internal React JSX merge collisions.
3. **Validation & Delivery Phase**:
   - Workstream 4's validation checks (T017 typecheck, T018 build, T019 test suite) and delivery tasks (T020–T022) must run sequentially as a single thread.

Attempting more than 2 concurrent workstreams is unnecessary for this scoped feature slice and would introduce file collision risks on `src/web/integrations.tsx`. A 2-workstream concurrency profile provides optimal throughput while ensuring zero integration conflicts.
