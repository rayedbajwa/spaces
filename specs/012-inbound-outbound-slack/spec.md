# Feature Specification: Inbound Work Intake, Outbound Triggers, and a Two-Way Slack Surface — delta for rayedbajwa/spaces

Initiative: `012-inbound-outbound-slack` · Change: `012-inbound-outbound-slack` · Repository: `github.com/rayedbajwa/spaces`

## Scope in this repository

- **Foundation, Intake Store and Conversion** — `.env.example` intake-sync / outbound-retry / Slack-signing-secret variables; the eight additive tables, indexes and `app_integrations_kind_check` extension with `datadog`; the Monitoring category; `src/lib/run-start.ts` with `startSpecifyRun` (clone-in-progress, duplicate-artifact and in-flight guards preserved); `upsertIntakeItem`, `listIntake`, `setIntakePriority`, conversion/dismiss/restore/merge and `linkIntentToWork` in `src/lib/intake-store.ts`; `GET`/`PATCH /api/intake` and `GET`/`PUT /api/intake/sources`, plus the convert/dismiss/restore/merge routes; `syncProjectIntents` calls `linkIntentToWork`. Tests: `tests/intake-store.test.ts`, `tests/intake-conversion.test.ts`, `tests/intake-api.test.ts`, `tests/intake-migration.test.ts`.
- **Inbound Connectors, Datadog and Source Health** — Jira/Linear/Datadog `(source, cursor) → { items, nextCursor }` connectors, normalization and monotonic cursors; `verifyDatadog` / `listDatadogEvents` in `src/lib/datadog.ts`; `intake_sources` health writes; Datadog verify/token/disconnect routes; the intake-sync worker timer; the best-effort source-ticket update for converted items (T023). Tests: `tests/intake-connectors.test.ts`, `tests/datadog-integration.test.ts`.
- **Routing Rules** — `evaluateRouting` with documented precedence and lower-suggestion retention in `src/lib/intake-routing.ts`; suggestions applied on first arrival in `upsertIntakeItem`; `GET`/`PUT /api/intake/routing-rules`; `tests/intake-routing.test.ts`.
- **Slack Two-Way Surface** — Shared exactly-once decision core callable with a link token or `{ gateId, actorUserId, outcome, feedback }`; nullable `decision.requestId`/`linkId`; sealed Slack signing secret; extended Slack manifest (slash commands, event subscriptions, interactivity); `commands` scope; verified `slack_identity_links` with unique/ambiguous/one-time verification; signature-verified events/interactions/commands with workspace→org resolution and signed approval references; interactive approval buttons, question-thread prompt and stale-prompt update; `/api/slack/{events,interactions,commands}` and identity routes. Tests: `tests/slack-identity.test.ts`, `tests/slack-interactions.test.ts`.
- **Outbound Triggers** — `outbound_subscriptions` CRUD and `emitOutboundEvent` with `ON CONFLICT (subscription_id, event_key) DO NOTHING`; `src/lib/outbound-deliver.ts` target actions, exponential backoff, bounded attempt cap and guardrail masking; `run_failed` / `gate_opened` / `stage_completed` emissions at existing worker points; `verification_completed` / `feature_delivered` from the intent status transition; the outbound drain timer and `GET`/`PUT /api/outbound/subscriptions`. Tests: `tests/outbound-store.test.ts`, `tests/outbound-delivery.test.ts`.
- **SPA Integration** — `src/web/intake.tsx` prioritized queue with source health, triage/convert/dismiss/merge, routing suggestions, matched-rule label and manual override; `src/web/outbound.tsx` subscriptions view; `src/web/slack-link.tsx` identity verification confirmation; routes in `src/web/main.tsx` (`/intake`, `/outbound`, `/slack-link/:token`) and the converted-work link back to Intake; navigation entries in `src/web/shell.tsx`; queue/monitoring/outbound styles in `src/web/styles.css`. E2E: `tests/intake-outbound.e2e.test.ts`.
- **Documentation and CI Wiring** — New `docs/concepts/` pages for Intake, outbound triggers and the two-way Slack surface; the new intake/Slack/outbound test files wired into the existing CI test steps.
- **Verification and Release (Sequential End Gate)** — `bun run typecheck`, `bun run db:migrate` (twice), `bun run build:web` and `bun test` all green with failures fixed; the quickstart acceptance run against `PORT=3369`; the `spaces` pull request with feature documents synced in; CI green and human review approval; merge to `main`; confirmed deployment; `test-plan.md` UAT and final acceptance on the deployed environment.

