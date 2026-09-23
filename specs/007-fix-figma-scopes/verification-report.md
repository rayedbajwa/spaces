# Verification Report: Fix Invalid Figma OAuth Scopes

Verification Status: PARTIAL
Acceptance Criteria Met: 7/9
Critical Issues Open: 0

**Feature**: `007-fix-figma-scopes` · bugfix
**Repository under test**: `rayedbajwa/spaces` (`/data/aidlc/workspaces/rayedbajwa/spaces`)
**Branch**: `007-fix-figma-scopes` (HEAD `b29f2c0`, fix commit `6dfb1bd`)
**Date**: 2026-09-23 · QA stage

---

## 0. Executive summary

The **code fix is correct and fully verified** — `src/lib/oauth.ts` now requests
only `files:read`, removing the Enterprise-only `file_variables:read` that caused
Figma's "scopes not valid" error. Every automated gate for this feature passes:
`bun run typecheck` is clean, the OAuth unit suite is `14 pass / 1 skip / 0 fail`,
and the Figma regression suite (`figma-tools`, `figma-api`, `integration-token`) is
`20 pass / 0 fail`.

However, verification is **PARTIAL** for two reasons that are not code defects:

1. **The feature's own artifacts (spec, plan, research, tasks, test-plan, quickstart)
   contain a factually wrong root cause.** All six documents claim the pre-fix scope
   list was `current_user:read`, `file_content:read`, `library_assets:read`. Git
   history proves the pre-fix value was actually
   `['files:read', 'file_variables:read']`. The *real* defect — and the *real* fix —
   is that `file_variables:read` (Enterprise-only, not "invalid") was being requested
   and is now removed. Three of the "regression" test assertions (U3/U4/U6) assert the
   *absence* of identifiers that never existed, so they pass against the buggy code
   and only the exact-equal (U1), `file_variables:read`-exclusion (U5), and URL (I1)
   assertions actually guard the fix.
