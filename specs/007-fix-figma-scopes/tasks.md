# Tasks — 007-fix-figma-scopes

Repository-local tasks for initiative **007-fix-figma-scopes** (Feature Specification: Fix Invalid Figma OAuth Scopes). Planning lives in the governing workspace; this file is what this repository owns. Tick items as they land; the pipeline commits it with the code.

## Figma Provider Template Correction (Source)
- [X] T006 [US1] In `src/lib/oauth.ts`, correct the `PROVIDER_TEMPLATES.figma` entry: set `scopes` to `['current_user:read', 'file_content:read', 'library_assets:read', 'library_content:read']` (replacing the deprecated `files:read` and the Enterprise-only `file_variables:read`), and add a comment noting the four scopes map to the read-only endpoints and that `files:read` (deprecated) and `file_variables:read` (Enterprise-only) are intentionally not requested (maps to FR-002, FR-003, FR-004)
- [X] T007 [US1] In `src/lib/oauth.ts`, update the `PROVIDER_TEMPLATES.figma.notes` string to `'OAuth 2.0 app. Enable the read-only scopes current_user:read, file_content:read, library_assets:read, and library_content:read in your Figma app settings.'` so administrator guidance lists exactly the requested scopes (maps to FR-005)
- [ ] **Proposed sub-agent assignment**: OAuth Provider Fix Engineer.

**Scoped files**
- `src/lib/oauth.ts` (the `figma` entry only)

Do **not** modify `tests/oauth.test.ts`, any other `tests/*`, `src/server.ts`, `src/web/`, or any governance artifact.

**Outputs**
- `PROVIDER_TEMPLATES.figma.scopes === ['current_user:read', 'file_content:read', 'library_assets:read', 'library_content:read']` (exactly four scopes).
- `PROVIDER_TEMPLATES.figma.notes` names the four granular scopes.
- Accurate comment block documenting the granular scopes' coverage and why the deprecated `files:read` and Enterprise-only `file_variables:read` are not requested.
- **Merge Checkpoint 1 (US1 Source Correction)**: source change green against the test suite at T008.

**Depends on**
- **Blocked by**: Workstream 2's T003 (failing test in place); Phase 1 setup (T001) and Phase 2 baseline (T002).
- **Can run in parallel with**: Workstream 2's T004/T005 (test-file additions) — disjoint files (`src/lib/oauth.ts` vs `tests/oauth.test.ts`).
- **Blocks**: T008 (green confirmation), Phase 4 regression (T010–T012), and delivery (D001–D005).

**QA focus**
- **Exact scope set**: `scopes` must deep-equal `['current_user:read', 'file_content:read', 'library_assets:read', 'library_content:read']` — length 4, exact values.
- **Removed identifiers absent**: the deprecated `files:read`, `file_variables:read` (Enterprise-only), and any deprecated `file_read` must not appear anywhere in the `figma` block.
- **Guidance parity**: the `notes` string must list exactly the scopes requested (the four granular scopes), never a removed scope.
- **Least privilege**: narrowing (not widening) — no new capabilities, read-only only.

---
## Figma Scope Test Suite (Red-Green)
- [X] T003 [P] Add a failing unit test for the corrected Figma scope set in `tests/oauth.test.ts` — import `PROVIDER_TEMPLATES` from `../src/lib/oauth` and assert `PROVIDER_TEMPLATES.figma.scopes` deep-equals `['current_user:read', 'file_content:read', 'library_assets:read', 'library_content:read']`, and does NOT contain the deprecated `files:read` or the Enterprise-only `file_variables:read` (maps to FR-001…FR-004). Run it to confirm it FAILS against the buggy `['files:read', 'file_variables:read']` value
- [X] T004 [P] [US1] Add admin-guidance assertion to the same test in `tests/oauth.test.ts` — assert `PROVIDER_TEMPLATES.figma.notes` names `current_user:read`, `file_content:read`, `library_assets:read`, and `library_content:read`, and does NOT name `files:read` or `file_variables:read` (maps to FR-005)
- [X] T005 [P] [US1] Add a Figma authorization-URL assertion in `tests/oauth.test.ts` — call `beginAuthorization` with `PROVIDER_TEMPLATES.figma` (plus a dummy `clientId`/`clientSecret`), parse the `redirectUrl`, and assert the `scope` query parameter equals exactly `current_user:read file_content:read library_assets:read library_content:read` with no other tokens (maps to FR-001, SC-001)
- [ ] **Proposed sub-agent assignment**: OAuth Test Engineer.

**Scoped files**
- `tests/oauth.test.ts` (add Figma scope-set, guidance, and URL assertions)

Do **not** modify `src/lib/oauth.ts`, `src/server.ts`, or any governance artifact. Use dummy `clientId`/`clientSecret` values (never real keys).

**Outputs**
- Red test (T003) proven failing against the buggy `['files:read', 'file_variables:read']` value.
- Guidance (U5–U6) and URL (I1) assertions in `tests/oauth.test.ts`.
- **Merge Checkpoint 2 (Red Test in Place)**: emitted *before* Workstream 1 begins; signals the gate for T006/T007.

**Depends on**
- **Blocked by**: T001 (branch + frozen install) and T002 (green baseline).
- **Can run in parallel with**: T004/T005 run in parallel with Workstream 1's T006/T007 (different files). T003 itself is a hard gate for Workstream 1 and must only be shown failing first.
- **Blocks**: T008 (green confirmation).

**QA focus**
- **Red-green discipline**: T003 must be confirmed FAILING before T006/T007 are applied; do not edit source to make the test pass out of order.
- **Presence/absence over literal-match**: assert the four granular scopes are present and removed names are absent rather than over-fitting the exact `notes` sentence (mitigates brittleness).
- **URL assertion**: reconstruct the `scope=` query param and assert it is exactly the four granular scopes with no other token; do not hard-code a full URL.
- **No secrets**: dummy client id/secret only; never log or assert real Figma credentials.

---
