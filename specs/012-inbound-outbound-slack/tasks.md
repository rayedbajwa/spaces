# Tasks — 012-inbound-outbound-slack

Repository-local tasks for initiative **012-inbound-outbound-slack** (Feature Specification: Inbound Work Intake, Outbound Triggers, and a Two-Way Slack Surface). Planning lives in the governing workspace; this file is what this repository owns. Tick items as they land; the pipeline commits it with the code.

## Foundation, Intake Store and Conversion
- [x] T001 Add intake sync, outbound retry and Slack signing-secret variables in `.env.example`
- [x] T002 [P] Add `datadog` to `AppIntegrationKind` in `src/lib/app-integrations.ts`
- [x] T003 [P] Add the Monitoring category and `datadog` mapping in `src/lib/integration-categories.ts`
- [x] T004 Add the eight additive intake, identity, routing and outbound tables, their indexes and the `app_integrations_kind_check` extension to `src/lib/db-schema.sql`
- [x] T005 Add an idempotent schema migration test (apply twice, then confirm the `datadog` kind is admitted) in `tests/intake-migration.test.ts`
- [x] T006 [P] [US1] Ingestion, normalization, dedup, storm aggregation and priority-ordering tests in `tests/intake-store.test.ts`
- [x] T009 [P] [US1] Intake queue and source REST tests (org scoping, ordering, `403` for outsiders) in `tests/intake-api.test.ts`
- [x] T010 [P] [US1] Implement `upsertIntakeItem`, `listIntake`, `setIntakePriority` and source health in `src/lib/intake-store.ts`
- [x] T014 [US1] Add `GET`/`PATCH /api/intake` and `GET`/`PUT /api/intake/sources` routes in `src/server.ts`
- [x] T020 [P] [US2] Conversion, work-link, dismiss/restore/merge and non-blocking source-update tests in `tests/intake-conversion.test.ts`
- [x] T021 [US2] Extract `startSpecifyRun` from the execute-step route into `src/lib/run-start.ts`
- [x] T022 [US2] Add `convertIntakeItem`, `dismissIntakeItem`, `restoreIntakeItem`, `mergeIntakeItems` and `linkIntentToWork` to `src/lib/intake-store.ts`
- [x] T024 [US2] Add the convert, dismiss, restore and merge routes in `src/server.ts`
- [x] T025 [US2] Call `linkIntentToWork` from `syncProjectIntents` in `src/lib/intent-store.ts`

**Scoped files**
Allowed to modify only: `.env.example`, `src/lib/app-integrations.ts`, `src/lib/integration-categories.ts`, `src/lib/db-schema.sql`, `src/lib/run-start.ts`, `src/lib/intake-store.ts`, `src/lib/intent-store.ts` (the `linkIntentToWork` call only), the intake/convert route block and `execute-step` extraction in `src/server.ts`, and `tests/intake-store.test.ts`, `tests/intake-conversion.test.ts`, `tests/intake-api.test.ts`, `tests/intake-migration.test.ts`. This workstream is the unique writer of `db-schema.sql` and `intake-store.ts` for its merge window.

**Outputs**
`.env.example` intake-sync / outbound-retry / Slack-signing-secret variables; the eight additive tables, indexes and `app_integrations_kind_check` extension with `datadog`; the Monitoring category; `src/lib/run-start.ts` with `startSpecifyRun` (clone-in-progress, duplicate-artifact and in-flight guards preserved); `upsertIntakeItem`, `listIntake`, `setIntakePriority`, conversion/dismiss/restore/merge and `linkIntentToWork` in `src/lib/intake-store.ts`; `GET`/`PATCH /api/intake` and `GET`/`PUT /api/intake/sources`, plus the convert/dismiss/restore/merge routes; `syncProjectIntents` calls `linkIntentToWork`. Tests: `tests/intake-store.test.ts`, `tests/intake-conversion.test.ts`, `tests/intake-api.test.ts`, `tests/intake-migration.test.ts`.
**Merge checkpoint**: `bun run db:migrate` applied twice is a no-op and the kind check admits `datadog`; store/conversion/API tests pass; the existing `execute-step` tests stay green after the `startSpecifyRun` extraction; `bun run typecheck` passes. **No story workstream begins before this checkpoint.**

