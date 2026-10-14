# Feature Specification: Fix Log Display Opening at the Bottom — delta for rayedbajwa/spaces

Initiative: `013-fix-log-open-bottom` · Change: `013-fix-log-open-bottom` · Repository: `github.com/rayedbajwa/spaces`

## Scope in this repository

- **Baseline and Log-Seeding Harness** — Green `typecheck` + `agent-bar` baseline captured before any edit.
- **Open-at-Bottom Regression Suite** — All ten cases B1–B10 added to the existing dock suite, keyed to FR-001…FR-006 and SC-001…SC-004.
- **Dock Reveal Fix** — Reveal-keyed + pending-flag layout effects in `AiAgentOutputBar`; `behavior: 'instant'` so CSS `scroll-behavior: smooth` cannot animate the open.
- **Cross-Cutting Verification** — Clean `build:web` bundle.
- **Delivery and Deployed Acceptance** — Open, CI-green, reviewed and merged PR in `rayedbajwa/spaces`.

## Specification (from the initiative)

# Feature Specification: Fix Log Display Opening at the Bottom

**Scope**: bugfix

**Feature Branch**: `013-fix-log-open-bottom`  
**Created**: 2026-10-14  
**Status**: Draft  
**Input**: User description: "fix the log display, buffer should always open at the bottom (Source: jira:KAN-2)"

## Problem Statement *(mandatory)*

The live agent-output panel ("log display") shows a run's streamed log. When the
panel is opened it should reveal the most recent output, i.e. it should open
scrolled to the bottom of the buffer. Today it does not always do so: the panel
only follows the bottom while a run is actively streaming, so in the common
cases where the panel is opened at another moment it shows stale, older output
and the reader must scroll down manually.

**Steps to reproduce**

1. Start or open a run whose agent output panel is collapsed or not currently
   auto-following.
2. Let output accumulate, or let the run finish.
3. Open (or re-open) the log display.

**Expected**: the log display opens with the newest line visible at the bottom.

**Actual**: the log display opens at the top of the buffer, or at a previous
scroll position, hiding the latest output.

**Intended outcome**: opening the buffer always lands at the bottom — the
newest output — regardless of the run's state (streaming, paused, completed,
failed) and regardless of where the reader had scrolled before. This restores
the panel's core promise that the newest agent output is what you see first.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Log buffer opens at the newest output (Priority: P1)

As a user watching a feature run, when I open the agent-output buffer I want it
to start at the bottom so I immediately see the latest output without scrolling.

**Why this priority**: This is the entire defect. Every other behaviour of the
panel is secondary to the buffer presenting the current output when opened.

**Independent Test**: Open the log display in each of the run states (streaming,
paused, completed, failed) with pre-existing output and confirm the newest line
is visible at the bottom on every open.

**Acceptance Scenarios**:

1. **Given** a run that has already produced output and is no longer streaming,
   **When** the log display is opened, **Then** it is scrolled to the bottom and
   the newest line is visible.
2. **Given** a completed (or failed) run with output, **When** the log display is
   opened, **Then** it is scrolled to the bottom and the newest line is visible.
3. **Given** the log display was previously scrolled up by the reader, **When**
   the reader collapses and re-opens it, **Then** it opens at the bottom again
   rather than restoring the old scroll position.
4. **Given** a streaming run, **When** the log display opens and new output
   arrives, **Then** it remains at the bottom and continues to follow the newest
   line.

### Edge Cases

- **No output yet**: An empty or "warming up" buffer must not error; when the
  first output arrives while open, it is shown at the bottom.
- **Very short buffer**: When the content is shorter than the visible area there
  is nothing to scroll; the panel must not appear broken or jump unexpectedly.
- **Reader intentionally scrolls up**: After the buffer is open, a reader who
  scrolls up to inspect history must be able to stay there while the run streams,
  with the existing "new output below" cue; merely opening the buffer is what
  forces the bottom.
- **Run switched while open**: Opening or switching to a different run shows that
  run's newest output at the bottom, not a stale position from the prior run.
- **Re-open after pause requiring input**: When a pause/question re-opens the
  buffer, it still lands at the bottom of the newest output.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Opening the log display MUST position the buffer at its bottom end,
  showing the most recent output, for every run state (streaming, paused,
  completed, failed, idle-with-history).
- **FR-002**: The bottom positioning MUST occur on each open, including re-opening
  after the reader has collapsed the panel, and MUST NOT restore a previously
  left scroll position.
- **FR-003**: Immediately after opening, a streaming run MUST remain following
  new output at the bottom automatically.
- **FR-004**: While the buffer is open, a reader MAY scroll up to read earlier
  output; that scroll position MUST be honoured until the reader returns to the
  bottom or re-opens the buffer.
- **FR-005**: Opening or switching to a different run MUST show that run's newest
  output at the bottom, unaffected by the prior run's scroll position.
- **FR-006**: The fix MUST NOT change the panel's other behaviour — collapse/expand,
  the scroll-to-top and scroll-to-bottom controls, the "new output below" cue,
  pause/resume/cancel controls, or how log content is rendered.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In 100% of opens across all run states, the newest log line is
  visible at the bottom immediately after opening, with no manual scrolling.
- **SC-002**: A reader who has scrolled up in a prior viewing sees the newest
  output, not the old position, on the next open (0 occurrences of a stale
  opening position in regression testing).
- **SC-003**: A reader can still scroll up to read history while a run streams,
  and follow-to-bottom resumes when they scroll back down or re-open.
- **SC-004**: No new defect is introduced: collapse/expand, manual scroll
  controls and run controls behave exactly as before the change.

## Dependencies

- No external systems, services or cross-repository contracts are involved; the
  fix is contained within the existing agent-output log display.

## Assumptions

- "Open" means the log display transitions from collapsed/hidden to visible, or
  is first shown for a run; it is the act of revealing the buffer, not every
  render while it is already visible.
- The intended behaviour is to show the newest output; preserving a manual
  scroll position while the panel stays open is desirable and out of scope to
  change.
- The log buffer is the agent-output panel on the project board; no other log or
  console view is in scope.
- A regression test covering the open-at-bottom behaviour in the applicable test
  layer is part of this fix.
