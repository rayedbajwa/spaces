# Feature Specification: Project Responsibilities and Owner Fallback — delta for rayedbajwa/spaces

Initiative: `project-responsibilities` · Change: `project-responsibilities` · Repository: `github.com/rayedbajwa/spaces`

## Scope in this repository

- **Domain, Migration, and Owner Safety Foundation** — Stable responsibility resolution and mutation contract.
- **Responsibility API and Authorization Boundary** — Authorized read/mutation/repair operations with deterministic response states.
- **Workflow Context and Review-Gate Preservation** — Advisory responsibility context at the intended stage/review boundaries.
- **Project Management UI and User Guidance** — Usable project responsibility management and read states.

## Specification (from the initiative)

# Feature Specification: Project Responsibilities and Owner Fallback

**Feature Branch**: `003-project-responsibilities`  
**Created**: 2026-09-20  
**Status**: Draft  
**Input**: User description: "add roles within a project, product owner, lead engineer, designer, qa, release manager - these could be separate or same roles, need suggestions on how to handle team management and project management - atleast one role is needed that owners should be assigned to, if no role is assigne in project, everything fallsback to owwner"

## Problem Statement

Projects need visible accountability for product, engineering, design, quality, and release work without changing the established team access model. Today, an unassigned responsibility can leave participants and workflow stages without a clear contact. This feature establishes standard project responsibilities, guarantees a safe Owner fallback for unassigned non-Owner work, and surfaces repair-needed conditions when no valid Owner exists.

## Clarifications

### Session 2026-09-20

- Q: How should workflow stages use project responsibilities? → A: Advisory standard mapping: Specify/review → Product Owner; plan/implement → Lead Engineer; design work → Designer; verify → QA; release/delivery → Release Manager; general escalation and fallback → Owner. These mappings do not grant approval authority or alter existing human review gates or authorization behavior.
- Q: When should legacy projects be repaired? → A: Seed on project creation; repair on project access or explicit authorized repair action; show repair-needed when no eligible Owner exists.

## User Scenarios & Testing

### User Story 1 - Set project accountability (Priority: P1)

As a team owner or administrator, I want to assign project responsibilities to team members so that every project has clear accountability for product, engineering, design, quality, and release work.

**Why this priority**: Clear accountability is the core value of the feature and prevents project work from depending on an implicit or unknown owner.

**Independent Test**: Create or open a team project, assign one or more active team members to the standard responsibilities, reload the project, and verify that each assignment and its primary assignee is shown consistently.

**Acceptance Scenarios**:

1. **Given** a newly created project with an eligible creator, **When** the project is opened, **Then** it contains exactly one responsibility definition for each of Owner, Product Owner, Lead Engineer, Designer, QA, and Release Manager, and the creator is assigned as Owner. Each definition may have one or more assignees where permitted.
2. **Given** an existing project, **When** a team owner or administrator opens responsibility management, **Then** all six standard responsibilities are available even if the project predates this feature.
3. **Given** an active team member, **When** an authorized manager assigns that person to more than one responsibility, **Then** all assignments are retained and displayed without replacing assignments in the other responsibilities.
4. **Given** several assignees for one responsibility, **When** the responsibility is resolved, **Then** the first active assignee by explicit order is treated as primary and the remaining assignees are retained as ordered backups.

### User Story 2 - Manage responsibilities without changing access (Priority: P1)

As a team manager, I want project accountability to remain separate from team access so that assigning a person to a project responsibility neither grants access nor changes their team role.

**Why this priority**: Separating accountability from authorization avoids accidental data exposure and preserves the existing organization, team, and project security model.

**Independent Test**: Attempt responsibility reads and mutations as team owner, administrator, member, viewer, and a non-team user, and verify both the permitted operation and the resulting team/project access.

**Acceptance Scenarios**:

1. **Given** a team owner or administrator, **When** they replace responsibility assignments for a project they can access, **Then** the change succeeds and is recorded as an accountability change.
2. **Given** an ordinary team member, **When** they view a project, **Then** they can read responsibility assignments but cannot change them.
3. **Given** a team viewer or a user outside the project’s owning team, **When** they request or modify responsibility assignments, **Then** the operation is denied and no assignment changes.
4. **Given** a user assigned to a responsibility, **When** the assignment is saved, **Then** the user’s team role and ability to access the project remain unchanged.

### User Story 3 - Resolve missing accountability safely (Priority: P1)

As a project participant, I want unassigned responsibilities to resolve predictably to the project Owner so that work can continue without silently losing accountability.

**Why this priority**: The requested fallback is the safety net for projects that have not yet assigned every function; it also gives workflow consumers a deterministic person to contact.

**Independent Test**: Leave each non-Owner responsibility unassigned, resolve it, and verify that active Owners are returned; then remove or invalidate all Owners and verify that the project is marked as needing repair rather than assigning someone by guesswork.

**Acceptance Scenarios**:

