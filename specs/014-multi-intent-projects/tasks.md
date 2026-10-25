# Tasks — 014-multi-intent-projects

Repository-local tasks for initiative **014-multi-intent-projects** (Feature Specification: Scale to Multiple Intents per Project). Planning lives in the governing workspace; this file is what this repository owns. Tick items as they land; the pipeline commits it with the code.

## Foundational Evidence Base
- [x] T002 [P] Gather current-behaviour evidence for the one-active-intent constraint and per-project execution bound, read-only (FR-003), in `spaces:src/lib/db-schema.sql`
- [ ] per-project execution bound (FR-003)
- [x] T003 [P] Gather evidence for current intent selection and sync, read-only (FR-003), in `spaces:src/lib/intent-store.ts`, `spaces:src/lib/active-feature.ts`, `spaces:src/lib/features.ts`
- [x] T004 [P] Gather evidence for admission, scheduling, per-project locking and worker capacity, read-only (FR-003), in `spaces:src/lib/dispatcher.ts`, `spaces:src/lib/job-queue.ts`, `spaces:src/lib/worker-slots.ts`, `spaces:src/lib/worker-registry.ts`
- [ ] capacity (FR-003)
- [x] T005 [P] Gather evidence for gate, approval and notification routing, read-only (FR-003), in `spaces:src/lib/approval-notify.ts`, `spaces:src/lib/approval-store.ts`, `spaces:src/lib/slack-gate-prompts.ts`
- [x] T006 [P] Gather evidence for delivery and merge ordering, read-only (FR-003), in `spaces:src/lib/delivery.ts`, `spaces:src/lib/release-gate.ts`, `spaces:src/lib/pull-requests.ts`
- [x] T007 [P] Gather evidence for observability, audit and cost, read-only (FR-003, FR-011), in `spaces:src/lib/intent-store.ts`, `spaces:src/lib/run-usage.ts`, `spaces:tests/`, `spaces:docs/concepts/intents.md`

**Scoped files**
- **May read:** the `spaces` paths listed in T002–T007 only.
- **May modify:** none. No write to `spaces` or `governance`. `spaces` git status
  must remain clean.

**Outputs**
- Three structured **evidence notes** (not repo files), each a list of
  `spaces:<path>:<line> → claim → dimension(s) served (D1…D8)` entries
- One `unverified` list per sub-agent for claims that cannot be confirmed (FR-017)

**Depends on**
- None. This is the foundational phase; it gates US1 authoring (T011–T013).
- WS2 may run concurrently (different file, different repository).

**QA focus**
- TP-003 evidence resolution: every emitted `spaces:<path>[:line]` must resolve.
- TP-007 current-behaviour fidelity: the one-active-intent constraint,
  per-project execution bound, project-scoped gates and delivery ordering each
  need a citable location.
- TP-020: any unconfirmed claim is marked `unverified` and handed to the coverage
  note; never asserted as fact.

---
