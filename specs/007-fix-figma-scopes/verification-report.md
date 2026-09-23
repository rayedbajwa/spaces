# Verification Report: Fix Invalid Figma OAuth Scopes

Verification Status: PARTIAL
Acceptance Criteria Met: 7/9
Critical Issues Open: 0

**Feature**: `007-fix-figma-scopes` · bugfix
**Repository under test**: `rayedbajwa/spaces` (`/data/aidlc/workspaces/rayedbajwa/spaces`)
**Branch**: `007-fix-figma-scopes` (HEAD `02f7f43`, fix commit `6dfb1bd`)
**Date**: 2026-09-23 · QA stage · loop iteration 2 (re-verification after review-driven changes)

---

## 0. Executive summary

This is a **re-verification** after the code-review (`CHANGES_REQUESTED`) and
verify-driven implement loops corrected the feature's artifacts. Prior findings
are resolved. The **code fix is correct and fully verified**: `src/lib/oauth.ts`
now requests only `files:read`, dropping the Enterprise-only `file_variables:read`
that caused Figma's "scope not valid" error on standard plans.

Every automated gate for this feature passes in this run:

- `bun run typecheck` — clean (exit 0).
- `bun test tests/oauth.test.ts` — **11 pass / 1 skip / 0 fail** (the scope-set,
  guidance, and URL assertions, now keyed to the *real* removed scope).
- `bun test tests/figma-tools.test.ts tests/figma-api.test.ts tests/integration-token.test.ts` — **20 pass / 0 fail**.
- Full suite — **441 pass / 9 skip / 3 fail / 1 error**; the 3 failures + 1 error
  are pre-existing Playwright/Chromium launch errors in
  `tests/project-responsibilities.e2e.test.ts`, unrelated to this change.

Two prior findings are **now resolved**:

1. **Artifact root-cause misstatement (was MAJOR)** — every artifact now names
   `file_variables:read` (Enterprise-only) as the sole removed scope; the phantom
   identifiers `current_user:read` / `file_content:read` / `library_assets:read`
   have been scrubbed from `spec.md`, `plan.md`, `research.md`, `tasks.md`,
   `test-plan.md`, `quickstart.md`, `data-model.md`, `parallel-workstreams.md`,
   and `checklists/requirements.md` (present only in the retained correction note).
2. **Phantom-scope test assertions (was MINOR)** — `tests/oauth.test.ts`'s
   `removedScopes` loop is collapsed to the single real identifier
   `file_variables:read`; U1 (exact equality), U3 (`file_variables:read`
   exclusion), and I1 (URL `scope=files:read`) now unambiguously guard the regression.

