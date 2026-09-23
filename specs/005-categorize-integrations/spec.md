# Feature Specification: Categorize Integrations by Functional Domain

**Scope**: improvement

**Feature Branch**: `005-categorize-integrations`  
**Created**: 2026-09-23  
**Status**: Draft  
**Input**: User description: "For integrations, split them into project management, source control, message channels/communication"

## Problem Statement *(mandatory)*

Spaces integrates with external services across the software development life cycle — version control systems, issue and project trackers, documentation hubs, and team communication platforms. Currently, all integrations and OAuth provider applications are presented in a single flat, un-categorized list in both the organization settings view and the read-only status modal.

This flat structure causes multiple problems for users and administrators:
- **Lack of domain clarity**: Users cannot quickly discern which tool fulfills which purpose in their SDLC workflow (for example, distinguishing code hosting from issue tracking from notification channels).
- **Toolchain gap discovery**: Teams cannot easily identify if an essential SDLC pillar is missing (e.g., whether the organization has connected a source control provider or a communication channel).
- **Cluttered administrative experience**: As additional tools are introduced, the unorganized list becomes increasingly difficult to navigate, audit, and configure.

The intended outcome is to split all integrations into three standard functional categories:
1. **Source Control**
2. **Project Management**
3. **Message Channels / Communication**

By organizing integrations into these three distinct categories across management and status views, administrators and team members can immediately understand their toolchain coverage, discover missing capabilities, and manage connections within clear functional domains.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Categorized Organization Integrations Management (Priority: P1)

As an organization owner or administrator configuring external tools, I want the Integrations management page to display integrations organized into three clear functional categories (Source Control, Project Management, and Message Channels / Communication), so that I can easily discover, set up, and connect services according to their role in our engineering workflow.

**Why this priority**: This is the primary administration touchpoint where connections and provider credentials are configured. Categorizing this view delivers immediate clarity and prevents misconfiguration.

**Independent Test**: Navigate to the organization integrations page as an administrator. Verify that integrations are grouped under the three category headers, that provider apps and connections appear under their correct category, and that credential setup, connection, and disconnection actions work seamlessly within each category.

**Acceptance Scenarios**:

1. **Given** an administrator visits the organization integrations view, **When** the page renders, **Then** three distinct category sections are displayed: "Source Control", "Project Management", and "Message Channels / Communication", each with an explanatory description of its purpose.
2. **Given** the categorized integrations view, **When** inspecting each category:
   - "Source Control" contains GitHub (and code repository integrations).
   - "Project Management" contains Jira, Linear, and Confluence (issue tracking, project management, and specification documentation).
   - "Message Channels / Communication" contains Slack (team messaging and notification channels).
3. **Given** an unconnected integration within any category, **When** an administrator configures credentials and initiates connection, **Then** the OAuth flow completes and the integration card updates to "connected" within that category.
4. **Given** a connected integration within any category, **When** an administrator clicks "Disconnect" and confirms, **Then** the integration updates to "disconnected" within that category and other categories remain unaffected.

---

### User Story 2 - Categorized Read-Only Status & Modal Inspection (Priority: P2)

As a team member or project manager inspecting the organization's integrations from the top navigation bar or settings modal, I want to see the integrations organized by functional category with category-level summary badges, so that I can immediately check the health and availability of our source control, project management, and communication channels without administrative controls.

**Why this priority**: Team members frequently check whether GitHub or Slack is connected before running automated pipelines or looking for project channels. Providing a categorized view allows instant verification of toolchain health.

**Independent Test**: Open the integrations modal from the top-level status chip as a non-administrative user. Confirm that the display is categorized into the three functional domains, displays accurate status summaries, and provides read-only clarity without administrative action buttons.

**Acceptance Scenarios**:

1. **Given** a user opens the integrations status modal from the top navigation bar, **When** the modal opens, **Then** integrations are presented grouped under the three functional categories (Source Control, Project Management, Message Channels / Communication).
2. **Given** an organization where GitHub and Slack are connected but Jira and Linear are not, **When** viewing the categories, **Then** Source Control displays an active/connected status, Message Channels / Communication displays an active/connected status, and Project Management indicates that no services are currently connected.
3. **Given** a non-administrative user viewing the categorized modal, **When** examining any category, **Then** connection statuses and provider names are clearly readable, and administrative actions (such as credential editing or disconnect buttons) are hidden or appropriately restricted.

---

### User Story 3 - Category Health Summary and Empty States (Priority: P3)

As an administrator or team lead evaluating our toolchain readiness, I want each category to provide a clear status summary (e.g., number of connected services or readiness state) and a helpful empty state when no services are connected in that domain, so that our team knows exactly what capabilities are missing and how to enable them.

**Why this priority**: Teams setting up a new workspace need guidance on what each category provides and what integrations to connect next. Clear empty states and category summaries provide actionable onboarding guidance.

**Independent Test**: In an organization with no integrations connected, verify that each category displays a helpful empty state explaining its purpose in the SDLC. Connect one service in a category and verify that the category summary transitions from "None connected" to "Connected".

**Acceptance Scenarios**:

1. **Given** a newly created organization with zero connected integrations, **When** viewing the integrations page or modal, **Then** each category section displays an informative empty state explaining the benefits of connecting that domain (e.g., "Connect source control to allow agents to clone repositories and create pull requests").
2. **Given** a category with multiple available services (such as Project Management with Jira and Linear), **When** at least one service is connected, **Then** the category header reflects a positive connection state (e.g., "1 connected") while unconnected options remain visible for optional setup.
3. **Given** an integration requiring credential re-authorization, **When** viewed under its category, **Then** the category highlights the attention state (e.g., "reconnect needed") so administrators can quickly pinpoint the issue.

