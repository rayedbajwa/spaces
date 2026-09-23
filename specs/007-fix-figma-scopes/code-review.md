Code Review Status: APPROVED

## Summary

This change corrects the Figma OAuth provider template in `src/lib/oauth.ts` to request only the read-only `files:read` scope, removing the Enterprise-only `file_variables:read` scope that caused Figma's "scope not valid" error on standard plans. The fix is a minimal, correctly-scoped change (one template constant, one explanatory comment, one `notes` string) that narrows to least privilege with no behavioral, schema, or security-surface change. Tests are comprehensive and keyed to the *real* removed scope, the feature artifacts accurately name `file_variables:read` as the root cause, and the change has now been merged (rayedbajwa/spaces#54) with CI green. Quality is high; no blocking findings.

## Findings

- [NIT] tests/oauth.test.ts:108-112 — the `removedScopes` loop iterates a single-element array (`['file_variables:read']`), a thin indirection; inlining the one `not.toContain('file_variables:read')` assertion would read more directly. Non-blocking: the assertion itself is correct and — together with the exact-equality `toEqual(['files:read'])` and the URL `scope=files:read` assertions — genuinely guards the regression.
- [NIT] `tests/project-responsibilities.e2e.test.ts` (out of tree for this feature) — the full suite reports 3 failures + 1 error, all Playwright/Chromium launch failures (`Target.createTarget: Not supported`, `Target page … has been closed`). These share no code path with `src/lib/oauth.ts`, reproduce identically in isolation, and pre-date this one-line scope change. Not blocking for this feature; tracked as an environment issue.

No BLOCKER or MAJOR findings. The prior `delivery-status.md` NIT (Delivery Status `NONE`) is resolved: the branch is pushed and PR #54 is merged.

## Tests & checks

Run in `rayedbajwa/spaces` (Bun 1.4.2), branch `007-fix-figma-scopes` (HEAD `9da57b3`), against this checkout's own database (`agent_spaces_3f701200`).

| Command | Result |
|---------|--------|
| `bun run typecheck` (`tsc --noEmit`) | ✅ clean, exit 0 |
| `bun test --timeout=20000 --max-concurrency=4` (full suite) | ⚠️ 441 pass / 9 skip / 3 fail / 1 error (453 tests, 65 files, 403s) |

The full suite includes `tests/oauth.test.ts` (11 pass / 1 skip) and the Figma regression trio (`figma-tools`, `figma-api`, `integration-token`) — all passing. The 3 failures + 1 error are confined to `tests/project-responsibilities.e2e.test.ts` and are Chromium launch failures (`waitFor: Target page, context or browser has been closed`, `newPage: Protocol error (Target.createTarget): Not supported`), reproduced in isolation and unrelated to the OAuth change. The 9 skips are 8 `smoke.test.ts` cases (no `:3000` server in this run) plus 1 OAuth backdated-clock test.

### CI (from delivery-status.md)

PR [#54](https://github.com/rayedbajwa/spaces/pull/54) — `build & test` ✅ success · `docker build` ✅ success. Merged into `main` as `3cf7570` at 2026-09-23T19:39 (Railway `spaces / production` deployment recorded, in progress at last check).

## Spec coverage

| Requirement | Status | Evidence |
|-------------|--------|----------|
| FR-001 request only valid scope identifiers | ✅ | `scopes: ['files:read']`; URL test asserts `scope=files:read` exactly |
| FR-002 include `files:read` for files/nodes/styles/components | ✅ | `scopes` contains `files:read`; Figma regression suite green |
| FR-003 request only `files:read` (least privilege) | ✅ | exact-equality assertion `toEqual(['files:read'])` |
| FR-004 no Enterprise-only `file_variables:read` | ✅ | exclusion assertion + URL `scope=files:read` |
| FR-005 admin guidance lists exactly requested scope | ✅ | `notes` asserts presence of `files:read`, absence of `file_variables:read` |
| FR-006 read capabilities unchanged | ✅ | figma-tools / figma-api / integration-token → 20/20 pass |
| AS1 URL requests only valid read-only scopes | ✅ | I1 `scope=files:read`, zero unrecognized identifiers |
| AS4 read tools still work | ✅ | Figma regression suite green |
| AS2/AS3/SC-002 live consent + token exchange + connected status + <2 min | ⏸ deferred | requires a configured Figma app + real keys; manual/UAT per Organization Memory — correctly out of CI scope |

Prior review findings are resolved: the once-MAJOR root-cause misstatement now names `file_variables:read` (Enterprise-only) as the sole removed scope across all artifacts, and the once-MINOR phantom-scope assertions (`current_user:read`/`file_content:read`/`library_assets:read`) are removed (these identifiers appear only in the retained correction note in `tasks.md`). Security is improved (least-privilege narrowing); no secrets are introduced (the URL test uses dummy `clientId`/`clientSecret`). Commits and PR title are Conventional Commits compliant (`fix(oauth): request only files:read scope for Figma`).