## Specification (from the initiative)

# Feature Specification: Inbound Work Intake, Outbound Triggers, and a Two-Way Slack Surface

**Scope**: feature

**Feature Branch**: `012-inbound-outbound-slack`  
**Created**: 2026-10-12  
**Status**: Draft  
**Input**: User description: "Inbound — work arrives from other tools (a Jira or Linear issue, a Slack request, a Datadog alert), lands in the organization's prioritized Intake queue, and becomes features or bugfixes in the right project. Outbound — things that happen in Spaces (a run fails, a feature is delivered) trigger actions in other tools. Slack as a two-way surface — people file tickets, approve or reject gates, and answer the agent from Slack without opening Spaces."

## Problem Statement *(mandatory)*

Work and information move in only one direction across Spaces' integrations today.
Jira and Linear tickets can be searched and imported by hand, Slack receives
one-way run updates, and nothing yet consumes a Datadog alert. When a real piece
of work originates outside Spaces — a filed issue, a colleague's request in
Slack, a production alert — someone has to notice it, retype it, and manually
create the project work. Decisions have the same problem in reverse: a human
gate can only be approved in the Spaces app, so people who live in Slack stall
the line, and when a run fails or a feature ships, the tool that raised the work
never hears about it.

The intended outcome is a two-way integration layer. Inbound, work from
connected tools lands automatically in the organization's prioritized **Intake
queue**, where an authorized person triages it into a feature or bugfix in the
right project, with the original item linked for traceability. Outbound, notable
things that happen inside Spaces (a run fails, a feature is delivered, a gate
opens, verification completes) trigger configured actions in other tools, so the
source ticket and the team's channel stay current. Slack becomes a true
two-way surface: linked people file requests, approve or reject gates, and
answer the agent from Slack without opening Spaces — with the same authority,
exactly-once decisions and audit trail as the in-app gate.

This is a feature-sized capability: it introduces a new organization-level queue
and routing surface, extends the integration model beyond read-only knowledge,
and adds externally-triggered outbound actions, while preserving every existing
authentication, authorization, tenant-isolation and human-gate guarantee.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Inbound work lands in the prioritized Intake queue (Priority: P1)

A connected tool raises something — a new Jira or Linear issue in a watched
scope, a Slack message someone marks as a request, or a Datadog alert matching a
configured severity — and it appears in the organization's Intake queue without
anyone retyping it. Each item carries enough context to judge it (source, title,
summary, link, requester, when it arrived, suggested urgency), is deduplicated
against re-deliveries, and can be ordered so the most urgent work is triaged
first.

**Why this priority**: This is the foundation of the whole feature. Without a
single, trustworthy place where outside work arrives, triage, conversion and
Slack filing have nothing to act on. It delivers value on its own by ending
copy-and-paste intake.

**Independent Test**: Connect one source, raise an item in that source, and
verify exactly one Intake item appears with the source, external reference, a
working link and a timestamp — and that re-delivering the same item does not
create a second row.

**Acceptance Scenarios**:

1. **Given** a Jira connection watching a project scope and an organization that
   has Intake enabled, **When** a new issue is created in that scope, **Then** an
   Intake item appears with the issue key, title, summary, a link that opens the
   issue, the source, and the arrival time, with no manual entry.
2. **Given** a Linear connection watching a team, **When** an issue is created or
   updated there, **Then** the Intake item appears (or its content is refreshed)
   with the issue identifier and link.
3. **Given** a Datadog connection and a configured severity threshold, **When** a
   matching alert fires, **Then** an Intake item appears with the alert name,
   severity, affected service, link and time.
