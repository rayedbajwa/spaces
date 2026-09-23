# Research: Categorize Integrations by Functional Domain

**Branch**: `005-categorize-integrations` | **Date**: 2026-09-23 | **Spec**: [spec.md](spec.md)

## Decisions

### 1. Centralized Category Taxonomy Module

**Decision**: Introduce a dedicated, dependency-free domain module `src/lib/integration-categories.ts` defining canonical categories, metadata, provider/kind mappings, and category status calculation helpers.

**Rationale**:
- FR-001, FR-002, and FR-009 require standard category definitions that are shared and consistent across all inspection surfaces (organization management page, top navigation status modal, and any future wizard/onboarding flows).
- `src/build-web.ts` uses Bun's browser bundler, which can import pure TypeScript utility modules from `src/lib/` (as already done with `src/lib/intent-scope.ts` and `src/lib/board-drop.ts`).
- By keeping `integration-categories.ts` pure and free of Node/Postgres runtime imports, both the server API handlers and React client components can consume the exact same taxonomy without divergence.

**Alternatives considered**:
- *Hardcoding categories inside `src/web/integrations.tsx`*: Rejected because it duplicates business logic, prevents backend verification, and violates FR-009 requiring central definition.
- *Adding a database table `integration_categories` with schema migrations*: Rejected because the set of SDLC domains and supported integrations is deterministic, code-governed, and does not require runtime administrative category customization. A database table would add unneeded migration overhead and complexity without user benefit.

---

### 2. Standard Three-Category Taxonomy and Mapping

**Decision**: Define exactly three canonical categories in fixed display order:
1. `source_control`: **Source Control**
2. `project_management`: **Project Management**
3. `communication`: **Message Channels / Communication**

Mapping of supported providers and integration kinds:
- **Source Control (`source_control`)**:
  - Providers: `github`
  - Kinds: `github`
  - Blurb: "Repository catalog, cloning, branch synchronization, pull request generation, and Git sign-in."
  - Empty Guidance: "Connect source control so autonomous agents can clone repositories, inspect codebase structure, and deliver verified pull requests."
- **Project Management (`project_management`)**:
  - Providers: `atlassian`, `linear`
  - Kinds: `jira`, `confluence`, `linear`
  - Blurb: "Issue tracking, sprint planning, project initiatives, and specification documents for agent context and knowledge base ingestion."
  - Empty Guidance: "Connect project management tools to link specs with active issues, sync initiatives, and ingest product knowledge."
- **Message Channels / Communication (`communication`)**:
  - Providers: `slack`
  - Kinds: `slack`
  - Blurb: "Dedicated channels per project (#spaces-<code>) with run progress, verification summaries, and human-in-the-loop review alerts."
  - Empty Guidance: "Connect message channels to receive stage updates, review notifications, and pipeline approval gates directly in your team's chat."

**Rationale**:
- Directly fulfills FR-001 and FR-002.
- Unifies Atlassian (Jira + Confluence) and Linear cleanly under Project Management without creating an unnecessary single-purpose documentation category.
- Captures the exact core SDLC pillars required by teams.

**Alternatives considered**:
- *Creating a 4th "Documentation" category for Confluence*: Rejected because Atlassian provides Jira and Confluence under a single OAuth app registration. Splitting them across categories would fragment the single Atlassian OAuth credentials card and confuse users during app configuration.

---

### 3. Category Status Calculation & State Aggregation

**Decision**: Implement a pure helper function `calculateCategoryStatus(category, apps, connections)` returning a structured summary:
- `totalProviders`: Count of providers in this category.
- `configuredProviders`: Count of providers with credentials set up (`app.configured === true`).
- `totalKinds`: Count of distinct integration kinds belonging to this category.
- `connectedKinds`: Count of kinds with `status === 'connected'` and `credentialsOk !== false`.
- `reconnectNeededCount`: Count of kinds with `credentialsOk === false`.
- `state`:
  - `'needs_reconnect'`: At least one connection has expired or invalid credentials (`credentialsOk === false`).
  - `'connected'`: At least one service is active and connected. If all are connected, full readiness; if a subset is connected, partial readiness.
  - `'configured_unconnected'`: Provider credentials are configured, but no OAuth connection has been completed.
  - `'empty'`: No apps configured and no services connected.
