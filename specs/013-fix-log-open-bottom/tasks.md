# Tasks — 013-fix-log-open-bottom

Repository-local tasks for initiative **013-fix-log-open-bottom** (Feature Specification: Fix Log Display Opening at the Bottom). Planning lives in the governing workspace; this file is what this repository owns. Tick items as they land; the pipeline commits it with the code.

## Baseline and Log-Seeding Harness
- [x] T001 Ensure the `rayedbajwa/spaces` checkout is on branch `013-fix-log-open-bottom`, dependencies are installed via `bun install`, and the test database schema is applied via `bun run db:migrate` with the checkout's `DATABASE_URL`, in `rayedbajwa/spaces`
- [x] T002 Record the pre-change baseline by running `bun run typecheck` and `bun test tests/agent-bar.e2e.test.ts` and confirming both are green before any source edit, in `tests/agent-bar.e2e.test.ts`
- [x] T003 Add a reusable `seedRunWithLog(label, status, stage, lines)` helper that creates a project/repo, inserts a `pipeline_runs` row and N `pipeline_events` rows (`kind='log'`, payload `{ chunk }`) ending in a unique sentinel line, and returns the ids, in `tests/agent-bar.e2e.test.ts`
- [x] T004 Extend `afterAll` to delete the seeded `pipeline_events` and `pipeline_runs` for every log-dock project, in `tests/agent-bar.e2e.test.ts`

**Scoped files**
- `tests/agent-bar.e2e.test.ts` — helper function and `afterAll` only; **no new `describe`/`test` blocks** yet.

**Outputs**
- Green `typecheck` + `agent-bar` baseline captured before any edit.
- `seedRunWithLog(...)` returning project/run ids and appending a unique sentinel line (≥60 rows of `kind='log'` events).
- Extended teardown that removes every log-dock project's events, runs, repos and project rows.
- Fixture port left as the file's existing fixed port (3373); do not introduce a second fixture.

**Depends on**
- None. This is the entry gate for all subsequent work.
- T002 (baseline green) must complete before T003/T004 edits land.

**QA focus**
- Confirm the helper seeds exactly N log events and the sentinel is the last chunk joined by `snapshotFromRow`.
- Confirm teardown is idempotent (safe when a test failed before seeding) and deletes nothing outside the seeded projects.
- Confirm the baseline run is green **before** any edit (red/green proof depends on it).
- No CI edit: the file is already run by CI's "Run responsibility browser tests" step.
## Open-at-Bottom Regression Suite
- [x] T005 [US1] Add the `describe('log dock opens at the bottom', …)` block with B1 (completed) and B2 (failed): seed runs of ≥60 log lines, open the dock, and assert `scrollTop + clientHeight >= scrollHeight - 2` plus the sentinel line is in the viewport (FR-001, AS1, AS2, SC-001), in `tests/agent-bar.e2e.test.ts`
- [x] T006 [US1] Add B3 (paused, `pauseKind='user'` and a non-user pause) and B4 (running/streaming): seed ≥60 log lines, open the dock, and assert it is at the bottom with the sentinel visible (FR-001, AS4, SC-001), in `tests/agent-bar.e2e.test.ts`
- [x] T007 [US1] Add B5: scroll the open buffer to the top, collapse, re-open, and assert it lands at the bottom rather than the stale position (FR-002, AS3, SC-002), in `tests/agent-bar.e2e.test.ts`
- [x] T008 [US1] Add B6: with the dock open switch run A → run B (both with logs) and assert B's newest sentinel line is at the bottom (FR-005), in `tests/agent-bar.e2e.test.ts`
- [x] T009 [US1] Add B7: with a streaming run pinned at the bottom, deliver new log output and assert the buffer stays at the bottom (FR-003, AS4, SC-003), in `tests/agent-bar.e2e.test.ts`
- [x] T010 [US1] Add B8: with a streaming run open scroll up and assert the position is held and the "New output below ↓" cue appears (FR-004, SC-003), in `tests/agent-bar.e2e.test.ts`
- [x] T011 [US1] Add B9: seed an empty/"warming up" log and a log shorter than the pane and assert no error and no unexpected scroll jump (edge cases), in `tests/agent-bar.e2e.test.ts`
- [x] T012 [US1] Add B10: assert collapse/expand, the ↑/↓ scroll controls and the run-control buttons still behave as before (FR-006, SC-004), in `tests/agent-bar.e2e.test.ts`
- [x] T013 [US1] Run `bun test tests/agent-bar.e2e.test.ts` and record that B1–B6 FAIL against the unmodified `isActive`-gated follow effect (red proof), in `tests/agent-bar.e2e.test.ts`

