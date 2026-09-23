# Test Plan: Categorize Integrations by Functional Domain

**Branch**: `005-categorize-integrations` | **Date**: 2026-09-23 | **Spec**: [spec.md](spec.md)

## 1. Overview & Objectives

This test plan validates that Spaces cleanly groups integrations into three canonical functional domains (**Source Control**, **Project Management**, and **Message Channels / Communication**) across both administrative and read-only views, while preserving 100% of existing authentication, credential management, and connection workflows.

---

## 2. Requirements to Test Matrix

| Req ID | Requirement Summary | Verification Strategy | Target Test File / Location |
|---|---|---|---|
| **FR-001** | Three canonical categories defined (`source_control`, `project_management`, `communication`) | Unit test asserting taxonomy schema, labels, and descriptions | `tests/integration-categories.test.ts` |
| **FR-002** | Every provider and kind classified into exactly one primary category | Unit test checking exhaustiveness against `OAUTH_PROVIDER_IDS` and `AppIntegrationKind` | `tests/integration-categories.test.ts` |
| **FR-003** | Organization integrations view renders 3 distinct category sections | Component test / Web build check | `tests/integration-categories.test.ts`, `src/web/integrations.tsx` |
| **FR-004** | Category sections display title, blurb, and aggregate status badge | Unit tests for `calculateCategoryStatus()` covering all status permutations | `tests/integration-categories.test.ts` |
| **FR-005** | Read-only modal groups integrations by category with read-only badges | Component verification in read-only mode | `src/web/integrations.tsx` |
| **FR-006** | Management actions (setup app, connect, disconnect) remain functional | Regression verification of API endpoints and action handlers | `tests/oauth.test.ts`, `tests/integration-token.test.ts` |
| **FR-007** | Empty state rendered when category has no connected services | Unit tests asserting empty state logic and UI rendering | `tests/integration-categories.test.ts` |
| **FR-008** | Atlassian displays both Jira and Confluence under Project Management | Unit & structure test asserting sub-service grouping | `tests/integration-categories.test.ts` |
| **FR-009** | Centralized category metadata definition | Unit test confirming all UI surfaces consume `integration-categories.ts` | `tests/integration-categories.test.ts` |
| **FR-010** | Top navigation status counter and modal trigger preserved | Typecheck & component verification of `TopStrip` | `tests/smoke.test.ts` |

---

## 3. Test Cases Specification

### Suite 1: Category Taxonomy & Mappings (`tests/integration-categories.test.ts`)

- **TC-CAT-001: Canonical Categories Ordering & Definitions**
  - Verify `INTEGRATION_CATEGORIES` contains exactly 3 categories in order: `source_control`, `project_management`, `communication`.
  - Verify each category contains non-empty `id`, `label`, `description`, `emptyGuidance`, `providers`, and `kinds`.
- **TC-CAT-002: Provider Exhaustiveness**
  - Verify every entry in `OAUTH_PROVIDER_IDS` (`github`, `atlassian`, `slack`, `linear`) belongs to exactly one category.
  - Verify no duplicate provider across categories.
- **TC-CAT-003: Kind Exhaustiveness**
  - Verify all kinds (`github`, `jira`, `confluence`, `slack`, `linear`) map to exactly one category.
  - Verify `jira` and `confluence` both map to `project_management`.
  - Verify `github` maps to `source_control`.
  - Verify `slack` maps to `communication`.
- **TC-CAT-004: Unknown Provider / Kind Graceful Handling**
  - Verify `getCategoryForProvider('unknown')` returns undefined without throwing.
  - Verify `getCategoryForKind('unknown')` returns undefined without throwing.

### Suite 2: Status Calculation & Aggregation (`tests/integration-categories.test.ts`)

- **TC-STAT-001: Empty / Unconfigured Category**
  - Given an empty category with 0 apps and 0 connections,
  - Expected: `state: 'empty'`, `summaryBadge: 'Not connected'`, `badgeVariant: 'idle'`.
- **TC-STAT-002: App Configured but No Services Connected**
  - Given an app configured (`configured: true`) with 0 connected kinds,
  - Expected: `state: 'configured_unconnected'`, `summaryBadge: 'App set up'`, `badgeVariant: 'idle'`.
- **TC-STAT-003: Partial Connectivity in Multi-Service Category**
  - Given Project Management with Jira connected (`status: 'connected'`, `credentialsOk: true`) and Linear not connected,
  - Expected: `state: 'partial'`, `connectedKinds: 1`, `totalKinds: 3`, `summaryBadge: '1 connected'`, `badgeVariant: 'completed'`.
- **TC-STAT-004: All Services Connected**
  - Given Source Control with GitHub connected (`status: 'connected'`, `credentialsOk: true`),
  - Expected: `state: 'connected'`, `connectedKinds: 1`, `totalKinds: 1`, `summaryBadge: 'Connected'`, `badgeVariant: 'completed'`.
- **TC-STAT-005: Reconnect Needed Priority**
  - Given a category with one connected kind and another kind with `credentialsOk: false`,
  - Expected: `state: 'needs_reconnect'`, `reconnectNeededCount: 1`, `summaryBadge: 'Reconnect needed'`, `badgeVariant: 'error'`.

### Suite 3: UI & Build Verification

- **TC-UI-001: TypeScript Type Safety**
  - Command: `bun run typecheck`
  - Expected: 0 type errors across `src/lib/integration-categories.ts`, `src/web/integrations.tsx`, and all consumers.
- **TC-UI-002: Frontend Asset Bundling**
  - Command: `bun run build:web`
  - Expected: Bundle succeeds with 0 errors and generates valid ES module assets.
- **TC-UI-003: Full Test Suite Regression**
  - Command: `bun test`
  - Expected: All test suites pass without regression.

---

## 4. Acceptance Criteria Checklist

- [ ] All 3 canonical categories are defined with descriptive blurbs and empty guidance.
- [ ] GitHub maps to Source Control; Jira, Confluence, Linear map to Project Management; Slack maps to Message Channels / Communication.
- [ ] Organization page renders 3 distinct category sections with headers and badges.
- [ ] Modal dialog renders 3 distinct category sections in read-only mode.
- [ ] Connect, disconnect, and app setup operations work without regression.
- [ ] Zero database migrations required.
