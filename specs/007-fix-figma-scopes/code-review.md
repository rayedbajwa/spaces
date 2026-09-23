Code Review Status: APPROVED

## Summary

This change corrects the Figma OAuth provider template in `src/lib/oauth.ts` to request only the read-only `files:read` scope, removing the Enterprise-only `file_variables:read` scope that caused Figma's "scope not valid" error on standard plans. The fix is a minimal, correctly-scoped change (one template constant, one comment, one `notes` string) that narrows to least privilege with no behavioral, schema, or security-surface change. Tests are comprehensive and now accurately keyed to the *real* removed scope, and all feature artifacts have been corrected to name `file_variables:read` as the root cause. Quality is high; the change is ready to merge once the delivery gate (push/PR) is satisfied.

## Findings

- [NIT] delivery-status.md:1 — Delivery Status is `NONE` (branch `007-fix-figma-scopes` not pushed, no PR, no CI check state to cite) — not a code defect, but CI has not yet run against this branch; push and open the PR in the delivery stage so review/CI gates can be recorded.
- [NIT] tests/oauth.test.ts:107-112 — the `removedScopes` loop iterates a single-element array (`['file_variables:read']`), which is a thin indirection; inlining the one exclusion assertion would read more directly. Non-blocking; the assertion itself is correct and guards the actual regression.

## Tests & checks

Run in `rayedbajwa/spaces` (Bun 1.4.2), branch `007-fix-figma-scopes` (HEAD `0b47d2e`):

| Command | Result |
|---------|--------|
| `bun run typecheck` (`tsc --noEmit`) | ✅ clean, exit 0 |
| `bun test tests/oauth.test.ts` | ✅ 11 pass / 1 skip / 0 fail (27 expect calls) |
| `bun test tests/figma-tools.test.ts tests/figma-api.test.ts tests/integration-token.test.ts` | ✅ 20 pass / 0 fail (89 expect calls) |
| `bun test --timeout=20000 --max-concurrency=4` (full suite) | ⚠️ 441 pass / 9 skip / 3 fail / 1 error |

The 3 failures + 1 error are all in `tests/project-responsibilities.e2e.test.ts` (`responsibility management UI`) — Playwright/Chromium launch failures (`Target.createTarget: Not supported`, `context or browser closed`). They are e2e (out of scope for this stage, deferred to verify), share no code path with `src/lib/oauth.ts`, and reproduce identically in isolation. The 9 skips are 8 `smoke.test.ts` cases (no `AUTH_DISABLED` server) plus 1 OAuth backdated-clock test — all environmental.

Commits on the branch are Conventional Commits compliant: `fix(oauth): request only files:read scope for Figma`, `test(oauth): drop phantom figma scope assertions`, `docs(007-fix-figma-scopes): correct root-cause narrative`, plus `chore(...)` WIP commits.

## Spec coverage

| Requirement | Status | Evidence |
|-------------|--------|----------|
| FR-001 request only valid scope identifiers | ✅ | `scopes: ['files:read']`; URL test asserts `scope=files:read` exactly |
| FR-002 include `files:read` for files/nodes/styles/components | ✅ | `scopes` contains `files:read`; regression suite (figma-tools/figma-api) green |
| FR-003 request only `files:read` (least privilege) | ✅ | exact-equality assertion `toEqual(['files:read'])` |
| FR-004 no Enterprise-only `file_variables:read` | ✅ | exclusion assertion + URL `scope=files:read` |
| FR-005 admin guidance lists exactly requested scope | ✅ | `notes` asserts presence of `files:read`, absence of `file_variables:read` |
| FR-006 read capabilities unchanged | ✅ | figma-tools (TC-FIG-001…006), figma-api (TC-API-001…005), integration-token → 20/20 pass |
| AS1 URL requests only valid read-only scopes | ✅ | I1 `scope=files:read`, zero unrecognized identifiers |
| AS4 read tools still work | ✅ | regression suite green |
| AS2/AS3/SC-002 live consent + token exchange + connected status | ⏸ deferred | requires real Figma keys; documented as manual/UAT per Organization Memory — correctly out of CI scope |

Prior review findings (MAJOR root-cause misstatement; MINOR phantom-scope assertions U3/U4/U6) are resolved: all six artifacts (`spec.md`, `plan.md`, `research.md`, `tasks.md`, `test-plan.md`, `quickstart.md`) now name `file_variables:read` (Enterprise-only) as the sole removed scope, and the phantom identifiers (`current_user:read`/`file_content:read`/`library_assets:read`) remain only in the historical `verification-report.md` and the `tasks.md` correction note, both intentionally retained as records. Security is improved (least-privilege narrowing); no secrets are introduced (URL test uses dummy `clientId`/`clientSecret`).