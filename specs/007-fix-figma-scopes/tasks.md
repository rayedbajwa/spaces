# Tasks: Fix Invalid Figma OAuth Scopes

**Input**: Design documents from `/specs/007-fix-figma-scopes/`
**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [quickstart.md](./quickstart.md)

**Repositories touched**: `rayedbajwa/spaces` (primary, `/data/aidlc/workspaces/rayedbajwa/spaces`). The `governance` workspace only hosts these Spec Kit artifacts.

**Tests**: Included — this is a security-boundary-adjacent change (OAuth consent), so verification is mandatory (not waived). No external keys are required for the automated gates; the live Figma consent flow is documented in `quickstart.md` but not run in CI (per Organization Memory: "E2E tests that require keys can be ignored").

**Organization**: A single user story (US1, P1). No parallel workstreams are required — this is a single-file source change plus one unit test.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm the working branch and baseline tooling (no new structure or dependencies).

- [X] T001 Check out branch `007-fix-figma-scopes` in `rayedbajwa/spaces` and confirm `bun install --frozen-lockfile` succeeds (no new dependencies are introduced by this feature)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Establish a green baseline before any change, and write the failing test first (red-green).

- [X] T002 Record a green baseline: run `bun run typecheck` and `bun test tests/oauth.test.ts` in `/data/aidlc/workspaces/rayedbajwa/spaces` and confirm they pass before editing
- [X] T003 [P] Add a failing unit test for the corrected Figma scope set in `tests/oauth.test.ts` — import `PROVIDER_TEMPLATES` from `../src/lib/oauth` and assert `PROVIDER_TEMPLATES.figma.scopes` deep-equals `['files:read']`, contains `files:read`, and does NOT contain `current_user:read`, `file_content:read`, `file_variables:read`, or any `file_read` id (maps to FR-001…FR-004). Run it to confirm it FAILS against the current `['current_user:read', 'file_content:read', 'library_assets:read']` value

**Checkpoint**: Baseline green; red test in place proving the defect.

---

## Phase 3: User Story 1 - Connect Figma via OAuth without an invalid-scope error (Priority: P1) 🎯 MVP

**Goal**: Correct the Figma OAuth provider template so the authorization URL requests only the valid read-only `files:read` scope, and update administrator guidance to match — restoring the connection flow broken in `006-figma-integration`.

**Independent Test**: In `rayedbajwa/spaces`, run `bun test tests/oauth.test.ts`; `PROVIDER_TEMPLATES.figma.scopes` equals `['files:read']`, `notes` names `files:read` (and none of the removed scopes), and a `beginAuthorization` URL for a Figma config carries `scope=files:read` only. (Live Figma consent per `quickstart.md` is documented but requires real keys and is not run in CI.)

### Tests for User Story 1 ⚠️

> **NOTE: T003 (Phase 2) is the failing test written first. The tasks below implement the fix and add the URL/guidance assertions.**

- [X] T004 [P] [US1] Add admin-guidance assertion to the same test in `tests/oauth.test.ts` — assert `PROVIDER_TEMPLATES.figma.notes` names `files:read` and does NOT name `current_user:read`, `file_content:read`, or `library_assets:read` (maps to FR-005)
- [X] T005 [P] [US1] Add a Figma authorization-URL assertion in `tests/oauth.test.ts` — call `beginAuthorization` with `PROVIDER_TEMPLATES.figma` (plus a dummy `clientId`/`clientSecret`), parse the `redirectUrl`, and assert the `scope` query parameter equals exactly `files:read` with no other tokens (maps to FR-001, SC-001)

### Implementation for User Story 1

- [X] T006 [US1] In `src/lib/oauth.ts`, correct the `PROVIDER_TEMPLATES.figma` entry: set `scopes` to `['files:read']`, and replace the comment block beginning `// Read-only granular scopes:` with an accurate note that `files:read` covers file/node inspection, published styles, and published components, and that `file_variables:read` is Enterprise-only so it is not requested (maps to FR-002, FR-003, FR-004)
- [X] T007 [US1] In `src/lib/oauth.ts`, update the `PROVIDER_TEMPLATES.figma.notes` string to `'OAuth 2.0 app. Enable the read-only scope files:read in your Figma app settings.'` so administrator guidance lists exactly the requested scope (maps to FR-005)
- [X] T008 [US1] Run `bun test tests/oauth.test.ts` and `bun run typecheck` in `rayedbajwa/spaces`; confirm the red test from T003 and the new assertions from T004/T005 now pass (green)

