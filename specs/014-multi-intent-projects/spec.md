# Feature Specification: Scale to Multiple Intents per Project — delta for rayedbajwa/spaces

Initiative: `014-multi-intent-projects` · Change: `014-multi-intent-projects` · Repository: `github.com/rayedbajwa/spaces`

## Scope in this repository

- **Foundational Evidence Base** — Three structured **evidence notes** (not repo files), each a list of

## Specification (from the initiative)

# Feature Specification: Scale to Multiple Intents per Project

**Scope**: spike
**Feature Branch**: `014-multi-intent-projects`
**Created**: 2026-10-25
**Status**: Draft
**Input**: User description: "scale up from running one intent per project to multiple"

## Problem Statement *(mandatory)*

A project today takes on **one intent at a time**: there is a single "current"
intent, and the next piece of work only begins once the previous one is
delivered, accepted or verified. Everything a project knows — its repositories,
memory, integrations, knowledge and delivery history — is scoped to that one
line of work. Teams that have several independent pieces of work ready
(a bug fix, an improvement and a new feature) must either run them strictly
one after another, or fragment the work across separate projects, which splits
memory, credentials, integrations and reporting.

The intended outcome of this spike is a single, reviewable **findings
artifact** that answers one question: *what would it take for one project to
carry multiple intents at the same time, and which path should we take?* The
answer must lay out the viable options, what each requires, the tradeoffs in
correctness, safety, cost and operator experience, and a recommended,
increment-sized first step — with enough evidence and acceptance-test themes
that a follow-up implementation specification can be written without
re-discovering the problem. This spike produces findings only; it changes no
product behaviour, data or configuration.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The multi-intent option space (Priority: P1)

As a product owner, I want one place that lays out the realistic ways a single
project could carry multiple intents, so that the team can choose a direction
with its eyes open instead of assuming the first idea.

**Why this priority**: Without the option space there is nothing to decide
from; this is the core deliverable of the spike.

**Independent Test**: Review the findings artifact and confirm it presents
distinct options, each described in terms of how work would be isolated, how
work would be scheduled and how intents would be kept from interfering with
one another.

**Acceptance Scenarios**:

1. **Given** the findings artifact, **When** a reviewer reads the options,
   **Then** at least three distinct approaches are described, covering the
   range from "many intents may be in flight but only one executes at a time"
   through "several intents execute at once under an explicit bound".
2. **Given** any option, **When** a reviewer asks "what would actually have to
   change", **Then** the option names the dimensions it affects (how work areas
   are isolated and kept intact, who may see and act on each intent, how work
   is admitted and scheduled, how human gates and notifications find the right
   people, how delivery and merges are ordered, how resources and cost are
   bounded, how operators observe it, and how existing projects are carried
   forward).
3. **Given** two options, **When** a reviewer compares them, **Then** the
   differences are stated as tradeoffs in correctness, safety, cost and
   operator effort, not as a bare list.

---

### User Story 2 - Evidence from the current single-intent behaviour (Priority: P2)

As a delivery lead, I want every proposed option grounded in what the product
does today, so that the recommendation is defensible and the first increment
is realistic.

**Why this priority**: A spike that ignores the existing single-intent model
will recommend work that duplicates or breaks it; evidence turns the option
space into a trustworthy recommendation.

**Independent Test**: Sample the claimed constraints and confirm each points to
a real location in the product repository or its documentation, and that the
artifact names which assumptions could not be verified.

**Acceptance Scenarios**:

1. **Given** an option, **When** its evidence is followed, **Then** it points
   to a concrete location in the named product repository (source, schema,
   test, specification or documentation) that shows the current single-intent
   limit or a related failure mode it must respect.
2. **Given** the findings, **When** a reviewer checks the constraints, **Then**
   the artifact states the current behaviour for sharing one project across
   concurrent work (for example human gates, job scheduling, per-project
   locking and delivery/merge ordering) with evidence, including failure modes
   the new behaviour must not regress.
3. **Given** something that could not be confirmed within the time-box,
   **When** a reviewer looks for it, **Then** it is marked as unverified rather
   than presented as fact.
4. **Given** the findings artifact, **When** a reviewer checks its boundaries,
   **Then** it names every repository it touches or relies on and records the
   assumptions it made about scope and evidence, including the time-box it was
   held to.

---

### User Story 3 - A recommended first step and open decisions (Priority: P3)

As a delivery lead, I want a recommended path and the questions only people can
answer, so that the next specification can start immediately after the spike.

**Why this priority**: The finding is only useful if it shortens the path to
the next approved increment; this is the hand-off into plan.