**Depends on**
None upstream (governance artifacts are on disk). T001 → T002/T003 → T004 → T005; T004/T005 block every other workstream. Internal chain: T010 → T014; T021 → T022 → T024 → T025.

**QA focus**
Idempotent additive DDL only (no existing column/table altered); `(org_id, source, external_ref)` dedup and concurrent-upsert race yield one row; priority-then-arrival ordering; every transition records actor/surface/time/from/to and a reason for dismiss/merge; conversion is org-scoped, rejects foreign/missing projects with no guessed target, and a source-update failure records `source_update_state='failed'` **without** rolling back the conversion; raw content is guardrail-masked before storage; `startSpecifyRun` keeps the existing guards byte-for-byte; no cross-org read or write.
## Inbound Connectors, Datadog and Source Health
- [x] T007 [P] [US1] Jira/Linear/Datadog connector fetch, cursor and source-health tests with stubbed `fetch` in `tests/intake-connectors.test.ts`
- [x] T008 [P] [US1] Datadog `verify` and event-normalization tests in `tests/datadog-integration.test.ts`
- [x] T011 [P] [US1] Implement Jira, Linear and Datadog fetch, normalization and cursors in `src/lib/intake-connectors.ts`
- [x] T012 [P] [US1] Implement `verifyDatadog` and `listDatadogEvents` in `src/lib/datadog.ts`
- [x] T013 [US1] Add the Datadog verify, token-store and disconnect routes in `src/server.ts`
- [x] T015 [US1] Add the intake-sync worker timer in `src/worker.ts`
- [x] T023 [US2] Add the best-effort source-ticket update for converted items in `src/lib/intake-connectors.ts`

**Scoped files**
Allowed to modify only: `src/lib/intake-connectors.ts`, `src/lib/datadog.ts`, the Datadog route block in `src/server.ts`, the intake-sync timer block in `src/worker.ts`, and `tests/intake-connectors.test.ts`, `tests/datadog-integration.test.ts`. `src/server.ts` and `src/worker.ts` are shared — edit only the named blocks, rebase immediately before merge.

**Outputs**
Jira/Linear/Datadog `(source, cursor) → { items, nextCursor }` connectors, normalization and monotonic cursors; `verifyDatadog` / `listDatadogEvents` in `src/lib/datadog.ts`; `intake_sources` health writes; Datadog verify/token/disconnect routes; the intake-sync worker timer; the best-effort source-ticket update for converted items (T023). Tests: `tests/intake-connectors.test.ts`, `tests/datadog-integration.test.ts`.
**Merge checkpoint**: connector and Datadog tests pass with `fetch` stubbed; a failed fetch marks the source unhealthy, retains queued items and resumes from the cursor without duplicates; the Datadog token is sealed and never returned; ingestion never throws into or blocks a run.

**Depends on**
WS1 (T004 schema, T002/T003 kind/category, T010/T021 contracts). T013 depends on T012; T015 depends on T010/T011; T023 depends on WS1's `startSpecifyRun`/conversion interface. May be authored concurrently with WS4; merges after WS1 and before WS4 for `src/server.ts`.

**QA focus**
Each connector normalizes `source`, `external_ref`, `external_url`, title, summary, requester and first-seen time; cursor advancement is monotonic and re-running a window adds nothing; a deleted/updated external item refreshes or flags `source_available=false` without discarding history or converted work; Datadog `verifyDatadog` rejects bad keys and a valid probe is accepted; source health surfaces `running|ok|error`; no live credential is required (stub `fetch`; org memory: key-requiring E2E may be ignored).
## Routing Rules
- [x] T052 [P] [US5] Match conditions, precedence, disabled-rule and manual-override tests in `tests/intake-routing.test.ts`
- [x] T053 [US5] Implement `evaluateRouting` with precedence and lower suggestions in `src/lib/intake-routing.ts`
- [x] T054 [US5] Apply routing suggestions on first arrival in `upsertIntakeItem` in `src/lib/intake-store.ts`
- [x] T055 [US5] Add `GET`/`PUT /api/intake/routing-rules` routes in `src/server.ts`