**Checkpoint**: User Story 1 fully implemented and independently testable — the Figma authorization URL and administrator guidance now use only `files:read`.

---

## Phase 4: Polish & Cross-Cutting Concerns

**Purpose**: Regression coverage, acceptance-scenario traceability, and artifact completion.

- [X] T009 [P] Generate `specs/007-fix-figma-scopes/test-plan.md` in `/data/aidlc/workspaces/_governance/spaces-3f701200`, mapping the four acceptance scenarios (AS1 invalid-scope-free URL, AS2 consent/token exchange, AS3 connected status, AS4 read-tool regression) plus FR-001…FR-006 and SC-001…SC-003 to concrete test cases, following the section structure of `specs/004-fix-version-api/test-plan.md`
- [X] T010 Run the Figma regression suite in `rayedbajwa/spaces`: `bun test tests/figma-tools.test.ts tests/figma-api.test.ts tests/integration-token.test.ts` to confirm the read-only tools and token exchange are unaffected (maps to FR-006, SC-003)
- [X] T011 Run the full regression gate in `rayedbajwa/spaces`: `bun run typecheck` and `bun test` across the suite to confirm no other behavior changed
- [X] T012 Execute `quickstart.md` verification steps in `rayedbajwa/spaces` (grep the scope identifiers in `src/lib/oauth.ts`, typecheck, and the OAuth + Figma unit tests)

**Checkpoint**: All automated gates green; `test-plan.md` produced with full acceptance traceability.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately.
- **Foundational (Phase 2)**: Depends on Setup. T003 must be written and shown failing before implementation.
- **User Story 1 (Phase 3)**: Depends on Foundational. T006/T007 (same file `src/lib/oauth.ts`) are sequential relative to each other only in that they touch adjacent lines; T004/T005 are tests in `tests/oauth.test.ts` and can run parallel to the source edits.
- **Polish (Phase 4)**: Depends on User Story 1 being complete and green.

### User Story Dependencies

- **User Story 1 (P1)**: The only story. No cross-story dependencies.

### Within User Story 1

- Tests (T003, T004, T005) written and demonstrated failing before implementation (T006, T007).
- Source correction (T006, T007) before the green confirmation run (T008).
- Story complete before Polish/regression (T010–T012).

### Parallel Opportunities

- T004 and T005 (test additions in `tests/oauth.test.ts`) can run in parallel with each other and with the source edits T006/T007 (different files).
- T009 (`test-plan.md` in the `governance` repo) is independent of T010–T012 and can run in parallel with the regression suite once US1 is green.

---

## Parallel Example: User Story 1