1. **Given** a non-Owner responsibility with no active explicit assignee and at least one active Owner, **When** it is resolved, **Then** the active Owners are returned as an explicit “Owner fallback” result.
2. **Given** an explicitly assigned responsibility with active assignees, **When** it is resolved, **Then** the explicit assignees are returned and Owner fallback is not used.
3. **Given** no active Owner exists, **When** any unassigned responsibility is resolved, **Then** the result is unresolved, the project is marked as needing repair, and no user is guessed or silently promoted.
4. **Given** the final active Owner assignment, **When** a manager attempts to remove it without assigning a replacement in the same change, **Then** the change is rejected and the project retains an Owner.
5. **Given** a legacy project with no eligible team member, **When** it is migrated or repaired, **Then** its standard responsibilities are created, it remains readable, and its unresolved Owner state is clearly surfaced for authorized repair.

### User Story 4 - Use responsibility context in the delivery workflow (Priority: P2)

As a project participant, I want workflow stages and review requests to use the project’s resolved responsibilities so that requests reach the right accountability group without bypassing human review gates.

**Why this priority**: Responsibilities deliver more value when they guide project work, but this can be added after management and safe resolution are reliable.

**Independent Test**: Run a project workflow with explicit assignments, fallback assignments, and an unresolved Owner state, and verify the displayed workflow context and review recipient behavior for each case.

**Acceptance Scenarios**:

1. **Given** a project with explicit responsibility assignments, **When** a workflow stage or review gate needs that responsibility, **Then** the resulting context identifies the active assignee(s) and preserves the existing human approval requirement.
2. **Given** a stage with no explicit responsibility assignment, **When** it needs a responsibility, **Then** its context identifies the active project Owner through the documented fallback.
3. **Given** an unresolved responsibility, **When** a workflow stage or review gate needs it, **Then** the system reports a repair-needed condition and does not silently route to an arbitrary user or bypass the gate.
4. **Given** multiple assignees, **When** a workflow action selects a primary contact, **Then** it uses the first active assignee in the configured order and exposes the remaining assignees as additional accountability contacts.

### User Story 5 - Understand and repair responsibility health (Priority: P2)

As a team manager, I want to see why a responsibility is explicit, using Owner fallback, or unresolved so that I can correct gaps without inspecting hidden system state.

**Why this priority**: Transparent status reduces operational confusion and makes legacy-project migration recoverable.

**Independent Test**: View a project with explicit, fallback, invalid-member, and unresolved responsibilities, then perform an authorized repair and verify the status and primary assignee update.

**Acceptance Scenarios**:

1. **Given** a project responsibility, **When** a participant views the project, **Then** the UI shows its name, current primary assignee when available, assignment status, and whether repair is needed.
2. **Given** a responsibility assigned to a deactivated or removed team member, **When** the project is viewed, **Then** that assignment is not treated as active and the resulting fallback or repair-needed status is shown.
3. **Given** an authorized manager, **When** they assign a valid active team member to an unresolved responsibility, **Then** the project immediately shows the new explicit assignment and no longer reports that responsibility as unresolved.

### Edge Cases

- A person may hold all six responsibilities; the system must not require different people for different responsibilities.
- A person cannot be assigned if they are not an active member of the project’s owning team.
- The owning team may have no active members, or the project may have no valid Owner after a member is removed; this must produce a visible repair-needed state, not an invented owner.
- Removing or deactivating a non-Owner assignee must remove that person from active resolution while preserving audit history.
- Multiple Owners are allowed and resolve in deterministic assignment order; removal of one Owner must not remove the final active Owner.
- Repeating project migration or repair must not duplicate responsibilities, assignments, or audit events for unchanged state.
- A project whose owning team changes must not retain assignments to people who are no longer eligible under the new team.
- Assignment operations must be isolated to the project’s organization and owning team; similarly named users or projects in another tenant must never be returned.
- An unavailable or deleted user must not prevent authorized participants from reading the project’s remaining responsibility state.

## Requirements

### Functional Requirements