- `summaryBadge`: String representation for UI badges (e.g. `"✓ Connected"`, `"✓ 1 connected"`, `"⚠ Reconnect needed"`, `"App set up"`, `"Not connected"`).

**Rationale**:
- Meets FR-004, FR-007, and SC-002 (instant visibility of health across all 3 domains).
- Enables clean rendering of category header badges without scattered inline conditional logic.
- Accurately conveys partial connectivity (e.g., Jira connected while Linear is not) as an active, healthy state rather than an error.

**Alternatives considered**:
- *Binary connected/disconnected badge*: Rejected because it masks reconnect alerts and fails to distinguish between "app not set up" vs "app set up but not connected".

---

### 4. UI Architecture & View Presentation

**Decision**: Refactor `src/web/integrations.tsx` to group provider cards by category, adding a category header, descriptive blurb, status badge, and dedicated empty-state card for unconfigured/unconnected categories.

- **Organization Settings (`canManage = true`)**:
  - Displays category sections in order: Source Control, Project Management, Communication.
  - For each category:
    - Section header with category name, summary badge, and description blurb.
    - If empty (no apps configured): render an informative empty state with a "Set up [Provider]" primary button.
    - Render cards for each provider in that category (GitHub, Atlassian, Linear, Slack).
    - Provide credential management (`SetupForm`), connection triggers, and disconnection buttons.
- **Top-Bar Read-Only Modal (`readOnly = true`)**:
  - Uses the same categorized layout and category headers.
  - Displays read-only badges, connected accounts/display names, and timestamps.
  - Replaces configuration/disconnection action buttons with read-only connection status text and empty state guidance.
- **Top Strip Indicator**:
  - Retains the global count (`Integrations X/Y` or `Integrations connected`) on the navigation bar chip (FR-010). Clicking it opens the categorized modal view.

**Rationale**:
- Ensures 100% DRY presentation between the administrative page and the inspection modal.
- Provides immediate visual alignment with the new domain-driven SDLC model.
- Preserves all existing OAuth setup, manifest callbacks, and credential editing flows without regression (FR-006, SC-003).

**Alternatives considered**:
- *Separate React components for modal vs management view*: Rejected because both views share 95% of the same rendering logic and state; using props `readOnly` and `embedded` keeps them synchronized.

---

### 5. Backward Compatibility and Zero-Migration Verification

**Decision**: Zero database migrations, zero API route breaking changes.

**Rationale**:
- Existing tables `oauth_apps` and `app_integrations` store data indexed by `provider` and `kind`.
- Category membership is derived deterministically from `provider` and `kind`.
- Existing routes (`/api/oauth-apps`, `/api/integrations`, `/api/integrations/:kind`, `/api/oauth/:provider/authorize`) require no changes to their request/response signatures.
- Reversibility is trivial and instant: if reverted, the UI simply renders the flat list again.

## Technical Findings

- `src/lib/oauth-apps.ts`: Defines `OAUTH_PROVIDER_IDS = ['github', 'atlassian', 'slack', 'linear']`.
- `src/lib/app-integrations.ts`: Defines `AppIntegrationKind = 'github' | 'jira' | 'confluence' | 'slack' | 'linear'`.
- `src/web/integrations.tsx`: Currently iterates flatly over `apps?.map(...)` without any grouping or category headers.
- `src/web/main.tsx`: Renders `<IntegrationsPanel readOnly />` in `isIntegrationsModalOpen`.
- `src/web/org-page.tsx`: Renders `<IntegrationsPanel embedded />` when `section === 'integrations'`.
- `src/web/shell.tsx`: Renders `TopStrip` with `integrationsConnected` and `integrationsTotal`.

## Test-Planning Implications

- **Unit tests** (`tests/integration-categories.test.ts`):
  - Category taxonomy completeness: every provider in `OAUTH_PROVIDER_IDS` and every kind in `AppIntegrationKind` maps to exactly one canonical category.
  - No orphaned providers or unknown kinds.
  - Status calculation logic for every permutation:
    - All connected
    - Partial connected
    - Needs reconnect
    - App configured but unconnected
    - Empty / unconfigured
- **Frontend bundling and build verification**:
  - `bun run build:web` must succeed with zero type errors.
  - `bun run typecheck` must pass.
- **E2E & smoke verification**:
  - Verify organization integrations page displays 3 category sections.
  - Verify modal displays 3 category sections with read-only badges.
  - Verify disconnect and connect buttons function properly.