4. **Given** Slack is connected and a member posts a message requesting a
   ticket, **When** the request is submitted, **Then** an Intake item is created
   attributed to the requesting Slack person.
5. **Given** the same source item is delivered more than once, **When** the
   duplicates arrive, **Then** exactly one Intake item exists for that source
   item, and later deliveries update it rather than adding rows.
6. **Given** a queue with items of differing priority, **When** it is viewed,
   **Then** items are ordered by priority and then by arrival time, and an
   authorized person can change an item's priority or reorder it.
7. **Given** items from several organizations' connections, **When** an
   authorized person views the queue, **Then** only their own organization's
   items are visible.

---

### User Story 2 - Triage an Intake item into work in the right project (Priority: P1)

An authorized person reviews the Intake queue and turns an item into real project
work. They choose the project and whether the item is a feature or a bugfix,
adjust the wording, and confirm. The resulting tracked work keeps a durable link
to the original source item, and the source item is updated (where the tool
supports it) so the person who raised it can see that Spaces picked it up.
Items can also be dismissed, restored, or merged as duplicates, always with who
and why.

**Why this priority**: Arrival without conversion is just another inbox.
Converting an item into project work in the right place is the outcome the queue
exists for, and it is independently testable from outbound actions or Slack
decisions.

**Independent Test**: Start from a queued item, assign it to a project as a
bugfix, and verify a new bugfix work item exists in that project with a link
back to the source, the queue item marked converted with actor and time, and the
source ticket updated when the tool supports it.

**Acceptance Scenarios**:

1. **Given** an un-triaged Intake item and a person with triage permission,
   **When** they assign it to a project and choose "bugfix", **Then** the project
   gains a new bugfix entry whose description cites the source item, the queue
   item becomes converted, and the actor and time are recorded.
2. **Given** the same item, **When** the person chooses "feature", **Then** the
   project gains a feature entry scoped with the source context.
3. **Given** a person without triage permission, **When** they attempt to assign,
   convert or dismiss an item, **Then** the action is refused, nothing changes,
   and the refusal is visible to them.
4. **Given** two queue items describing the same request, **When** a triager
   merges them, **Then** one item remains, both originals stay linked from the
   surviving item, and the merge is recorded.
5. **Given** a converted item, **When** the source tool is reachable and
   conversion updates are enabled, **Then** the source item receives a traceable
   link or status update, and a failure to update the source does not block or
   undo the conversion.
6. **Given** a dismissed item, **When** the queue is viewed, **Then** the item
   has left the active queue but is retained with the dismissal reason and actor
   and can be restored.
7. **Given** a triager is unsure, **When** they convert an item, **Then** the
   original source content remains attached and unaltered for later reference.

---

### User Story 3 - File work and decide gates from Slack (Priority: P1)

People who live in Slack treat it as a full surface: a linked person can file a
request that becomes an Intake item, and when a run is waiting on a human
decision they can approve, approve with notes, request changes, or answer the
agent's question directly in Slack. Every action carries the same authorization
and effect as the in-app gate, is recorded exactly once, and is confirmed back
in Slack.

**Why this priority**: This is the headline two-way capability and the largest
source of stalled gates. It is testable without the inbound queue or outbound
triggers, and it must never weaken the existing authorization and exactly-once
guarantees.

**Independent Test**: Open a gate, have the authorized accountable person act on
it in Slack, and verify the run responds exactly as an in-app decision would,
the outcome is recorded once with actor and time, and a second action shows the
winning outcome without changing it.

**Acceptance Scenarios**:

1. **Given** a linked person who is the accountable approver and a gate awaiting
   a decision, **When** they choose "Approve" in Slack, **Then** the decision is
   recorded exactly once and the run continues as it would from the in-app gate.
2. **Given** the same gate, **When** the person chooses "Approve with notes",
   **Then** the notes are delivered verbatim to the agent and the run continues.
3. **Given** the same gate, **When** the person chooses "Request changes" with
   feedback, **Then** the work is sent back to the agent with that feedback and
   the gate is not reported as passed.