**Scoped files**
Allowed to modify only: `src/lib/intake-routing.ts`, the routing-suggestion application in `src/lib/intake-store.ts`, the routing route block in `src/server.ts`, and `tests/intake-routing.test.ts`. The `intake.tsx` routing UI (T056) is owned by WS6.

**Outputs**
`evaluateRouting` with documented precedence and lower-suggestion retention in `src/lib/intake-routing.ts`; suggestions applied on first arrival in `upsertIntakeItem`; `GET`/`PUT /api/intake/routing-rules`; `tests/intake-routing.test.ts`.
**Merge checkpoint**: routing tests pass (one matching rule, precedence, disabled rule, manual override); non-matching items stay untriaged; a manual choice wins and records a `rule_override` transition; `bun run typecheck` passes.

**Depends on**
WS1 (item shape) and WS2 (source/scope fields). Starts after both merge so the single `intake-store.ts` append and the `src/server.ts` routing route block have no competing writer.

**QA focus**
Routing only ever pre-suggests — it never auto-assigns a project/team/priority; disabled rules are never evaluated; precedence is deterministic and losers are retained as lower suggestions; a manual assign sets `rule_overridden` and is audited; cross-org rules never apply to another tenant's items.
## Slack Two-Way Surface
- [x] T028 [P] [US3] Slack identity link, verify, ambiguous and revoked tests in `tests/slack-identity.test.ts`
- [x] T029 [P] [US3] Signature verification, filing, gate decisions, verbatim feedback and stale/unauthorized refusal tests in `tests/slack-interactions.test.ts`
- [x] T030 [US3] Refactor the exactly-once decision core in `src/lib/approval-store.ts` to accept a link token or `{ gateId, actorUserId, outcome, feedback }`
- [x] T031 [US3] Relax `answerPausedRun` decision `requestId` and `linkId` to nullable in `src/lib/run-store.ts`
- [x] T032 [US3] Seal and read the Slack signing secret in `oauth_apps.config_json` in `src/lib/oauth-apps.ts`
- [x] T033 [US3] Extend the Slack manifest with slash commands, event subscriptions and interactivity in `src/lib/github-app.ts`
- [x] T034 [US3] Add `commands` to the Slack scope list in `src/lib/slack-scopes.ts`
- [x] T035 [US3] Implement verified Slack identity links, email matching and one-time verification in `src/lib/slack-identity.ts`
- [x] T036 [US3] Implement signature-verified Slack events, interactions and commands with workspace-to-org resolution in `src/lib/slack-interactions.ts`
- [x] T037 [US3] Add interactive approval buttons, question-thread prompt and stale-prompt update in `src/lib/slack.ts`
- [x] T038 [US3] Add the `/api/slack/{events,interactions,commands}` endpoints and identity routes in `src/server.ts`

**Scoped files**
Allowed to modify only: `src/lib/slack-identity.ts`, `src/lib/slack-interactions.ts`, `src/lib/slack.ts`, `src/lib/slack-scopes.ts`, `src/lib/github-app.ts`, `src/lib/oauth-apps.ts`, `src/lib/approval-store.ts`, `src/lib/run-store.ts`, the Slack/identity route block in `src/server.ts`, and `tests/slack-identity.test.ts`, `tests/slack-interactions.test.ts`. `slack-link.tsx` and the `/slack-link/:token` route (T039/T040) are owned by WS6.

