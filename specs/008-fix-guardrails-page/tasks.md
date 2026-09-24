# Tasks — 008-fix-guardrails-page

Repository-local tasks for initiative **008-fix-guardrails-page** (Feature Specification: Fix and Modernize the Data Guardrails Page). Planning lives in the governing workspace; this file is what this repository owns. Tick items as they land; the pipeline commits it with the code.

## Browser regression test harness and tests
- [x] T003 [P] Create the Playwright fixture `tests/helpers/guardrails-page.ts` in `/data/aidlc/workspaces/rayedbajwa/spaces` that creates an organization, a team, an owner and a member, mints session tokens, builds the SPA with `NODE_ENV=development bun run build:web`, and starts `src/server.ts` on a free port unless `SPACES_E2E_BASE_URL` is set, falling back to the existing `RESPONSIBILITY_BASE_URL` (the env var the CI browser step exports) so T014 reuses the :3100 server rather than spawning another (research R5, R6)
- [x] T004 [US1] Add the desktop and mobile alignment and no-overflow assertions (one radio left edge and width, one text-column left edge, heading/options/textarea/save aligned to the section content edge within 1px, zero horizontal overflow at 1440px and 390px) to `tests/guardrails-page.e2e.test.ts` in `/data/aidlc/workspaces/rayedbajwa/spaces` (FR-001, FR-002, FR-003, FR-004, FR-005, SC-001)
- [x] T005 [US1] Add the owner select → edit never-mask → save → reload round-trip test (asserting the mode and allow-list render after reload and `GET /api/org/guardrails` returns the saved policy) to `tests/guardrails-page.e2e.test.ts` in `/data/aidlc/workspaces/rayedbajwa/spaces` (FR-006, SC-002)
- [x] T006 [US1] Add the read-only member/viewer test (aligned and readable content, disabled controls, and the existing "Only team owners or admins can change the guardrails." message) to `tests/guardrails-page.e2e.test.ts` in `/data/aidlc/workspaces/rayedbajwa/spaces` (FR-006, FR-007)
- [x] T007 [US1] Add the accessibility assertions (the `role="radiogroup"` keeps its accessible name, each radio stays associated with its label, and the never-mask textarea keeps an associated label) to `tests/guardrails-page.e2e.test.ts` in `/data/aidlc/workspaces/rayedbajwa/spaces` (FR-007)
- [x] T008 [US1] Add the edge-case assertions (longest mode description does not break the text column, an empty/cleared never-mask list keeps the field and button aligned with the correct enabled state, a very long single-line allow entry does not overflow, the in-flight disabled state does not shift layout, and success/error messages do not break alignment) to `tests/guardrails-page.e2e.test.ts` in `/data/aidlc/workspaces/rayedbajwa/spaces` (spec Edge Cases)
- [x] T012 [US1] Run `bun test tests/guardrails-page.e2e.test.ts` and `bun run typecheck` in `/data/aidlc/workspaces/rayedbajwa/spaces` and confirm the T004–T008 tests now pass (green)

**Scoped files**
- May create/modify **only**: `tests/guardrails-page.e2e.test.ts`, `tests/helpers/guardrails-page.ts`
- May read, but never modify: `src/web/guardrails.tsx`, `src/web/styles.css`, `src/server.ts`, `src/lib/guardrails-policy.ts`, existing `tests/**`
- Tests to run: `bun test tests/guardrails-page.e2e.test.ts`, `bun run typecheck`

**Outputs**
- `tests/helpers/guardrails-page.ts` (new)
- `tests/guardrails-page.e2e.test.ts` (new) — first failing against current markup (T004–T008 red), then passing after T009–T011 (T012)
- A recorded red-green evidence note for `test-plan.md` entry criteria

**Depends on**
- T001 (branch + frozen install) and T002 (green baseline) must be done first.
- T003 precedes T004–T008 (the tests need the fixture to run).
- T004–T008 are one file and therefore sequential; they must be shown **failing** before T009–T011 begin (red-green gate).
- T012 depends on Workstream 2 (T009) and Workstream 3 (T010, T011) landing.

**QA focus**
- Prove the fixture builds the SPA (`NODE_ENV=development`) or reuses the CI-built assets so it never asserts against a stale `public/` bundle (R6).
- Assertions must be structural (shared left edge/width, zero overflow, alignment within the 1px tolerance) and ASCII-safe; measure radios/text columns from bounding boxes, not hard-coded pixels beyond the 1px tolerance.
- Entry/exit evidence: record that T004–T008 failed before T009–T011 and passed after; this is a hard `test-plan.md` exit criterion.