4. **Given** an agent clarification question, **When** the accountable linked
   person replies in the thread, **Then** the reply is delivered verbatim as the
   answer and the run continues.
5. **Given** a Slack person who is not an authorized approver for that gate,
   **When** they attempt to decide, **Then** the attempt is refused, no decision
   is recorded, and the items and run are unchanged.
6. **Given** a Slack person with no linked Spaces account, **When** they attempt
   to decide, **Then** they are asked to verify and link their identity, and no
   decision is recorded until that verification succeeds.
7. **Given** a gate already resolved, **When** anyone acts on the old Slack
   prompt, **Then** the winning outcome is shown and nothing is changed.
8. **Given** a linked person in Slack, **When** they file a request, **Then** an
   Intake item is created under the same rules as User Story 1, attributed to
   them.
9. **Given** a decision or request made in Slack, **When** it is recorded, **Then**
   the actor, source surface ("Slack"), time and outcome are auditable.

---

### User Story 4 - Outbound events trigger actions in other tools (Priority: P2)

When something notable happens inside Spaces — a run fails, a gate opens, a
feature is delivered, verification completes — configured actions fire in other
tools: the source ticket is updated, an issue is opened, or a message is posted
to a channel. Subscriptions say what event maps to which action in which tool;
deliveries are retried, idempotent and recorded, and a failure to reach an
external tool never changes or blocks the run.

**Why this priority**: It closes the loop and keeps the tools people already use
current, but it is valuable after the inbound and Slack-decision flows exist and
can be delivered independently against those events.

**Independent Test**: Configure one subscription for "run failed", force a run
failure, and verify the configured action happens in the target tool with the
project, error summary and a link to the run — and that a target outage does not
alter the run's outcome.

**Acceptance Scenarios**:

1. **Given** an organization subscription for "run failed" targeting a tool,
   **When** a run fails, **Then** an action occurs in that tool within the
   expected interval containing the project, a short error summary and a link to
   the run.
2. **Given** a subscription for "feature delivered", **When** a feature is
   delivered, **Then** the linked source ticket is updated and/or a message is
   posted to the configured channel with the feature name and delivery link.
3. **Given** a subscription for "gate opened" or "verification completed",
   **When** the event occurs, **Then** the configured action fires with enough
   context to act without opening Spaces.
4. **Given** the target tool is unavailable or rejects the action, **When** the
   event fires, **Then** delivery is retried and the failure is recorded, and the
   run and its state are unaffected.
5. **Given** the same event is delivered more than once, **When** duplicates
   arrive, **Then** the external action is applied at most once for that event.
6. **Given** no subscription covers an event, **When** it occurs, **Then** no
   outbound action is taken.
7. **Given** an outbound payload, **When** it is sent, **Then** it contains no
   secrets, credentials or restricted content.

---

### User Story 5 - Route and prioritize inbound work automatically (Priority: P3)

An organization can define routing rules that match incoming items (by source,
keyword, label, severity or scope) and set a target project, team, or priority,
so the common cases land pre-triaged and triagers handle exceptions. Manual
triage always remains available and always overrides a rule.

**Why this priority**: It reduces triage toil once volume grows, but the feature
works end to end without it.

**Independent Test**: Create one routing rule, deliver a matching item, and
verify it arrives pre-assigned with the rule's priority and target while a
non-matching item still requires manual triage.

**Acceptance Scenarios**:

1. **Given** an enabled routing rule, **When** a newly arrived item matches it,
   **Then** the item shows the rule's suggested project/priority and names the
   rule that matched.
2. **Given** several matching rules, **When** an item matches more than one,
   **Then** a documented precedence decides the winner and the others are shown
   as lower-priority suggestions.
3. **Given** a rule-routed item, **When** a triager changes the target or
   priority, **Then** the manual choice wins and the override is recorded.
4. **Given** a disabled rule, **When** an item would have matched it, **Then**
   the item is untouched by that rule.

---

### Edge Cases

- **Source disconnected or credentials expired**: queued items are retained and
  the source is shown as unhealthy; no data is lost, and syncing resumes on
  reconnect without duplicating items.
