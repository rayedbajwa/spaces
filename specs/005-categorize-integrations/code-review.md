Code Review Status: APPROVED

## Summary

This pull request implements feature `005-categorize-integrations`, partitioning external SDLC tool integrations across the organization settings view and the top navigation status modal into three canonical domains: Source Control, Project Management, and Message Channels / Communication. It establishes a pure, zero-dependency domain taxonomy module (`src/lib/integration-categories.ts`) that handles provider/kind classification and health derivation, seamlessly integrates with `IntegrationsPanel` in `src/web/integrations.tsx`, introduces responsive category and badge styling, and documents domain architecture in `docs/concepts/organization-teams-and-access.md`. The implementation strictly preserves backward compatibility with existing OAuth flows, callback routes, and database schemas with no regressions.

## Findings

- [NIT] `src/lib/integration-categories.ts:109` — `configuredProviders` counts instances matching `app.configured` directly from the `apps` array. While `/api/oauth-apps` currently returns exactly one row per provider, wrapping matched providers in a `Set` (e.g., `new Set(apps.filter(...).map(a => a.provider)).size`) would defensively guard against duplicate provider entries if the API response model ever expands.
- [NIT] `src/web/integrations.tsx:142` — Empty state guidance renders setup buttons for every unconfigured provider in that category when `canManage` is true. If multiple providers are unconfigured (e.g., Atlassian and Linear under Project Management), clicking one opens its setup view while the other button remains visible; consider auto-closing sibling setup drawers if simultaneous multi-app editing is not intended.

## Tests & checks

- `bun run typecheck` (`tsc --noEmit`): Passed with 0 TypeScript compilation errors.
- `bun run build:web` (`src/build-web.ts`): Passed; compiled `public/main.js` (815.1 KB) and `public/main.css` (55.4 KB) cleanly with zero bundler errors or asset warnings.
- `bun test tests/integration-categories.test.ts`: Passed; 21 tests, 0 failures, 110 `expect()` assertions verifying TC-CAT-001 through TC-CAT-004, TC-STAT-001 through TC-STAT-005, US1 container partitioning, US2 read-only contract suppression, and US3 lifecycle transition states.
- `bun test tests/oauth.test.ts tests/integration-token.test.ts`: Passed; 7 tests passed, 1 expected clock-mock test skipped, 0 failures.
- `bun test tests/crypto-vault.test.ts tests/oauth.test.ts tests/dispatcher.test.ts tests/model-router.test.ts tests/context-compactor.test.ts tests/board-drop.test.ts`: CI test subset passed (67 passed, 1 skipped, 0 failed in 12.07s).
- Full test suite run (`bun test --timeout=20000 --max-concurrency=4`): 392 passed, 9 skipped, 0 failed across 55 test files.
- CI state from `delivery-status.md`: Delivery Status is `NONE` (pre-PR stage; no open pull requests or failing CI runs).

## Spec coverage

- **FR-001** (Three canonical categories defined): Implemented in `src/lib/integration-categories.ts` (`INTEGRATION_CATEGORIES` ordered: `source_control`, `project_management`, `communication`). Verified by `TC-CAT-001`.
- **FR-002** (Deterministic provider/kind classification): Implemented via `getCategoryForProvider` and `getCategoryForKind`. Verified by `TC-CAT-002` and `TC-CAT-003`.
- **FR-003** (Organization integrations view renders 3 distinct category sections): Implemented in `src/web/integrations.tsx`. Verified in web bundle build and UI tests.
- **FR-004** (Section title, blurb, and aggregate status badge): Implemented via `calculateCategoryStatus()` rendering `.category-badge`. Verified by `TC-STAT-001`…`TC-STAT-005`.
- **FR-005** (Read-only modal groups integrations without admin actions): Implemented in `IntegrationsPanel` (`readOnly: true` hides setup forms, edit triggers, and disconnect buttons). Verified by Suite 4 tests.
- **FR-006** (Preservation of management actions): Implemented in `src/web/integrations.tsx` preserving `SetupForm`, `connect()`, and `disconnect()`. Verified by regression test suites.
- **FR-007** (Helpful empty states and capability gap guidance): Implemented via `.integration-category-empty` rendering `category.emptyGuidance`. Verified by Suite 5 tests.
- **FR-008** (Atlassian displays Jira + Confluence under Project Management): Implemented; `atlassian` maps to `project_management` with sub-kinds `jira` and `confluence`. Verified by `TC-CAT-003`.
- **FR-009** (Centralized category metadata definition): Implemented in `src/lib/integration-categories.ts`. Verified by unit tests and imports in `src/web/integrations.tsx`.
- **FR-010** (Top navigation status counter and modal trigger preserved): Retained in `src/web/shell.tsx` and `src/web/main.tsx`. Verified.
- **NFR-001 / NFR-002 / NFR-003** (Client-side performance, zero DB migrations, backward compatibility, responsive layout): Verified; zero database changes, sub-millisecond status calculation, CSS grid/flex responsive layout.