Verification remains **PARTIAL** for a single, non-code reason: **AS2/AS3 and
SC-002 (live Figma consent + token exchange + <2-minute connect) are unverified
and deferred to manual/UAT** — they need a configured Figma app and real keys,
which is out of CI scope per Organization Memory ("E2E tests that require keys
can be ignored"). SC-001's "zero unrecognized scope identifiers" half is proven at
the URL level (I1); its "Figma presents the consent screen" half is deferred to
the same live flow.

No release-blocking defect (data loss, security, broken core journey, or failing
must-have requirement) remains. Least-privilege is actually improved.

---

## 1. Test execution

Commands run in `/data/aidlc/workspaces/rayedbajwa/spaces` (Bun 1.4.2), each with
a time limit, against this checkout's own database (`agent_spaces_3f701200`).

| Command | Result | Duration |
|---|---|---|
| `bun run typecheck` (`tsc --noEmit`) | **PASS** (clean, exit 0) | ~5.6s |
| `bun test tests/oauth.test.ts` | **11 pass / 1 skip / 0 fail** (27 expect calls) | 19ms |
| `bun test tests/figma-tools.test.ts tests/figma-api.test.ts tests/integration-token.test.ts` | **20 pass / 0 fail** (89 expect calls) | 2.6s |
| `bun test --timeout=20000 --max-concurrency=4` (full suite) | **441 pass / 9 skip / 3 fail / 1 error** (453 tests, 65 files) | 404.6s |
| `bun test tests/smoke.test.ts` (server on `:3369`, `AUTH_DISABLED=1`) | **5 pass / 2 fail** (409 no_provider_key) | 2.0s |
| `bun test tests/project-responsibilities.e2e.test.ts` (isolation) | **0 pass / 3 fail / 1 error** (Chromium launch) | 17.7s |

The OAuth suite dropped from 14 → 11 tests vs. the prior verify pass because the
three phantom-scope assertions were correctly removed (the `removedScopes` loop now
iterates the single real identifier `file_variables:read`); the full suite moved
from 444 → 441 pass for the same reason, with no new failures.

### Environmental failures (not feature defects)

**`project-responsibilities.e2e.test.ts` (3 fail / 1 error)** — Playwright/Chromium
launch failures: `Protocol error (Target.createTarget): Not supported`,
`Target page, context or browser has been closed`. Reproduced identically in
isolation (`0 pass / 3 fail / 1 error`). These tests exercise the React
responsibility-management UI and share **no code path** with `src/lib/oauth.ts`
(the only source file changed). A minimal Playwright launch succeeds in this
environment, confirming the crash is in the e2e fixture's navigation path and is
unrelated to, and pre-dates, the one-line scope change.

**`smoke.test.ts` (2 fail when a server is up)** — `POST /api/projects` returns
`409 no_provider_key`. The smoke fixture seeds a provider key only when
`provider_keys` is empty; this shared DB already contains 23 org-owned keys that
cannot be decrypted (the `.env` `ENCRYPTION_KEY` no longer matches the one that
encrypted them — "stored provider key cannot be decrypted" in the server log). This
is a shared-DB/environment limitation, not a feature regression. The other 5 smoke
cases (health, board, projects list, integrations list, rerun-404) pass. The 9 skips
in the full-suite run are the 8 smoke cases (no `:3000` server in that run) plus the
1 OAuth backdated-clock skip.

---

## 2. Requirement-by-requirement verification (traceability)

| Req | Description | Test | Result |
|---|---|---|---|
| FR-001 | Request only valid Figma scope identifiers | U1 (deep-equal `['files:read']`), I1 (URL `scope=files:read`) | ✅ PASS |
| FR-002 | Include `files:read` for file/node/style/component reads | U2 (`files:read` present) | ✅ PASS |
| FR-003 | Request only `files:read` (least privilege) | U1 (exact length-1 equality) | ✅ PASS |
| FR-004 | Do **not** require Enterprise-only `file_variables:read` | U3 (`file_variables:read` absent) | ✅ PASS |
| FR-005 | Admin guidance lists exactly the requested scope | U5 (`notes` names `files:read`), U6 (absent `file_variables:read`) | ✅ PASS |
| FR-006 | Read capabilities unchanged (no regression) | figma-tools (TC-FIG-001…006), figma-api (TC-API-001…005), integration-token | ✅ PASS (20/20) |
| SC-001 | Zero unrecognized scopes; Figma shows consent, not "invalid scope" | I1 (URL-level proof of zero unrecognized identifiers) | ⚠️ PARTIAL — URL proven; live consent deferred |
| SC-002 | Connect completes in under 2 minutes | none automated | ❌ UNVERIFIED (deferred — live flow) |
| SC-003 | 100% of read-only tool paths unchanged | figma regression suite (20/20) | ✅ PASS |

The `removedScopes` loop and the `notes`/URL assertions are now keyed to the *real*
removed scope (`file_variables:read`), so U1/U3/I1 all genuinely fail against the
pre-fix `['files:read', 'file_variables:read']` value and guard the actual regression.

### Acceptance-scenario coverage

- **AS1** (URL requests only valid read-only scopes) — ✅ verified by I1.
- **AS2** (consent approval → auth code → token exchange) — ❌ unverified (deferred).
- **AS3** (card reports Connected + handle) — ❌ unverified (deferred).
- **AS4** (read tools still work) — ✅ verified by the regression suite (20/20).

---

## Unsatisfied Test Cases

- `[AS2]` — live Figma consent + token exchange — unverified: requires a configured Figma OAuth app and real keys (deferred to manual/UAT per Organization Memory); no automated evidence exists.
- `[AS3]` — integration card reports "Connected" with account handle — unverified: depends on the deferred live flow.
- `[SC-002]` — administrator connects Figma in under 2 minutes — unverified: no timing measurement exists; requires the live flow.

> Resolution note: the prior pass's `[U3/U4/U6]` unsatisfied entries (phantom-scope
> assertions for `current_user:read` / `file_content:read` / `library_assets:read`)
> are **resolved** — those identifiers never existed and the assertions were removed;
> the `removedScopes` loop now checks the single real identifier
> `file_variables:read`. The prior MAJOR artifact-root-cause misstatement is also
> resolved (§0, §5.1).

