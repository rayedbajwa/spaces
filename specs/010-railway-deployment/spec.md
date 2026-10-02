# Feature Specification: Railway Deployment Integration — delta for rayedbajwa/spaces

Initiative: `010-railway-deployment` · Change: `010-railway-deployment` · Repository: `github.com/rayedbajwa/spaces`

## Scope in this repository

- **Tasks in spaces**

## Specification (from the initiative)

# Feature Specification: Railway Deployment Integration

**Scope**: feature

**Feature Branch**: `010-railway-deployment`  
**Created**: 2026-10-02  
**Status**: Draft  
**Input**: User description: "add railway integration as a deployment platform"

## Problem Statement *(mandatory)*

Spaces orchestrates the full software delivery lifecycle — specify, plan, tasks, implement, review and verify — and integrates with source control, project tracking and communication tools. It has no deployment platform integration, so the final delivery step stops at "the work is merged": nothing in Spaces knows whether the change actually reached a running environment, and the board cannot truthfully claim a feature is delivered.

Today, after a feature is approved and merged, teams must leave Spaces, open Railway, find the right service and environment, trigger a deploy, wait, and then manually report back. This creates several problems:

- **Invisible delivery state**: the board reaches its final lane without evidence that a release is live, so participants cannot distinguish "merged" from "deployed and healthy".
- **Manual, unaudited deployments**: deploys happen outside Spaces, so there is no record of who approved the release, what was deployed, or what the outcome was.
- **No verification loop**: the verify/delivery stage cannot confirm the deployed artifact, so a failed or missing deployment is only discovered by users or monitoring, not by the delivery workflow.
- **Broken context for agents**: release notes, delivery reports and follow-up stages cannot cite the deployment that shipped the work.

The intended outcome is a **product-level deployment integration**: Railway is added as a first-class, organization-scoped platform in Spaces so that users can deploy the software their teams build to Railway without leaving Spaces. Administrators connect a Railway account once; a project is linked to a specific deployment target; the current deployment state is visible on the project; a release is sent to Railway only after an explicit human approval; and the delivery report carries the deployment outcome as evidence. The integration observes Railway and releases to it, but does not create or reconfigure the account's infrastructure.

This feature is about deploying the organization's own software through Spaces. It is **not** about how the Spaces application itself is hosted (its existing container and Railway self-hosting configuration are unaffected).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Connect and Manage the Railway Integration (Priority: P1)

As an organization owner or administrator, I want to connect our organization's Railway account under a dedicated Deployment integration category, so that our teams can deploy their software to our environments from Spaces, securely and once for the whole organization.

**Why this priority**: A validated, securely stored organization-level connection is the foundation; no deployment visibility, approval or verification is possible without it.

**Independent Test**: As an organization administrator, open Organization → Integrations, find Railway under the Deployment category, connect either through OAuth sign-in or by supplying an account/API token, and verify the connection reports Connected with the accessible workspace details. Corrupt or revoke the credential and verify the card switches to "Reconnect needed". Disconnect and verify credentials are removed and the integration is no longer usable.

**Acceptance Scenarios**:

1. **Given** an organization administrator views the integrations page, **When** the page renders, **Then** a Deployment category is shown containing Railway, with a plain-language description of deploying software to Railway.
2. **Given** an unconfigured Railway integration, **When** an administrator supplies an account/API token and saves, **Then** Spaces validates it against Railway, seals the credential, and shows the connection as Connected with the accessible workspace/account name and a last-validated timestamp.
3. **Given** a connected Railway integration, **When** the credential is revoked or expires, **Then** Spaces surfaces "Reconnect needed" with actionable guidance and stops attempting deployments until reconnected.
4. **Given** a connected Railway integration, **When** an administrator disconnects it, **Then** the stored credential is destroyed, the connection is marked not connected, and any project deployment links show as blocked/reconnect-needed rather than silently failing.
5. **Given** a non-administrator member, **When** they attempt to connect, reconnect, or disconnect the integration, **Then** the action is denied and no credential is stored or changed.
6. **Given** two organizations, **When** one connects Railway, **Then** the other organization never sees the connection or its accessible targets, and neither can use the other's credential.
7. **Given** a narrowly scoped Railway credential, **When** an administrator connects it, **Then** Spaces accepts the connection and exposes only the targets that credential permits, without requiring broader workspace access.
8. **Given** an unconfigured Railway integration, **When** an administrator chooses OAuth sign-in, completes Railway's authorization, and returns to Spaces, **Then** Spaces seals the authorized credential and shows the connection as Connected with the accessible workspace/account name.
9. **Given** an unconfigured Railway integration, **When** an administrator cancels or fails the OAuth authorization, **Then** no credential is stored, the integration remains not connected, and the error is reported with an actionable reason.