**Independent Test**: Take the recommendation and confirm a specification can
be drafted from the artifact alone — problem, intended outcome, scope of a
first slice, prerequisites, risks and acceptance-test themes.

**Acceptance Scenarios**:

1. **Given** the findings, **When** the recommendation is read, **Then** one
   path is recommended with a stated rationale tied to user value, risk and
   delivery cost, and the rejected options record why they were set aside.
2. **Given** the recommendation, **When** the first increment is read, **Then**
   it is the smallest slice that delivers a usable step toward multiple
   intents, and it names the acceptance-test themes a future specification
   should cover.
3. **Given** the findings, **When** a reviewer looks for unresolved matters,
   **Then** the artifact lists the open product, safety and operational
   decisions, each with the role that should decide it and the impact of
   leaving it undecided.

---

### Edge Cases

- Two intents would touch the same files or the same repository at once: the
  artifact MUST describe how each option keeps one intent's work from
  corrupting another's, and what happens when isolation is not possible.
- Two or more intents reach a human gate at the same time: the artifact MUST
  state how each option routes each request to the right people without
  ambiguous or duplicate approvals.
- One intent fails, is cancelled, paused or archived while others are in
  flight: the artifact MUST describe whether and how it affects the others.
- Several intents are ready but the project's capacity is full: the artifact
  MUST state how each option admits, queues, defers or rejects work, and how it
  prevents one project from exhausting shared capacity or budget.
- Two intents are ready to be delivered to the same place: the artifact MUST
  describe the ordering and conflict behaviour each option implies.
- A concurrent status or document change arrives for an intent: the artifact
  MUST confirm that intent records, history and audit remain correct and
  attributable under concurrency, or record the risk.
- A person is authorized for one intent but not another, or an intent's owning
  team changes while others are in flight: the artifact MUST state how each
  option preserves authorization and tenant boundaries per intent.
- Existing projects that already hold several intents as history: the artifact
  MUST state how each option carries them forward without loss or duplication.
- The time-box expires before every option is examined: the artifact MUST state
  what was covered, what was not, and what a follow-up would need to examine.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The spike MUST produce a single findings artifact, stored with
  this feature's specification, that answers what it would take for one project
  to carry multiple intents at the same time.
- **FR-002**: The artifact MUST state the research question in full and define
  what a useful, decision-ready answer looks like (which matters must be
  settled for a follow-up specification to begin).
- **FR-003**: The artifact MUST describe the current single-intent behaviour
  and its concrete limits, grounded in the named product repository.
- **FR-004**: The artifact MUST identify the distinct dimensions that any
  multi-intent design has to settle: work isolation and data integrity;
  authorization and tenant isolation (who may see and act on each intent, and
  that one organization's or team's intents are never exposed to another); how
  work is admitted and scheduled; how human gates, approvals and notifications
  are routed per intent; how delivery and merges are ordered; resource, fairness
  and cost limits; observability and auditability; and compatibility with
  existing projects.
- **FR-005**: The artifact MUST present at least three viable options spanning
  the range from "multiple intents in flight, one executing at a time" through
  "several intents executing at once under an explicit bound", each described
  in conceptual, non-implementation terms.
- **FR-006**: Each option MUST cite at least one concrete location in the named
  product repository (source, schema, test, specification or documentation)
  as evidence of the constraint it would relax.
- **FR-007**: Each option MUST state how it isolates concurrent intents'
  work and preserves intent records, history and attribution when changes
  happen at the same time.
- **FR-008**: Each option MUST state how gate, approval and notification flows
  are resolved to the right intent and the right people, including when several
  intents wait at once.
- **FR-009**: Each option MUST state how delivery and integration of several
  in-flight intents are ordered and how conflicts or partial delivery are
  handled.
- **FR-010**: Each option MUST state how many intents may run, how work is
  queued or deferred when capacity is reached, and how one project cannot
  exhaust shared platform capacity or budget.
- **FR-011**: Each option MUST state what an operator can see and audit for
  many in-flight intents (per-intent status, progress, history and cost).
- **FR-012**: Each option MUST assess compatibility with existing projects and
  the current single-intent model, and whether it can be adopted and reversed
  incrementally without data loss.
- **FR-013**: The artifact MUST compare the options against the project
  constitution and organization principles (thin vertical slices, secure
  boundaries, observable and reversible operations, testable acceptance) and
  state a single recommended path with rationale.
- **FR-014**: The artifact MUST record the options that were set aside and the
  reason each was set aside.
- **FR-015**: The artifact MUST recommend the smallest first increment that
  delivers a usable step toward multiple intents, and name the acceptance-test
  themes a follow-up specification should cover.