---
## Component markup (mode rows, never-mask field)
- [x] T009 [P] [US1] Rework `src/web/guardrails.tsx` in `/data/aidlc/workspaces/rayedbajwa/spaces`: give each mode a stable control column plus a `min-width: 0` text column (keeping `role="radiogroup"`/`aria-label`, the `selected`/`readonly` classes and the same labels/values), and give the never-mask textarea an explicit `<label htmlFor>`/`id` plus an `aria-describedby` hint (research R2, R3; contracts/ui-contract.md)

**Scoped files**
- May modify **only**: `src/web/guardrails.tsx`
- May read, but never modify: `src/web/styles.css`, `src/main.tsx`, `src/lib/guardrails-policy.ts`, `tests/**`
- Tests to run: `bun run typecheck` (the browser suite is owned and executed by Workstream 1 at T012)

**Outputs**
- Updated `src/web/guardrails.tsx` with stable layout hooks and the target accessibility associations

**Depends on**
- Same as Workstream 3: requires T001, T002 and the **red** T004–T008.
- No dependency on Workstream 3 (different file); the two run concurrently.

**QA focus**
- Zero behaviour change: modes, labels, descriptions, defaults, permission gating, never-mask semantics and persistence stay identical (FR-008).
- Preserve `role="radiogroup"` and its accessible name; each radio stays associated with its label; the textarea gains `htmlFor`/`id` + `aria-describedby` (FR-007).
- Do not rename or drop the selectors/classes the test relies on (`guardrail-mode`, `guardrail-modes`, `guardrail-allow`, `button-row`, `selected`, `readonly`).

---
## Stylesheet layout, alignment and visual system
- [x] T010 [P] [US1] Replace the `.guardrail-*` block in `/data/aidlc/workspaces/rayedbajwa/spaces/src/web/styles.css` with scoped, token-based rules: grid `auto minmax(0, 1fr)` mode rows, `.guardrail-mode input[type="radio"] { width: auto; flex: none }` (scoped so the unrelated primary-repo radio in `main.tsx` is unaffected), `min-width: 0` on the text column, a readable `max-width: 62ch` measure and `overflow-wrap: anywhere` (research R2, R4; FR-002, FR-005)
- [x] T011 [US1] Align the section heading, never-mask field and `.button-row` save action to the section's single content column using the page's existing `card panel team-section` shell, tokens and shared primitives in `/data/aidlc/workspaces/rayedbajwa/spaces/src/web/styles.css` (research R3; FR-001, FR-004)

**Scoped files**
- May modify **only**: `src/web/styles.css` — and within it, the `.guardrail-*` block plus section-scoped rules added by T011
- Must not change the app-wide `input, textarea, select { width: 100% }` rule or any rule used outside the guardrails section (e.g. the primary-repo radio in `src/main.tsx`)
- Tests to run: `bun run typecheck` (browser suite executed by Workstream 1 at T012)

**Outputs**
- Updated `.guardrail-*` block (and only the scoped section rules) in `src/web/styles.css`

**Depends on**
- Requires T001, T002 and the **red** T004–T008.
- T011 must run **after** T010 (same file) — sequential inside this workstream.
- Independent of Workstream 2; safe to run concurrently with it.

**QA focus**
- Radio scoping must not leak to unrelated radios/inputs on the Organization page.
- Assert no horizontal overflow at 1440px and 390px, long descriptions wrap, and heading/options/textarea/save share the section content edge within 1px (FR-001…FR-005).
- Reuse existing tokens/primitives only — no redesign, no new dependency (FR-008, research R8).

---
## Regression, CI wiring and manual verification
- [x] T013 Run `bun test tests/guardrails.test.ts tests/guardrails-policy.test.ts` and the full `bun test` suite in `/data/aidlc/workspaces/rayedbajwa/spaces`, confirming the guardrail suites pass and recording any full-suite failures that also fail on the baseline commit (repo memory notes full-suite greenness is unverified, so only new failures count as a regression) (SC-003)
- [x] T014 [P] Append `tests/guardrails-page.e2e.test.ts` to the existing "Run responsibility browser tests" `bun test` invocation in `/data/aidlc/workspaces/rayedbajwa/spaces/.github/workflows/ci.yml` so the end-to-end tests run together in the existing auth-enabled step (research R7)
- [x] T015 [P] Run the `quickstart.md` verification steps (build the SPA, load the section at desktop and ≈390px, confirm alignment/no overflow, the select/edit/save round-trip and the read-only role view) in `/data/aidlc/workspaces/rayedbajwa/spaces` and record the result