- **External item changed or deleted after arrival**: an update refreshes the
  existing Intake item; a deletion marks it unavailable while preserving the
  record and any linked converted work.
- **Ambiguous or missing project on conversion**: the triager must choose; the
  system never guesses a project, and no work is created until they do.
- **Alert storm**: repeated Datadog alerts for the same condition and service
  aggregate into one item (or update it) rather than flooding the queue, and
  clearly show repeat count.
- **Concurrent or duplicate Slack decisions**: at most one decision is recorded;
  every later attempt sees the winner and changes nothing.
- **Slack outage or an undeliverable Slack message**: the in-app gate stays
  actionable and the decision is never lost; nothing about the run is blocked.
- **Slack identity mismatch**: a Slack email that does not map to exactly one
  active member of the owning organization requires explicit verification before
  any action is accepted.
- **Authorization revoked between prompt and action**: the action is refused and
  the gate is re-presented to the currently accountable person.
- **Large or sensitive external content**: inbound content is subject to the
  organization's data guardrails before storage or display, and restricted
  content is not forwarded outbound.
- **Cross-tenant delivery**: an item, decision or outbound action can never
  cross organization boundaries, even when the same external workspace serves
  two organizations.
- **Re-delivery after reconnection**: already-seen items are recognized and do
  not create duplicates; genuinely new items since the last successful sync are
  picked up.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST receive inbound work from Jira, Linear, Slack and
  Datadog connections, using the organization's existing connection and
  credential model.
- **FR-002**: Each received item MUST be normalized into an Intake item carrying
  at least: source, external reference, title, summary, link, requester (when
  known), arrival time, and a priority.
- **FR-003**: Intake ingestion MUST be idempotent per source and external
  reference: re-delivery MUST update the existing item and MUST NOT create a
  duplicate.
- **FR-004**: The system MUST present an organization-scoped Intake queue ordered
  by priority and then arrival time, and MUST let an authorized person change an
  item's priority.
- **FR-005**: Intake items MUST have explicit states — new, converted, dismissed,
  merged — with the actor and time of every transition recorded.
- **FR-006**: An authorized person MUST be able to convert an item into project
  work, choosing the target project and whether it is a feature or a bugfix.
- **FR-007**: Converted work MUST retain a durable, navigable link to the source
  item, and the source item MUST be updatable with a traceable link or status
  change when the tool supports it.
- **FR-008**: A failure to update the source tool MUST NOT block or roll back a
  conversion.
- **FR-009**: An authorized person MUST be able to dismiss, restore and merge
  Intake items, each recording the actor and reason.
- **FR-010**: Viewing and mutating the Intake queue and converting items MUST be
  restricted to authorized roles within the owning organization.
- **FR-011**: Slack MUST support filing a request that creates an Intake item,
  attributed to the acting Slack person.
- **FR-012**: Slack MUST support acting on a pending human gate: approve, approve
  with notes, request changes with feedback, and answering an agent's
  clarification question.
- **FR-013**: A Slack gate action MUST have exactly the same effect as the
  equivalent in-app decision, including delivering feedback to the agent
  verbatim.
- **FR-014**: Each gate MUST accept at most one decision across all surfaces; a
  later attempt MUST show the already-recorded outcome and MUST NOT alter it.
- **FR-015**: A Slack action MUST be accepted only from a person verified and
  linked to a Spaces member who is authorized for that action; otherwise it MUST
  be refused with no state change.
- **FR-016**: The system MUST notify the acting person in Slack of the recorded
  outcome, and MUST show a stale prompt as already decided.
- **FR-017**: The system MUST support outbound actions triggered by notable
  Spaces events, at minimum: run failed, gate opened, stage completed,
  verification completed, and feature delivered.
- **FR-018**: Outbound behavior MUST be configurable per organization and per
  project through subscriptions that map an event to a target tool and action,
  and subscriptions MUST be individually enableable and disableable.
- **FR-019**: Outbound payloads MUST include enough context to act (project,
  event, summary, and a link) and MUST NOT include secrets, credentials or
  restricted content.