---

### User Story 2 - Link a Project to a Railway Deployment Target and See Live Status (Priority: P2)

As a release owner or team administrator, I want to link a project to the Railway service and environment it deploys to, and see the current deployment state on the project, so that I know what is running and whether the latest release is live.

**Why this priority**: Linking makes the connection operational per project and delivers immediate visibility value even before release automation exists.

**Independent Test**: With Railway connected, open a project's settings, link it to an accessible Railway service and environment, and verify the project shows the target, its current deployment state, the service URL and the last deployment time. Verify an unlinked project shows a clear empty state and keeps its current, merge-based delivery behavior.

**Acceptance Scenarios**:

1. **Given** a connected Railway integration, **When** a team administrator or the project's Release Manager or Owner opens the project's deployment settings, **Then** they can choose from the services and environments the organization credential can access and link one as the project's deployment target.
2. **Given** a linked project, **When** the project page is viewed, **Then** it shows the current deployment state (for example building, deploying, success, failed, sleeping, or unknown), the public service URL when available, and the time of the most recent deployment.
3. **Given** a linked project whose target was removed or renamed in Railway, **When** status is refreshed, **Then** Spaces flags the link as invalid with guidance to re-link, and does not display stale status as current.
4. **Given** a project that has linked a deployment target, **When** a release is requested, **Then** the release is driven by the Railway deployment flow. **Given** a project that has not linked a target, **When** delivery completes, **Then** its existing merge-based delivery behavior is unchanged.
5. **Given** a linked project, **When** an authorized member unlinks the target, **Then** the project no longer shows deployment status and returns to merge-based delivery until a target is linked again.

---

### User Story 3 - Deploy Software Only After Explicit Human Approval (Priority: P2)

As a release owner or team administrator, I want every Railway deployment to require an explicit human approval and to be recorded, so that production-impacting releases stay accountable and auditable.

**Why this priority**: Deployment is production-impacting; a deployment integration that could ship without a gate would violate the project's human-accountability principle. This story makes releases safe and traceable.

**Independent Test**: With a linked project, request a release and verify the run pauses at the delivery stage's approval gate. Approve as an authorized role and verify the deployment is recorded with approver, time and target; reject and verify nothing is deployed. Verify an unauthorized member cannot approve or deploy.

**Acceptance Scenarios**:

1. **Given** a linked project whose work is approved and merged, **When** the delivery stage requires a release, **Then** Spaces pauses at the existing delivery approval gate and asks an authorized approver to approve or reject the deployment before anything is sent to Railway.
2. **Given** a pending deployment approval, **When** an authorized approver approves, **Then** Spaces triggers exactly one deployment to the linked target, records who approved it, when, the target, and the initiating run, and reports the resulting state.
3. **Given** a pending deployment approval, **When** the approver rejects, **Then** no deployment is triggered, the run records the rejection and reason, and the project returns to a non-delivered state.
4. **Given** a member without release authority, **When** they attempt to approve a deployment, **Then** the action is denied and no deployment occurs.
5. **Given** a deployment is triggered, **When** it is in progress, **Then** participants can see that a deployment is in flight and, when it finishes, whether it succeeded or failed with an actionable error.
6. **Given** the connection credential is invalid or the target is missing at approval time, **When** a deployment is attempted, **Then** the attempt fails closed, no partial deployment is recorded as successful, and the approver is told to reconnect or re-link.