---

## 4. Missing tests

- **Live Figma OAuth consent + token exchange (AS2/AS3)** — no automated or CI test
  exists. This is an accepted, documented deferral (needs real Figma keys), not an
  accidental omission; the spec's AS2/AS3 are proven only at the URL level (I1) plus
  the internal `integration-token` / `figma-api` mock and credential-sealing tests.
- **A timing test for SC-002** — none exists and none is feasible in CI without the
  live flow.
- No other missing tests: U1–U6 + I1 fully cover FR-001…FR-006 and the edge cases
  (deprecated `file_read` excluded via U4; Enterprise-only scope excluded via U3;
  admin-guidance match via U5/U6).

---

## 5. Remaining defects, risks, and unknowns

### 5.1 Resolved — artifact root-cause misstatement (was MAJOR)

All feature artifacts now correctly name `file_variables:read` (Enterprise-only) as
the sole removed scope. The phantom identifiers (`current_user:read`,
`file_content:read`, `library_assets:read`) are scrubbed from every artifact body and
from `src/` / `tests/`; they appear only in the retained correction note in
`tasks.md` (a deliberate record of the fix). `spec.md`'s Problem Statement and FR-003
now match git history (`git show 79fac3c:src/lib/oauth.ts` →
`['files:read', 'file_variables:read']`).

### 5.2 Resolved — phantom-scope test assertions (was MINOR)

The `removedScopes` loop in `tests/oauth.test.ts` now iterates the single real
identifier `file_variables:read`; the `notes` exclusion checks only
`file_variables:read`. The regression is genuinely guarded by U1 (exact
`['files:read']` equality), U3 (`file_variables:read` exclusion), and I1
(URL `scope` exactly `files:read`).

### 5.3 Environment-only (not feature) failures

- **3 `project-responsibilities.e2e.test.ts` failures + 1 error** — Chromium launch
  errors, unrelated to `src/lib/oauth.ts`, reproduce in isolation, pre-existing.
- **2 `smoke.test.ts` failures** (when the server is run against the shared DB) —
  `409 no_provider_key` from undecryptable pre-seeded provider keys (ENCRYPTION_KEY
  mismatch in the shared database), unrelated to this change.

Neither set blocks this feature's acceptance; both are noted for honesty and so the
next run can distinguish them from real regressions.

### 5.4 Deferred live verification

AS2, AS3 and SC-002 remain unverified pending a manual UAT run against a deployed
app with a configured Figma OAuth app (documented in `quickstart.md`). `quickstart.md`
correctly lists `files:read` as the only scope to enable.

### 5.5 Delivery status

Delivery Status is `NONE` — branch `007-fix-figma-scopes` is not pushed, no PR, no CI
run recorded against it. Delivery (D001–D005: push/PR, CI, human review, merge,
deploy) is the separate delivery stage and requires human approval; it does not affect
the verification of the code itself.

---

## 6. Release readiness recommendation

**READY (conditional on the deferred live-UAT item)** — the code is correct, each
automated gate for the feature is green, the artifacts now accurately record
`file_variables:read` as the removed scope, and the test suite guards the real
regression. The only outstanding item is the intentionally-deferred live Figma
consent/token-exchange flow (AS2/AS3/SC-002), which requires a configured Figma app
and real keys and is a manual/UAT task recorded for after merge (D005), not a code,
artifact, or test-blocking defect.

**Bottom line**: approve for delivery (push/PR → CI → review → merge). After merge,
complete the D005 manual/UAT Figma connect flow to close AS2/AS3/SC-002.