- **FR-016**: The artifact MUST list the open product, safety and operational
  decisions, each with the role that should decide it and the impact of leaving
  it undecided.
- **FR-017**: The artifact MUST state what could not be verified within the
  time-box defined in Assumptions, and which areas therefore need a follow-up
  spike or a decision before they can be prioritised.
- **FR-018**: The artifact MUST name every repository it touches or relies on,
  and which of them a future increment would change.
- **FR-019**: The spike MUST NOT change product behaviour, data, schema or
  deployed configuration; its only outputs are the findings artifact and this
  specification's supporting checklist.
- **FR-020**: The artifact MUST record the assumptions it made about scope and
  evidence — in particular the meaning of "multiple" — so a reviewer can judge
  whether it is complete enough to plan from.

### Key Entities *(include if feature involves data)*

- **Multi-Intent Option**: One candidate approach to running several intents in
  a project. Key attributes: short title; the mechanism in plain terms; the
  dimensions it affects and how; isolation and data-integrity stance;
  authorization and tenant-isolation stance (who may see and act on the intent,
  and which boundary it sits in); gate and notification routing; delivery and
  merge ordering; resource, fairness and cost model; observability stance;
  compatibility and reversibility with existing projects; benefits; costs;
  risks and prerequisites; evidence location(s); and a rough effort signal.
- **Research Question and Answer Criteria**: The question the spike must answer
  and the conditions that make an answer decision-ready.
- **Open Decision**: A matter the spike cannot settle from evidence alone. Key
  attributes: question; context; impact if left undecided; suggested decision
  owner.
- **Coverage Note**: What was examined within the time-box, what was not, and
  what a follow-up would need.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The findings artifact presents at least three distinct options,
  including at least one in which more than one intent executes at once.
- **SC-002**: 100% of options cite at least one verifiable location in the
  named product repository.
- **SC-003**: Every option addresses all of the dimensions in FR-004
  (isolation and data integrity, authorization/tenant isolation, admission and
  scheduling, gate and notification routing, delivery ordering, resource/cost,
  observability, and compatibility), so options can be compared without further
  research.
- **SC-004**: The artifact states a single recommended path with a rationale
  and a smallest first increment whose acceptance-test themes are described.
- **SC-005**: The artifact records at least three open decisions, each with a
  suggested decision owner.
- **SC-006**: The spike's change set contains no production code, schema or
  configuration change — only specification and findings artifacts.
- **SC-007**: A delivery lead can begin a follow-up implementation
  specification from the artifact alone, without re-researching the current
  single-intent behaviour.
- **SC-008**: The artifact explicitly states the default interpretation of
  "multiple" (simultaneously executing versus in flight but serialized) and
  says which one the recommendation targets.

## Assumptions

- **Meaning of "multiple"**: the description is read as *multiple intents in
  flight within a single project*, and the spike treats "how many may execute
  at once" as one of the questions to answer rather than a given. The spike
  MUST record this interpretation and recommend which reading to implement
  (see SC-008); it is not treated as a blocking clarification because the
  comparison of simultaneous versus serialized execution is itself part of the
  investigation.
- An **intent** is one piece of work a project takes on (a bug fix, feature,
  improvement, chore or spike) — the unit the current product tracks per
  project. This spike does not redefine it.
- The **product repository** is `rayedbajwa/spaces`; this governance repository
  holds only the specification, checklist and findings artifacts. A future
  increment would change `rayedbajwa/spaces`.
- Evidence comes from the product repository's source, schema, tests,
  `specs/`, `docs/`, and from project and organization memory. The research
  brief at `.aidlc/research/brief.md` predates this feature and concerns
  project responsibilities; only its repository map, standards and constraints
  are reused here.
- **Time-box**: the spike is limited to one research iteration, time-boxed to
  five working days and ending Friday 2026-10-30. Anything not verified inside
  that window is reported as unverified (and as follow-up work per FR-017)
  rather than guessed.
- **Non-goals**: this spike does not redefine what an *intent* is, replace
  team roles, grant or restrict access through intents, alter team-role
  authorization, or modify deployed configuration or data, or commit to
  producing production code. Human review gates, team-role authorization and
  approval authority are unchanged; any multi-intent gate behaviour is
  described as a finding, not adopted. Any such change is recorded only as a
  finding or an open decision, never adopted by this spike.
- Testing for a spike means reviewing the artifact against the acceptance
  scenarios and this specification's checklist; no executable test suite is
  added for the spike itself. Each recommended increment carries the
  acceptance-test themes the future feature must cover.
- Prioritisation defaults to user value and risk reduction first, then delivery
  cost, consistent with the organization's delivery principles.
