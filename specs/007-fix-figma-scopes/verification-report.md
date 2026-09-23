# Verification Report: Fix Invalid Figma OAuth Scopes

Verification Status: PARTIAL
Acceptance Criteria Met: 7/9
Critical Issues Open: 0

**Feature**: `007-fix-figma-scopes` · bugfix
**Repository under test**: `rayedbajwa/spaces` (`/data/aidlc/workspaces/rayedbajwa/spaces`)
**Branch**: `007-fix-figma-scopes` (HEAD `60f247f`; `src/` and `tests/` byte-identical to merged `main` `3cf7570`, PR #54)
**Date**: 2026-09-23 · verify stage

---

## 0. Executive summary

The Figma OAuth scope fix is **already merged into `main` (`3cf7570`, PR #54) and
deployed** (Railway `spaces / production` deploy `success`). The code under test is
unchanged from that merged state (`git diff origin/main HEAD -- src/ tests/` is
empty); this run re-confirms it.

The fix is correct: `src/lib/oauth.ts` requests only `files:read`, removing the
Enterprise-only `file_variables:read` that caused Figma's "scope not valid" error
on standard plans. Every automated gate that exercises this feature is green:

- `bun run typecheck` — clean (exit 0).
- `bun test tests/oauth.test.ts tests/figma-tools.test.ts tests/figma-api.test.ts tests/integration-token.test.ts` — **31 pass / 1 skip / 0 fail**.
- `bun test --timeout=20000 --max-concurrency=4` (full suite) — **441 pass / 9 skip / 3 fail / 1 error** (453 tests, 65 files); the 3 failures + 1 error are pre-existing Playwright/Chromium launch errors in `tests/project-responsibilities.e2e.test.ts`, unrelated to this change.

Verification remains **PARTIAL** for one non-code reason: **AS2/AS3 and SC-002**
(live Figma consent → token exchange → "Connected" → <2-minute connect) require a
configured Figma OAuth app and real keys and are deferred to manual/UAT per
Organization Memory ("E2E tests that require keys can be ignored"). SC-001's
"zero unrecognized scope identifiers" half is proven at the URL level; its live
"consent screen" half is deferred.

No release-blocking defect remains; least privilege is improved and no secrets
were introduced.

---

## 1. Test execution

Commands run in `/data/aidlc/workspaces/rayedbajwa/spaces` (Bun 1.4.2), each with
a time limit, against this checkout's own database (`agent_spaces_3f701200`).

| Command | Result | Duration |
|---|---|---|
| `bun run typecheck` (`tsc --noEmit`) | **PASS** (clean, exit 0) | ~6s |
| `bun test tests/oauth.test.ts tests/figma-tools.test.ts tests/figma-api.test.ts tests/integration-token.test.ts` | **31 pass / 1 skip / 0 fail** (116 expect calls) | 2.6s |
| `bun test --timeout=20000 --max-concurrency=4` (full suite) | **441 pass / 9 skip / 3 fail / 1 error** (453 tests, 65 files) | 403s |
| smoke tests (`SMOKE_BASE_URL=http://127.0.0.1:3369`) | **0 pass / 8 skip** — server `:3369` `:3000` liveness probe not satisfied during slow boot against the shared multi-org DB (environmental; a prior run this session gave 5 pass / 2 fail, the 2 being `409 no_provider_key`) | 2.0s |
| `docker build` (container image) | **NOT RUN** — no Docker daemon in this environment | — |

The OAuth suite is 11 pass / 1 skip within the 31/1/0 targeted run; the Figma
regression trio is the other 20. The full suite's 9 skips are the 8 `smoke.test.ts`
cases (no reachable server) plus 1 OAuth backdated-clock test.

### Environmental failures (not feature defects)

- **`tests/project-responsibilities.e2e.test.ts` (3 fail / 1 error)** — Chromium
  launch failures (`Target.createTarget: Not supported`, `Target page … has been
  closed`); no code path shared with `src/lib/oauth.ts`, reproduce in isolation,
  pre-date this change.
- **smoke tests** — shared-DB limitations (`409 no_provider_key` from
  undecryptable pre-seeded org keys; slow `:3369` boot against the multi-org DB).
  Unrelated to the Figma scope change.

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

The `removedScopes` loop and the `notes`/URL assertions are keyed to the *real*
removed scope (`file_variables:read`), so U1/U3/I1 genuinely fail against the
pre-fix `['files:read', 'file_variables:read']` value and guard the regression.

### Acceptance-scenario coverage

- **AS1** (URL requests only valid read-only scopes) — ✅ verified by I1.
- **AS2** (consent approval → auth code → token exchange) — ❌ unverified (deferred).
- **AS3** (card reports Connected + handle) — ❌ unverified (deferred).
- **AS4** (read tools still work) — ✅ verified by the regression suite (20/20).

---

## Unsatisfied Test Cases

- `[AS2]` — live Figma consent + token exchange — unverified: requires a configured Figma OAuth app and real keys (deferred to manual/UAT per Organization Memory).
- `[AS3]` — integration card reports "Connected" with account handle — unverified: depends on the deferred live flow.
- `[SC-002]` — administrator connects Figma in under 2 minutes — unverified: no timing measurement exists; requires the live flow.

> Resolution note (carried forward): the prior `[U3/U4/U6]` phantom-scope entries
> and the MAJOR root-cause misstatement are long resolved — the `removedScopes`
> loop checks the single real identifier `file_variables:read`, and every artifact
> names `file_variables:read` (Enterprise-only) as the sole removed scope.

---

## 4. Missing tests

- **Live Figma OAuth consent + token exchange (AS2/AS3)** — no automated/CI test;
  accepted, documented deferral (needs real Figma keys), not an accidental omission.
- **A timing test for SC-002** — none exists; not feasible in CI without the live flow.
- **Container-image build** — not executed here (no Docker daemon); the CI
  `docker build` job passes on the PR, so this is a sandbox limitation.
- No other missing tests: U1–U6 + I1 fully cover FR-001…FR-006 and the edge cases.

---

## 5. Remaining defects, risks, and unknowns

- **Environment-only failures** (not feature regressions): 3+1
  `project-responsibilities.e2e.test.ts` Chromium launch failures, and the smoke
  suite's shared-DB limitations.
- **Deferred live verification** — AS2/AS3/SC-002 remain unverified pending a
  manual UAT run against the deployed app with a configured Figma OAuth app
  (recorded post-merge as D005; `quickstart.md` lists `files:read` as the only
  scope to enable).
- **Non-blocking NIT** (from review) — `tests/oauth.test.ts:108` iterates a
  single-element `removedScopes` array; assertion is correct but could be inlined.
- **Delivery** — merged (`main` `3cf7570`, PR #54), CI green, Railway `spaces /
  production` deploy **success**. Duplicate PRs (#56/#57/#58) auto-opened by the
  deliver stage (squash-merge divergence) were closed; none currently open.

---

## 6. Release readiness recommendation

**READY (conditional on the deferred live-UAT item)** — the code is correct, every
automated gate for the feature is green, the artifacts accurately record
`file_variables:read` as the removed scope, and the test suite guards the real
regression. The only outstanding item is the intentionally-deferred live Figma
consent/token-exchange flow (AS2/AS3/SC-002), which requires a configured Figma
app and real keys and is a manual/UAT task recorded for after merge (D005), not a
code, artifact, or test-blocking defect.

**Bottom line**: already merged and deployed with CI green. After the production
deploy confirms healthy, run the manual/UAT Figma connect flow (AS2/AS3/SC-002)
to close the remaining acceptance criteria.