**Outputs**
Shared exactly-once decision core callable with a link token or `{ gateId, actorUserId, outcome, feedback }`; nullable `decision.requestId`/`linkId`; sealed Slack signing secret; extended Slack manifest (slash commands, event subscriptions, interactivity); `commands` scope; verified `slack_identity_links` with unique/ambiguous/one-time verification; signature-verified events/interactions/commands with workspace→org resolution and signed approval references; interactive approval buttons, question-thread prompt and stale-prompt update; `/api/slack/{events,interactions,commands}` and identity routes. Tests: `tests/slack-identity.test.ts`, `tests/slack-interactions.test.ts`.
**Merge checkpoint**: identity, interaction and exactly-once tests pass; a second/stale action reads the winner and changes nothing; forged/old signatures and unauthorized/non-recipient actors are refused, audited and change no state; the existing `tests/approval-*.test.ts` and `tests/answer-paused-run.test.ts` suites stay green after the T030/T031 refactor.

**Depends on**
WS1 (filing creates items) and the T030/T031 shared decision core. May be authored concurrently with WS2 (disjoint `slack-*.ts`, `oauth-apps.ts`, `github-app.ts`, `approval-store.ts`, `run-store.ts`); merges to `src/server.ts` after WS2. Blocks WS6.

**QA focus**
All three endpoints verify `X-Slack-Signature` + timestamp before any effect; a missing signing secret fails closed as `not_configured`; a verified link grants **no** team/project role; Slack authority is re-checked against current `resolveGateRecipients` and revoked membership refuses the action; feedback/notes reach the agent **verbatim**; one `approval_decisions` row per gate across link, in-app and Slack under concurrent submits; workspace→org resolves only from the signed approval reference, filing fails closed on ambiguity, and `team_id + slack_user_id` alone never selects an org; Slack secrets are sealed and never logged; Slack actions never throw into or block a run.
## Outbound Triggers
- [x] T041 [P] [US4] Subscription CRUD and event-emission idempotency tests in `tests/outbound-store.test.ts`
- [x] T042 [P] [US4] Delivery, target-outage retry/backoff, duplicate-once and payload-masking tests in `tests/outbound-delivery.test.ts`
- [x] T043 [US4] Implement subscriptions and `emitOutboundEvent` in `src/lib/outbound-store.ts`
- [x] T044 [US4] Implement target actions, retry/backoff and guardrail masking in `src/lib/outbound-deliver.ts`
- [x] T045 [US4] Emit `run_failed`, `gate_opened` and `stage_completed` at the existing worker event points in `src/worker.ts`
- [x] T046 [US4] Emit `verification_completed` and `feature_delivered` from the intent status transition in `src/lib/intent-store.ts`
- [x] T047 [US4] Add the outbound drain timer in `src/worker.ts`
- [x] T048 [US4] Add `GET`/`PUT /api/outbound/subscriptions` routes in `src/server.ts`

**Scoped files**
Allowed to modify only: `src/lib/outbound-store.ts`, `src/lib/outbound-deliver.ts`, the emit/drain blocks in `src/worker.ts`, the `verification_completed`/`feature_delivered` emission in `src/lib/intent-store.ts`, the outbound route block in `src/server.ts`, and `tests/outbound-store.test.ts`, `tests/outbound-delivery.test.ts`. `outbound.tsx` and its route/nav (T049–T051) are owned by WS6.

**Outputs**
`outbound_subscriptions` CRUD and `emitOutboundEvent` with `ON CONFLICT (subscription_id, event_key) DO NOTHING`; `src/lib/outbound-deliver.ts` target actions, exponential backoff, bounded attempt cap and guardrail masking; `run_failed` / `gate_opened` / `stage_completed` emissions at existing worker points; `verification_completed` / `feature_delivered` from the intent status transition; the outbound drain timer and `GET`/`PUT /api/outbound/subscriptions`. Tests: `tests/outbound-store.test.ts`, `tests/outbound-delivery.test.ts`.
**Merge checkpoint**: store/delivery tests pass; each of the five events fires at its documented path; duplicate events action once; target outage retries with backoff and leaves `pipeline_runs` byte-identical; disabled or absent subscriptions do nothing; payloads are masked and contain no secrets.

