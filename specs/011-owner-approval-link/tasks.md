# Tasks — 011-owner-approval-link

Repository-local tasks for initiative **011-owner-approval-link** (Feature Specification: Owner Approval Links). Planning lives in the governing workspace; this file is what this repository owns. Tick items as they land; the pipeline commits it with the code.

## Foundation — schema, config and shared types
- [x] T001 Document optional `RESEND_API_KEY`, `APPROVAL_EMAIL_FROM`, and `APPROVAL_LINK_TTL_HOURS` fallbacks in `.env.example`
- [x] T002 [P] Add approval link-TTL and platform email-sender config readers in `src/lib/env.ts`
- [x] T003 [P] Add `approval_requests`, `approval_links`, `approval_deliveries`, `approval_decisions`, and `approval_link_attempts` tables with indexes and the idempotent `app_integrations_kind_check` `'email'` value (both occurrences) in `src/lib/db-schema.sql`
- [x] T004 [P] Add `'email'` to `AppIntegrationKind` in `src/lib/app-integrations.ts`
- [x] T005 [P] Add the `notifications` (`Email & Notifications`) category and `'email'` kind mapping in `src/lib/integration-categories.ts`
- [x] T006 Create `src/lib/approval-store.ts` with approval domain row types and the shared `summaryForGate` helper in `src/lib/approval-store.ts`
- [x] T011 [P] [US1] Add an integration test that applying the schema twice is a no-op and `app_integrations_kind_check` accepts `'email'` in `tests/approval-migration.test.ts`

**Scoped files**
Allowed to modify only: `.env.example`, `src/lib/env.ts`, `src/lib/db-schema.sql`,
`src/lib/app-integrations.ts`, `src/lib/integration-categories.ts`, and the type/`summaryForGate`
declarations in `src/lib/approval-store.ts`. May add `tests/approval-migration.test.ts`.

**Outputs**
`.env.example` documented fallbacks; TTL/sender config readers; five additive `approval_*` tables
and indexes; `app_integrations_kind_check` accepts `'email'` in both constraint occurrences; the
`notifications` category; `approval-store.ts` row types and `summaryForGate`.
**Merge checkpoint**: `bun run db:migrate` applied twice is a no-op; `app_integrations_kind_check`
accepts `'email'`; `bun run typecheck` passes. No user story may start before this checkpoint.

**Depends on**
None (governance artifacts already on disk). Every other workstream depends on this one.

**QA focus**
Idempotent DDL only (`CREATE TABLE/INDEX IF NOT EXISTS`, drop/re-add of the kind constraint) and no
destructive change to existing columns/tables; both occurrences of `app_integrations_kind_check` are
updated; config readers tolerate missing env vars and never log secrets; the schema must stop
blocking before any story code merges.
## Approval store core — resolution, links and decisions
- [x] T007 [P] [US1] Add integration tests for explicit-assignee resolution, Owner fallback, repair-needed with no guessed recipient, and primary ordering in `tests/approval-store.test.ts`
- [x] T012 [US1] Implement `resolveGateRecipients` with Owner fallback and repair-needed status in `src/lib/approval-store.ts`
- [x] T013 [US1] Implement `createApprovalRequests` with the `(gate_id, recipient_user_id)` idempotency guard, 256-bit hashed link mint, and `recordDelivery`/`recordLinkAttempt` audit writers in `src/lib/approval-store.ts`
- [x] T020 [P] [US2] Add integration tests for valid/expired/consumed/wrong-recipient/gate-resolved verdicts, both review and clarification gate kinds and their outcome mapping, decision recording, `UNIQUE(gate_id)` concurrency, multiple-assignee primary/informed with first-decision-wins, sibling invalidation, and revocation re-resolution in `tests/approval-store.test.ts`
- [x] T024 [US2] Implement `verifyApprovalLink`, `submitApprovalDecision`, and `invalidateApprovalRequestsForGate` with the outcome-to-answer vocabulary in `src/lib/approval-store.ts`