```bash
# After the red test (T003) is in place, launch in parallel:
Task: "T004 [US1] admin-guidance assertion in tests/oauth.test.ts"
Task: "T005 [US1] Figma authorization-URL assertion in tests/oauth.test.ts"
Task: "T006 [US1] correct PROVIDER_TEMPLATES.figma scopes + comment in src/lib/oauth.ts"
Task: "T007 [US1] update PROVIDER_TEMPLATES.figma.notes in src/lib/oauth.ts"

# Then converge:
Task: "T008 [US1] run oauth.test.ts + typecheck (green)"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1 (branch + frozen install).
2. Complete Phase 2 (baseline + red test).
3. Complete Phase 3 (correct scopes/notes + green tests).
4. **STOP and VALIDATE**: `bun test tests/oauth.test.ts` green; scope set is `['files:read']`.
5. Complete Phase 4 (test-plan + regression) before delivery.

### Incremental Delivery

This is a single-story bugfix; there is no incremental story delivery. The whole feature is the MVP.

---

## Delivery

Tasks below run in `rayedbajwa/spaces` after all Phase 1–4 gates are green. No other repository is touched, so there is no cross-repo ordering.

- [ ] D001 Open a pull request for branch `007-fix-figma-scopes` in `rayedbajwa/spaces` (source change `src/lib/oauth.ts` + test `tests/oauth.test.ts`)
- [ ] D002 Ensure CI is green on the PR (`typecheck`, `build:web`, DB schema apply, and the OAuth/Figma unit tests per Organization Memory — no CI change is required as long as the existing jobs pass)
- [ ] D003 Obtain human review approval on the PR (review is required per Org Review Policies for implement)
- [ ] D004 Merge the PR into the default branch
- [ ] D005 Confirm the deployment pipeline ran (and that the corrected provider template is live), then run the final acceptance checks from `test-plan.md` and `quickstart.md` against the deployed environment — the live Figma consent flow (AS2/AS3) requires a configured Figma app and is documented as manual/UAT rather than CI

---

## Notes

- `PROVIDER_TEMPLATES` is already exported from `src/lib/oauth.ts`, so the unit test may import it directly (no source refactor needed to enable testing).
- `tests/oauth.test.ts` already imports from `../src/lib/oauth` and covers `beginAuthorization`; the new Figma assertions extend the existing file rather than creating a new one.
- The `notes`/`scopes`/comment all live in the same `figma` block of `src/lib/oauth.ts` (lines ~169–182); T006 and T007 are closely adjacent and may sensibly be committed together.
- No database, schema, or migration work is required (see `data-model.md`); existing connected Figma tokens are unaffected because scopes only apply to new authorization requests.

## Implementation Execution Notes (2026-09-23)

Implementation completed in `rayedbajwa/spaces` on branch `007-fix-figma-scopes`; committed as `6dfb1bd` `fix(oauth): request only files:read scope for Figma`.

- **T001** — Branch already checked out; `bun install --frozen-lockfile` passed (270 installs across 296 packages, no changes).
- **T002** — Green baseline recorded: `bun run typecheck` clean; `bun test tests/oauth.test.ts` 4 pass / 1 skip / 0 fail.
- **T003** — Added the red unit test (scope-set assertions U1–U7). Ran against the buggy scope list and confirmed **8 failures** (e.g. `Expected: ["files:read"] / Received: ["current_user:read", "file_content:read", "library_assets:read"]`), proving the defect before the fix.
- **T004/T005** — Added the `notes` guidance assertions (U8–U9) and the `beginAuthorization` URL `scope=` assertion (I1) to the same test file.
- **T006/T007** — Corrected `src/lib/oauth.ts`: `scopes: ['files:read']`, accurate comment (files:read covers file/node inspection, published styles/components; `file_variables:read` is Enterprise-only so not requested), and `notes` updated to `'OAuth 2.0 app. Enable the read-only scope files:read in your Figma app settings.'`.
- **T008** — Green: `bun test tests/oauth.test.ts` 14 pass / 1 skip / 0 fail; `bun run typecheck` clean.
- **T009** — `test-plan.md` present and complete (maps AS1–AS4, FR-001…FR-006, SC-001…SC-003, and edge cases); no regeneration needed.
- **T010** — `bun test tests/figma-tools.test.ts tests/figma-api.test.ts tests/integration-token.test.ts` → 20 pass / 0 fail.
- **T011** — `bun run typecheck` clean. Full `bun test --timeout=20000 --max-concurrency=4` → 444 pass / 9 skip / 3 fail / 1 error. The 3 failures + 1 error are **pre-existing and unrelated** browser-launch issues in `tests/project-responsibilities.e2e.test.ts` (`Target page, context or browser has been closed` / `Protocol error (Target.createTarget): Not supported`); reproduced identically in isolation and independent of this one-line scope change. No OAuth/Figma behavior regressed.
- **T012** — `quickstart.md` grep confirms `src/lib/oauth.ts` shows `scopes: ['files:read']` and none of the removed identifiers; typecheck + OAuth/Figma unit tests green.

**Delivery (D001–D005) not yet run** — push/PR, CI, human review, merge and deploy are the separate delivery stage (merge/deploy require approval).