---

### Edge Cases

- **Provider with multiple distinct capabilities (e.g., Atlassian)**: Atlassian powers both Jira (issue tracking) and Confluence (documentation and specifications). Both capabilities reside within the "Project Management" category, clearly distinguishing issue tracking from project documentation while sharing the common Atlassian provider authentication.
- **Category with zero connected services**: The category section must not collapse or disappear; it must render a structured empty state explaining the functional gap and how to resolve it.
- **Partial connectivity within a category**: When one provider in a category is connected and another is not (e.g., Jira is connected while Linear is not), the category status must report the active connection without marking the category as deficient or failing.
- **Provider app configured but no connection created**: If an administrator sets up provider credentials (e.g., client ID and secret) but has not yet completed the OAuth connection, the card within its category must distinguish between "app set up" and "connected".
- **Token expiration or revocation**: When an integration's credentials expire or are revoked, the affected card within its category displays a prominent warning/reconnect prompt without destabilizing the layout of adjacent categories.
- **Small screen / mobile responsiveness**: The categorized layout must wrap cleanly into vertical stacks on narrower viewports without horizontal overflowing or broken alignment.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST define three standard, canonical integration categories:
  1. `source_control` (Display label: **Source Control**)
  2. `project_management` (Display label: **Project Management**)
  3. `communication` (Display label: **Message Channels / Communication**)
- **FR-002**: The system MUST classify every supported integration and provider application into exactly one primary functional category:
  - **Source Control**: GitHub (and git repository connections)
  - **Project Management**: Jira, Linear, and Confluence
  - **Message Channels / Communication**: Slack
- **FR-003**: The organization integrations view MUST group integrations into three separate visual sections corresponding to the three categories.
- **FR-004**: Each category section MUST display:
  - The category title (e.g., "Source Control", "Project Management", "Message Channels / Communication")
  - A descriptive blurb explaining what this category does for the team and autonomous agents
  - A category status indicator summarizing whether services in this category are connected, partially connected, or unconfigured
- **FR-005**: The read-only integrations modal (opened from the navigation bar status chip) MUST also group integrations by the same three categories, displaying read-only connection indicators and descriptions.
- **FR-006**: Existing integration management operations (setup app credentials, OAuth connect, reconnect, and disconnect) MUST remain fully functional within their respective categorized sections without regression.
- **FR-007**: When a category contains no connected integrations, the system MUST render a dedicated empty state explaining the capability gap and providing clear instructions or call-to-actions for setup.
- **FR-008**: For providers that supply multiple integration kinds (such as Atlassian supplying Jira and Confluence), both sub-services MUST be displayed within the Project Management category, with clear indicators of each sub-service's connection status.
- **FR-009**: Category grouping metadata MUST be centrally defined so that all user interface surfaces (organization settings, inspection modals, project wizards, and status summaries) render consistent categories and descriptions.
- **FR-010**: The top navigation status indicator ("Integrations X/Y") MUST continue to report the overall count and status while allowing users to inspect the categorized breakdown upon clicking.

### Assumptions

- **Atlassian grouping**: While Confluence is a documentation tool and Jira is an issue tracker, both support project planning, specifications, and requirements management, and both are authorized through a single Atlassian OAuth app. They are therefore unified under the "Project Management" category rather than creating a separate single-item "Documentation" category.
- **Future extensibility**: Additional providers in the future (e.g., GitLab or Bitbucket under Source Control; Asana or Shortcut under Project Management; Discord or Microsoft Teams under Message Channels / Communication) will plug directly into these three canonical categories.
- **No data migration required**: Categorization is an architectural and presentation improvement; existing database records for `app_integrations` and `oauth_apps` retain their existing kinds and primary keys, with categories mapped deterministically from integration kinds and providers.

### Key Entities *(include if feature involves data)*

- **Integration Category**: A domain categorization entity defined by:
  - `id`: Unique identifier (`source_control`, `project_management`, `communication`)
  - `label`: Human-readable display name ("Source Control", "Project Management", "Message Channels / Communication")
  - `description`: Explanatory text of the category's role in the SDLC
  - `providers`: List of provider identifiers belonging to this category
  - `kinds`: List of integration kinds belonging to this category
- **Provider Application**: An external OAuth application configuration (e.g., GitHub App, Atlassian App, Slack App, Linear App) belonging to a specific category.
- **Integration Connection**: An active, authorized link to an external tenant/instance for a specific integration kind, displaying its health and connection timestamp within its category.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of supported integrations and provider apps in the application are classified into one of the three canonical categories with zero un-categorized or orphaned items.
- **SC-002**: Users can visually identify the connection status of all three SDLC categories (Source Control, Project Management, Communication) in under 5 seconds upon opening the integrations view or modal.
- **SC-003**: 100% of existing integration management flows (create app, edit credentials, OAuth authorize callback, disconnect, reconnect) continue to work without functional regression.
- **SC-004**: In an organization with zero integrations configured, all three categories display informative empty states explaining their purpose and next steps.
- **SC-005**: All integration inspection views (organization settings panel, top-bar modal, wizard summaries) present identical category assignments and consistent status reporting.