**Scoped files**
Allowed to modify only: `src/lib/approval-store.ts`, `tests/approval-store.test.ts`.
Do not touch `src/lib/run-store.ts` here — the transaction seam is owned by WS4; agree the
`submitApprovalDecision` → `answerPausedRun` interface with WS4 before implementing T024.

**Outputs**
`resolveGateRecipients` with Owner fallback and repair-needed; `createApprovalRequests`
(`(gate_id, recipient_user_id)` idempotency, 256-bit hashed link, TTL); `verifyApprovalLink`;
`submitApprovalDecision` with outcome-to-answer mapping and atomic transaction; audit writers
`recordDelivery`/`recordLinkAttempt`; `invalidateApprovalRequestsForGate`.
**Merge checkpoint**: `bun test tests/approval-store.test.ts` green, including concurrency exactly-one
decision and token-hashed-at-rest.

**Depends on**
WS1 (types + schema). Provides the request/decision contract that WS3 and WS4 consume.

**QA focus**
Raw token never stored or logged (`token_hash` only); `UNIQUE(gate_id)` and first-decision-wins under
parallel submit; sibling invalidation on any gate resolution; every query scoped through the project
team to `org_id`; expired/consumed/wrong-recipient/gate-resolved verdicts covered.
## Direct delivery, Slack DM and email integration
- [x] T008 [P] [US1] Add integration tests for channel precedence, message content, one-channel-per-request, failure fallback, undeliverable, and idempotency in `tests/approval-delivery.test.ts`
- [x] T009 [P] [US1] Add unit tests for direct-message rendering and `im:write` scope in `tests/slack.test.ts`
- [x] T010 [P] [US1] Add integration tests for email connect/verify/disconnect, unverified-domain rejection, sealed-key storage, and org-admin gating in `tests/approval-email-integration.test.ts`
- [x] T014 [P] [US1] Add `sendDirectMessage` (`users.lookupByEmail` → `conversations.open` → `chat.postMessage`) and the `im:write` bot scope in `src/lib/slack.ts`
- [x] T015 [P] [US1] Implement `emailConfigured`, `emailSender`, `verifyEmailCredential`, and `sendEmail` against the Resend REST API in `src/lib/email.ts`
- [x] T016 [US1] Implement `notifyApprovalRequests` channel selection, guardrail masking, per-channel fallback, and delivery audit in `src/lib/approval-notify.ts`
- [x] T017 [US1] Add org-admin `POST /api/integrations/email/verify` and `POST /api/integrations/email/token` routes in `src/server.ts`
- [x] T018 [US1] Add the email integration labels, blurb, and connect dialog in `src/web/integrations.tsx`

**Scoped files**
Allowed to modify only: `src/lib/slack.ts`, `src/lib/email.ts`, `src/lib/approval-notify.ts`,
`src/web/integrations.tsx`, the email-integration route block in `src/server.ts`,
`tests/approval-delivery.test.ts`, `tests/slack.test.ts`,
`tests/approval-email-integration.test.ts`.
`src/server.ts` is shared with WS4: edit only the email route block and its imports, and merge before
WS4's link routes (or rebase immediately after).

**Outputs**
`sendDirectMessage` + `im:write` scope; `src/lib/email.ts` (`emailConfigured`, `emailSender`,
`verifyEmailCredential`, `sendEmail`); `notifyApprovalRequests` channel selection, masking,
per-channel fallback and audit; org-admin `POST /api/integrations/email/verify` and
`POST /api/integrations/email/token`; email integration labels/dialog in
`src/web/integrations.tsx`.
**Merge checkpoint**: `bun test tests/approval-delivery.test.ts tests/slack.test.ts
tests/approval-email-integration.test.ts` green with `fetch` stubbed — Slack preference, email
connection, platform fallback, `undeliverable`, one channel per request, sealed key never returned,
and no throw into the run.

