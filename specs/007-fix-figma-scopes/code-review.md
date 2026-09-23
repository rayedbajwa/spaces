Code Review Status: APPROVED

## Summary

The change corrects the Figma OAuth provider template in `src/lib/oauth.ts` to request only the read-only `files:read` scope, removing the Enterprise-only `file_variables:read` scope that caused Figma's "scope not valid" error on standard plans. The fix is minimal and correctly scoped (one template constant, one explanatory comment, one `notes` string) with no schema or security-surface change, and the accompanying unit tests in `tests/oauth.test.ts` genuinely guard the regression. This work is already merged and deployed via rayedbajwa/spaces#54 (`main` `3cf7570`), and its CI was green; this review re-confirms the merged code and records a duplicate-PR condition (see findings).

## Findings

- [NIT] `tests/oauth.test.ts:108-112` — the `removedScopes` loop iterates a single-element array (`['file_variables:read']`); inlining the one `not.toContain('file_variables:read')` assertion would read more directly. Non-blocking: the assertion is correct and, with the exact-equality `toEqual(['files:read'])` and the URL `scope=files:read` assertions, guards the real regression.
- [NIT] delivery-status.md / PR #56 — **PR #56 is a duplicate** of the already-merged PR #54. Its 14 changed files (`src/lib/oauth.ts`, `tests/oauth.test.ts`, and all `specs/007-fix-figma-scopes/*.md`) are byte-identical to what already exists on `main` (confirmed: `git diff origin/main HEAD -- src/ tests/` is empty, and `main`/`3cf7570` already contains the full `specs/007-fix-figma-scopes/` tree). PR #56 reports `mergeable: false` for this reason. It should be **closed**, not merged — no new content is present.
- [NIT] `tests/project-responsibilities.e2e.test.ts` (out of scope for this feature) — the full suite reports 3 failures + 1 error, all Playwright/Chromium launch failures (`Target.createTarget: Not supported`, `Target page … has been closed`); they share no code path with `src/lib/oauth.ts`, reproduce in isolation, and pre-date this change.

No BLOCKER or MAJOR findings. The code is correct; the only delivery item is closing the redundant duplicate PR #56 (done as part of this review cycle).

## Tests & checks

Run in `rayedbajwa/spaces` (Bun 1.4.2), branch `007-fix-figma-scopes` (HEAD `66499a6`), against this checkout's own database (`agent_spaces_3f701200`).

| Command | Result |
|---------|--------|
| `bun run typecheck` (`tsc --noEmit`) | ✅ clean, exit 0 |
| `bun test --timeout=20000 --max-concurrency=4` (full suite) | ⚠️ 441 pass / 9 skip / 3 fail / 1 error (453 tests, 65 files, 405s) |

The 3 failures + 1 error are confined to `tests/project-responsibilities.e2e.test.ts` (Chromium launch). The 9 skips are 8 `smoke.test.ts` (no `:3000` server in this run) plus 1 OAuth backdated-clock test. `tests/oauth.test.ts` and the Figma regression trio pass within the full suite.

### CI (from delivery-status.md)

- PR #54 — `build & test` ✅ success · `docker build` ✅ success · merged · Railway `spaces / production` deploy **success**.
- PR #56 — open, **no checks** (duplicate of #54; `mergeable: false`). Flagged for closure, not merge.

## Spec coverage

| Requirement | Status | Evidence |
|-------------|--------|----------|
| FR-001 request only valid scope identifiers | ✅ | `scopes: ['files:read']`; URL test asserts `scope=files:read` |
| FR-002 include `files:read` for file/node/style/component reads | ✅ | `scopes` contains `files:read`; Figma regression suite green |
| FR-003 request only `files:read` (least privilege) | ✅ | `toEqual(['files:read'])` |
| FR-004 no Enterprise-only `file_variables:read` | ✅ | exclusion assertion + URL `scope=files:read` |
| FR-005 admin guidance lists exactly requested scope | ✅ | `notes` asserts `files:read` present, `file_variables:read` absent |
| FR-006 read capabilities unchanged | ✅ | figma-tools / figma-api / integration-token → 20/20 pass |
| AS1 URL requests only valid read-only scopes | ✅ | I1 `scope=files:read` |
| AS4 read tools still work | ✅ | Figma regression suite green |
| AS2/AS3/SC-002 live consent + token exchange + connected + <2 min | ⏸ deferred | requires a configured Figma app + real keys; manual/UAT per Organization Memory |

The prior MAJOR root-cause misstatement and MINOR phantom-scope assertions are resolved, and security is improved (least-privilege narrowing; no secrets introduced). Commits and PR titles are Conventional Commits compliant.