- **FR-001**: The system MUST provide six standard project responsibilities: Owner, Product Owner, Lead Engineer, Designer, QA, and Release Manager.
- **FR-002**: The system MUST seed the six standard responsibilities during project creation and MUST support idempotent repair when an existing project is accessed or an authorized manager explicitly requests repair, without duplicating an already present responsibility.
- **FR-003**: The system MUST ensure that a project has at least one active Owner whenever an eligible active member of the owning team is available.
- **FR-004**: The system MUST prefer the project creator as the initial Owner when that creator is an active member of the owning team; otherwise it MUST choose a deterministic eligible team member. If no eligible member exists, it MUST leave the project in an explicit repair-needed state.
- **FR-005**: The system MUST allow an active owning-team member to be assigned to multiple responsibilities and MUST allow multiple ordered active assignees for a responsibility.
- **FR-006**: The system MUST treat the first active assignee in responsibility order as the primary assignee and MUST preserve the order of additional assignees.
- **FR-007**: The system MUST resolve an explicitly assigned responsibility to its active assignees before applying fallback.
- **FR-008**: The system MUST resolve an unassigned non-Owner responsibility to the project’s active Owner assignee(s), and MUST label the result as Owner fallback.
- **FR-009**: The system MUST return an unresolved, repair-needed result when no active Owner can be resolved, without selecting an arbitrary user.
- **FR-010**: The system MUST reject an assignment to a user who is not an active member of the project’s owning team.
- **FR-011**: The system MUST prevent a change from removing the final active Owner unless the same operation establishes at least one valid replacement Owner.
- **FR-012**: The system MUST restrict responsibility mutations to authorized team owners and administrators, allow authorized team members to read responsibility state, and deny unauthorized viewers and users outside the owning team.
- **FR-013**: The system MUST NOT grant, revoke, or alter team/project access as a side effect of assigning a project responsibility.
- **FR-014**: The system MUST deactivate or exclude responsibility assignments when their user leaves or becomes inactive in the owning team, while retaining sufficient history to explain the change.
- **FR-015**: The system MUST expose responsibility name, ordered assignees, primary assignee, resolution status, and repair-needed state to project participants who can read the project.
- **FR-016**: The system MUST record responsibility creation, assignment replacement, migration/repair, and member-deactivation changes with the project, actor, affected responsibility, and outcome. Repeated repair with unchanged state MUST NOT create duplicate audit events.
- **FR-017**: Workflow stages and review gates that consume accountability context MUST use the advisory standard mapping of Specify/review to Product Owner, plan/implement to Lead Engineer, design work to Designer, verify to QA, release/delivery to Release Manager, and general escalation/fallback to Owner. They MUST use explicit assignments first and Owner fallback second, and MUST preserve existing human approval and review-gate behavior without granting approval authority.
- **FR-018**: Workflow consumers MUST surface unresolved responsibility state as an actionable repair condition and MUST NOT silently route work to an arbitrary person.
- **FR-019**: Responsibility reads, writes, migration, and workflow resolution MUST enforce organization and owning-team boundaries, including for projects with legacy or missing ownership metadata.
- **FR-020**: The system MUST provide user-facing guidance that distinguishes team access roles from project responsibilities and explains explicit, Owner fallback, and unresolved states.

### Key Entities

- **Project Responsibility**: A standard accountability area belonging to one project; includes its stable name, display label, and ordering.
- **Responsibility Assignment**: An ordered link between a project responsibility and an active owning-team member; the first active link is primary.
- **Resolution Result**: The participant-facing outcome for a responsibility: explicit assignee(s), Owner fallback assignee(s), or unresolved/repair-needed.
- **Team Member**: A user with active membership in the project’s owning team; eligibility for assignment is distinct from the member’s team access role.
- **Responsibility Audit Event**: An immutable record describing a responsibility lifecycle or assignment change, its actor, affected project, and result.

## Assumptions

- The six responsibilities are fixed standard vocabulary for this increment; creating, renaming, deleting, or reordering custom responsibility types is out of scope.
- One user may hold any number of responsibilities, and every responsibility may have multiple ordered assignees.
- The project creator is the preferred initial Owner only when eligible; otherwise a deterministic active team member is acceptable. No owner is invented when no eligible member exists.
- Responsibility assignment is accountability, not authorization. Existing organization, team, and project access rules remain authoritative.
- Owner fallback applies whenever a non-Owner responsibility lacks active explicit assignees. It does not require an administrator acknowledgment before use.
- Workflow responsibility mappings are advisory routing/context; they do not replace human review gates or grant approval authority.
- Write-only auditability is sufficient for this increment; a dedicated audit-history browsing experience is not required.
- The owning team remains the eligibility boundary for project responsibility assignments; a separate project membership model is not introduced.

## Out of Scope

- Replacing or redefining organization, team, or project access roles.
- Granting project access through responsibility assignment.
- Organization-wide role templates or custom responsibility CRUD.
- Automatic notifications, escalation policies, or SLA management beyond exposing the resolved accountability context.
- Changing the AIDLC stage definitions or removing human approval gates.

## Success Criteria

### Measurable Outcomes

- **SC-001**: 100% of newly created projects display all six standard responsibilities and a valid Owner when at least one eligible active team member exists.
- **SC-002**: 100% of legacy projects tested through migration retain project readability, have all six standard responsibilities after repair, and produce no duplicate standard responsibilities when migration is repeated.
- **SC-003**: In acceptance testing, 100% of explicit, fallback, unresolved, invalid-member, multiple-assignee, final-Owner, and member-removal scenarios produce the specified result.
- **SC-004**: In authorization testing, 100% of allowed manager mutations succeed and 100% of member/viewer/cross-tenant mutation attempts are denied without data changes.
- **SC-005**: A project participant can identify the primary assignee and whether the result is explicit, Owner fallback, or repair-needed within 30 seconds of opening the project.
- **SC-006**: In workflow acceptance tests, 100% of responsibility lookups use explicit assignments before fallback and preserve the existing review-gate behavior.
- **SC-007**: Responsibility changes are auditable in 100% of tested create, replace, repair, migration, and member-deactivation operations.
- **SC-008**: At least 90% of representative test users can assign a responsibility, understand the difference between team access and project accountability, and repair an unassigned responsibility without assistance.