**Depends on**
WS1 (schema, `'email'` kind, category); consumes WS2's `createApprovalRequests` signature. May run
concurrently with WS2 once WS1 lands; agree the request shape before coding T016.

**QA focus**
One channel per request (no double send); Slack `users_not_found` falls through to email; provider
failure never throws, blocks or alters run/queue state; guardrail masking applied to all outbound
text; the sealed Resend key is never returned by `/api/integrations`, logged, or included in errors;
`fromAddress` rejected unless on a verified domain; org-admin gating on connect/disconnect.
## Run integration, decision API and confirmation
- [x] T019 [US1] Replace the local `stageSummary` with the shared helper and wire `notifyGate` to create and fire-and-forget deliver approval requests for review and clarification gates in `src/worker.ts`
- [x] T021 [P] [US2] Add API tests for `GET`/`POST /api/approvals/:token`, recipient match, tenant isolation, stale-state response, and no-membership-grant in `tests/approval-api.test.ts`
- [x] T022 [P] [US2] Add a Playwright test for sign-in, link open, decision submit, and stale re-open in `tests/approval.e2e.test.ts`
- [x] T023 [US2] Extend `answerPausedRun` with an optional `decision` payload, sibling-link invalidation, and atomic decision persistence in `src/lib/run-store.ts`
- [x] T025 [US2] Invalidate outstanding approval links when runs are cancelled in `src/lib/project-cancel.ts`
- [x] T026 [US2] Add the `/approvals/:token` SPA shell entry and the authenticated `GET`/`POST /api/approvals/:token` routes in `src/server.ts`
- [x] T030 [P] [US3] Add integration tests for verbatim agent feedback, confirmation content and channel, and decision visibility in the project run record in `tests/approval-delivery.test.ts`
- [x] T031 [US3] Implement `notifyApprovalDecision` confirmation over the request's channel in `src/lib/approval-notify.ts`
- [x] T032 [US3] Trigger the decision confirmation after a successful link submission in `src/server.ts`
- [x] T033 [US3] Record the link decision outcome, actor, and feedback in the run event stream in `src/lib/run-store.ts`

**Scoped files**
Allowed to modify only: `src/lib/run-store.ts`, `src/lib/project-cancel.ts`, `src/worker.ts`, the
approval/link route block and confirmation call in `src/server.ts`,
`tests/approval-api.test.ts`, `tests/approval.e2e.test.ts`, and the US3 cases appended to
`tests/approval-delivery.test.ts`.
Coordinate the `tests/approval-delivery.test.ts` append with WS3 — do not edit WS3's cases.

**Outputs**
`answerPausedRun` optional `decision` payload, sibling invalidation and atomic persistence; worker
`notifyGate` creates + fire-and-forget delivers requests for review/clarification gates (shared-channel
post retained); cancel-path link invalidation; authenticated `GET`/`POST /api/approvals/:token` and
`/approvals/:token` shell route; `notifyApprovalDecision` confirmation; decision outcome/actor/feedback
in the run event stream.
**Merge checkpoint**: `bun test tests/approval-api.test.ts tests/approval-delivery.test.ts` plus
`tests/approval.e2e.test.ts` green; a link decision resolves the gate exactly once and a second
submit returns the winning outcome without writing.

**Depends on**
WS1 (schema), WS2 (decision store), WS3 (email routes already merged to avoid `src/server.ts`
conflict). Blocks WS5 (routes must be stable) and WS6.

**QA focus**
Decision + link consumption + gate resolution + resume enqueue are one atomic transaction; existing
`answerPausedRun` callers behave byte-for-byte the same; link grants no membership/role and applies no
project-access middleware; 401/403/404/409 semantics and tenant isolation; stale notifications return
the winning state; feedback reaches the agent verbatim; delivery confirmation uses the request channel
and never re-opens a resolved gate.
## Approval link SPA page
- [x] T027 [US2] Build the approval link page with summary, three decisions, inline sign-in, and expired/used/resolved notices in `src/web/approval.tsx`
- [x] T028 [US2] Route `/approvals/:token` to the approval page in `src/web/main.tsx`
- [x] T029 [US2] Add approval card and state styles in `src/web/styles.css`

