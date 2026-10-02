# Tasks — 009-aidlc-improvement-research

Repository-local tasks for initiative **009-aidlc-improvement-research** (Feature Specification: AIDLC Improvement Research). Planning lives in the governing workspace; this file is what this repository owns. Tick items as they land; the pipeline commits it with the code.

## Spaces read-only evidence baseline and scope confirmation
- [x] T001 Confirm branch `009-aidlc-improvement-research` is checked out in `/data/aidlc/workspaces/_governance/spaces-3f701200` and the read-only evidence checkout is clean (`git -C /data/aidlc/workspaces/rayedbajwa/spaces status --short`), capturing its HEAD SHA for T005 (FR-011, SC-006)
- [x] T005 [US1] Write the Header (including the evidence baseline SHA captured in T001), Scope & Assumptions and Coverage matrix sections in `specs/009-aidlc-improvement-research/findings.md`, naming the time-box, evidence standard and the lifecycle/platform area set (FR-001, FR-014; contract §1–3)
- [x] T030 [spaces] Confirm no delivery action is needed in `rayedbajwa/spaces`: the feature makes no product change, the branch has no commits ahead of `main` and `git status` is clean (FR-011, SC-006)
- [x] T010 [US2] Resolve every candidate's Evidence entry against the `rayedbajwa/spaces` and `governance` checkouts and correct the `repo:path[:line]` values in `specs/009-aidlc-improvement-research/findings.md` (FR-004, SC-002)
- [x] T011 [US2] Mark any evidence that cannot be confirmed within the time-box `Status: unverified` and list it for the Coverage Note in `specs/009-aidlc-improvement-research/findings.md` (FR-013; spec Edge Cases)
- [ ] evidence against the checkout and report missing/unsupported paths to the spine.

**Scoped files**
- May modify: **none** — this workstream is strictly read-only.
- Explicitly forbidden: any file under `/data/aidlc/workspaces/rayedbajwa/spaces`
  (FR-011, SC-006; contract §Boundaries).

**Outputs**
- Evidence baseline: `HEAD` SHA + clean `git status --short`, handed to the spine
  for the T005 header.
- Evidence-resolution report (per candidate: resolves / missing), consumed by the
  spine for T010/T011 but **not committed** to `spaces`.
- T030 confirmation that the branch has no commits ahead of `main` and the tree
  is clean.
- **Merge checkpoint**: the SHA/clean-state evidence is required before T005 and
  before T024; the T030 confirmation is required before T029/T030 sign-off. No
  commit or branch is created in `spaces`.

**Depends on**
- T001/T030 have no dependency on governance work; they can run at any time.
- The evidence-resolution support depends on T009 (inventory frozen).
- Blocks none of the spine except the T005 header value.

**QA focus**
- `git status --short` in `spaces` must stay empty before and after the
  workstream; a dirty tree is a blocker, not a warning.
- Path existence is the enforced invariant; line numbers are informative only
  (research R2).
- Report unverified candidates to the spine; do not silently drop or "correct"
  them.

---