2. **Acceptance scenarios AS2/AS3 and success criterion SC-002 are unverified** — the
   live Figma consent + token-exchange flow requires a configured Figma app and real
   keys, which is deferred to manual/UAT per Organization Memory ("E2E tests that
   require keys can be ignored").

No release-blocking defect (data loss, security, broken core journey, or failing
must-have requirement) is present: the code is correct, least-privilege is actually
*improved*, and the Figma connect journey is genuinely fixed.

---

## 1. Test execution

Commands run in `/data/aidlc/workspaces/rayedbajwa/spaces` (Bun 1.4.2), each with a
time limit.

| Command | Result | Duration |
|---|---|---|
| `bun run typecheck` (`tsc --noEmit`) | **PASS** (clean, exit 0) | ~5.6s |
| `bun test tests/oauth.test.ts` | **14 pass / 1 skip / 0 fail** (32 expect calls) | 13ms |
| `bun test tests/figma-tools.test.ts tests/figma-api.test.ts tests/integration-token.test.ts` | **20 pass / 0 fail** (89 expect calls) | 2.5s |
| `bun test --timeout=20000 --max-concurrency=4` (full suite) | **444 pass / 9 skip / 3 fail / 1 error** (456 tests, 65 files, 1633 expect calls) | 405.6s |

### The 3 failures + 1 error (full suite only)

All four are in `tests/project-responsibilities.e2e.test.ts` (`responsibility
management UI` describe block) and are **browser-launch/environment errors**, not
feature defects:

- `(fail) the owner sees all six roles, status badges and edit controls` — timed out after 20s; `waitFor: Target page, context or browser has been closed`
- `(fail) an owner assigns an ordered member and the order survives a reload` — `newPage: Protocol error (Target.createTarget): Not supported`
- `(fail) an ordinary member sees the statuses but no edit controls` — `newContext: Target page, context or browser has been closed`
- `(error) # Unhandled error between tests` — same browser-teardown root cause

**Independence check:** these tests exercise the React responsibility-management UI.
They share no code path with `src/lib/oauth.ts` (the only source file changed). The
failure is reproduced identically in isolation (`bun test
tests/project-responsibilities.e2e.test.ts` → `0 pass / 3 fail / 1 error`), is a
Playwright/Chromium `Target.createTarget: Not supported` launch limitation, and is
pre-existing (unrelated to the one-line scope change). The 9 skips are the 8
`smoke.test.ts` cases (no `AUTH_DISABLED` server on `:3000`) plus 1 OAuth backdated-
clock test — all environmental.

---

## 2. Requirement-by-requirement verification (traceability)

| Req | Description | Test | Result |
|---|---|---|---|
| FR-001 | Request only valid Figma scope identifiers | U1 (deep-equal `['files:read']`), I1 (URL `scope=files:read`) | ✅ PASS |
| FR-002 | Include `files:read` for file/node/style/component reads | U2 (`files:read` present) | ✅ PASS |
| FR-003 | Do **not** request `file_content:read` or `current_user:read` | U3, U4 | ✅ PASS (vacuous — see §5.1) |
| FR-004 | Do **not** require Enterprise-only `file_variables:read` | U5 (`file_variables:read` absent) | ✅ PASS — this is the actual fix |
| FR-005 | Admin guidance lists exactly the requested scope | U8 (`notes` names `files:read`), U9 (absent removed names) | ✅ PASS |
| FR-006 | Read capabilities unchanged (no regression) | figma-tools (TC-FIG-001…006), figma-api (TC-API-001…005), integration-token | ✅ PASS (20/20) |
| SC-001 | Zero unrecognized scopes; Figma shows consent, not "invalid scope" | I1 (URL-level proof) | ⚠️ PARTIAL — URL proven; live consent deferred |
| SC-002 | Connect completes in under 2 minutes | none automated | ❌ UNVERIFIED (deferred — live flow) |
| SC-003 | 100% of read-only tool paths unchanged | figma regression suite | ✅ PASS |

### Acceptance-scenario coverage

- **AS1** (URL requests only valid read-only scopes) — ✅ verified by I1.
- **AS2** (consent approval → auth code → token exchange) — ❌ unverified (deferred).
- **AS3** (card reports Connected + handle) — ❌ unverified (deferred).
- **AS4** (read tools still work) — ✅ verified by regression suite.

---

## Unsatisfied Test Cases

- `[AS2]` — live Figma consent + token exchange — unverified: requires a configured Figma OAuth app and real keys (deferred to manual/UAT per Organization Memory); no automated evidence exists.
- `[AS3]` — integration card reports "Connected" with account handle — unverified: depends on the deferred live flow.
- `[SC-002]` — administrator connects Figma in under 2 minutes — unverified: no timing measurement exists; requires the live flow.
- `[U3/U4/U6]` — scope-exclusion assertions for `current_user:read`, `file_content:read`, `library_assets:read` — weak/no-op guards: these identifiers never existed in the pre-fix code (`git show 79fac3c:src/lib/oauth.ts` → `['files:read', 'file_variables:read']`), so these three assertions pass against the *buggy* code too and do not guard the actual regression. Only U1 (exact equality), U5 (`file_variables:read` exclusion), and I1 (URL `scope=files:read`) actually fail against the buggy scope list.

---

## 4. Missing tests

- **Live Figma OAuth consent + token exchange (AS2/AS3)** — no automated or CI test
  exists. This is an accepted, documented deferral (needs real Figma keys), not an
  accidental omission, but the spec's AS2/AS3 have **no passing test** of any kind;
  they are proven only at the URL level (I1) plus the internal `integration-token`
  and `figma-api` mock/credential-sealing tests.
- **A regression test keyed to the *actual* removed scope** is effectively present
  (U5 + I1 cover `file_variables:read` and the exact `scope=files:read`), so the fix
  *is* guarded — but the surrounding `removedScopes` loop mixes real
  (`file_variables:read`) and phantom (`current_user:read`/`file_content:read`/
  `library_assets:read`) names, which dilutes the guard's readability.

---

## 5. Remaining defects, risks, and unknowns

### 5.1 MAJOR — the feature artifacts misstate the root cause (factual error)

Every stage artifact — `spec.md` (Problem Statement, FR-003), `plan.md`,
`research.md` (§1 "Rationale", §2 "Where the change lives"), `tasks.md`
(execution notes claiming a red-test `Received: ["current_user:read", ...]`),
`test-plan.md` (§1, U3/U4/U6), and `quickstart.md` ("What changed") — claim the
pre-fix scope list was `current_user:read`, `file_content:read`, `library_assets:read`.

**Verified false.** `git show 79fac3c:src/lib/oauth.ts` (the `006-figma-integration`
commit that introduced the Figma entry) shows:

```
scopes: ['files:read', 'file_variables:read'],
notes: 'OAuth 2.0 app. Enable files:read and file_variables:read scopes in your Figma app settings.',
```

The identifiers `current_user:read`, `file_content:read`, and `library_assets:read`
appear **nowhere** in `src/` before or after the fix — only in the new test
assertions and the spec artifacts. The actual defect is that `file_variables:read`
is **Enterprise-only**; requesting it on a standard Figma app produces the "scope
not valid" error. The spec even acknowledges this in FR-004 and the "Enterprise-only
scopes" edge case, but its primary Problem Statement and FR-003 describe a state that
never existed, and `tasks.md`'s execution notes fabricate a red-test output
(`Received: ["current_user:read", ...]`) that contradicts git history.

**Impact**: not a code defect, but a material integrity problem in the deliverable
artifacts. Any reader of the spec/tasks is misled about what the bug was and how the
fix was verified. **This should be corrected** (rewrite the Problem Statement, FR-003,
and the fabricated T003 red-test evidence to name `file_variables:read` as the
removed scope) before the artifacts are treated as an accurate record.

### 5.2 MINOR — three test assertions target phantom scopes

U3 (`current_user:read`), U4 (`file_content:read`), U6 (`library_assets:read`)
assert the absence of identifiers that were never present, so they would pass against
the buggy code and carry no regression-guarding power. The fix is nevertheless
genuinely protected by U1 (exact `['files:read']` equality), U5
(`file_variables:read` exclusion), and I1 (URL `scope` equals exactly `files:read`).

### 5.3 Environment-only (not feature) failures

The 3 `project-responsibilities.e2e.test.ts` failures + 1 error are Chromium launch
errors (`Target.createTarget: Not supported`, browser closed). They are unrelated to
this feature and reproduce in isolation. They do not block this feature's acceptance.

### 5.4 Deferred live verification

AS2, AS3 and SC-002 remain unverified pending a manual UAT run against a deployed
app with a configured Figma OAuth app (documented in `quickstart.md` "Manual OAuth
flow"). `quickstart.md` correctly lists `files:read` as the only scope to enable.

---

## 6. Release readiness recommendation

**CONDITIONALLY READY** — the code is correct, least-privilege is improved, and all
automated gates for the feature are green. Two non-code items should be resolved
before the review/acceptance gate is treated as fully satisfied:

1. **(Required, artifact integrity)** Correct the root-cause narrative in `spec.md`,
   `plan.md`, `research.md`, `tasks.md`, `test-plan.md`, and `quickstart.md` so they
   name `file_variables:read` (Enterprise-only) as the removed scope, and replace the
   fabricated T003 red-test evidence with the actual pre-fix value
   `['files:read', 'file_variables:read']`. (This was already raised as
   CHANGES_REQUESTED in the code-review stage.)
2. **(Recommended, test clarity)** Drop the phantom-scope assertions U3/U4/U6 (or
   convert the `removedScopes` loop to the single real identifier
   `file_variables:read`) so the test names reflect what actually guarded the
   regression.

The deferred live Figma flow (AS2/AS3/SC-002) is a manual/UAT item recorded for after
merge (D005), not a blocker.

**Bottom line**: ship the fix; do not sign off the artifacts as an accurate record
until item (1) is corrected.