**Scoped files**
Allowed to modify only: `src/web/approval.tsx`, `src/web/main.tsx`, `src/web/styles.css`.

**Outputs**
`src/web/approval.tsx` page with summary, three decisions, inline sign-in and
expired/used/resolved/confirmation notices; `/approvals/:token` routed in `src/web/main.tsx`;
approval card styles in `src/web/styles.css`.
**Merge checkpoint**: `bun run build:web` clean and the Playwright link flow in
`tests/approval.e2e.test.ts` passes against the WS4 routes.

**Depends on**
WS4 (stable routes and JSON contract). Blocks WS6.

**QA focus**
Inline sign-in reloads back to the same link and token; the raw token never lands in the DOM bundle,
document title, or logs; expired/used/resolved states show a clear path to the in-app gate; feedback
length limits enforced client-side and server-side; no new dependency.
## Security hardening and end-to-end verification
- [x] T034 [P] Add token-secrecy, key-non-disclosure, and no-log assertions across approval paths in `tests/approval-security.test.ts`
- [x] T035 Run `bun run typecheck` and fix all errors in `src/`
- [x] T036 Run `bun run build:web` and fix all web build errors in `src/web/`
- [x] T037 Run `bun test tests/approval-*.test.ts` plus the existing suite and fix failures in `tests/`
- [x] T038 Validate the manual steps in `specs/011-owner-approval-link/quickstart.md` against a local run

**Scoped files**
May add `tests/approval-security.test.ts`. Otherwise read-only across `src/` and `tests/` — fix
failures in the owning workstream's files by rebasing that workstream, not by silently changing its
scope.

**Outputs**
`tests/approval-security.test.ts` (token secrecy, key non-disclosure, no-log, no-membership-grant);
`bun run typecheck` clean; `bun run build:web` clean; full `bun test` including
`tests/approval-*.test.ts` green; quickstart validated against a local run.
**Merge checkpoint**: all listed commands green on the integration branch, recorded in the PR.

**Depends on**
WS2, WS3, WS4, WS5. Runs after the last code workstream; nothing else starts from it except WS8.

**QA focus**
Zero cross-org disclosure; the link alone never reaches project routes; raw token and Resend keys
never appear in responses, errors or logs; migration apply-twice test (T011) is exercised; live
Slack/Resend credentials are not required (stub `fetch`; org memory: key-requiring E2E may be
ignored); the existing suite (not only approval tests) stays green.
## Spaces release, migration and UAT
- [ ] T041 Open the feature pull request from branch `011-owner-approval-link` in the `rayedbajwa/spaces` repository
- [ ] T042 Get CI green on the pull request in `rayedbajwa/spaces` (`bun run typecheck`, `bun run build:web`, existing suites, approval suites) (after T041)
- [ ] T043 Obtain human review approval on the pull request in `rayedbajwa/spaces` (after T042)
- [ ] T044 Merge the pull request in `rayedbajwa/spaces` after approval, following the `governance` merge in T040 (after T043)
- [ ] T045 Confirm the deployment pipeline in `rayedbajwa/spaces` ran and `bun run db:migrate` applied the approval tables idempotently in the deployed environment (after T044)
- [ ] T046 Run the UAT/final acceptance checks in `specs/011-owner-approval-link/test-plan.md` against the deployed `rayedbajwa/spaces` environment (after T045)

**Scoped files**
Branch `011-owner-approval-link` in `rayedbajwa/spaces`; no new source beyond the merged workstreams.

