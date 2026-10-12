# Feature Specification: Workflows

**Feature Branch**: `013-workflows` · **Created**: 2026-10-12 · **Status**: Draft
**Input**: "A Workflows section where a user decides what happens when things happen in Spaces, picking actions from Jira, Slack, Linear and the other enabled integrations. Add Datadog as an integration."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Build a workflow from a trigger and actions (Priority: P1)

In a new **Workflows** section, a user creates a workflow: they pick a trigger (something that happens in Spaces, such as "a feature is delivered"), optionally narrow it to projects or pipelines, and add one or more actions picked from the integrations the organization has connected (for example "post to Slack channel #releases" then "create a Linear issue"). Action fields can use values from the event — feature name, stage, summary, links. The workflow is saved disabled; the user tests it, then enables it. **Why P1**: this is the feature. **Independent test**: with Slack connected, create "when a run fails → post to a channel", fail a run, and see the message.

**Acceptance Scenarios**:

1. **Given** Slack and Jira are connected and Linear is not, **When** a user adds an action, **Then** Slack and Jira actions are offered and Linear is shown as "connect to use" without being selectable.
2. **Given** a new workflow, **When** the user tests it, **Then** it runs once against a sample event, shows each action's result, and is not enabled by the test.
3. **Given** an enabled workflow, **When** its trigger occurs in a project it covers, **Then** its actions run in order with the event's values filled in.
4. **Given** an enabled workflow, **When** the trigger occurs in a project it does not cover, **Then** nothing runs.

### User Story 2 - Keep Jira and Linear in step with a feature (Priority: P1)

A workflow can create a Jira or Linear issue for a feature, and later workflows can comment on or move that same issue (for example: "feature specified → create Jira story", "feature delivered → transition the story to Done and comment with the PR links"). Spaces remembers which external issue belongs to which feature. **Why P1**: the most asked-for use — teams track work in Jira or Linear, not in Spaces. **Independent test**: create the two workflows above, run a feature through to delivery, and check one issue was created and then moved to Done with the comment.

**Acceptance Scenarios**:

1. **Given** a "create issue" action ran for a feature, **When** a later "comment" or "change status" action runs for the same feature, **Then** it targets the issue that was created, and the feature page links to it.
2. **Given** a "change status" action and no linked issue for the feature, **When** it runs, **Then** it is skipped with the reason "no linked issue" and the rest of the workflow continues.
3. **Given** a "create issue" action that already created an issue for this feature, **When** it runs again for the same feature, **Then** it does not create a duplicate.

### User Story 3 - Connect Datadog and mark releases in it (Priority: P2)

An organization admin connects Datadog (site plus API key, application key optional) under Integrations, in a new Observability category. Workflows can then send a Datadog event — for example a deployment marker tagged with the project, feature and environment when a deployment succeeds — so releases line up with the team's dashboards. **Why P2**: gives teams release markers today and lays the ground for post-launch operations (spec 012). **Independent test**: connect Datadog, enable "deployment succeeded → send Datadog event", deploy, and find the event in Datadog with its tags.

**Acceptance Scenarios**:

1. **Given** an admin enters a Datadog site and API key, **When** they save, **Then** the key is validated, stored encrypted, and Datadog shows as connected; an invalid key shows an error and is not saved.
2. **Given** Datadog is connected, **When** a "send Datadog event" action runs, **Then** an event with the chosen title, text and tags appears in that Datadog site.

### User Story 4 - See what workflows did (Priority: P2)

Each workflow shows its recent runs: when, which event, each action's outcome, and the error for any failure. A failed action can be retried. **Why P2**: actions reach outside Spaces; people need to trust and debug them. **Independent test**: break an action (e.g. a deleted Slack channel), trigger it, see the failure and reason, fix it, and retry successfully.

**Acceptance Scenarios**:

1. **Given** an action fails, **When** the user opens the workflow, **Then** the run shows which action failed, why, and the actions after it as not run.
2. **Given** a failed run, **When** the user retries it, **Then** only the failed and not-run actions run again.

### Edge Cases

