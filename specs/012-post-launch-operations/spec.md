# Feature Specification: Post-launch operations

**Feature Branch**: `012-post-launch-operations` · **Created**: 2026-10-12 · **Status**: Draft (deferred — scoped for later implementation)
**Input**: "Operations support after launch: a feature or fix is not finished at delivery. Real outcomes only show once it is used, so a shipped feature needs a watch period, a way to report problems against it, and a review of its post-release outcomes that feeds the next iteration (learning)."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A delivered feature goes live and is watched (Priority: P1)

When delivery confirms a feature is merged (and deployed, for a linked project), the feature moves from Done to a **Live** state for a watch window. Its page shows the deployment, the PRs that shipped it, open issues reported against it, and its post-release outcomes with when each is due for review. **Why P1**: today nothing exists after Done, so there is no place for operations to happen. **Independent test**: deliver a feature and check it appears as Live with its outcomes and watch window, then leaves Live when the window ends.

**Acceptance Scenarios**:

1. **Given** a feature whose delivery is confirmed, **When** the board refreshes, **Then** the feature is Live with a watch-window end date.
2. **Given** a linked project whose deployment is not yet confirmed successful, **When** delivery reports merged, **Then** the feature is not Live until the deployment succeeds.
3. **Given** a Live feature whose watch window has ended and whose outcomes are all reviewed, **When** the board refreshes, **Then** the feature moves to Done (operated).

### User Story 2 - Report a problem against a live feature (Priority: P1)

A team member reports a problem with a live feature from its page. That creates a bugfix intent linked to the feature, carrying its spec and context, which runs through the existing bugfix pipeline. **Why P1**: problems found in use are the main operational input and today have no intake. **Independent test**: report an issue on a Live feature and check a linked bugfix intent exists and appears on the feature page until fixed.

**Acceptance Scenarios**:

1. **Given** a Live feature, **When** a member reports an issue with a description, **Then** a bugfix intent is created, linked to that feature, and listed on the feature page as open.
2. **Given** a linked bugfix that is delivered, **When** the feature page is viewed, **Then** the issue shows as fixed with a link to its delivery.
3. **Given** a feature that is not Live (still in progress), **When** a member tries to report an issue against it, **Then** they are directed to the running feature instead.

### User Story 3 - Review post-release outcomes once the feature is in use (Priority: P2)

Each business-outcome success criterion listed under "Post-release outcomes" in the feature's verification report gets a review date. When it falls due, the accountable person is asked (in the project's Slack channel, and in the app) to record the measured value, whether the target was met, partly met or missed, and notes. **Why P2**: outcomes are only meaningful after real use; this is the learning half of the loop. **Independent test**: give a Live feature an outcome due today and check the request is sent and a recorded result appears on the feature page.

**Acceptance Scenarios**:

1. **Given** a delivered feature with post-release outcomes, **When** it goes Live, **Then** each outcome has a review-due date.
2. **Given** an outcome review that is due, **When** the daily check runs, **Then** the accountable person is asked once, with the outcome, its target and a link to record the result.
3. **Given** a recorded result, **When** it is saved, **Then** the outcome shows its value, verdict, who recorded it and when.

### User Story 4 - Learnings feed the next iteration (Priority: P2)

Recorded outcomes and issues found in operation become part of the project's memory, so the next spec touching that area starts from what actually happened. A missed or partly met outcome can suggest a follow-up feature, which a person accepts or dismisses. **Why P2**: closes the loop from release back to planning. **Independent test**: record a missed outcome, start a new feature in the project, and check the recorded learning is in the context it is given.

**Acceptance Scenarios**:

1. **Given** a recorded outcome or a fixed operational issue, **When** a new feature starts in the project, **Then** its context includes those learnings.
2. **Given** a missed outcome, **When** it is recorded, **Then** a follow-up feature is suggested and created only if a person accepts it.

### Edge Cases