---

### User Story 4 - Deployment Evidence in Delivery Verification and Agent Context (Priority: P3)

As a release manager and as an autonomous agent, I want the delivery report to include the deployment outcome and link, and I want agents to read deployment context without changing it, so that "Done" means genuinely delivered and later stages can cite the release.

**Why this priority**: This closes the loop between the board's final state and reality, and gives agents trustworthy release context; it depends on the connection, link and approval stories.

**Independent Test**: Approve and complete a deployment, then open the delivery report and verify it contains the deployment target, outcome, timestamp and a link to the deployment. Verify a failed deployment leaves the project not marked delivered and surfaces the failure. Verify an agent can read deployment context but has no ability to trigger, cancel or reconfigure a deployment.

**Acceptance Scenarios**:

1. **Given** a deployment completes, **When** the delivery report is produced, **Then** it includes the target, the outcome, the completion time and a link to the deployment in Railway.
2. **Given** a linked project whose deployment fails, **When** the delivery stage completes, **Then** the project is not marked delivered, the failure and a link to logs/state are surfaced, and a follow-up action is proposed rather than silently retrying.
3. **Given** an agent working on a release or verification stage, **When** it needs deployment context, **Then** it receives read-only deployment state and history for the project and cannot mutate the Railway account or its infrastructure.
4. **Given** a Railway outage or rate limit, **When** status or deployment is requested, **Then** the failure is reported as a structured, actionable error and does not crash the run or block unrelated projects.
5. **Given** a linked project whose deployment succeeds, **When** the delivery stage completes, **Then** the project transitions to Done only on the confirmed deployment outcome; **Given** an unlinked project, **When** delivery completes on merge, **Then** it still transitions to Done as it does today.

---

### Edge Cases

- **Credential revoked or expired during a deployment**: the attempt fails closed, is recorded as failed/unconfirmed (never delivered), and the approver is told to reconnect.
- **Linked service, environment or deployment deleted, renamed or archived in Railway**: the link is marked invalid, status becomes unknown rather than stale-current, and re-linking is required before any further release.
- **Service has multiple environments**: the project must select exactly one target; the selector shows environment names so the wrong environment is visible before linking.
- **Two approvers act on the same pending deployment**: the first decision wins and produces a single deployment; later decisions are recorded as superseded and trigger no additional deployment.
- **Deployment accepted but never becomes observable (stuck or timed out)**: after a defined timeout the deployment is marked unconfirmed, not delivered, and surfaced for human follow-up.
- **No authorized approver remains (for example the only release owner left the team)**: the release is blocked with a "no authorized approver" state and repair guidance; Spaces never self-approves.
- **Integration disconnected while projects still reference targets**: links become blocked/reconnect-needed, status shows unknown, and no deployment is attempted.
- **Credential only permits read access**: the connection still validates for observation, but a release attempt fails closed with a permission-guidance message.
- **OAuth authorization is cancelled, fails, or the callback cannot be completed**: no credential is stored, the integration stays not connected, and the error gives an actionable retry path; the token path remains available as an alternative.
- **The same environment is deployed by another tool outside Spaces**: Spaces reflects the latest observed deployment state and does not claim or overwrite external deployments; approval applies only to deployments Spaces triggers.

## Requirements *(mandatory)*

### Functional Requirements

#### Integration, Authentication and Security

