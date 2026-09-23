# Implementation Plan: Categorize Integrations by Functional Domain

**Branch**: `005-categorize-integrations` | **Date**: 2026-09-23 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification to categorize all integrations and OAuth providers into three functional SDLC domains: Source Control, Project Management, and Message Channels / Communication.

## Summary

Currently, Spaces presents all external integrations and OAuth provider credentials in a flat, un-categorized list. This feature organizes all integrations across both the organization management view (`/organization?section=integrations`) and the top-navigation read-only status modal into three standard functional categories:
1. **Source Control**: GitHub (repositories, branch tracking, pull requests, Git sign-in)
2. **Project Management**: Jira, Linear, Confluence (issue tracking, initiatives, specification docs, and knowledge base ingestion)
3. **Message Channels / Communication**: Slack (project channels, stage summaries, and human-in-the-loop review alerts)

The technical approach introduces a centralized domain module (`src/lib/integration-categories.ts`) that standardizes the taxonomy, provider/kind mappings, and category status calculation logic. The React UI in `src/web/integrations.tsx` is structured to iterate over the canonical categories, rendering category headers, explanatory blurbs, aggregate readiness badges, dedicated empty states, and provider cards with sub-service statuses. All existing OAuth flows, setup manifests, credential forms, and disconnect operations remain 100% backward compatible without any database schema changes.

## Repositories

- `rayedbajwa/spaces` — application code (`src/lib/integration-categories.ts`, `src/web/integrations.tsx`, `src/web/styles.css`), unit test suite (`tests/integration-categories.test.ts`), and web bundle build.
- `governance` — feature specification, plan, research, data-model, interface contracts, quickstart, and test-plan artifacts only; no runtime code changes.

## Technical Context

**Language/Version**: TypeScript 5.9 on Bun 1.4+  
**Primary Dependencies**: React 18, React DOM, vanilla CSS (`src/web/styles.css`)  
**Storage**: PostgreSQL 16 (via Bun `postgres` library) — **No database schema migration required** (category assignment is deterministic metadata)  
**Testing**: Bun test runner (`bun test`) plus Playwright headless browser check  
**Target Platform**: Linux server / Web SPA (Bun HTTP server)  
**Project Type**: Web application (SDLC orchestrator SPA + REST API)  
**Performance Goals**: Instant client-side grouping (<16ms render), zero backend database queries added  
**Constraints**: 100% backward compatibility for all existing OAuth flows, callback URLs, and API contracts; fail-safe fallback for unexpected kinds; responsive layout  
**Scale/Scope**: 3 canonical categories, 4 supported OAuth providers, 5 integration kinds, across 2 UI views (Organization page tab + modal dialog)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- [x] Specification has a problem statement, acceptance scenarios, and measurable success criteria.
- [x] Repositories and cross-repository contracts are named above.
- [x] Security, authorization, tenant boundaries, auditability, and data protection impacts are addressed.
- [x] State changes have an idempotent migration, rollback, or repair path.
- [x] Test planning maps changed behavior, security boundaries, migrations, and failure modes to verification.
- [x] Parallel work, if used, has machine-readable workstreams and merge checkpoints.

Evidence:
- **Problem statement & acceptance**: `spec.md` details problem statement, User Stories 1–3, edge cases, and Measurable Outcomes SC-001…SC-005.
- **Repositories & contracts**: `rayedbajwa/spaces` and `governance` named above. Interface contracts defined in `contracts/categorized-integrations.md`.
- **Security & tenant boundaries**: Role-based access control is fully preserved: only organization owners and admins can configure credentials, connect, or disconnect tools (`requireOrgAdmin`), while all authenticated members can view categorized read-only statuses. No tokens or secrets are exposed or logged.
- **State changes & rollback**: **Zero database schema changes and zero data migrations**. Category membership is computed dynamically from existing provider and kind keys. Rollback is trivial and instantaneous by reverting UI rendering.
- **Test planning**: `test-plan.md` maps FR-001…FR-010 to unit tests (`tests/integration-categories.test.ts`), type checking, and bundle validation.
- **Parallel work**: The work represents a clean vertical slice suitable for single-pass implementation or isolated frontend/backend test tasks.

## Architecture and Component Plan

1. **Centralized Category Taxonomy (`src/lib/integration-categories.ts`)**:
   - Define canonical categories: `source_control`, `project_management`, `communication`.
   - Map providers: `github` → `source_control`; `atlassian`, `linear` → `project_management`; `slack` → `communication`.
   - Map kinds: `github` → `source_control`; `jira`, `confluence`, `linear` → `project_management`; `slack` → `communication`.
   - Implement `calculateCategoryStatus(category, apps, connections)` computing `connectedKinds`, `configuredProviders`, `needsReconnect`, and human-readable badges.
2. **UI Categorization & Presentation (`src/web/integrations.tsx`)**:
   - Refactor `IntegrationsPanel` to render categories in canonical order.
   - For each category:
     - Render category section header with category label, status badge, and descriptive blurb.
     - If empty (no apps configured): render an informative empty-state card with call-to-action buttons (management mode) or empty notice (read-only mode).
     - Render provider cards belonging to that category, preserving existing `SetupForm`, OAuth connect button, reconnect alerts, and kind-level disconnect buttons.
3. **Responsive Styling (`src/web/styles.css`)**:
   - Add styling rules for `.integration-category`, `.integration-category-header`, `.integration-category-empty`, and category badges.
4. **Verification Suite (`tests/integration-categories.test.ts`)**:
   - Exhaustive tests verifying mapping completeness, edge case handling, and status derivation permutations.
   - Run `bun run typecheck` and `bun run build:web` to guarantee clean bundling.

## Project Structure

### Documentation (this feature)

```text
specs/005-categorize-integrations/
├── plan.md                                  # Implementation plan
├── research.md                              # Phase 0 decisions & alternatives
├── data-model.md                            # Phase 1 data entities and taxonomy
├── quickstart.md                            # Phase 1 developer and verification guide
├── contracts/
│   └── categorized-integrations.md          # Phase 1 interface and UI contracts
├── test-plan.md                             # Test matrix and acceptance verification
└── checklists/
    └── requirements.md                      # Quality checklist
```

### Source Code (rayedbajwa/spaces)

```text
src/
├── lib/
│   └── integration-categories.ts            # Central category definitions, mappings, and status logic
└── web/
    ├── integrations.tsx                     # Categorized IntegrationsPanel component
    └── styles.css                           # Category layout, header, badge, and empty-state styling

tests/
└── integration-categories.test.ts           # Unit tests for taxonomy, mapping, and status calculations
```

**Structure Decision**: A pure domain module in `src/lib/` ensures category metadata is universally accessible to both browser bundles and server/test runtimes. The UI component in `src/web/integrations.tsx` consumes this taxonomy directly, ensuring zero drift between management and inspection views.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

*No violations. All constitution gates pass.*