**Depends on**
WS1 (link/summary context, T025) and US2 run/intent events. Starts after WS1. Shares `src/worker.ts` (T045/T047) and `src/lib/intent-store.ts` (T046) with WS1/WS2, so it merges after WS2 for `worker.ts` and after WS1 for `intent-store.ts`. Blocks WS6.

**QA focus**
Emission inserts one delivery per matching **enabled** subscription and is idempotent per `(subscription_id, event_key)`; delivery never writes `pipeline_runs` and never blocks the producer (fire-and-forget); retries use exponential backoff to a bounded cap and record attempts/error/time; guardrail masking runs **before** the payload leaves the app; missing/disabled subscriptions produce no action; re-enabling resumes; cross-org subscriptions never deliver another tenant's event.
## SPA Integration
- [x] T016 [P] [US1] Implement the prioritized Intake queue view with source health in `src/web/intake.tsx`
- [x] T017 [US1] Add the intake client route in `src/web/main.tsx`
- [x] T018 [US1] Add the Intake navigation entry in `src/web/shell.tsx`
- [x] T019 [P] [US1] Add queue and monitoring-category styles in `src/web/styles.css`
- [x] T026 [US2] Add triage, convert, dismiss/restore and merge actions to `src/web/intake.tsx`
- [x] T027 [US2] Add the converted-work link back to Intake in `src/web/main.tsx`
- [x] T039 [US3] Implement the Slack identity verification page in `src/web/slack-link.tsx`
- [x] T040 [US3] Add the `/slack-link/:token` client route in `src/web/main.tsx`
- [x] T049 [P] [US4] Implement the outbound subscriptions view in `src/web/outbound.tsx`
- [x] T050 [US4] Add the outbound client route in `src/web/main.tsx`
- [x] T051 [US4] Add the Outbound navigation entry in `src/web/shell.tsx`
- [x] T056 [US5] Add routing suggestions, matched-rule label and manual-override UI to `src/web/intake.tsx`

**Scoped files**
Allowed to modify only: `src/web/intake.tsx`, `src/web/outbound.tsx`, `src/web/slack-link.tsx`, `src/web/main.tsx`, `src/web/shell.tsx`, `src/web/styles.css`, and may add `tests/intake-outbound.e2e.test.ts`. If the Datadog connect dialog in `src/web/integrations.tsx` is required by T013, coordinate with WS2 — WS6 owns that file while active.

**Outputs**
`src/web/intake.tsx` prioritized queue with source health, triage/convert/dismiss/merge, routing suggestions, matched-rule label and manual override; `src/web/outbound.tsx` subscriptions view; `src/web/slack-link.tsx` identity verification confirmation; routes in `src/web/main.tsx` (`/intake`, `/outbound`, `/slack-link/:token`) and the converted-work link back to Intake; navigation entries in `src/web/shell.tsx`; queue/monitoring/outbound styles in `src/web/styles.css`. E2E: `tests/intake-outbound.e2e.test.ts`.
**Merge checkpoint**: `bun run build:web` is clean and the Playwright flows (queue triage/convert, Datadog dialog, outbound save/enable, Slack identity confirmation) pass against `PORT=3369`.

**Depends on**
WS1–WS5 APIs stable. Runs last among implementation workstreams; nothing else depends on it except the WS8 end gate. This workstream is the unique writer of `src/web/**` so WS3's routing UI and WS4's identity page do not race.

**QA focus**
Every view is org-scoped and re-uses existing auth/session handling; the raw Slack token never lands in the DOM bundle, document title or logs; conversion shows a navigable link back to the source item and the converted work; source-health, dismissed/merged and expired/used Slack states show a clear path; no new dependency; `src/web` has a single writer during its merge window.
## Documentation and CI Wiring
- [x] T059 [P] Document Intake, outbound triggers and the two-way Slack surface in `docs/concepts/`
- [x] T060 Wire the new intake, Slack and outbound test files into the CI test steps in `.github/workflows/ci.yml` (CI enumerates test files explicitly, so new suites do not run without this)