- **FR-020**: Outbound delivery MUST be idempotent per event and target and MUST
  be retried on failure with the attempt, time and outcome recorded.
- **FR-021**: Outbound delivery failure MUST NOT fail, pause, or change the run
  or feature that produced the event.
- **FR-022**: The system MUST support routing rules that match inbound items by
  source, scope, label, severity or keyword and suggest a target project, team
  and priority; manual triage MUST always override a rule.
- **FR-023**: Inbound content MUST pass through the organization's data
  guardrails before storage, display, or outbound forwarding.
- **FR-024**: The system MUST surface connection health for each intake source
  and MUST stop accepting new items from a broken source without losing already
  queued items.
- **FR-025**: All intake ingestion, triage, conversion, dismissal, merge, routing,
  Slack actions and outbound deliveries MUST be auditable with actor, time,
  origin surface, and outcome.
- **FR-026**: Intake items and their provenance MUST be retained after
  conversion, dismissal or merge for traceability.
- **FR-027**: Every operation in this feature MUST preserve organization, team and
  project tenant boundaries; external identities MUST NOT grant access.
- **FR-028**: Inbound ingestion, Slack actions and outbound deliveries MUST NOT
  change existing pipeline, gate, or authorization behavior when the feature is
  not configured.
- **FR-029**: Repeated or storm-like alerts from a single source condition MUST
  aggregate or update rather than create unbounded duplicate items.
- **FR-030**: The system MUST provide enough status feedback in Slack and in the
  app for a person to tell whether an item was received, converted, dismissed, or
  is still waiting.

### Key Entities *(include if feature involves data)*

- **Source Connection**: an organization's configured Jira, Linear, Slack or
  Datadog integration, with health, watched scope, and credentials managed by the
  existing vault.
- **Intake Item**: one piece of inbound work — source, external reference, title,
  summary, link, requester, arrival time, priority, state, and optional suggested
  project/team from routing.
- **Intake Transition / Audit Entry**: a state change or action on an item —
  actor, origin surface, time, from/to state, and reason.
- **Converted Work Link**: the durable relationship between an Intake item and the
  project feature or bugfix it became, including the source-side update status.
- **Routing Rule**: a match condition plus a suggested target project, team and
  priority, with enablement and precedence.
- **Outbound Subscription**: an event-to-target mapping (tool, destination,
  action) scoped to an organization or project, with enablement.
- **Outbound Delivery**: one attempt to perform an outbound action — event,
  target, outcome, attempts, and time.
- **Slack Identity Link**: the verified association between a Slack person and a
  Spaces member/account, granting no project access by itself.

## Dependencies and Assumptions *(mandatory)*

### Dependencies

- The existing organization/team/project model and role-based authorization
  (organization → team → project, roles: owner, admin, member, viewer).
- The existing integration connection and encrypted credential vault, including
  Jira, Linear and Slack connections, and the pipeline/run/gate event sources
  that outbound subscriptions consume.
- The existing data guardrails pipeline for masking secrets and sensitive data.
- A new Datadog connection type, approved by the organization, since Datadog is
  named as an inbound source but is not currently a connected integration.
- The existing human-gate and project-responsibility resolution used to decide
  who may act on a gate from Slack.

### Assumptions

- **Intake is organization-scoped**: one prioritized queue per organization, so
  items can be triaged to any project the organization owns.
- **Human-in-the-loop by default**: items land unassigned unless an enabled
  routing rule matches; conversion always requires an authorized person, and no
  project or priority is guessed.
- **Slack identity**: a Slack action is accepted only after linking the Slack
  person to a Spaces member and then enforcing the same authorization as the
  in-app gate; matching is by verified email, with explicit verification when it
  is ambiguous.
- **Outbound "actions" in this increment** mean the common, reversible ones:
  commenting on or updating the linked issue, creating an issue, and posting a
  message to a channel. Destructive or production-changing actions are not
  included.
- **Default subscriptions**: when outbound is enabled, "run failed" and "feature
  delivered" are offered as sensible defaults; everything else is opt-in.
