# Feature Specification: Workflows

**Feature Branch**: `013-workflows` · **Created**: 2026-10-12 · **Status**: Draft
**Input**: "A Workflows section where a user decides what happens, picking actions from Jira, Slack, Linear and the other enabled integrations; add Datadog. It should be inbound, so Spaces can take tasks and prioritize them from other tools. Slack could be used for creating new tickets, approving/rejecting, and providing input on projects. Workflows are organization level, not per project."

Workflows connect Spaces to the team's tools in both directions:

- **Inbound** — work arrives from other tools (a Jira or Linear issue, a Slack request, a Datadog alert), lands in the organization's prioritized **Intake** queue, and becomes features or bugfixes in the right project.
- **Outbound** — things that happen in Spaces (a run fails, a feature is delivered) trigger actions in other tools.
- **Slack as a two-way surface** — people file tickets, approve or reject gates, and answer the agent from Slack without opening Spaces.

Workflows belong to the **organization**, not to projects: they are managed in one organization-level Workflows section and apply across all of its projects. A workflow is one trigger (from Spaces or from a connected tool), an optional filter on the event, and an ordered list of actions (in a connected tool or in Spaces). Where a project matters — which project an item lands in — it is a property of the event or a field of the action, not an owner of the workflow.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Take work in from Jira and Linear (Priority: P1)

An organization admin creates an inbound workflow: "when a Jira issue gets the label `spaces` → add it to Intake". Matching issues — new or changed to match — appear in the organization's Intake with their title, description, reporter, source priority, a link back, and a suggested project (the Spaces project mapped to that Jira project or Linear team). Spaces keeps one Intake item per external issue and updates it when the issue changes. **Why P1**: teams already plan in Jira or Linear; Spaces must take its work from there. **Independent test**: label a Jira issue `spaces` and see it appear in Intake within a minute, then edit its title in Jira and see the item update.

**Acceptance Scenarios**:

1. **Given** an enabled inbound workflow for Jira label `spaces`, **When** an issue in Jira project PAY gets that label, **Then** one Intake item is created with the issue's details, priority and link, suggesting the Spaces project mapped to PAY.
2. **Given** an Intake item from a Linear issue, **When** the Linear issue is edited or closed, **Then** the item reflects the change (a closed issue is marked withdrawn, not deleted).
3. **Given** the same issue is reported twice (a repeated webhook, or the label removed and re-added), **When** it arrives, **Then** there is still only one Intake item.
4. **Given** an issue that does not match any workflow's filter, **When** it changes, **Then** nothing is created.

### User Story 2 - Prioritize and accept work in Intake (Priority: P1)

