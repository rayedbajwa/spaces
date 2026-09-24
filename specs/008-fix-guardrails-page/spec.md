# Feature Specification: Fix and Modernize the Data Guardrails Page — delta for rayedbajwa/spaces

Initiative: `008-fix-guardrails-page` · Change: `008-fix-guardrails-page` · Repository: `github.com/rayedbajwa/spaces`

## Scope in this repository

- **Browser regression test harness and tests** — `tests/helpers/guardrails-page.ts` (new)
- **Component markup (mode rows, never-mask field)** — Updated `src/web/guardrails.tsx` with stable layout hooks and the target accessibility associations
- **Stylesheet layout, alignment and visual system** — Updated `.guardrail-*` block (and only the scoped section rules) in `src/web/styles.css`
- **Regression, CI wiring and manual verification** — `.github/workflows/ci.yml` edit adding the new browser test to the single existing auth-enabled step

## Specification (from the initiative)

# Feature Specification: Fix and Modernize the Data Guardrails Page

**Scope**: bugfix

**Feature Branch**: `008-fix-guardrails-page`  
**Created**: 2026-09-24  
**Status**: Draft  
**Input**: User description: "fix the data guardrails page, it looks not aligned at all - modernize it"

## Problem Statement *(mandatory)*

The **Data guardrails** section of the Organization settings page (the place where an owner or admin chooses how secrets and personal data are kept from AI models, and which values are never masked) renders as a visibly broken layout. Controls, descriptive text and the save area do not line up with the card grid and spacing used by every other section of the same page, so the section reads as an unaligned, dated block rather than a first-class part of the page. The content itself works; its presentation does not.

This is a presentation defect, not a behaviour change. The goal is to restore a correctly aligned, visually consistent section so that a responsible administrator can scan the four modes, understand the trade-off, edit the "never mask" list and save without the layout getting in the way — with no change to what the guardrails actually do.

### Steps to Reproduce

1. Sign in as a team owner or admin.
2. Open **Organization** and choose the **Data guardrails** section (`/organization?section=guardrails`).
3. Observe the section: the mode options, the "never mask" list and the save action do not align to a consistent edge or grid with the surrounding card, and the visual treatment is out of step with the rest of the page.
4. Repeat at a narrow (mobile) viewport: content crowds, wraps unevenly or overflows.

### Expected vs Actual

- **Expected**: the section is visually indistinguishable in structure and spacing from other Organization sections — one consistent content column, aligned headings, controls and actions, readable line lengths, and a clean narrow-viewport layout. All four modes remain selectable, the never-mask list remains editable, and saving still persists the choice.
- **Actual**: the section is not aligned with the page's card grid; elements have inconsistent edges/spacing, the long mode descriptions are hard to scan, and the narrow-viewport layout degrades.

### The Fix

Bring the section back into the page's existing visual system so it is correctly aligned and modern: a consistent content grid for headings and rows, aligned mode options, a properly labelled and aligned never-mask field, and a save action placed consistently with other form sections — across desktop and narrow viewports — without changing any guardrail behaviour, labels, defaults, permissions, persistence or masking semantics.

### Regression Test

Add an automated UI check (browser/end-to-end) that loads the Data guardrails section at desktop and mobile widths and fails if the section's elements are not aligned to the page's content grid or if the section overflows horizontally. The same test must confirm that selecting a mode, editing the never-mask list and saving still round-trips the setting.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Read and change guardrails on a correctly laid-out section (Priority: P1)

As a team owner or admin, I want the Data guardrails section to be cleanly aligned and visually consistent with the rest of the Organization page, so that I can confidently read the four protection modes and change the organization's setting.

**Why this priority**: The section is the only place to control model data protection. A misaligned layout makes a security-relevant setting hard to read and trust; restoring the layout is the whole point of this bugfix.

**Independent Test**: Open `/organization?section=guardrails` as an owner/admin at desktop and mobile widths. Confirm every element aligns to the same content edges as other Organization sections and that mode selection and save still work end-to-end.

**Acceptance Scenarios**:

