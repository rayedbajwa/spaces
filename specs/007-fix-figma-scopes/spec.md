# Feature Specification: Fix Invalid Figma OAuth Scopes — delta for rayedbajwa/spaces

Initiative: `007-fix-figma-scopes` · Change: `007-fix-figma-scopes` · Repository: `github.com/rayedbajwa/spaces`

## Scope in this repository

- **Figma Provider Template Correction (Source)** — `PROVIDER_TEMPLATES.figma.scopes === ['current_user:read', 'file_content:read', 'library_assets:read', 'library_content:read']` (exactly four scopes).
- **Figma Scope Test Suite (Red-Green)** — Red test (T003) proven failing against the buggy `['files:read', 'file_variables:read']` value.

## Specification (from the initiative)

# Feature Specification: Fix Invalid Figma OAuth Scopes

**Scope**: bugfix

**Feature Branch**: `007-fix-figma-scopes`  
**Created**: 2026-09-23  
**Status**: Draft  
**Input**: User description: "Figma app is not working, shows scopes not valid even thought I have seleceed everyting on figma side"

## Problem Statement *(mandatory)*

When an organization administrator tries to connect Figma through the OAuth flow, Figma rejects the request with a "scopes not valid" (invalid scope) error — even though the administrator selected every available scope on the Figma app side. The connection therefore cannot be established, blocking the entire Figma integration (authentication, design-system ingestion, and agent design inspection tools) described in `006-figma-integration`.

The root cause is that the Figma OAuth provider definition requests the Enterprise-only `file_variables:read` scope alongside the read-only `files:read` scope. `file_variables:read` requires a Figma Enterprise plan; on standard plans Figma rejects the consent request with a "scope not valid" error, regardless of which scopes are enabled on the Figma app itself. The provider template requested `['files:read', 'file_variables:read']` (as shipped in `006-figma-integration`), but `file_variables:read` should never have been requested for a read-only integration that must connect on standard plans.

The deprecated `files:read` umbrella scope is also being replaced with Figma's granular read-only scopes — `current_user:read` (the `/v1/me` identity check), `file_content:read` (file/node contents), `library_assets:read` (individual published components & styles), and `library_content:read` (published components & styles of files) — matching the four Figma endpoints the read-only tools call and requesting the least privilege Figma still supports.

The goal of this fix is to correct the requested scopes so that the Figma OAuth consent flow succeeds and the integration can connect, without changing any other behavior.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Connect Figma via OAuth without an invalid-scope error (Priority: P1)

As an organization administrator, I want the Figma OAuth consent flow to complete successfully, so that I can connect our organization's Figma account and use the design integration.

**Why this priority**: Authentication is the foundation of the Figma integration. Without a valid consent request, nothing downstream (knowledge ingestion, agent tools) can function.

**Independent Test**: As an administrator with a Figma OAuth app configured, begin the Figma connect flow. The authorization URL that the browser is redirected to must contain only valid Figma scopes, and Figma must present the consent screen instead of an "invalid scope" error. After consent, the token exchange succeeds and the Figma integration reports "Connected".

**Acceptance Scenarios**:

1. **Given** an administrator has configured a Figma OAuth app, **When** they click "Connect" for Figma, **Then** the generated Figma authorization URL requests only valid Figma read-only scopes and contains no unrecognized scope identifier.
2. **Given** a valid Figma authorization request, **When** the administrator approves consent on the Figma side, **Then** Figma returns an authorization code and the token exchange completes without an "invalid scope" or "scope not valid" error.
3. **Given** a completed token exchange, **When** the integration is validated, **Then** the Figma integration card reports a connected, healthy status and displays the authenticated account handle.
4. **Given** the corrected scope list, **When** an agent or knowledge sync uses the stored OAuth token, **Then** reading files, nodes, published styles, and published components still works (no regression in the read-only tools).

---

### Edge Cases

- **Legacy/deprecated scope names**: The fix must not request the deprecated `files:read` umbrella scope (retired in favor of granular scopes) or the older `file_read` identifier, or any other retired identifier that Figma may reject.
- **Enterprise-only scopes**: The fix must not make the read-only integration depend on `file_variables:read` (Enterprise-only) unless explicitly required, so that standard Figma plans can still connect.
- **Wrong-but-recognized scopes**: If a scope is syntactically valid but not enabled on the Figma app, Figma's error message ("scope does not match" / "inactive scope") must be distinguishable from the "scope not valid" case this fix resolves.
- **Administrator guidance**: The instructions shown to administrators about which scopes to enable in their Figma app must match the scopes actually requested, so they are not asked to enable nonexistent scopes.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST request only valid Figma OAuth scope identifiers when constructing the Figma authorization URL, such that Figma never receives an unrecognized scope name.
- **FR-002**: The system MUST request the granular read scopes the read-only design tools require — `current_user:read` (identity verification), `file_content:read` (file/node contents), `library_assets:read` (published styles & components), and `library_content:read` (published components & styles of files) — instead of the deprecated `files:read` umbrella scope.
- **FR-003**: The system MUST request only the granular scopes its read-only tools use and MUST NOT include the deprecated `files:read` umbrella scope, the Enterprise-only `file_variables:read` scope, or any other scope the tools do not require (least privilege).
- **FR-004**: The system MUST NOT require the Enterprise-only `file_variables:read` scope as a precondition for connecting Figma on standard plans.
- **FR-005**: The administrator-facing guidance for the Figma OAuth app MUST list exactly the granular scopes the system requests (`current_user:read`, `file_content:read`, `library_assets:read`, `library_content:read`), so administrators enable only real, matching scopes.
- **FR-006**: After applying the corrected scopes, all existing Figma read capabilities (identity verification, file/node inspection, published styles, published components) MUST continue to function without regressions.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A Figma OAuth consent request contains zero unrecognized scope identifiers, and Figma presents the consent screen instead of returning an "invalid scope" error in 100% of connection attempts with a correctly configured Figma app.
- **SC-002**: Administrators can complete the Figma OAuth connection in under 2 minutes once their Figma app is configured.
- **SC-003**: 100% of the existing Figma read-only tool paths (identity verification, file/node inspection, styles, components) function unchanged after the scope correction, as verified by the automated test suite.