- Feature delivered with no post-release outcomes → Live only for the watch window; no reviews requested.
- Accountable person cannot be resolved → the project owner is asked, and the feature page flags that the responsibility needs repair.
- No Slack connected → the review request is shown in the app only; nothing fails.
- An outcome review is never answered → reminded once, then shown as overdue on the feature page; the feature stays Live until it is reviewed or dismissed.
- A feature is re-delivered (follow-up fix) while Live → the watch window restarts from the latest delivery.
- Several features ship together → each is Live on its own; an issue is reported against one feature.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST move a feature to Live when its delivery is confirmed (merged, and deployment succeeded for a linked project).
- **FR-002**: System MUST keep a feature Live for a watch window and record when it started and ends. [NEEDS CLARIFICATION: fixed window (e.g. 30 days) for every feature, or set per feature from its outcomes (e.g. "within one quarter")?]
- **FR-003**: System MUST show, for a Live feature, its deployment, shipped PRs, reported issues and post-release outcomes with due dates.
- **FR-004**: Members MUST be able to report an issue against a Live feature, creating a bugfix intent linked to it with the feature's spec as context.
- **FR-005**: System MUST show each linked issue's status (open, in progress, fixed) on the feature page.
- **FR-006**: System MUST read the post-release outcomes from the feature's verification report and give each a review-due date.
- **FR-007**: System MUST ask the accountable person to review each outcome once when it falls due, remind once, then mark it overdue. [NEEDS CLARIFICATION: who owns operations — the feature's accountable person from the responsibility model, the project owner, or the delivery agent preparing a draft for a person to confirm?]
- **FR-008**: Users MUST be able to record an outcome result: measured value, verdict (met / partly met / missed / dismissed) and notes; the record keeps who and when.
- **FR-009**: System MUST add recorded outcomes and fixed operational issues to project memory so later features in the project receive them as context.
- **FR-010**: System MUST suggest a follow-up feature for a missed or partly met outcome and create it only when a person accepts.
- **FR-011**: System MUST move a feature from Live to Done (operated) when its watch window has ended and no outcome is still pending review.
- **FR-012**: Operations data (issues, outcomes, learnings) MUST stay within the feature's organization and project.
- **FR-013**: Version 1 collects issues and outcome results from people; automatic signals are out of scope. [NEEDS CLARIFICATION: is a manual-first v1 acceptable, or is automatic error detection after deploy the main need?]

### Key Entities *(if the feature involves data)*

- **Live period**: a feature's watch window — start (delivery confirmed), end, state (live, operated).
- **Operational issue**: a problem reported against a Live feature — reporter, description, linked bugfix intent, status.
- **Outcome review**: one post-release outcome — criterion id, metric, target, due date, accountable person, recorded value, verdict, notes, recorded by/at.
- **Learning**: a recorded outcome or fixed issue summarized into project memory, with a link back to its source.

## Success Criteria *(mandatory)*

- **SC-001**: Every feature whose delivery is confirmed appears as Live within one board refresh.
- **SC-002**: A member can report an issue against a Live feature in under one minute, and the linked bugfix is visible on the feature page immediately.
- **SC-003**: Every post-release outcome gets a due date at launch and its review request is sent on the due date.
- **SC-004**: A recorded outcome or fixed issue is present in the context of the next feature started in that project.

## Post-release outcomes

- **PRO-001**: Share of shipped features with all outcomes reviewed within 30 days of their due date — measured from outcome-review records after one quarter of use.
- **PRO-002**: Share of problems found in production that are reported through the feature page rather than outside Spaces — measured by asking teams after one quarter.

## Out of scope (later versions)

- **v2 — automatic signals**: scheduled polling of the deployment platform (error rate, logs) after release; flag a regression against the most recently shipped feature and suggest a rollback or fix.
- **v3 — more inputs**: read feedback from Slack and inbound email; connect Datadog/Sentry; pull outcome metrics automatically instead of asking people.

## Assumptions

- "Post-release outcomes" are the business-outcome success criteria the verification report lists under that heading; QA does not count them.
- Delivery confirmation reuses the existing delivery and deployment status that already moves a card to Done.
- Reported issues run through the existing bugfix pipeline; no new pipeline is introduced.
- Reminders run from the existing worker's periodic checks; there is no new scheduler.
- Learnings use the existing project memory, which is already rebuilt from feature history before each new feature.