The organization has one **Intake** queue ordered by priority, then age, filterable by suggested project and source. Spaces maps the source priority (Jira Highest…Lowest, Linear Urgent…Low, Datadog alert severity) to a Spaces priority (P1–P4) and suggests a scope — feature or bugfix — with a one-line reason. A person reviews the queue: accept into a project (becomes a feature or bugfix in that project's backlog, keeping its link to the source), change priority, scope or project, merge duplicates, or decline with a reason. Project members see and act on the items suggested for their projects. A workflow can also accept matching items automatically into a project named in the action (for example, P1 Datadog alerts for service `payments-api` start a bugfix run in Payments at once). **Why P1**: "take tasks and prioritize" — without a queue, inbound work is just noise. **Independent test**: send three issues with different priorities, see them ordered P1 first with suggested scopes, accept one and decline one.

**Acceptance Scenarios**:

1. **Given** Intake items of mixed priority, **When** the queue is viewed, **Then** they are ordered by priority then age, each with its source, suggested project, suggested scope and reason.
2. **Given** an Intake item, **When** a person accepts it as a bugfix into a project, **Then** a bugfix intent is created in that project's backlog with the item's details as its input and a link to the source issue.
3. **Given** an inbound workflow with "accept into Payments and start run" for P1 items, **When** a P1 item arrives, **Then** a run starts in Payments without a person accepting it, and the item records that a workflow accepted it.
4. **Given** an item with no mapped project, **When** it arrives, **Then** it waits in Intake with no suggested project until a person assigns one.
5. **Given** a declined item, **When** it was created from Jira or Linear, **Then** a comment with the reason is posted on the source issue.

### User Story 3 - File tickets from Slack (Priority: P1)

In Slack, a person uses a `/spaces` command or the "Send to Spaces" message action. A short form asks for title, details, priority and, optionally, project (prefilled from the message; a Slack channel linked to a project suggests that project). The ticket lands in the organization's Intake, and the person gets a reply in Slack with a link. **Why P1**: Slack is where requests actually happen. **Independent test**: run "Send to Spaces" on a Slack message, submit the form, and see the item in Intake with the message as its details and a link back to the message.

**Acceptance Scenarios**:

1. **Given** a Slack user matched to a Spaces member, **When** they submit the form, **Then** an Intake item is created, attributed to them, with the chosen or suggested project and a link to the Slack message.
2. **Given** a Slack user who is not a member of the organization, **When** they use the command, **Then** they are told to ask an admin for access, and nothing is created.

### User Story 4 - Approve, reject and answer from Slack (Priority: P1)

When a run waits for approval, the Slack message to the accountable person carries **Approve** and **Request changes** buttons; request changes opens a box for feedback. When the agent asks a question, the person can reply in the message's thread and that reply is the answer. Status updates and new questions for the same run stay in one thread. **Why P1**: approvals and answers are what stall runs; deciding where the conversation already is unblocks them. **Independent test**: start a run with a review gate, approve it from Slack, and see the run continue; then answer an agent question by replying in the thread.

**Acceptance Scenarios**:

1. **Given** a gate waiting on its accountable person, **When** that person clicks Approve in Slack, **Then** the gate is decided once through the same path as an approval link, the run resumes, and the Slack message updates to show who decided and when.
2. **Given** someone who is not the gate's recipient clicks Approve, **When** the click arrives, **Then** it is refused privately ("only <person> can decide this") and the gate is unchanged.
3. **Given** the gate was already decided elsewhere, **When** someone clicks in Slack, **Then** they see the existing outcome and nothing changes.
4. **Given** an agent question posted to a run's thread, **When** a project member replies in that thread, **Then** the reply is recorded as the answer and the run resumes; replies from non-members are ignored with a private notice.

### User Story 5 - Act in other tools when things happen in Spaces (Priority: P2)

An admin creates an outbound workflow: a Spaces trigger (run started, stage finished, waiting for approval, run failed, feature delivered, deployment succeeded or failed) that fires for every project in the organization, an optional filter on the event (pipeline, stage, or project), and actions from connected integrations — post to a Slack channel, create/comment/change status of the feature's Jira or Linear issue, send a Datadog event, send an email. Action fields use placeholders from the event. An issue a workflow creates, or the source issue of an accepted Intake item, is the feature's linked issue, so "feature delivered → move the issue to Done" keeps Jira and Linear in step. **Why P2**: keeps other tools current once work is in Spaces. **Independent test**: accept a Jira-sourced item, run it to delivery, and see the source issue moved to Done with the PR links as a comment.

**Acceptance Scenarios**:

1. **Given** Slack and Jira are connected and Linear is not, **When** a user adds an action, **Then** Slack and Jira actions are offered and Linear is shown as "connect to use".
2. **Given** a feature accepted from a Jira issue, **When** a "change status" action runs for it, **Then** it moves that source issue.
3. **Given** a "create issue" action already ran for a feature, **When** it runs again, **Then** no duplicate issue is created.

### User Story 6 - Connect Datadog: alerts in, release markers out (Priority: P2)

An admin connects Datadog (site, API key, optional application key) in a new Observability category. Inbound: a Datadog monitor alert, sent to Spaces' webhook, can add a bugfix to Intake with the alert's severity mapped to priority, linked to the alert. Outbound: a workflow can send a Datadog event, such as a deployment marker tagged with project, feature and environment. **Why P2**: production problems become work automatically, and releases line up with dashboards; the inbound path is what post-launch operations (spec 012) builds on. **Independent test**: trigger a test monitor alert and see a bugfix item in Intake; deploy and see the event in Datadog.

**Acceptance Scenarios**:

1. **Given** an admin enters a Datadog site and API key, **When** they save, **Then** the key is validated and stored encrypted; an invalid key is not saved.
2. **Given** an inbound workflow for Datadog alerts, **When** a monitor alerts and then alerts again before recovering, **Then** one Intake item exists, showing both occurrences.
3. **Given** the monitor recovers, **When** recovery arrives, **Then** the item is marked recovered, but is not removed.

### User Story 7 - See what workflows did (Priority: P2)

Each workflow shows recent runs: the event (from Spaces or from a tool), each action's outcome and error. A failed run can be retried from the failed action. Inbound events that were received but matched nothing are visible to admins for a few days, to debug filters. **Why P2**: actions reach outside Spaces, and inbound work must never vanish silently. **Independent test**: break an action, trigger it, see the failure, fix it and retry.

**Acceptance Scenarios**:

1. **Given** an action fails, **When** the workflow is opened, **Then** the run shows which action failed, why, and the later actions as not run.
2. **Given** an inbound event that matched no workflow, **When** an admin opens the inbound log, **Then** the event and why it matched nothing are listed.

### Edge Cases

- An inbound event is not signed correctly by its tool → rejected and logged; nothing is created.
- A tool sends a burst of events (bulk-edit of 200 Jira issues) → each is processed once; Intake is not flooded with duplicates; outbound actions are rate-limited per integration.
- An integration is disconnected or its credentials expire → its inbound events stop and its actions fail with "reconnect <integration>"; admins are told once.
- A workflow fails several runs in a row (e.g. 5) → it is paused and the organization's admins are told.
- A project is archived or deleted → workflows keep running for the other projects; Intake items suggested for it lose the suggestion; auto-accept actions naming it fail with "project no longer exists" and the workflow is paused.
- A Slack user's email matches no Spaces member → they can't file, approve or answer; told privately.
- A Slack approval and an approval link are used at the same moment → exactly one decision wins; the other sees the outcome.
- An inbound workflow could create a loop (Spaces comments on a Jira issue, which triggers the inbound workflow again) → changes made by Spaces itself never trigger inbound workflows.
- Content leaving Spaces passes the organization's AI data guardrails; content coming in is treated as untrusted input to agents.

## Requirements *(mandatory)*

### Functional Requirements

**Workflows**

- **FR-001**: System MUST provide one organization-level Workflows section listing the organization's workflows with trigger, filter, actions, enabled state and last run result; workflows are not created, owned or listed per project.
- **FR-002**: Organization admins MUST be able to create, edit, test, enable, disable and delete a workflow made of one trigger, an optional filter on the event, and an ordered list of actions; other members can view workflows and their runs.
- **FR-003**: System MUST offer only triggers and actions from connected integrations, showing the others as available to connect.
- **FR-004**: Inbound triggers in v1: Jira issue created or updated (filter by project, label, issue type, status); Linear issue created or updated (filter by team, project, label, status); Slack ticket submitted; Datadog monitor alert (filter by monitor, tag, severity).
- **FR-005**: Spaces triggers in v1: run started, stage finished, waiting for approval, run failed, feature delivered, deployment succeeded, deployment failed.
- **FR-006**: Spaces actions in v1: add to Intake; accept into a named project as feature or bugfix; accept into a named project and start a run.
- **FR-007**: Tool actions in v1: Slack — post to a channel, message the accountable person; Jira and Linear — create an issue, comment on the feature's linked issue, change its status; Datadog — send an event; Email — send to project members or a fixed address.
- **FR-008**: Action fields MUST accept placeholders for the event's values and show a preview when testing.
- **FR-009**: Each enabled workflow MUST run when its trigger matches, run actions in order, and run each action at most once per event.
- **FR-010**: Changes made by Spaces itself MUST NOT trigger inbound workflows.
- **FR-011**: Workflow failures MUST never block, fail or delay a pipeline run.
- **FR-012**: System MUST record each workflow run with per-action results, allow retry from the failed action, pause a workflow after repeated consecutive failures, and keep unmatched inbound events visible to admins for at least 7 days.

**Intake and prioritization**

- **FR-013**: The organization MUST have one Intake queue ordered by priority, then age, filterable by suggested project and source; project members can act on items suggested for their projects.
- **FR-013a**: System MUST suggest a project for each item from the organization's existing project mappings (Jira project, Linear team or project, Slack channel, Datadog service tag); with no match the item has no suggested project.
- **FR-014**: System MUST keep exactly one Intake item per external source item and update it when the source changes; a closed or deleted source marks the item withdrawn.
- **FR-015**: System MUST map source priority (Jira, Linear, Datadog severity, Slack form) to P1–P4 and suggest a scope (feature or bugfix) with a one-line reason; people can override both.
- **FR-016**: People MUST be able to accept into a project (as feature or bugfix), reprioritize, change the project, merge duplicates, or decline with a reason; a declined Jira/Linear item gets the reason as a comment on its source.
- **FR-017**: An accepted item MUST keep its link to the source, and that source becomes the feature's linked issue for outbound actions.

**Slack two-way**

- **FR-018**: Organization members MUST be able to file a ticket into Intake from Slack with a command or a message action, optionally choosing a project.
- **FR-019**: Approval requests in Slack MUST carry Approve and Request changes (with feedback) controls that decide the gate through the same single-decision path as approval links (spec 011), only for the gate's recipient.
- **FR-020**: Agent questions MUST be answerable by replying in the run's Slack thread, by project members only; a run's notices and questions stay in one thread.
- **FR-021**: Slack users MUST be matched to Spaces members by verified email; unmatched users cannot file, decide or answer.

**Datadog**

- **FR-022**: Admins MUST be able to connect Datadog with a site and API key (application key optional), validated before saving and stored encrypted, in a new Observability category.
- **FR-023**: System MUST receive Datadog monitor alerts through a signed webhook, keep one Intake item per monitor alert until it recovers, and record recovery.

**Security**

- **FR-024**: Every inbound request MUST be verified as coming from the connected tool for that organization; unverified requests are rejected and logged.
- **FR-025**: Workflows, Intake items and links MUST stay within the organization; outbound content passes the AI data guardrails; inbound content is treated as untrusted input.
- **FR-026**: Existing Slack run notices and approval-link delivery MUST keep working as they are, and are not workflows in v1 (they cannot be edited or turned off from Workflows); the new Slack controls (approve, request changes, answer in thread) are added to them.

### Key Entities *(if the feature involves data)*

- **Workflow**: organization, name, created by, trigger (Spaces or tool), event filter, ordered actions, enabled/paused. No project owner.
- **Action**: target (a tool or Spaces), action type, field values with placeholders.
- **Workflow run**: workflow, event, time, status, per-action result and error.
- **Inbound event**: tool, organization, verified flag, payload summary, matched workflows (or why none), received at.
- **Intake item**: organization, suggested project, assigned project (on accept), source (tool, id, URL), title, details, reporter, source priority, Spaces priority, suggested scope and reason, status (new, accepted, declined, merged, withdrawn), resulting feature.
- **External link**: a feature linked to its source or created issue (tool, key, URL).
- **Slack identity**: Slack user matched to a Spaces member by email.
- **Datadog connection**: organization, site, encrypted API key and optional application key, status.

## Success Criteria *(mandatory)*

- **SC-001**: A matching Jira, Linear, Slack or Datadog item appears in Intake within one minute.
- **SC-002**: Zero duplicate Intake items for one external source item, including repeated or bulk events.
- **SC-003**: A gate can be decided from Slack in two clicks without opening Spaces, and is never decided twice.
- **SC-004**: An agent question answered in a Slack thread resumes the run within one minute.
- **SC-005**: A user can create, test and enable a two-action workflow in under 3 minutes.
- **SC-006**: No pipeline run fails or is delayed because a workflow action failed.
- **SC-007**: Zero inbound requests that fail verification create or change anything.

## Post-release outcomes

- **PRO-001**: Share of new features and bugfixes that enter Spaces through Intake rather than being typed in — measured from Intake records after one quarter.
- **PRO-002**: Median time a gate waits for a decision, before and after Slack approvals — measured from gate records after one quarter.
- **PRO-003**: Fewer manual status updates in Jira/Linear for work run in Spaces — measured by asking teams after one quarter.

## Out of scope (later versions)

- Logic: conditions on event values beyond trigger filters, branching, delays, schedules.
- More tools: Confluence (publish spec/report), GitHub issues as an inbound source, Figma, Datadog incidents and monitors, Microsoft Teams.
- AI steps: an agent drafting text (release notes, triage notes) inside a workflow.
- Template gallery of ready-made workflows.
- Turning the built-in Slack run notices into editable default workflows.
- Two-way field sync beyond status and comments (assignee, estimates, sprints).

## Assumptions

- Inbound events arrive by webhook; Spaces registers the webhook with each tool when an inbound workflow is enabled, where the tool allows it, or shows the admin the URL and secret to add.
- Jira and Linear connections, used for knowledge today, need write and webhook permission; organizations may need to reconnect.
- Slack needs interactivity and slash commands enabled on the Spaces Slack app; existing workspaces reinstall once to grant them.
- Saving and enabling a workflow is the consent for its actions; individual runs do not ask for approval.
- Project mappings used for suggestions are the existing per-project knowledge settings (Jira projects, Linear teams and projects), plus the project's Slack channel and a Datadog service tag set per project.
- Priority, scope and project suggestions are recommendations a person can change; only workflows set to accept automatically act without a person.
- Workflows execute in the existing background worker, using the existing webhook job kind.