**Scoped files**
- `tests/agent-bar.e2e.test.ts` — the new `describe` block and any test-local helpers only.
- Read-only: `src/web/main.tsx`, `src/server.ts` (`snapshotFromRow`).

**Outputs**
- All ten cases B1–B10 added to the existing dock suite, keyed to FR-001…FR-006 and SC-001…SC-004.
- Recorded red proof: B1–B6 failing against the `isActive`-gated follow effect, with the failure output and the seeded `runId`/log length.

**Depends on**
- Depends on Workstream 1 (helper + teardown).
- T005–T012 may be authored in any internal order but land in one file; T013 depends on all of them.
- T013 blocks Workstream 3 (implementation must not start before red is recorded).

**QA focus**
- Use the 2 px slack and a visible-sentinel assertion; never assert exact `scrollTop` equality.
- One fixture and one browser context per run; reuse the Workstream 1 helper rather than reseeding ad hoc.
- Ensure cases do not race the async latest-run answer (seed before navigation; `waitFor` the dock).
- B7–B10 should pass even before the fix where the code path is unchanged; only B1–B6 are expected red.
## Dock Reveal Fix
- [x] T014 [US1] Add `useLayoutEffect` to the React import, in `src/web/main.tsx`
- [x] T015 [US1] Add the reveal/run-switch layout effect keyed on `[expanded, currentRun?.runId]` that sets follow-to-bottom and sets a `useRef` pending-bottom-pin flag (not component state), in `src/web/main.tsx`
- [x] T016 [US1] Add the pending-pin layout effect keyed on `[expanded, currentRun?.log]` that, when the ref flag is set and `logRef.current` exists, calls `logRef.current.scrollTo({ top: el.scrollHeight, behavior: 'instant' })` and clears the flag, in `src/web/main.tsx`
- [x] T017 [US1] Run `bun test tests/agent-bar.e2e.test.ts` and confirm B1–B10 PASS and the existing project-switch test remains green (green proof, FR-001…FR-006, SC-001…SC-004), in `tests/agent-bar.e2e.test.ts`
- [x] T018 [US1] Run `bun run typecheck` and confirm the `AiAgentOutputBar` change compiles under strict TypeScript, in `src/web/main.tsx`

**Scoped files**
- `src/web/main.tsx` — `AiAgentOutputBar` imports and the two layout effects only.
  Must **not** touch `onLogScroll`, `scrollLog`, the follow effect, the run
  controls, the cue or `LogText` rendering (FR-006).
- Read-only: `tests/agent-bar.e2e.test.ts` (run, not edit).

**Outputs**
- Reveal-keyed + pending-flag layout effects in `AiAgentOutputBar`; `behavior: 'instant'` so CSS `scroll-behavior: smooth` cannot animate the open.
- Green proof: B1–B10 pass and the existing project-switch test is unchanged.
- Green `bun run typecheck`.

**Depends on**
- Depends on Workstream 2 (T013 red proof). Implementing before red is recorded invalidates the proof.
- T015 and T016 are logically coupled (flag producer/consumer); land them together.
- Blocks Workstream 4.