1. **Given** an owner or admin viewing Data guardrails at a desktop width, **When** the section renders, **Then** its heading, mode options, never-mask field and save action share consistent left/right content edges and spacing with the other Organization sections.
2. **Given** the same section, **When** the four protection modes are displayed, **Then** each mode's radio control and label text align to a single predictable column and the selected mode is visually obvious.
3. **Given** an owner/admin, **When** they select a different mode and save, **Then** the choice is persisted and reflected on reload, exactly as before this change.
4. **Given** a narrow (mobile) viewport, **When** the section renders, **Then** no element overflows horizontally, text wraps to the available width, and controls remain fully visible and usable.
5. **Given** a non-editor (member/viewer), **When** they view the section, **Then** it is aligned and readable and the edit controls remain disabled with the existing explanatory message.

### Edge Cases

- **Long mode descriptions**: the longest descriptions must not break alignment or cause wrapping that pushes the radio control out of column; line length stays readable.
- **Empty never-mask list**: hiding/clearing the list must leave the field and save action correctly aligned and the save action's enabled state correct.
- **Very long single-line allow entries**: input must not force horizontal overflow of the section.
- **Narrow viewport**: lists, labels and buttons must stack without clipping or scrollbar.
- **In-flight/disabled state**: while saving is in progress, disabled controls must remain aligned and the state change must not shift the layout.
- **Error and success messages**: showing a validation/error or success message must not break the alignment of surrounding elements.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The Data guardrails section MUST align to the same content grid, edges and spacing as the other sections of the Organization page, on desktop and narrow viewports.
- **FR-002**: The four protection modes MUST be presented so that each radio control and its label align consistently, and the currently selected mode is clearly distinguishable.
- **FR-003**: The "never mask" input MUST be presented with a clear label aligned to the section's content edge, with text wrapping/readability that does not force horizontal overflow.
- **FR-004**: The save action MUST be positioned consistently with save actions in other Organization form sections and MUST reflect the saved/unsaved/in-progress state without changing layout.
- **FR-005**: The section MUST remain fully readable and functional down to the narrowest supported viewport, with no horizontal overflow or clipped controls.
- **FR-006**: The section MUST preserve all existing guardrail behaviour: the same modes and labels, the same defaults, the same permission rules (owners/admins edit, others read), the same never-mask semantics, and the same persistence of saved settings.
- **FR-007**: The section MUST preserve existing accessibility semantics — mode choice exposed as a single-choice group with an accessible name, and labels associated with their inputs.
- **FR-008**: The change MUST NOT introduce any new user-facing capability or alter agent/masking behaviour.
- **FR-009**: An automated regression test MUST verify the section's alignment/no-overflow at desktop and mobile widths and the select-edit-save round-trip.

### Key Entities

- **Guardrail policy**: the organization's chosen protection mode and the list of values that are never masked. Readable by all members; editable only by owners/admins. (No change to this entity.)

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In an automated check at desktop and mobile widths, the Data guardrails section shows zero horizontal overflow and its heading, mode options, never-mask field and save action share the same content edges as the adjacent Organization sections.
- **SC-002**: An owner/admin can change the protection mode and save it in under 1 minute from opening the section, with the saved value present after reload.
- **SC-003**: All previously working guardrail behaviours — mode options, defaults, permissions and never-mask handling — continue to pass their existing tests with no regressions.
- **SC-004**: In a review of the section against the rest of the Organization page, no element is reported as visibly unaligned or inconsistent at either viewport width.

## Assumptions

- "Modernize" means bring the section into the page's existing visual system; it does not mean a product redesign or new controls, because the intent is scoped as a bugfix restoring correct presentation.
- The guardrail modes, labels, defaults, permissions and masking semantics are correct today and must not change; only the presentation is fixed.
- The section remains inside the Organization settings page under the existing "Data guardrails" navigation entry; no new page or route is introduced.
- Supported viewport range is the same as the rest of the application (existing responsive breakpoints).

## Dependencies

- The existing Organization page layout and shared visual system that the section must match.
- The existing guardrails API and permission behavior that the section reads from and writes to.

## Research Context

The repository research brief (`/.aidlc/research/brief.md`) predates this intent and concerns project responsibilities; its scope does not apply here. The one relevant finding it establishes is the repository boundary: the change belongs in `rayedbajwa/spaces` (the Bun/TypeScript app and its React web client), while this governance repository holds only Spec Kit artifacts.