**Scoped files**
Allowed to modify only: `docs/concepts/` and `.github/workflows/ci.yml` in `spaces`. No runtime source and no test files (those belong to WS1–WS5).

**Outputs**
New `docs/concepts/` pages for Intake, outbound triggers and the two-way Slack surface; the new intake/Slack/outbound test files wired into the existing CI test steps.
**Merge checkpoint**: docs build clean; CI runs the new `tests/intake-*`, `tests/slack-*`, `tests/outbound-*` and `tests/datadog-integration.test.ts` suites; no CI change beyond wiring files that already pass locally (org memory: don't change CI while it already works — wiring is required here only because CI enumerates test files, per test-plan risk R-01).

**Depends on**
T059 needs the implemented surfaces from WS1–WS5. T060 needs the new test files from WS1–WS5 and must land before the WS9 full-suite gate. Runs in parallel with WS6; touches no `src/` file, so it does not contend with implementation workstreams.

**QA focus**
Docs match the shipped routes, event catalog and Slack manifest; CI wiring lists the exact new files (no glob guesswork) and does not duplicate, reorder or weaken existing steps; no secret or key appears in docs or CI.
## Verification and Release (Sequential End Gate)
- [x] T061 Run `bun run typecheck`, `bun run db:migrate`, `bun run build:web` and `bun test`, and fix every failure
- [x] T062 Run the end-to-end acceptance checks in `specs/012-inbound-outbound-slack/quickstart.md` against `PORT=3369`
- [ ] T063 Open the pull request for the `spaces` changes (feature documents synced in) against `main`
- [ ] T064 Get CI green and review approval on the `spaces` pull request
- [ ] T065 Merge the `spaces` pull request to `main`
- [ ] T066 Confirm the deployment pipeline ran for the merged `spaces` change
- [ ] T067 Run the `test-plan.md` UAT and final acceptance checks against the deployed `spaces` environment

**Scoped files**
Branch `012-inbound-outbound-slack` in `spaces`; no new source beyond merged workstreams. May fix failures in the owning workstream's files, preferring a rebase of that workstream over silently changing its scope.

**Outputs**
`bun run typecheck`, `bun run db:migrate` (twice), `bun run build:web` and `bun test` all green with failures fixed; the quickstart acceptance run against `PORT=3369`; the `spaces` pull request with feature documents synced in; CI green and human review approval; merge to `main`; confirmed deployment; `test-plan.md` UAT and final acceptance on the deployed environment.
**Merge checkpoint**: CI green and human approval before merge; deployed migration idempotent and UAT recorded after merge. Strictly sequential T061 → T062 → T063 → T064 → T065 → T066 → T067.

**Depends on**
WS1–WS8 complete. T063–T065 are human-gated (open PR, approve, merge); T066/T067 follow the merged deployment. No task waits on another repository's merge: `governance` produces no PR.

**QA focus**
Migration applies twice as a no-op in the deployed environment; the existing suite (not only the new tests) stays green (FR-028); no secret/credential is committed or logged in the release; key-dependent live-provider smoke checks may be skipped per org memory, with stubbed contract tests as the deterministic gate; merge/deploy/UAT are human-gated and require explicit approval.

## Sequential Tasks (must not be parallelized)

- **Foundation gate**: T001 → T002/T003 → T004 → T005; T004/T005 block every story workstream (WS1 must merge before WS2–WS6).
- **WS1 store/API chain**: T010 → T014; T021 → T022 → T024 → T025. T013 depends on T012; T015 depends on T010/T011.
- **Shared-file serialization** (`src/server.ts`): WS1 intake/convert blocks → WS2 Datadog block → WS3 routing block → WS4 Slack block → WS5 outbound block; one writer at a time, rebase before each append.
- **Shared-file serialization** (`src/worker.ts`): WS2 intake-sync timer → WS5 emit/drain timer.
- **Shared-file serialization** (`src/lib/intent-store.ts`): WS1 `linkIntentToWork` call (T025) → WS5 event emission (T046).
- **Decision-core chain** (WS4): T030 → T031 → T035/T036/T037 → T038; T032/T033/T034 are independent of the core but land in the same merge window.
- **Outbound chain** (WS5): T043 → T044 → T045/T046 → T047 → T048.
- **SPA chain** (WS6): after WS1–WS5 routes are stable; T017/T018/T019 → T026/T027; T039/T040 and T049/T050/T051 together; T056 after WS3.
- **Verification/release**: T061 → T062 → T063 → T064 → T065 → T066 → T067, human-gated at T064/T065 (WS9); T060 (WS8) precedes T061.

## QA Coordination Notes

1. **Single writer per shared file.** `src/server.ts` (WS1, WS2, WS3, WS4, WS5) and `src/worker.ts` (WS2, WS5) each have one owner at a time; follow the serialization order above and rebase the next writer before appending its route/timer block.
2. **Single writer per test file.** Each `tests/*.test.ts` listed in the inventory has exactly one owning workstream; no two workstreams append to the same test file in one merge window.
3. **`src/web/**` is owned by WS6.** Routing UI (T056), Slack identity page (T039/T040) and outbound/nav views are authored by WS6, not by WS3/WS4/WS5, to keep one writer for the SPA.
4. **Interface freeze before parallel coding.** WS1 freezes the `upsertIntakeItem` / `startSpecifyRun` / conversion interfaces and the `intake_work_links.source_update_state` contract before WS2 (T023) and WS5 start; WS4 confirms the relaxed `answerPausedRun` / `approval-store` decision shape against the frozen 011 contract before coding T030/T031.
5. **Decision-core regression is the top risk.** Any change to `approval-store.ts`/`run-store.ts` must leave `tests/approval-*.test.ts` and `tests/answer-paused-run.test.ts` green; this is the gate WS4 passes before WS6 starts.
6. **Database isolation.** All DB-backed tests run through `tests/setup/db-guard.ts` against the test Postgres; use the checkout `.env` `DATABASE_URL` and never point suites at the live deployment or the application database.
7. **HTTP stubbing.** Jira, Linear, Datadog, Slack and GitHub are stubbed at the `fetch` boundary; workstreams must not add live-credential dependencies to deterministic suites (org memory: E2E tests requiring keys can be ignored).
8. **Guardrails at both boundaries.** Inbound content is masked before storage/display (WS1/WS2) and outbound payloads before send (WS5); no secret appears in `raw_json`/`payload_json`, logs or errors.
9. **Build/test cadence.** Each workstream runs `bun run typecheck` on its scoped files before its merge checkpoint; `bun run build:web` belongs to WS6/WS9; the full `bun test` suite is the WS9 gate.
10. **CI.** The only CI change is wiring the new test files (T060) because the workflow enumerates files explicitly; no other CI edit (org memory).

## Concurrency Recommendation

Run **at most 2 implementation workstreams concurrently** after the single, sequential **WS1 foundation gate**. The safe concurrent pair is **WS2 (connectors/Datadog) and WS4 (Slack surface)**: their source files are disjoint (`intake-connectors.ts`/`datadog.ts` vs `slack-*.ts`/`oauth-apps.ts`/`approval-store.ts`/`run-store.ts`) and only `src/server.ts` must merge serially (WS2 then WS4). WS3 follows WS1/WS2 on `intake-store.ts`; WS5 follows WS1/WS2 on `intent-store.ts` and `src/worker.ts`; both may then share a second slot if only one of `src/server.ts`/`src/worker.ts` is in play. WS6 is the last implementation workstream (single writer of `src/web/**`); WS7 (governance documents) may run at any time and WS8 (docs/CI) runs beside WS6 with no `src/` contention. WS9 verification/release is strictly sequential and human-gated. This keeps every concurrent writer on a distinct file set and every merge checkpoint independently verifiable.