**QA focus**
- Verify the bottom pin fires on reveal and on run-id change, but **not** on every `currentRun.log` change while open (FR-004).
- Verify the pending flag is a `useRef`, not state, and is cleared after the pin so it cannot re-fire.
- Verify `behavior: 'instant'` (the CSS sets smooth) and that re-open resets `followLog = true`.
- Confirm typecheck strictness (no unused import, correct `useLayoutEffect` typing).
## Cross-Cutting Verification
- [x] T019 Run `bun run build:web` and confirm the SPA bundles cleanly with the dock change, in `src/web/main.tsx`
- [x] T020 Run the full `bun test` suite and confirm no regression outside the dock suite, in `tests/`
- [x] T021 Run the other SPA browser suites to confirm the shared component is unaffected, in `tests/guardrails-page.e2e.test.ts` and `tests/project-responsibilities.e2e.test.ts`
- [x] T022 Walk the `quickstart.md` manual checks for all four run states (streaming, paused, completed, failed), re-open after scroll-up, and run switch, in `specs/013-fix-log-open-bottom/quickstart.md`

**Scoped files**
- None modified in this workstream — it only runs builds/tests/manual checks.
- Read-only: the whole `spaces` working tree; `specs/013-fix-log-open-bottom/quickstart.md`.

**Outputs**
- Clean `build:web` bundle.
- Full `bun test` result with no regression outside the dock suite.
- Results of the two other SPA browser suites.
- Recorded manual quickstart results for streaming/paused/completed/failed, re-open, and run switch.

**Depends on**
- Depends on Workstream 3.
- T022 is manual and needs a running app with the fix; it must not share a port or fixture with T020/T021.

**QA focus**
- Serialize the DB/browser suites: do **not** run T020 and T021 simultaneously (shared database and fixture ports; see QA Coordination).
- Confirm the existing project-switch test in `agent-bar.e2e.test.ts` still guards the late-answer/live-log behaviour.
- Record the manual check evidence with the `scrollTop`/`clientHeight`/`scrollHeight` values from the defect-reporting format in `test-plan.md` §7.
- No CI workflow edit is permitted here (Organization Memory: CI already runs the browser step).
## Delivery and Deployed Acceptance
- [x] T023 Open a Conventional Commits pull request for branch `013-fix-log-open-bottom` in `rayedbajwa/spaces` (spaces)
- [x] T024 Get CI green on the pull request — typecheck, frontend build, the browser suites and the full test jobs — in `rayedbajwa/spaces` (spaces)
- [ ] T025 Get review approval on the pull request, in `rayedbajwa/spaces` (spaces)
- [ ] T026 Merge the approved pull request into the main branch (after any PR it is stacked on), in `rayedbajwa/spaces` (spaces)
- [ ] T027 Confirm the deployment pipeline ran (or deploy) and run the deployed-environment acceptance: the `quickstart.md` manual checks across all four run states plus the smoke commands `bun run typecheck` and `bun test tests/agent-bar.e2e.test.ts`; record the result against test-plan.md's acceptance table (spaces), in `specs/013-fix-log-open-bottom/test-plan.md`

**Scoped files**
- `spaces` repository via the PR; no ad-hoc files outside the two changed files.
- Read-only acceptance inputs: `specs/013-fix-log-open-bottom/quickstart.md`, `test-plan.md`.

**Outputs**
- Open, CI-green, reviewed and merged PR in `rayedbajwa/spaces`.
- Deployed-environment acceptance result for all four run states plus smoke commands, ready to record.

**Depends on**
- Depends on Workstream 4 (all local verification green).
- T023 → T024 → T025 → T026 strictly ordered; T026 is merge-gated and requires explicit human approval (irreversible) per the constitution.
- T027 execution depends on T026 (deployment) and its result is the input to Workstream 6.

**QA focus**
- PR body must state the red→green proof and the no-schema/no-API/no-CI-change scope.
- CI must run the existing browser step; if it does not execute `tests/agent-bar.e2e.test.ts`, stop and escalate rather than editing CI silently.
- Deployed acceptance must cover streaming, paused, completed and failed, re-open after scroll-up, and run switch, and must include the sentinel/geometry evidence.