**Outputs**
Feature PR from branch `011-owner-approval-link`; CI green (typecheck, `build:web`, existing suites,
approval suites); human review approval; merge after the governance merge; confirmed deployment with
idempotent `db:migrate`; UAT/final acceptance checks recorded.
**Merge checkpoint**: CI green and human approval before merge; deployed migration and UAT results
recorded after merge.

**Depends on**
WS6 (all code merged and verified) and T040 (governance merge) before T044. Strictly sequential:
T041 → T042 → T043 → T044 → T045 → T046.

**QA focus**
Migration is idempotent in the deployed environment; no secret/credential is committed or logged in
the release; merge/deploy/UAT are human-gated and require explicit approval; key-dependent E2E checks
may be skipped per org memory.

## Sequential Tasks (must not be parallelized)

- **Foundation gate**: T001 → T002/T003/T004/T005/T006 — no story code begins before WS1's merge
  checkpoint.
- **Store chain**: T012 → T013 → T016 → T019; T023 → T024 → T025/T026/T032.
- **Decision chain**: T024 → T031 → T032; T023 → T033.
- **SPA chain**: T026 → T027 → T028 → T029.
- **Shared-file serialization**: `src/server.ts` email routes (T017) → link routes (T026) → decision
  confirmation (T032); `src/lib/run-store.ts` (T023 → T033); `src/lib/approval-notify.ts`
  (T016 → T031).
- **Verification**: T035 → T036 → T037 → T038 after WS2–WS5 merge; T034 may be authored in parallel
  but runs last.
- **Release**: T039 → T040, and T041 → T042 → T043 → T044 → T045 → T046.

## QA Coordination Notes

1. **Single writer per shared file.** `src/server.ts` (WS3 email routes, WS4 link/confirmation
   routes), `src/lib/approval-store.ts` (WS1 types, WS2 lifecycle), `src/lib/approval-notify.ts`
   (WS3 delivery, WS4 confirmation) and `src/lib/run-store.ts` (WS4 only, but consumed by WS2) each
   have one owner at a time. Merge order is WS3 → WS4 for `server.ts`.
2. **Shared test files.** `tests/approval-store.test.ts` (T007 + T020) is owned by WS2;
   `tests/approval-delivery.test.ts` (T008 + T030) is owned by WS3 for US1 cases and WS4 appends US3
   cases only. One author per test file per merge window; rebase before appending.
3. **Interface freeze before parallel coding.** WS2 and WS3 confirm the `createApprovalRequests`
   request/return shape (and WS2/WS4 the `submitApprovalDecision` → `answerPausedRun` seam) before
   either starts, so no workstream invents a competing shape.
4. **No cross-workstream edits in verification.** WS6 fixes failures by sending them back to the
   owning workstream and rebasing, keeping `git bisect` and review diffs attributable.
5. **Database isolation.** All DB-backed tests run through `tests/setup/db-guard.ts` against the test
   Postgres; never point approval tests at the application database.
6. **HTTP stubbing.** Slack and Resend are stubbed at `fetch`; workstreams must not add live-credential
   dependencies to deterministic suites.
7. **Build/test cadence.** Each workstream runs `bun run typecheck` on its own scoped files before its
   merge checkpoint; `build:web` is WS5/WS6; the full suite is the WS6 gate.
8. **CI.** No CI step is added for this feature (org memory); if the existing workflow misses the new
   `tests/approval-*.test.ts` files it is a follow-up, not a workstream.

## Concurrency Recommendation

Run **at most 2 implementation workstreams concurrently** (WS2 store core and WS3 delivery/email)
after the **single, sequential WS1 foundation gate**; add the independent WS7 governance PR at any
time. WS4 and WS5 are serialization points because of `server.ts`, `run-store.ts` and the
route-before-page dependency, so they follow rather than overlap. WS6 verification and WS8 release
are strictly sequential end gates. If a third implementation slot is used, it must be a test-only
author working on WS6's `tests/approval-security.test.ts`, and the shared-file rules above still
apply. This keeps every concurrent writer on a distinct file set and every merge checkpoint
independently verifiable.
