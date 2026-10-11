# Feature Specification: Owner Approval Links — delta for rayedbajwa/spaces

Initiative: `011-owner-approval-link` · Change: `011-owner-approval-link` · Repository: `github.com/rayedbajwa/spaces`

## Scope in this repository

- **Foundation — schema, config and shared types** — `.env.example` documented fallbacks; TTL/sender config readers; five additive `approval_*` tables
- **Approval store core — resolution, links and decisions** — `resolveGateRecipients` with Owner fallback and repair-needed; `createApprovalRequests`
- **Direct delivery, Slack DM and email integration** — `sendDirectMessage` + `im:write` scope; `src/lib/email.ts` (`emailConfigured`, `emailSender`,
- **Run integration, decision API and confirmation** — `answerPausedRun` optional `decision` payload, sibling invalidation and atomic persistence; worker
- **Approval link SPA page** — `src/web/approval.tsx` page with summary, three decisions, inline sign-in and
- **Security hardening and end-to-end verification** — `tests/approval-security.test.ts` (token secrecy, key non-disclosure, no-log, no-membership-grant);
- **Spaces release, migration and UAT** — Feature PR from branch `011-owner-approval-link`; CI green (typecheck, `build:web`, existing suites,

## Specification (from the initiative)

# Feature Specification: Owner Approval Links

**Scope**: feature

**Feature Branch**: `011-owner-approval-link`  
**Created**: 2026-10-11  
**Status**: Draft  
**Input**: User description: "building a slack or email based approval process for the assigned owner with a one time usable link to provide feedback for the agent and sent summary and action in the email"

## Problem Statement *(mandatory)*

Spaces pauses a run whenever a stage reaches a human decision point — a review
approval, or a question the agent needs answered before it can continue. Today
those pauses are announced to the project's shared Slack channel (when Slack is
connected) and the reader is sent to the project page, where they must be signed
in to act. When Slack is not connected there is no outbound notification at all,
and the gate simply waits in the app.

The result is a decision that belongs to a named, accountable person — the
project responsibility assignee for that stage — but is delivered to whoever
happens to be watching a channel. Approvals stall for hours or days, decisions
are taken without the accountable owner, and there is no durable record of the
summary the decider actually read before acting.

The intended outcome: when a run pauses, the accountable owner (the assigned
responsibility, or the Owner fallback) receives a direct Slack message or an
email containing the stage summary and a single-use link. Opening that link
shows the same summary, lets the owner approve, approve with notes, or send the
work back with feedback for the agent, consumes the link, and confirms back to
the owner what was decided and on what basis. The run continues, stops or
re-runs accordingly, and the notification and decision are auditable.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The accountable owner receives the approval request (Priority: P1)

A run pauses at a human decision point. Spaces resolves who is accountable for
that stage — the project responsibility assignee, or the project Owners when the
responsibility is unassigned — and sends that person a direct Slack message and/or
an email. The message names the project and stage, quotes the agent's summary of
the work being decided, and contains a single-use link to act.

**Why this priority**: This is the missing link between a paused run and the one
person whose job it is to unblock it. Without it, gates stall or are decided by
the wrong person, and organizations without Slack receive nothing.

**Independent Test**: Pause a run on a gate in a project whose mapped
responsibility has an active assignee, and verify a direct message/email is
produced for that assignee containing the project, the stage, the summary and
one action link — and that no message is produced for the shared channel in
place of the owner.

**Acceptance Scenarios**:

1. **Given** a project with an active assignee for the responsibility mapped to a stage, **When** a run reaches a review approval for that stage, **Then** the assignee receives the request over the organization's configured delivery channel(s) with the project name, stage name, agent summary and a single-use link.
2. **Given** the mapped responsibility has no explicit assignee but the project has an active Owner, **When** a gate opens, **Then** the request is delivered to that Owner and the message states that it is an Owner fallback.
3. **Given** a project with no active Owner and no assignee, **When** a gate opens, **Then** no recipient is guessed, the request stays actionable in the app, and the project's responsibility state is marked as needing repair.

---

### User Story 2 - The owner decides from the one-time link (Priority: P1)

The owner opens the link from Slack or email. The page shows the same summary
they were sent and the available decisions. They approve, approve with notes, or
request changes with feedback. The link is consumed, the decision is recorded
against the gate, and the run continues, is reworked, or stops accordingly.

**Why this priority**: Delivery alone does not unblock anything. The owner must
be able to act with the minimum friction the link promises while the decision
still lands on the correct gate.

**Independent Test**: Take an open gate, open its single-use link, submit each
decision type, and verify the gate records the decision and the run behaves
accordingly; then attempt to reuse the link and verify it is refused.

**Acceptance Scenarios**:

1. **Given** an unexpired, unused link for an open gate, **When** the owner approves, **Then** the gate is resolved as approved, the run continues, and the link can no longer be used.
2. **Given** an unexpired, unused link, **When** the owner approves with notes, **Then** the notes are recorded and passed to the agent as guidance for the stage before the run continues.
3. **Given** an unexpired, unused link, **When** the owner requests changes with feedback, **Then** the feedback is recorded and delivered to the agent so the work is re-run before the gate can be reported as passed.
4. **Given** a link that has already been used, **When** it is opened again, **Then** the already-recorded outcome is shown and no second decision can be made.

---

### User Story 3 - Feedback reaches the agent and confirmation reaches the owner (Priority: P2)

Whichever decision the owner makes, the platform tells them what was recorded
and on what basis, and the agent receives the owner's feedback so that "approve
with notes" and "request changes" change the work rather than just closing a
gate. The project's own activity shows the same outcome so teammates are not
surprised by the decision.

**Why this priority**: The feature's value is closing the loop: feedback has to
change what the agent does next, and the accountable owner needs confirmation
that their decision was applied.

**Independent Test**: Submit feedback through a link and verify the next agent
pass receives it; verify a confirmation message is produced for the owner and
the outcome is visible in the project's record.

**Acceptance Scenarios**:

1. **Given** an owner submits feedback with "request changes", **When** the run re-runs the stage, **Then** the agent's input contains that feedback verbatim.
2. **Given** an owner submits any decision through a link, **When** the decision is recorded, **Then** the owner receives a confirmation naming the project, stage, decision, feedback and the summary they acted on.
3. **Given** a decision made through a link, **When** project participants view the run, **Then** they see the decision, who made it, when, and the feedback.

---

### Edge Cases

- **Expired link**: opening a link after its validity window shows an expired notice and points the person to the in-app gate; the gate stays open and may be re-notified.
- **Forwarded or intercepted link**: a link opened by someone other than the intended recipient must not expose the summary or allow a decision; the attempt is recorded.
- **Recipient loses access**: if the recipient is removed, deactivated, or no longer an assignee before acting, the link is refused and the gate is reassigned or re-notified to the current accountable owner.
- **Multiple active assignees**: the primary assignee (first active by order) is the addressee; the remaining active assignees are informed and any one of them may act. The first accepted decision wins and all other links for that gate are invalidated.
- **Concurrent decisions**: two recipients submit at nearly the same time; exactly one decision is recorded, the second submission shows the winning outcome.
- **Gate resolved elsewhere**: the gate is approved in the app, or the run is cancelled, while a link is outstanding; outstanding links stop working and show the resolved outcome.
- **No delivery channel**: neither Slack nor email is configured, or the recipient is unreachable; nothing fails, the gate remains actionable in the app, and the delivery attempt is recorded as undeliverable with repair guidance.
- **Delivery failure on one channel**: Slack delivery fails but email is configured (or vice versa); the other channel is used and the run is never blocked by a notification failure.
- **Duplicate notification**: a retry or repeated gate event must not create more than one active request per recipient per gate.
- **Cross-tenant attempt**: a link from one organization's project must never reveal data from, or act on, another organization's project.
- **Stage with no mapped responsibility**: the request falls back to the project Owner; if none is resolvable it is treated as repair-needed rather than sent to no one.
- **Decision arrives after the run ended**: the resolution attempt is rejected and reports that the gate is closed.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: When a run pauses at a human decision point, the system MUST determine the accountable recipient by resolving the project responsibility mapped to the stage, and MUST fall back to project Owners when that responsibility has no explicit assignee.
- **FR-002**: The system MUST NOT invent or guess a recipient. When no eligible active recipient can be resolved, the gate MUST remain actionable in the app and the project's responsibility state MUST be marked as needing repair.
- **FR-003**: The system MUST deliver the approval request to the accountable recipient over the organization's configured delivery channels — a Slack direct message and/or email — without requiring the recipient to be watching the project channel.
- **FR-004**: The approval request MUST name the project and stage, include a summary of the agent's output at the gate, identify the recipient's responsibility, and contain a single action link.
- **FR-005**: The action link MUST be unique to one gate and one recipient, unguessable, valid for a bounded period, and invalidated immediately and permanently after its first accepted use.
- **FR-006**: The action link MUST be usable only by the intended recipient and MUST NOT be treated as authorization to view or change anything beyond that gate's summary and decision.
- **FR-007**: Opening a valid link MUST present the same summary the recipient was sent and offer the decisions: approve, approve with notes, and request changes with feedback.
- **FR-008**: Submitting a decision MUST record the chosen outcome, the feedback text if any, the acting person, and the time.
- **FR-009**: The system MUST apply the recorded decision to the run: approve continues, approve with notes continues after the notes are passed to the agent, and request changes sends the stage back to the agent with the feedback before the gate can be reported as passed.
- **FR-010**: Feedback submitted through a link MUST be delivered verbatim to the agent as the reviewer's guidance.
- **FR-011**: Each gate MUST accept at most one decision. A second decision attempt MUST show the already-recorded outcome and MUST NOT alter it.
- **FR-012**: When a gate is resolved by any other path — in-app decision, cancellation, or another recipient — every outstanding link for that gate MUST become invalid.
- **FR-013**: When a responsibility has multiple active assignees, the primary assignee MUST be the addressee, the other active assignees MUST be informed, and any active assignee MUST be allowed to decide; the first accepted decision resolves the gate.
- **FR-014**: Delivery MUST be idempotent per gate and recipient: retries and repeated gate events MUST NOT create more than one active request for the same recipient and gate.
- **FR-015**: Every delivery attempt and every decision MUST be auditable, recording recipient, channel, responsibility, time, and outcome.
- **FR-016**: A notification or delivery failure MUST NOT fail, pause, or otherwise block the run; the system MUST try the remaining configured channel and leave the gate actionable in the app.
- **FR-017**: Link content and the decision page MUST respect organization and team boundaries; a link MUST never expose cross-organization data.
- **FR-018**: If the recipient's access or assignment is revoked before they act, the link MUST be refused and the request MUST be re-resolved to the current accountable recipient.
- **FR-019**: After any decision, the system MUST send the deciding owner a confirmation that states the project, stage, decision, feedback, and the summary they acted on.
- **FR-020**: Using a link MUST NOT grant the recipient any project access, role, or permission beyond recording the one decision.
- **FR-021**: The system MUST cover both review approval gates and agent clarification questions, since both pause a run waiting on a human decision.
- **FR-022**: A recipient MUST be able to see whether a request is still open or already decided when they open the link, so a stale notification cannot be mistaken for a pending action.

### Key Entities *(include if feature involves data)*

- **Approval Request**: a request for one accountable recipient to decide one gate. Carries the gate, the run, the project, the resolved responsibility, the recipient, the summary shown, the delivery channel(s), its state (pending, delivered, undeliverable, decided, invalidated) and timestamps.
- **Action Link**: a single-use credential for one approval request. Carries a unique unguessable reference, its validity window, the recipient it is bound to, and whether it has been consumed.
- **Decision**: the outcome recorded for a gate through a request. Carries the outcome (approve, approve with notes, request changes), the feedback text, who decided, when, and which request/link produced it.
- **Delivery Attempt**: the audit record of a notification try. Carries the request, channel, outcome, failure detail when applicable, and time.
- **Responsibility Resolution**: the existing project responsibility assignment used to pick the recipient, including the Owner-fallback and repair-needed states.

## Dependencies and Assumptions *(mandatory)*

### Dependencies

- The existing project responsibility model and resolution rules (standard responsibilities, ordered assignees, Owner fallback, repair-needed when no valid Owner exists) are the source of truth for "assigned owner".
- The existing pipeline human-gate mechanism (open gate, resolved gate, resume with answer) is the source of truth for what a decision does to a run.
- The existing Slack integration and its organization-level consent are the delivery path for Slack. Email is delivered through the Resend API: a platform-wide sender `noreply@spacesos.dev` works with no per-organization setup, and an organization may optionally connect its own Resend credential and sender under Organization → Integrations, which takes precedence when present.
- The existing authentication, team-role, and tenant-boundary rules continue to apply unchanged to who may configure channels and who may be an assignee.

### Assumptions

- **Delivery channel choice**: the system supports both Slack direct messages and email. When the organization has Slack connected and the recipient can be matched to a Slack account, Slack is preferred; otherwise email is used. If both are available the recipient is not double-notified for the same request.
- **Email delivery**: email is delivered through the Resend API. The default is a platform-wide sender `noreply@spacesos.dev` — no per-organization mail setup is required — and an organization may optionally connect its own Resend credential and sender (taking precedence when present). Recipients reply and decide through the one-time link; replies to the email itself are not processed as decisions.
- **Link model**: the link is a single-use, short-lived, unguessable reference bound to the intended recipient and the one gate. It identifies the recipient (for example by matching their account or email) without granting broader access. Validity is measured in hours, not days, and is configurable.
- **Recipient eligibility**: recipients are active members of the project's owning team, matching the current responsibility rules. Using the link does not make someone a project member.
- **Coverage**: both review approvals and agent clarification questions are in scope because both suspend a run pending a human answer; where the answer is an approval, the approve/approve-with-notes/request-changes outcomes apply.
- **Notification identity**: the request is sent to the individual, not only to a shared channel. Shared-channel posts may still occur as they do today but do not satisfy the direct-delivery requirement.
- **Failure posture**: notifications are best-effort and never gate the run; the in-app gate is always the fallback decision surface.
- **Confirmation**: confirmation is sent over the same channel as the request when possible, and is always visible in the project's run record.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: When a channel is configured and the recipient is reachable, the accountable recipient is notified within one minute of a gate opening.
- **SC-002**: At least 95% of delivered approval requests contain the project, stage, summary, and a link that opens successfully.
- **SC-003**: An owner can open a request and record a decision in under two minutes without needing to navigate the project first.
- **SC-004**: Zero gates are decided more than once; every second attempt shows the winning outcome.
- **SC-005**: 100% of decisions record the acting person, time, outcome, feedback, and the summary that was shown.
- **SC-006**: Zero runs fail or stall because of a notification error; when no channel is configured the gate remains actionable in the app.
- **SC-007**: The share of human gates waiting more than 24 hours falls by at least half within one quarter of adoption compared with the pre-feature baseline.
- **SC-008**: Zero cross-organization data disclosures occur through link content or link decisions.
- **SC-009**: At least 90% of owners who receive a request can correctly state, when asked, what was decided and on what basis.

### Acceptance Test Coverage

QA can trace each requirement to the scenarios and case families below.

| Requirement group | Primary scenarios | Test families |
|---|---|---|
| FR-001, FR-002, FR-012, FR-018 | US1 #2, #3; US2 #2 | Recipient resolution, Owner fallback, repair-needed, revocation |
| FR-003, FR-004, FR-016 | US1 #1, #3 | Channel delivery, delivery failure fallback, idempotency |
| FR-005, FR-006, FR-011, FR-022 | US2 #1, #4 | Link lifecycle: valid, expired, reused, invalidated, wrong recipient |
| FR-007, FR-008, FR-009, FR-010 | US2 #1–#3 | Decision recording, run resume, feedback applied to agent |
| FR-019 | US3 #2 | Confirmation content and channel |
| FR-013, FR-014 | Edge cases (multiple assignees, concurrent decisions, duplicate notification) | Concurrency and idempotency |
| FR-015, FR-017, FR-020 | Edge cases (cross-tenant, revoked access) | Audit, authorization, tenant isolation |
| FR-021 | US1 #1 | Coverage of approvals and clarification questions |
| SC-001…SC-009 | All | End-to-end timing, delivery rate, decision integrity, isolation |