- **FR-001**: Spaces MUST present Railway as a deployment platform integration under a distinct Deployment category in the organization's Integrations management and status views.
- **FR-002**: Only an organization owner or administrator MUST be able to connect, reconnect, or disconnect the Railway integration; other roles MUST be denied.
- **FR-003**: When an administrator connects Railway, Spaces MUST support both connection methods — a guided OAuth authorization and a manually supplied account/API token — MUST validate the credential against Railway, and MUST report the connection as Connected with the accessible account/workspace identity, or as Error with an actionable reason. Both methods MUST produce an equivalent connection.
- **FR-004**: Spaces MUST seal and store the Railway credential so it is never exposed in the interface, logs, errors, or exported artifacts, and MUST destroy it on disconnect.
- **FR-005**: Spaces MUST detect a revoked, expired, or undecryptable credential and mark the integration "Reconnect needed" instead of repeatedly failing silently.
- **FR-006**: The Railway connection MUST be scoped to a single organization; no other organization, team, or project outside it may view or use the credential or its accessible targets.
- **FR-007**: The integration MUST be read-only with respect to Railway account configuration; Spaces MUST NOT create, delete, rename, or reconfigure Railway projects, services, environments or variables.
- **FR-008**: Spaces MUST require a least-privilege Railway credential and MUST NOT require broad workspace-wide access when a narrower project or environment scope is sufficient for the linked targets.

#### Project Deployment Targets and Visibility

- **FR-009**: A team administrator, or the project's assigned Release Manager or Owner, MUST be able to link a project to a Railway service and environment that the organization credential can access.
- **FR-010**: The selectable targets MUST be limited to what the connected credential can actually access and to the scope the organization intends that project to use, and MUST NOT reveal targets from other organizations.
- **FR-011**: A linked project MUST display its current deployment state, the public service address when available, and the time of the most recent deployment.
- **FR-012**: Spaces MUST refresh deployment status when a participant views or explicitly refreshes it, and MUST visibly distinguish stale or unknown status from a confirmed current state.
- **FR-013**: When a linked target becomes inaccessible, Spaces MUST flag the link as invalid and direct the user to re-link rather than presenting stale state as current.
- **FR-014**: An authorized user MUST be able to unlink a project's deployment target, after which no deployment status is shown and the project returns to its merge-based delivery behavior.

#### Human-Approved Releases

- **FR-015**: Every deployment MUST require an explicit human approval in Spaces before Spaces sends any release action to Railway; no automatic or merge-triggered deployment is permitted.
- **FR-016**: Approval authority MUST be limited to the team owner/administrator, or the project's assigned Release Manager or Owner, consistent with existing approval rules; unauthorized attempts MUST be denied.
- **FR-017**: On approval, Spaces MUST trigger exactly one deployment to the linked target and record the approver, approval time, target, and initiating run.
- **FR-018**: On rejection, Spaces MUST trigger no deployment, record the rejection and any reason, and leave the project not marked delivered.
- **FR-019**: Deployment attempts MUST fail closed when the credential is invalid, the target is missing, or release authority cannot be established; a partial or unconfirmed attempt MUST NOT be recorded as a successful delivery.
- **FR-020**: Participants MUST be able to observe that a deployment is in progress and whether it succeeded or failed, with an actionable message on failure.
- **FR-021**: Release progress and outcomes MUST be communicated through the same channels used for existing run approvals and updates.
- **FR-022**: The release approval MUST reuse the delivery stage's existing human gate; Spaces MUST NOT introduce a second parallel approval step for the same release.

#### Delivery Verification and Agent Context

- **FR-023**: The delivery report MUST include the deployment target, outcome, completion time, and a reference/link to the deployment, or explicitly state that no deployment was performed.
- **FR-024**: For a project with a linked target, the project MUST NOT be marked delivered when its deployment is failed or unconfirmed; the failure and suggested next action MUST be surfaced. A project without a linked target MUST retain its existing merge-based delivery behavior.
- **FR-025**: When a project has a linked target, the board's final "Done" transition MUST be driven by the confirmed deployment outcome rather than by merge alone.
- **FR-026**: Autonomous agents MUST receive read-only deployment context (current state and history) for the project and MUST be unable to trigger, cancel, or reconfigure deployments.
- **FR-027**: Railway errors (outage, rate limit, permission denial, timeout) MUST be reported as structured, actionable errors and MUST NOT crash a run or block unrelated projects.

