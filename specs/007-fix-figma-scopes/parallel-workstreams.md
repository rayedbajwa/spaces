# Parallel Execution Plan: Fix Invalid Figma OAuth Scopes

**Feature**: `007-fix-figma-scopes` · bugfix
**Application repository**: `rayedbajwa/spaces` (`/data/aidlc/workspaces/rayedbajwa/spaces`)
**Governance repository**: `governance` (`/data/aidlc/workspaces/_governance/spaces-3f701200`)
**Source**: [tasks.md](tasks.md) · [plan.md](plan.md) · [spec.md](spec.md) · [test-plan.md](test-plan.md) · [data-model.md](data-model.md) · [quickstart.md](quickstart.md)
**Status**: Ready for implementation — tasks T001–T012 + D001–D005 defined.

---

## Scope Note & Honest Concurrency Assessment

This is a **single-source-file bugfix plus one unit-test-file extension**. The
correct scope set lives entirely in the `PROVIDER_TEMPLATES.figma` block of
`src/lib/oauth.ts` (lines ~169–182: `scopes`, `notes`, and the comment block),
and every new assertion lands in the existing `tests/oauth.test.ts`. There is
no database change, no migration, no new module, and no frontend change.

Because the whole feature is three lines of `oauth.ts` plus a handful of
assertions, **full multi-workstream parallelism is neither possible nor
valuable** — two workstreams can genuinely overlap during implementation
(source vs. test), and one governance-only artifact workstream is fully
independent of the code. The tasks.md note ("No parallel workstreams are
required") is technically correct at the *file* granularity, but the `[P]`
markers still permit a **source-vs-test split** with a single merge
checkpoint, which is what this plan formalizes in machine-readable form.

### Cross-Repository Note

Only `rayedbajwa/spaces` is changed by runtime code. The `governance` workspace
hosts these Spec Kit artifacts, and T009 (generate `test-plan.md`) is the only
governance-side task. No cross-repository contract changes; there is no
governance-vs-application merge ordering requirement (unlike 006).

---

## Workstream 1: Figma Provider Template Correction (Source)

### Repository

rayedbajwa/spaces

### Tasks

- **Task IDs**: T006, T007
- T006 `[US1]`: In `src/lib/oauth.ts`, set `PROVIDER_TEMPLATES.figma.scopes` to `['files:read']` and replace the `// Read-only granular scopes:` comment with an accurate note (maps to FR-002, FR-003, FR-004).
- T007 `[US1]`: In `src/lib/oauth.ts`, update `PROVIDER_TEMPLATES.figma.notes` to `'OAuth 2.0 app. Enable the read-only scope files:read in your Figma app settings.'` (maps to FR-005).

**Proposed sub-agent assignment**: OAuth Provider Fix Engineer.

### Inputs

- The **red test** from Workstream 2 (T003) — must be present and demonstrated failing before these edits land.
- `specs/007-fix-figma-scopes/spec.md` (FR-001…FR-005, edge cases).
- `specs/007-fix-figma-scopes/research.md` (§ scope-name resolution).
- `specs/007-fix-figma-scopes/plan.md` (§ Technical Context).
- Existing module: `src/lib/oauth.ts` (`PROVIDER_TEMPLATES.figma`, lines ~169–182).

### Outputs

- `PROVIDER_TEMPLATES.figma.scopes === ['files:read']` (exactly one scope).
- `PROVIDER_TEMPLATES.figma.notes` names only `files:read`.
- Accurate comment block documenting `files:read` coverage and why Enterprise-only `file_variables:read` is not requested.
- **Merge Checkpoint 1 (US1 Source Correction)**: source change green against the test suite at T008.

### Dependencies

- **Blocked by**: Workstream 2's T003 (failing test in place); Phase 1 setup (T001) and Phase 2 baseline (T002).
- **Can run in parallel with**: Workstream 2's T004/T005 (test-file additions) — disjoint files (`src/lib/oauth.ts` vs `tests/oauth.test.ts`).
- **Blocks**: T008 (green confirmation), Phase 4 regression (T010–T012), and delivery (D001–D005).

### Scoped Files

- `src/lib/oauth.ts` (the `figma` entry only)

Do **not** modify `tests/oauth.test.ts`, any other `tests/*`, `src/server.ts`, `src/web/`, or any governance artifact.

### QA Focus

- **Exact scope set**: `scopes` must deep-equal `['files:read']` — length 1, exact value.
- **Removed identifiers absent**: `file_variables:read` (Enterprise-only) and any deprecated `file_read` must not appear anywhere in the `figma` block.
- **Guidance parity**: the `notes` string must list exactly the scope requested (`files:read`), never a removed scope.
- **Least privilege**: narrowing (not widening) — no new capabilities, read-only only.

---

## Workstream 2: Figma Scope Test Suite (Red-Green)

### Repository

rayedbajwa/spaces

### Tasks

- **Task IDs**: T003, T004, T005
- T003 `[P]`: Add the failing unit test for the corrected scope set in `tests/oauth.test.ts` — import `PROVIDER_TEMPLATES` from `../src/lib/oauth` and assert `figma.scopes` deep-equals `['files:read']`, contains `files:read`, and does NOT contain `file_variables:read` (the Enterprise-only scope removed by this fix) (FR-001…FR-004). Confirm it FAILS against the current buggy value.
- T004 `[P]` `[US1]`: Add the admin-guidance assertion — `figma.notes` names `files:read` and does NOT name `file_variables:read` (FR-005).
- T005 `[P]` `[US1]`: Add the Figma authorization-URL assertion — call `beginAuthorization` with `PROVIDER_TEMPLATES.figma` + dummy `clientId`/`clientSecret`, parse `redirectUrl`, assert the `scope` query parameter equals exactly `files:read` (FR-001, SC-001).

**Proposed sub-agent assignment**: OAuth Test Engineer.

### Inputs

- Phase 2 green baseline (T002) recorded first.
- `specs/007-fix-figma-scopes/spec.md` (FR-001…FR-005, SC-001, acceptance scenario AS1).
- `specs/007-fix-figma-scopes/test-plan.md` (§ 2 unit cases U1–U6, integration case I1).
- Existing module: `tests/oauth.test.ts` (already imports `../src/lib/oauth` and exercises `beginAuthorization`).

### Outputs

- Red test (T003) proven failing against the buggy `['files:read', 'file_variables:read']` value.
- Guidance (U5–U6) and URL (I1) assertions in `tests/oauth.test.ts`.
- **Merge Checkpoint 2 (Red Test in Place)**: emitted *before* Workstream 1 begins; signals the gate for T006/T007.

### Dependencies

- **Blocked by**: T001 (branch + frozen install) and T002 (green baseline).
- **Can run in parallel with**: T004/T005 run in parallel with Workstream 1's T006/T007 (different files). T003 itself is a hard gate for Workstream 1 and must only be shown failing first.
- **Blocks**: T008 (green confirmation).

### Scoped Files

- `tests/oauth.test.ts` (add Figma scope-set, guidance, and URL assertions)

Do **not** modify `src/lib/oauth.ts`, `src/server.ts`, or any governance artifact. Use dummy `clientId`/`clientSecret` values (never real keys).

### QA Focus

- **Red-green discipline**: T003 must be confirmed FAILING before T006/T007 are applied; do not edit source to make the test pass out of order.
- **Presence/absence over literal-match**: assert `files:read` is present and removed names are absent rather than over-fitting the exact `notes` sentence (mitigates brittleness).
- **URL assertion**: reconstruct the `scope=` query param and assert it is exactly `files:read` with no other token; do not hard-code a full URL.
- **No secrets**: dummy client id/secret only; never log or assert real Figma credentials.

---

## Workstream 3: Governance Test-Plan Traceability Artifact

### Repository

governance

### Tasks

- **Task IDs**: T009
- T009 `[P]`: Generate `specs/007-fix-figma-scopes/test-plan.md`, mapping acceptance scenarios AS1–AS4 plus FR-001…FR-006 and SC-001…SC-003 to concrete test cases, following `specs/004-fix-version-api/test-plan.md` section structure.

**Proposed sub-agent assignment**: Governance Test-Plan Writer.

### Inputs

- `specs/007-fix-figma-scopes/spec.md`, `plan.md` (§ Test Planning), `data-model.md`, `quickstart.md`.
- `specs/004-fix-version-api/test-plan.md` (structure reference).

### Outputs

- `specs/007-fix-figma-scopes/test-plan.md` with full acceptance/requirement/success-criteria traceability.
- **Merge Checkpoint 3 (Traceability Artifact Present)**: no code dependency; independent of Workstreams 1–2.

### Dependencies

- **Blocked by**: nothing (governance-only; can start immediately).
- **Can run in parallel with**: Workstreams 1 and 2 (no shared files).
- **Blocks**: nothing in the code path.

### Scoped Files

- `specs/007-fix-figma-scopes/test-plan.md`

Do **not** modify any file in `rayedbajwa/spaces`, nor `spec.md`/`plan.md`/`tasks.md` in this feature directory.

### QA Focus

- **Traceability completeness**: every acceptance scenario (AS1 invalid-scope-free URL, AS2 consent/token exchange, AS3 connected status, AS4 read-tool regression) and every FR/SC must map to at least one concrete test case.
- **Consistency with tasks.md**: T003/T004/T005 in the plan must match the unit/integration cases (U1–U6, I1) the test workstream actually authors.
- **Key-free stance**: mark the live Figma consent flow (AS2/AS3) as manual/UAT per Organization Memory ("E2E tests that require keys can be ignored").

---

## Sequential Work and Merge Checkpoints

The following tasks and transitions **MUST remain strictly sequential**:

1. **Phase 1 Setup (T001)**: Check out `007-fix-figma-scopes` in `rayedbajwa/spaces` and confirm `bun install --frozen-lockfile`. First; nothing else starts before this.
2. **Phase 2 Baseline (T002)**: `bun run typecheck` + `bun test tests/oauth.test.ts` green on the unmodified tree. Records the pre-change baseline.
3. **Red test (T003)**: Written and demonstrated **failing** before any `src/lib/oauth.ts` edit. This is the hard gate (Merge Checkpoint 2) that unblocks Workstream 1.
4. **Source implementation (T006 → T007)**: Both touch the same adjacent `figma` block in `src/lib/oauth.ts`; they stay sequential to each other (a single commit is acceptable). Cannot start until T003's red test is in place.
5. **Green confirmation (T008)**: `bun test tests/oauth.test.ts` + `bun run typecheck` must turn green only after T006/T007 have landed alongside T004/T005. This is **Merge Checkpoint 1**, the integration point for Workstreams 1 and 2.
6. **Phase 4 regression (T010 → T011 → T012)**: Must run sequentially after T008 green. T010 (Figma regression suite) and T011 (full `bun test` + typecheck) must not run ahead of the source fix; T012 (`quickstart.md` verification) last.
7. **Delivery (D001 → D005)**: PR open → CI green → human review approval → merge → deploy + final acceptance checks. D003 (review), D004 (merge), and D005 (deploy) are **strictly human-gated** per AIDLC Directives and Org Review Policies — never merge or deploy autonomously.

---

## QA Coordination Notes

- **Disjoint file isolation**: Workstream 1 owns `src/lib/oauth.ts`; Workstream 2 owns `tests/oauth.test.ts`; Workstream 3 owns `specs/007-fix-figma-scopes/test-plan.md`. These are mutually disjoint — no sub-agent edits another workstream's file. The only "collision" is logical (red-green), not textual.
- **Red-green ordering is a correctness invariant, not a file dependency**: Workstream 1 must not touch `src/lib/oauth.ts` until T003 is committed/visible as failing. Coordinate through Merge Checkpoint 2, not by waiting on the whole test file.
- **Typecheck gate before merge**: both `bun run typecheck` and `bun test tests/oauth.test.ts` must be green together (T008) — a source edit without the matching test, or vice versa, must not be called done.
- **Key-free CI**: no Figma app, keys, or live consent flow is exercised in CI. The URL-level assertion (I1) is the CI-equivalent integration proof of SC-001. Live AS2/AS3 verification is manual/UAT and deferred to D005.
- **No schema / no migration**: no `DATABASE_URL`, no `db:migrate`, no `db:up` required for any automated gate (confirmed by data-model.md). Do not introduce one.
- **No CI changes**: per Organization Memory ("CI update is not necessary as long as its working as expected"), do not touch `.github/workflows/*.yml`.
- **Artifact state reality**: `specs/007-fix-figma-scopes/test-plan.md` already exists in the checkout (it was prepared at the plan stage). T009 is therefore effectively a *verify-and-refresh* (confirm traceability and sync with the exact assertions T003–T005 author) rather than a from-scratch write; the Workstream 3 sub-agent should reconcile, not recreate.
- **Port discipline**: if any local server smoke test is run, use `PORT=3369`; never bind port 3000 (reserved for the agent runtime).

---

## Concurrency Recommendation

**Safe concurrency: up to 2 concurrent code workstreams** (Workstream 1 source +
Workstream 2 tests) **during Phase 3**, after the red test (T003) is in place.
Workstream 3 (governance `test-plan.md`) may run concurrently at any time with
zero conflict since it touches no application files.

Concretely:

1. **Phase 1–2 (sequential, single operator)**: T001 → T002 → T003. Only T003's
   red state must be confirmed before moving on.
2. **Phase 3 (2-way parallel)**: launch Workstream 1 (T006/T007 on
   `src/lib/oauth.ts`) and the remaining Workstream 2 tasks (T004/T005 on
   `tests/oauth.test.ts`) simultaneously. Workstream 3 (T009) can run at the
   same time.
3. **Phase 4 + Delivery (sequential)**: converge at T008 (Merge Checkpoint 1),
   then run T010 → T011 → T012 and the human-gated D001–D005 in order.

**Do not run more than 2 concurrent code workstreams** — the feature is a
single-file source change plus a single test file, and a third code workstream
would have no disjoint files to operate on, guaranteeing merge conflicts for
zero throughput gain.