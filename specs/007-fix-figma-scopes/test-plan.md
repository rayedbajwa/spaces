# Test Plan: Fix Invalid Figma OAuth Scopes

**Feature**: `007-fix-figma-scopes` · bugfix
**Repository under test**: `rayedbajwa/spaces` (`/data/aidlc/workspaces/rayedbajwa/spaces`)
**Created**: 2026-09-23
**Source specification**: [spec.md](spec.md) · [plan.md](plan.md) · [tasks.md](tasks.md) · [research.md](research.md) · [data-model.md](data-model.md) · [quickstart.md](quickstart.md)
**Status**: Ready for execution; maps FR-001…FR-006, SC-001…SC-003, the four acceptance scenarios (AS1–AS4), and the four edge cases to unit and regression verification.

## 1. Scope and Feature Overview

This plan verifies that the Figma OAuth provider template requests **only valid
Figma scope identifiers**, fixing the "scopes not valid" error that blocks the
entire Figma integration. The defect is a single, localized drift in
`src/lib/oauth.ts`: the `PROVIDER_TEMPLATES.figma` entry requests the
Enterprise-only `file_variables:read` scope alongside the read-only `files:read`
scope. `file_variables:read` requires a Figma Enterprise plan, so on standard
plans Figma rejects the consent request with a "scope not valid" error before
token exchange.

The fix has two parts under test:

1. **Scope correction** (`src/lib/oauth.ts`) — set `scopes` to `['files:read']`
   (the canonical read-only scope that covers file/node inspection, published
   styles, and published components), removing the Enterprise-only
   `file_variables:read` scope that caused the error.
2. **Administrator guidance** (`src/lib/oauth.ts`) — update the `notes` string
   so admins are told to enable exactly the requested scope.

There is **no database change, no migration, no new module, and no
authorization/tenant-boundary change**. The correction is a static provider
constant; existing connected Figma tokens are unaffected because scopes apply
only to *new* authorization requests. The test strategy is therefore
unit-first, backed by the existing Figma/oauth regression suite. There is no
database integration layer to exercise.

### Quality objectives

- Prove every functional requirement (FR-001…FR-006) and every success
  criterion (SC-001…SC-003) through automated unit assertions (no external keys
  required).
- Prove the scope set is exactly `['files:read']` — contains `files:read` and
  contains **none** of the removed/deprecated/Enterprise identifiers.
- Prove the authorization URL's `scope` query parameter carries only
  `files:read`.
- Prove the admin-facing guidance names only `files:read`.
- Prove the read-only Figma tools and token-exchange tests remain green (no
  regression in the shipped integration, FR-006).

### Out of scope for this plan

- The **live Figma consent + token-exchange flow** (AS2, AS3) — per Organization
  Memory ("E2E tests that require keys can be ignored"), this requires a
  configured Figma OAuth app and real keys and is **not run in CI**; it is
  documented as manual/UAT in `quickstart.md` and deferred in §5.
- Any change to the read-only Figma tools, the knowledge connector, or the
  token exchange itself (none are in scope; the plan only asserts they are
  *unaffected*).