### Key Entities *(include if feature involves data)*

- **Railway Integration Connection**: The organization-scoped link to a Railway account. Holds the sealed credential, the connection method used (OAuth or token), the accessible account/workspace identity, connection status (not connected, pending, connected, error, reconnect needed), and last validation/refresh time.
- **Deployment Target Link**: The association between one project and one Railway service plus environment, including its validity state and last confirmed status.
- **Deployment Record**: A single release attempt to a target, including its initiating run, approver, approval time, trigger time, resulting state (in progress, success, failed, unconfirmed), completion time, and reference to the deployment in Railway.
- **Deployment Approval**: The human decision that authorizes a release, with approver identity, role, decision, timestamp, and optional reason.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An organization administrator can connect and validate Railway in under 2 minutes from the Integrations page, whether using OAuth sign-in or a manually supplied token.
- **SC-002**: 100% of deployment attempts without an explicit human approval are blocked; 0 deployments occur automatically.
- **SC-003**: A linked project shows a current deployment state within 1 minute of opening the project or refreshing.
- **SC-004**: 0 Railway credentials appear in the interface, application logs, error messages, or exported artifacts; 100% are destroyed on disconnect.
- **SC-005**: 0 cross-organization accesses to a Railway connection or its targets succeed across authorization tests.
- **SC-006**: 100% of linked projects that reach delivery either carry a confirmed deployment outcome in the delivery report or are explicitly marked not delivered with a reason; unlinked projects are unaffected.
- **SC-007**: A revoked or expired credential is surfaced as "Reconnect needed" within one status refresh and never produces a false "delivered" state.
- **SC-008**: Every deployment record identifies who approved it, when, and to which target for 100% of completed releases.
- **SC-009**: 100% of release approvals use exactly one gate, with no duplicate or parallel approval prompts observed in delivery runs.

### Assumptions

- **Product-level deployment scope**: This feature lets users deploy the software their organization builds through Spaces; it is not about how the Spaces application itself is hosted, and the existing container/self-hosting configuration is untouched.
- **Read-and-release, not infrastructure management**: This increment observes Railway state and triggers a release after human approval; creating/deleting services, editing variables, and similar account changes are out of scope.
- **Least-privilege credential**: Administrators can connect Railway either through OAuth authorization or by supplying a token. Whichever method is used, the credential is scoped as narrowly as the deployment targets allow (preferably project/environment scope); Spaces does not introduce a new authentication protocol of its own.
- **New Deployment category**: Railway is added under a new Deployment category alongside the existing Source Control, Project Management, Design & Prototyping, and Communication categories.
- **Organization-scoped, self-serve setup**: Like existing integrations, the connection is configured once per organization through the interface, not through environment variables.
- **Human gate is mandatory**: Because deployment is production-impacting, approval is always required and is not configurable off in this increment.
- **Opt-in and backward compatible**: A project only gains deployment behavior once it links a target; projects without a linked target continue to reach delivery on merge exactly as today.
- **Existing responsibility model is reused**: Release authority uses the project's existing responsibility and team-role model rather than defining new roles.

### Dependencies

- A functioning connected organization (organization, teams, and projects) and the existing Integrations management experience.
- A Railway account and a connection via OAuth or a least-privilege token with permission to observe deployments and trigger releases for the target service and environment.
- The existing project responsibility and delivery-stage human-gate model for determining who may approve a release.
- The existing delivery report and board-lane behavior for recording release evidence.

### Out of Scope

- Automatic deployment on merge, scheduled deployment, or deployment without human approval.
- Managing Railway infrastructure (creating/removing projects, services, environments, variables, domains).
- Deployment platforms other than Railway.
- Migrating historical deployments that happened outside Spaces.
- Changing the AIDLC stage or gate model beyond extending the delivery stage's existing human gate to include the release decision.