**Scoped files**
- May modify **only**: `.github/workflows/ci.yml`
- May read, but never modify: `src/**`, `tests/**` (T014 only appends a filename)
- Tests/commands to run: the full `bun test` suite, `bun test tests/guardrails-page.e2e.test.ts`, `quickstart.md` verification steps

**Outputs**
- `.github/workflows/ci.yml` edit adding the new browser test to the single existing auth-enabled step
- Recorded full-suite regression result and quickstart verification result

**Depends on**
- Blocked by T012 (green) and T010/T011.
- T014 and T015 are disjoint (different files/activities) and may run concurrently with each other, but each only after T012.

**QA focus**
- Keep end-to-end tests together in CI: one extra file in the existing browser step; do not add a feature-specific job or a second server (research R7; Organization Memory "run E2E together", "CI churn unnecessary while it works").
- Only *new* full-suite failures count as regressions — the repo's full-suite greenness is unverified, so compare against the T002 baseline.
- Capture quickstart evidence (viewport, mode, allow-list, alignment verdict) so the record can be attached to the feature artifacts.

---

## Sequential Tasks (Must Not Be Parallelized)

These are ordered barriers. They may run in the same time window as the
workstreams above only where noted, but they must never be split across
concurrent writers.

1. **T001 → T002** (setup, then green baseline). Both precede all edits; T002 must observe a pre-edit baseline.
2. **T003 → T004 → T005 → T006 → T007 → T008** — same file (`tests/guardrails-page.e2e.test.ts`); strictly sequential, and the whole block must be completed and shown **red** before T009/T010 start.
3. **T010 → T011** — same file (`src/web/styles.css`); T011 must not start until T010 lands.
4. **T012** — single green gate that depends on T009, T010 and T011 all being complete; do not run it while implementation writers are still active.
5. **T013** — runs after T012 green; must not run concurrently with edits to `src/**` or `tests/**`.
6. **T014 / T015** — each starts only after T012/T013; T014 edits `ci.yml` while T015 performs a read-only verification, so they may overlap, but neither may overlap an implementation write.
7. **Delivery chain T016 → T017 → T018 → T019 → T020 → T021** — strictly sequential and human-gated:
   - T016 open PR; T017 CI green (both `build & test` and `docker build`).
   - T018 human review approval recorded in `specs/008-fix-guardrails-page/code-review.md` (governance artifact).
   - T019 merge into default branch — **irreversible, requires T018 approval**.
   - T020 confirm deployment pipeline; T021 run deployed UAT from `test-plan.md` (SC-001…SC-004).
   - T019/T020/T021 touch production/release state and must not be delegated to parallel sub-agents.

---

## QA Coordination Notes

- **One writer per file.** `guardrails.tsx` (WS2) and `styles.css` (WS3) are the only files two agents could plausibly collide on; the split above keeps them apart. `tests/guardrails-page.e2e.test.ts` is single-writer (WS1) and is frozen for writes while WS2/WS3 run.
- **Red before green.** No implementation sub-agent starts until T004–T008 exist and fail. Record the failing output as the red evidence; T012 is the green check against the *same* assertions — do not let WS1 weaken an assertion to make it pass.
- **Freeze the contract.** `contracts/ui-contract.md` is the interface between the test workstream and the two implementation workstreams. CSS/class/role changes not in that contract must be raised as a contract change before implementation, not patched in.
- **Merge checkpoints.** (1) Baseline green (T002); (2) red tests committed/locked (T008); (3) T009 + T010 merged to the feature branch together (they are interdependent visually but file-disjoint); (4) T011 merged after T010; (5) T012 green; (6) T013/T014/T015 complete; (7) PR CI green (T017) before human review (T018).
- **Dependency handoff.** WS1's fixture must implement the `SPACES_E2E_BASE_URL` → `RESPONSIBILITY_BASE_URL` fallback so WS4/T014 can reuse CI's :3100 server; if the fallback is wrong, CI will spawn a second server and conflict on ports.
- **No schema/API/permission work.** `data-model.md` records no data-model change; any task that would touch `ai_guardrails`, `/api/org/guardrails` or `requireOrgAdmin` is out of scope and must be rejected rather than parallelised.
- **Evidence ownership.** WS1 records red-green evidence, WS4 records full-suite and quickstart results; both are handed to the governance delivery workstream for `code-review.md`/UAT records so no code workstream writes into the `governance` repository.

---

## Recommendation

**Run at most 2 concurrent workstreams.** The safe maximum is Workstream 2
(`guardrails.tsx`) + Workstream 3 (`styles.css`) after the test block is red;
after that, T014 + T015 may overlap. Never run more than one writer per file, and
never parallelise the sequential list above. Delivery (T016–T021) should run as a
single, human-gated lane, not as a workstream.