- A CI change — per Organization Memory ("CI update is not necessary as long as
  it is working as expected"), the existing `bun test` job already runs the
  OAuth/Figma unit tests.

## 2. Test Strategy and Levels

The pyramid is unit-heavy. This is a data-free, single-constant bugfix, so the
"integration" level is represented by the authorization-URL assertion (which
glues `PROVIDER_TEMPLATES` → `beginAuthorization` → the `scope=` param) plus the
existing Figma tool/token regression suites; there is no database or external
service to integrate against in CI.

### Unit tests

**Purpose**: Fast, deterministic, key-free verification of the corrected scope
set and guidance.

**Primary target**: `tests/oauth.test.ts` (extend the existing file; it already
imports from `../src/lib/oauth` and exercises `beginAuthorization`).

**Required coverage** (mapped to requirements):

| # | Case | Requirement |
|---|---|---|
| U1 | `PROVIDER_TEMPLATES.figma.scopes` deep-equals `['files:read']` (exact length 1, exact value) | FR-001, FR-002, SC-001 |
| U2 | `PROVIDER_TEMPLATES.figma.scopes` contains `files:read` | FR-002, FR-006 |
| U3 | `PROVIDER_TEMPLATES.figma.scopes` does **not** contain `file_variables:read` (Enterprise-only — the removed scope) | FR-003, FR-004 |
| U4 | `PROVIDER_TEMPLATES.figma.scopes` does **not** contain any deprecated `file_read` identifier | edge case (legacy/deprecated) |
| U5 | `PROVIDER_TEMPLATES.figma.notes` names `files:read` | FR-005 |
| U6 | `PROVIDER_TEMPLATES.figma.notes` does **not** name `file_variables:read` | FR-005 |

The failing test is written first (red‑green): T003 covers U1–U4, T004 adds
U5–U6, T005 adds the URL test below. **Pass threshold**: every case above
passes; T003 must be shown to FAIL against the current
`['files:read', 'file_variables:read']` value before the source fix (T006/T007)
lands.

### Integration-level: authorization-URL assertion

**Purpose**: Prove the scope correction propagates into the actual authorization
URL Figma receives (the literal failure mode in SC-001).

**Primary target**: `tests/oauth.test.ts`, reusing the existing
`beginAuthorization` URL test pattern.

| # | Case | Requirement / success |
|---|---|---|
| I1 | Call `beginAuthorization` with `PROVIDER_TEMPLATES.figma` (dummy `clientId`/`clientSecret`), parse `redirectUrl`, assert the `scope` query parameter equals exactly `files:read` with no other tokens | FR-001, SC-001, AS1 |

**Pass threshold**: I1 passes; the `scope=` value is `files:read` and does not
contain any removed/invalid identifier (the URL contains zero unrecognized scope
names — AS1/SC-001).

### Regression tests

**Purpose**: Prove no regression in the shipped Figma integration (FR-006,
SC-003) — the token exchange and read-only tools are unaffected because
`files:read` authorizes file/node inspection, published styles, and published
components, and `/v1/me` (identity) is not gated by an additional scope.

- `tests/oauth.test.ts` — the existing `beginAuthorization` tests (client_id,
  callback, state, scope expansion) must remain green with the changed scope
  list.
- `tests/integration-token.test.ts` — token exchange / credential round-trip
  unchanged (FR-006).
- `tests/figma-api.test.ts` — Figma API client (identity, file/node inspection)
  unchanged (FR-006).
- `tests/figma-tools.test.ts` — read-only tools (styles, components, knowledge
  connector) unchanged (FR-006, SC-003).

**Pass threshold**: all of the above plus the full `bun test` suite and
`bun run typecheck` are green (T010–T011).

### Smoke tests

**Every PR**: `bun run typecheck` + `bun test tests/oauth.test.ts` + `bun test
tests/figma-tools.test.ts tests/figma-api.test.ts tests/integration-token.test.ts`.

**Merge/release**: the above plus the full `bun test` suite, and the
`quickstart.md` grep/typecheck verification steps (T012).

## 3. Acceptance Coverage and Traceability

| Acceptance area | Spec trace | Planned evidence | Level | Priority |
|---|---|---|---|---|
| Authorization URL requests only valid read-only scopes, zero unrecognized identifiers | AS1; FR-001, FR-002, FR-003; SC-001 | I1 (scope param == `files:read`) + U1–U4 (scope set) | Unit/integration | P0 |
| Scope set includes the read scope for files/nodes/styles/components | FR-002; FR-006 | U2 (`files:read` present) | Unit | P0 |
| Enterprise-only `file_variables:read` not requested | FR-003, FR-004; edge case | U3 | Unit | P0 |
| Deprecated `file_read` not requested | edge case (legacy/deprecated) | U4 | Unit | P0 |
| Admin guidance names exactly the requested scope | FR-005; edge case (admin guidance) | U5, U6 | Unit | P0 |
| Read-only tools + identity + token exchange unaffected | AS4; FR-006; SC-003 | figma-tools, figma-api, integration-token, oauth regression | Regression | P0 |
| Figma presents consent screen (not "invalid scope") | AS2; SC-001 | I1 (URL) in CI; live consent deferred (manual/UAT) | Manual/UAT | P1 (deferred) |
| Token exchange completes; card reports Connected + handle | AS3; SC-002 | Live flow (manual), regression tests for exchange internals | Manual/UAT | P1 (deferred) |

### Edge-case traceability

| Edge case | Where covered |
|---|---|
| Legacy/deprecated scope names not requested | U4 (`file_read` prohibited) |
| Enterprise-only scopes not required | U3 (`file_variables:read` prohibited) |
| Wrong-but-recognized vs. not-valid scope distinction | Documented (deferred to live Figma behavior; not reproducible without a Figma app — see §5) |
| Admin guidance matches requested scopes | U5, U6 |

## 4. Test Data and Environment Needs

### Required fixtures and identity

This feature is **data-free**. All inputs are the static provider constant in
`src/lib/oauth.ts` and a dummy `OAuthProviderConfig` (client id/secret, callback
URL) for the `beginAuthorization` URL assertion.

- **Unit fixtures**: `PROVIDER_TEMPLATES.figma` imported directly from
  `../src/lib/oauth` (already exported — no source refactor needed to enable
  testing); a dummy Figma config for the URL test.
- **No database fixtures, no tenant/role identities, no provider keys, no
  `.env` secrets** are required for the automated gates.

### Environment

- **No database** is needed (no schema, no migration, no `DATABASE_URL`).
- **Bun** for `bun test` and `bun run typecheck`.
- The **live Figma consent flow** (AS2/AS3) additionally requires a configured
  Figma OAuth app with `files:read` enabled and real keys — documented in
  `quickstart.md`, not run in CI.

### Suggested commands

Run from `/data/aidlc/workspaces/rayedbajwa/spaces` after implementation:

```bash
bun install --frozen-lockfile                     # once (T001)
bun run typecheck                                 # gate
bun test tests/oauth.test.ts                      # U1–U6, I1 (the fix's core)
bun test tests/figma-tools.test.ts tests/figma-api.test.ts tests/integration-token.test.ts  # regression (T010)
bun test                                          # full suite (T011)

# Source confirmation (T012 / quickstart)
grep -n "files:read\|file_variables:read" src/lib/oauth.ts
```

## 5. Risks, Gaps, and Deferred Verification

| Risk or gap | Impact | Mitigation / verification | Status |
|---|---|---|---|
| Live Figma consent/token exchange requires real keys and a configured app | AS2/AS3 cannot be verified in CI; the "invalid scope → consent" fix is proven only at the URL level | I1 proves zero unrecognized scope names (the root cause); live flow is documented as manual/UAT per Organization Memory | Deferred |
| The "wrong-but-recognized" vs. "not-valid" scope distinction (edge case) is only observable against a live Figma app | Cannot automate without keys; a wrongly-enabled scope's "scope does not match"/"inactive scope" message is indistinguishable in unit tests | Document as a UAT observation; I1 guarantees no *unrecognized* identifier is sent, which is the defect being fixed | Deferred |
| No new module/database boundary | N/A — static constant change | Full `bun test` regression plus typecheck guards against unintended fallout | N/A |
| Assertions could over-fit the exact notes string | Brittle test if wording changes later | U5/U6 assert *presence/absence of scope names* (`files:read` named; `file_variables:read` absent) rather than the full literal sentence | Mitigated |
| CI coverage is intentionally unchanged | A future drift in the scope list would only be caught by the unit test if it remains in the default `bun test` suite | Confirm `tests/oauth.test.ts` is already reached by CI's unit-test job (it is an existing file); re-evaluate a dedicated CI job only if a regression surfaces | Accepted |

## 6. Automation Priorities

### P0 — merge-blocking

1. Scope-set unit assertions U1–U6 (`tests/oauth.test.ts`).
2. Authorization-URL assertion I1 (`scope=files:read` only).
3. Regression: `tests/oauth.test.ts` + `tests/integration-token.test.ts` +
   `tests/figma-api.test.ts` + `tests/figma-tools.test.ts` green.
4. `bun run typecheck` green.

### P1 — required before feature release

1. Full `bun test` suite green (no unintended behavior change anywhere).
2. `quickstart.md` source-confirmation steps (grep scope identifiers +
   typecheck + tests) pass.

### P2 — release evidence / follow-up

1. **Manual/UAT live Figma flow** (AS2/AS3): in a deployed environment with a
   configured Figma app, confirm the address-bar `scope=files:read`, Figma
   presents the consent screen, and the card reports **Connected** with the
   account handle (SC-001, SC-002). Recorded after merge (D005), not in CI.

## 7. Entry, Exit, and Reporting Criteria

### Entry criteria

- Feature branch `007-fix-figma-scopes` checked out in `rayedbajwa/spaces`.
- `bun install --frozen-lockfile` succeeds (T001).
- `bun run typecheck` and `bun test tests/oauth.test.ts` record a **green
  baseline** before the source change (T002).

### Exit criteria

- The red test (T003) demonstrably failed against the buggy scope list and now
  passes after the fix (red-green proven).
- U1–U6 and I1 all pass.
- Regression suites (oauth, integration-token, figma-api, figma-tools) and the
  full `bun test` + `bun run typecheck` are green.
- `grep` of `src/lib/oauth.ts` shows `scopes: ['files:read']` and none of the
  removed identifiers.

### Defect reporting

Each defect report MUST include: the exact `PROVIDER_TEMPLATES.figma.scopes`
value observed, the exact `scope=` query parameter in a reproduced
`beginAuthorization` URL, whether `notes` names a removed scope, the expected
vs. actual scope set, and the `bun test tests/oauth.test.ts` output. No defect
report should contain secrets — the Figma `clientId`/`clientSecret` used in the
URL test must be dummy values, never real keys.

## Summary

This test plan defines a unit-first, key-free strategy for the Figma OAuth scope
fix, tracing all four acceptance scenarios, FR-001…FR-006, SC-001…SC-003, and
every spec edge case to concrete automatable assertions in
`tests/oauth.test.ts` (scope set, admin guidance, and an authorization-URL
`scope=` check) backed by the existing Figma/OAuth regression suites. Because the
feature is a static provider-constant change with no database, migration, or
authorization surface, the plan deliberately omits a database integration layer
and relies on the URL-level assertion as the equivalent of an integration check.

**Uncovered / residual risks:**

1. **Live Figma consent + token exchange (AS2/AS3)** cannot run in CI without a
   configured Figma app and real keys; the plan proves zero unrecognized scope
   names at the URL level (the actual root cause) but defers consent/token
   exchange to manual/UAT — this is documented, not undiscovered.
2. **The "wrong-but-recognized vs. not-valid scope" edge case** is only
   observable against a live Figma app and is deferred to UAT; the automated
   assertions guarantee no *unrecognized* identifier is ever sent.
3. **CI coverage is intentionally unchanged** per Organization Memory — the
   existing `tests/oauth.test.ts` is the ongoing guard; a future drift in the
   scope list is caught by it only if it remains in the default `bun test`
   suite, which T002/T010/T011 confirm it is.
4. **No cross-repository or data risk** — the change is confined to
   `src/lib/oauth.ts` in `rayedbajwa/spaces`; existing connected Figma tokens are
   unaffected because scopes apply only to new authorization requests.