- **Priority vocabulary**: a small ordered set (for example urgent, high,
  normal, low) with "normal" as the default for untriaged items.
- **Retention**: Intake items and their history are retained by default so
  traceability survives conversion; the organization's normal data-retention
  controls apply.
- **Existing gates unchanged**: this feature adds surfaces and triggers around
  runs; it does not change the AIDLC stage model, gate semantics, or who is
  accountable.

### Out of Scope

- Custom or user-defined integration providers beyond Jira, Linear, Slack and
  Datadog in this increment.
- Replacing team roles or making project responsibility grant any access.
- Automatically converting an item into project work with no human involved.
- Bidirectional sync of every field of a ticket; only the conversion link and
  configured status/comment updates are in scope.
- Running destructive or production-impacting actions in external tools.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A newly raised item in a connected source appears in the Intake
  queue without manual entry within two minutes of being raised, for at least 95%
  of items.
- **SC-002**: Re-delivering the same source item never produces a second Intake
  item; duplicate rate is zero in end-to-end tests.
- **SC-003**: At least 90% of triaged items become a feature or bugfix in the
  intended project on the first attempt, with a working link back to the source.
- **SC-004**: A person can file an intake request, approve a gate, or answer the
  agent from Slack in under one minute and no more than three interactions.
- **SC-005**: Zero gates are decided more than once; every later attempt shows the
  winning outcome.
- **SC-006**: Zero unauthorized Slack decisions are recorded; 100% of accepted
  actions are attributable to a verified, authorized person.
- **SC-007**: A configured outbound action fires within one minute of its event
  for at least 95% of events, and zero outbound failures change or block a run.
- **SC-008**: Duplicate outbound deliveries never perform an external action more
  than once per event and target.
- **SC-009**: Zero cross-organization items, decisions or outbound actions occur
  in end-to-end tenant-isolation tests.
- **SC-010**: The share of human gates waiting more than 24 hours falls by at
  least half within one quarter of adoption compared with the pre-feature
  baseline.

### Acceptance Test Coverage

This table maps the functional requirements to the acceptance scenarios and edge
cases QA can build tests from; each row is independently verifiable.

| Requirements | Scenario coverage | What it proves |
|---|---|---|
| FR-001, FR-002, FR-024 | US1 #1–#4; edge cases (source disconnected, deleted item) | Ingestion, normalization and source health |
| FR-003, FR-029 | US1 #5; edge cases (alert storm, re-delivery) | Idempotent ingestion and storm aggregation |
| FR-004, FR-005 | US1 #6, US2 #3, #6 | Queue ordering, priority change, item states |
| FR-006, FR-007, FR-008, FR-026 | US2 #1, #2, #5, #7 | Conversion, traceability, non-blocking source update |
| FR-009 | US2 #4, #6 | Merge, dismiss, restore with actor and reason |
| FR-010, FR-027 | US1 #7, US2 #3; edge cases (cross-tenant) | Authorization and tenant isolation |
| FR-011, FR-030 | US3 #8; US1 #4 | Slack filing and status feedback |
| FR-012, FR-013 | US3 #1–#4 | Slack decisions have in-app effect, verbatim answers |
| FR-014 | US3 #7; edge cases (concurrent decisions) | Exactly-once gate decisions |
| FR-015 | US3 #5, #6; edge cases (identity mismatch, revoked access) | Verified identity and authorization |
| FR-016 | US3 #7, #9 | Confirmation and stale-prompt handling |
| FR-017, FR-018 | US4 #1–#3, #6 | Event catalog and subscription configuration |
| FR-019, FR-023 | US4 #7; edge cases (sensitive content) | Guardrails and non-leakage of restricted content |
| FR-020, FR-021 | US4 #4, #5; edge cases (target outage) | Idempotent, retried, non-blocking delivery |
| FR-022 | US5 #1–#4 | Routing rules, precedence, manual override |
| FR-025 | US3 #9; US2 #1; US4 #1 | Auditability across surfaces |
| FR-028 | All | No behavior change when the feature is unconfigured |
| SC-001…SC-010 | All | End-to-end timing, duplicate, isolation and adoption measures |