- An integration is disconnected or its credentials expire → its actions fail with "reconnect <integration>"; the workflow stays enabled and its owner is told once.
- A workflow fails on several runs in a row (e.g. 5) → it is paused and its owner is told; it does not keep failing silently.
- The same event fires twice (a retried run) → each action runs at most once per event.
- A run moves faster than workflows execute → actions for one feature run in the order its events happened.
- A placeholder has no value for this event (e.g. no PR yet) → it renders empty and the run records a warning.
- Content sent outside Spaces passes the organization's AI data guardrails, like other outbound text.
- A workflow covers a project the user later loses access to → it keeps running under the organization; only people who may edit workflows can change it.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST provide a Workflows section listing the organization's workflows with their trigger, actions, scope, enabled state and last run result.
- **FR-002**: Users MUST be able to create, edit, test, enable, disable and delete a workflow made of one trigger, an optional scope (projects, pipelines) and an ordered list of actions. [NEEDS CLARIFICATION: who may create and edit workflows — organization admins only, or also project owners for workflows scoped to their projects?]
- **FR-003**: System MUST offer these triggers in v1: run started, stage finished, waiting for approval, run failed, feature delivered, deployment succeeded, deployment failed.
- **FR-004**: System MUST offer actions only from integrations that are connected for the organization, and show the others as available to connect.
- **FR-005**: System MUST offer these actions in v1:
  - Slack: post a message to a channel; message the accountable person.
  - Jira: create an issue; comment on the feature's issue; change the feature's issue status.
  - Linear: create an issue; comment on the feature's issue; change the feature's issue status.
  - Datadog: send an event.
  - Email: send an email to project members or a fixed address.
- **FR-006**: Action fields MUST accept placeholders for the event's values (project, feature, stage, summary, status, run link, PR links, deployment link) and show a preview when testing.
- **FR-007**: System MUST link an issue created by a workflow to its feature, target that issue in later actions for the same feature, and not create a second one for the same feature and action.
- **FR-008**: System MUST run each enabled workflow when its trigger occurs within its scope, run its actions in order, and run each action at most once per event.
- **FR-009**: Workflow failures MUST never block, fail or delay a pipeline run.
- **FR-010**: System MUST record each workflow run (event, time, each action's result and error) and let a user retry a failed run from the failed action.
- **FR-011**: System MUST pause a workflow after repeated consecutive failures and notify its owner.
- **FR-012**: Admins MUST be able to connect Datadog with a site and API key (application key optional), validated before saving and stored encrypted, in a new Observability integration category.
- **FR-013**: Workflows, their runs and the issues they link MUST stay within the organization; outbound content MUST pass the organization's AI data guardrails.
- **FR-014**: System MUST keep the existing Slack run notices and approval-link delivery working unchanged alongside workflows. [NEEDS CLARIFICATION: should the built-in Slack run notices become editable default workflows in v1, or stay as they are until a later version?]
- **FR-015**: Workflows in v1 are started by events in Spaces only. [NEEDS CLARIFICATION: must v1 also start work in Spaces from outside events — a Jira/Linear issue created or moved, a Datadog alert — or can that wait for v2?]

### Key Entities *(if the feature involves data)*

- **Workflow**: organization, name, owner, trigger, scope (projects, pipelines), ordered actions, enabled/paused state.
- **Action**: integration, action type, field values with placeholders.
- **Workflow run**: workflow, triggering event, time, status, and per-action result and error.
- **External link**: a feature linked to an issue created in Jira or Linear (integration, key or id, URL, created by which workflow).
- **Datadog connection**: organization, site, encrypted API key and optional application key, status.

## Success Criteria *(mandatory)*

- **SC-001**: A user can create, test and enable a two-action workflow in under 3 minutes without leaving the Workflows section.
- **SC-002**: An enabled workflow's actions start within one minute of its trigger occurring.
- **SC-003**: No pipeline run fails or is delayed because a workflow action failed.
- **SC-004**: No duplicate external issues are created for the same feature and action, including when events repeat.
- **SC-005**: Every workflow run is visible with its per-action result, and a failed run can be retried.

## Post-release outcomes

- **PRO-001**: Share of active organizations with at least one enabled workflow after one quarter — measured from workflow records.
- **PRO-002**: Fewer manual status updates in Jira/Linear for features run in Spaces — measured by asking teams after one quarter.

## Out of scope (later versions)

- **Inbound triggers**: start a feature or bugfix in Spaces from a Jira/Linear issue, a Slack message, or a Datadog monitor alert (the alert path ties into post-launch operations, spec 012).
- **More actions**: Confluence (publish the spec or delivery report as a page), GitHub (issues, labels), Figma, Datadog monitors and incidents.
- **Logic**: conditions on event values, branching, delays, and schedules (time-based triggers).
- **AI steps**: an action that has an agent draft text (e.g. release notes) before it is sent.
- **Templates**: a gallery of ready-made workflows.

## Assumptions

- Workflows belong to an organization and may be scoped to some of its projects; with no scope they cover all projects.
- Actions use the organization's existing integration connections; workflows do not hold their own credentials.
- Jira and Linear connections, used today for knowledge only, need write permission for create, comment and transition; organizations may have to reconnect to grant it.
- Saving and enabling a workflow is the consent for its actions; individual runs do not ask for approval.
- Datadog events go to the site the admin configures (US1, US3, US5, EU1, AP1, Gov).
- Workflows execute in the existing background worker; there is no separate automation engine.
