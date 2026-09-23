Code Review Status: APPROVED

## Summary

The change corrects the Figma OAuth provider template in `src/lib/oauth.ts` to request only the read-only `files:read` scope, removing the Enterprise-only `file_variables:read` scope that caused Figma's "scope not valid" error on standard plans. The fix is minimal and correctly scoped, and the `tests/oauth.test.ts` assertions genuinely guard the regression. It is already merged and deployed via rayedbajwa/spaces#54 (`main` `3cf7570`, CI green, Railway `spaces / production` success). This cycle also confirms a regression that a loop-stage commit introduced on the stale branch was correctly reverted (commit `ee654fc`), so the branch code is byte-identical to `main`.

## Findings

- [NIT] `tests/oauth.test.ts:108-112` — the `removedScopes` loop iterates a single-element array (`['file_variables:read']`); inlining the one exclusion assertion would read more directly. Non-blocking; guards the real regression alongside the exact-equality and URL assertions.
- [NIT] reprinted regression (reverted) — a prior loop-stage commit (`3f8b12d`) had replaced `files:read` with invalid granular scopes (`file_content:read`/`library_content:read`/`current_user:read`) and pushed them; this was **reverted to `files:read` in `ee654fc`** and pushed, restoring `git diff origin/main HEAD -- src/ tests/` to empty. Recorded in `tasks.md`.
- [NIT] `tests/project-responsibilities.e2e.test.ts` (out of scope) — full suite reports 3 failures + 1 error, all Playwright/Chromium launch failures; no code path shared with `src/lib/oauth.ts`, reproduce in isolation, pre-date this change.
- [NIT] delivery — duplicate PRs (#56/#57/#58/#59) continue to be auto-opened against the already-merged branch (squash-merge divergence). Each is a duplicate with no new content (`mergeable: false`); closed on sight. Terminal fix remains deleting the stale remote branch (content preserved in `main`).

No BLOCKER or MAJOR findings.

## Tests & checks

Run in `rayedbajwa/spaces` (Bun 1.4.2), branch `007-fix-figma-scopes` (HEAD `b930737`; `git diff origin/main HEAD -- src/ tests/` empty), against this checkout's own database (`agent_spaces_3f701200`).

| Command | Result |
|---------|--------|
| `bun run typecheck` (`tsc --noEmit`) | ✅ clean, exit 0 |
| `bun test --timeout=20000 --max-concurrency=4` (full suite) | ⚠️ 441 pass / 9 skip / 3 fail / 1 error (453 tests, 65 files, 409s) |

The 3 failures + 1 error are confined to `tests/project-responsibilities.e2e.test.ts` (Chromium launch); the 9 skips are 8 `smoke.test.ts` (no `:3000` server) plus 1 OAuth backdated-clock test. `tests/oauth.test.ts` (11/1) and the Figma regression trio (20/0) pass within the suite.

### CI (from delivery-status.md / GitHub)

- PR #54 — `build & test` ✅ success · `docker build` ✅ success · merged · Railway deploy **success**.
- PRs #56/#57/#58/#59 — duplicate, closed (no checks; no new content).

## Spec coverage

| Requirement | Status | Evidence |
|-------------|--------|----------|
| FR-001 request only valid scope identifiers | ✅ | `scopes: ['files:read']`; URL test asserts `scope=files:read` |
| FR-002 include `files:read` for file/node/style/component reads | ✅ | `scopes` contains `files:read`; Figma regression green |
| FR-003 request only `files:read` (least privilege) | ✅ | `toEqual(['files:read'])` |
| FR-004 no Enterprise-only `file_variables:read` | ✅ | exclusion assertion + URL `scope=files:read` |
| FR-005 admin guidance lists exactly requested scope | ✅ | `notes` asserts `files:read` present, `file_variables:read` absent |
| FR-006 read capabilities unchanged | ✅ | figma-tools / figma-api / integration-token → 20/20 pass |
| AS1 URL requests only valid read-only scopes | ✅ | I1 `scope=files:read` |
| AS4 read tools still work | ✅ | Figma regression suite green |
| AS2/AS3/SC-002 live consent + token exchange + connected + <2 min | ⏸ deferred | requires a configured Figma app + real keys; manual/UAT per Organization Memory |

Security improved (least-privilege narrowing; no secrets introduced). Commits and PR titles are Conventional Commits compliant.