# Implementation Plan: Fix Invalid Figma OAuth Scopes

**Branch**: `007-fix-figma-scopes` | **Date**: 2026-09-23 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/007-fix-figma-scopes/spec.md`

## Summary

The Figma OAuth provider template in `src/lib/oauth.ts` requests three scope
identifiers — `current_user:read`, `file_content:read`, and `library_assets:read` —
two of which (`current_user:read`, `file_content:read`) are not valid Figma OAuth
scope names. Figma therefore rejects the consent request with an "invalid scope"
error, blocking the entire Figma integration shipped in `006-figma-integration`.

The fix corrects the scope list in the Figma provider template to request only the
valid, read-only `files:read` scope (the scope documented for `006-figma-integration`),
removes the invalid identifiers, and updates the administrator-facing guidance so the
instructions match what is actually requested. No other behavior changes; the token
exchange, identity verification, and all read-only agent tools continue to work
because `files:read` authorizes file/node inspection, published styles, and published
components, and `/v1/me` (identity) is not gated by an additional scope.

The fix is a single localized constant change in `rayedbajwa/spaces` plus a unit test
asserting the corrected scope set.

## Repositories

- primary — `rayedbajwa/spaces` — correct the Figma OAuth provider scope list and administrator guidance in `src/lib/oauth.ts`, and add a unit test in `tests/oauth.test.ts`.

(No other repository is changed or depended upon. The `governance` workspace only
hosts these Spec Kit artifacts.)

## Technical Context

**Language/Version**: TypeScript 5.9 (strict, `type: module`) on Bun 1.4+
**Primary Dependencies**: none new — edits only the `PROVIDER_TEMPLATES.figma` entry in `src/lib/oauth.ts` (no libraries, no schema)
**Storage**: N/A (no database change; Figma tokens remain in `app_integrations.credentials_json` via the existing crypto-vault)
**Testing**: `bun test` (bun:test); extend `tests/oauth.test.ts`
**Target Platform**: Bun server (Linux), plus the React SPA (unchanged)
**Project Type**: web application (multi-process orchestrator); change is server-side only
**Performance Goals**: N/A (no runtime path altered except the authorization URL string)
**Constraints**: The Figma authorization URL must contain only recognized Figma scope identifiers; read-only access; must not require the Enterprise-only `file_variables:read` scope
**Scale/Scope**: one provider-template constant (`scopes`) + one `notes` string + comments + a unit test

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- [x] **Specification has a problem statement, acceptance scenarios, and measurable success criteria.** The spec (007-fix-figma-scopes) has a Problem Statement, a P1 User Story with 4 acceptance scenarios and edge cases, 6 functional requirements (FR-001…FR-006), and 3 measurable success criteria (SC-001…SC-003).
- [x] **Repositories and cross-repository contracts are named above.** Only `rayedbajwa/spaces` (primary) changes; no cross-repository contract.
- [x] **Security, authorization, tenant boundaries, auditability, and data protection impacts are addressed.** No change to auth or tenant boundaries: tokens are still stored encrypted per-`org_id`, exchange is unchanged, and the scope list is narrowed (least privilege — read-only `files:read`) rather than widened. No secrets are added or logged.
- [x] **State changes have an idempotent migration, rollback, or repair path.** No database state change. The fix is a source constant; rollback is a revert of the one-line change. Existing connected Figma tokens are unaffected because the scope only applies to *new* authorization requests.
- [x] **Test planning maps changed behavior, security boundaries, migrations, and failure modes to verification.** Test plan recorded below (section at the end) and expanded in `test-plan.md` at the tasks stage; a unit test asserts the corrected scope set and readiness for `test-plan.md` generation.
- [x] **Parallel work, if used, has machine-readable workstreams and merge checkpoints.** No parallel work — this is a single-repo, single-file change; no workstreams required.

All gates pass; no exceptions or complexity justifications needed.

## Project Structure

### Documentation (this feature)

```text
specs/007-fix-figma-scopes/
├── plan.md              # This file
├── research.md          # Phase 0 output — scope-name resolution
├── data-model.md        # Phase 1 output — "no data model change" record
├── quickstart.md        # Phase 1 output — minimal verification steps
└── test-plan.md         # Generated at the tasks stage (prepared here)
```

### Source Code (repository root — `rayedbajwa/spaces`)

```text
src/
└── lib/
    └── oauth.ts          # edit: PROVIDER_TEMPLATES.figma scopes + notes + comment

tests/
└── oauth.test.ts         # edit: add Figma scope-set unit test
```

**Structure Decision**: No new modules or directories. The change is confined to the
existing Figma provider template in `src/lib/oauth.ts`, and the test belongs in the
existing `tests/oauth.test.ts`, which already exercises `beginAuthorization` and
`OAuthProviderConfig`. `contracts/` is intentionally omitted — the product exposes no
new external interface (the Figma authorization URL contract is internal and unchanged
in shape, only in scope value).

## Complexity Tracking

No violations. Not applicable.

---

## Test Planning (prepared for `test-plan.md`)

The scope correction is a security-boundary-adjacent change (OAuth consent), so
verification is mandatory, not waived. Test strategy:

1. **Unit test (new, `tests/oauth.test.ts`)** — assert `PROVIDER_TEMPLATES.figma.scopes`
   equals `['files:read']`, contains `files:read`, and does **not** contain
   `current_user:read`, `file_content:read`, `file_variables:read`, or `library_assets:read`.
   This maps to FR-001…FR-004.
2. **Admin-guidance test (optionally folded into the unit test)** — assert
   `PROVIDER_TEMPLATES.figma.notes` names `files:read` and does not name the removed
   scopes (FR-005).
3. **Authorization URL test** — reuse the existing `beginAuthorization` URL test to
   assert a Figma-config `scope` query parameter contains only `files:read` (FR-001,
   SC-001).
4. **Regression (existing suite)** — `tests/figma-tools.test.ts`,
   `tests/figma-api.test.ts`, and `tests/integration-token.test.ts` continue to pass,
   confirming the read-only tools and token exchange are unaffected (FR-006, SC-003).
5. **Live E2E (manual/optional)** — a real Figma consent flow is covered by
   User Story 1's independent test but requires a configured Figma app and keys;
   per project memory, E2E tests that require external keys are documented but not
   run in CI.

Full acceptance-scenario-to-test-case mapping is deferred to `test-plan.md` at the
tasks stage; this plan records the strategy so task decomposition can generate it
directly.