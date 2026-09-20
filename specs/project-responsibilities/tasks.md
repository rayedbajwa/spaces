# Tasks — project-responsibilities

Repository-local tasks for initiative **project-responsibilities** (Feature Specification: Project Responsibilities and Owner Fallback). Planning lives in the governing workspace; this file is what this repository owns. Tick items as they land; the pipeline commits it with the code.

## Domain, Migration, and Owner Safety Foundation
- [ ] **Task IDs**: T004–T009; T001–T003 are prerequisite reconciliation and fixture tasks.
- [ ] Verify or complete standard responsibility seeding at project creation and
- [ ] idempotent access/explicit repair for legacy projects (FR-001–004, FR-016).
- [ ] Verify or complete ordered multi-assignee persistence, active-member
- [ ] validation, deterministic primary selection, and resolution precedence
- [ ] (FR-005–010).
- [ ] Verify or complete atomic final-Owner protection, member-deactivation cleanup,
- [ ] audit evidence, and cross-team/project reassignment behavior (FR-011, FR-014,
- [ ] FR-019).
- [ ] Add unit and PostgreSQL-backed integration/concurrency tests for this domain.
- [ ] **Proposed sub-agent assignment**: Domain and persistence engineer.

**Scoped files**
Allowed implementation paths after tasks are generated:

- `src/lib/project-responsibilities.ts`
- `src/lib/project-registry.ts`
- `src/lib/db.ts`
- `src/lib/db-schema.sql`
- `tests/project-responsibilities.test.ts`
- New focused domain/database tests under `tests/`

Do **not** modify `src/server.ts`, `src/web/`, worker/pipeline files, or docs in
this workstream unless the approved task list explicitly reassigns ownership.

**Outputs**
- Stable responsibility resolution and mutation contract.
- Idempotent schema/repair behavior with a documented repair-needed state.
- PostgreSQL-backed test fixtures and passing domain/migration/concurrency tests.
- A merge-ready contract summary for API, workflow, and UI workstreams.

**Depends on**
- **Blocked by**: T001–T003 source attribution and fixture setup.
- **Must complete before**: Workstreams 2, 3, and 4 implement against the
  domain contract.
- **Merge checkpoint A**: A single integration owner merges the domain/schema
  change and runs the focused unit plus PostgreSQL integration suite before
  releasing the resolved contract to parallel workstreams.

**QA focus**
- Standard-role uniqueness and seed/repair idempotency.
- Creator-preferred Owner selection and deterministic eligible-member fallback.
- Explicit → Owner fallback → unresolved precedence.
- Final-Owner replacement/removal under concurrent PostgreSQL transactions.
- No duplicated assignments or unchanged-state audit events after repeated repair.
## Responsibility API and Authorization Boundary
- [ ] **Task IDs**: T010–T016, with T012 and T014 explicitly parallelizable.
- [ ] Expose the stable responsibility state and authorized management operations
- [ ] using the domain contract (FR-012, FR-015, FR-019).
- [ ] Enforce owner/admin mutation, member read, and viewer/non-member/cross-tenant
- [ ] denial without mutating team/project access (FR-012, FR-013).
- [ ] Validate active owning-team membership, malformed input, invalid identities,
- [ ] and final-Owner failure responses without partial writes (FR-010, FR-011).
- [ ] Add API/security tests and update the API reference contract.
- [ ] **Proposed sub-agent assignment**: API and application-security engineer.

**Scoped files**
Allowed implementation paths after tasks are generated:

- `src/server.ts`
- `src/lib/auth.ts` only where required for existing authorization integration
- `docs/reference/api.md`
- Focused API/security tests under `tests/`

Do **not** modify `src/lib/project-responsibilities.ts`, schema files, web UI,
or worker/pipeline files. Report domain-contract changes to the integration owner
instead of editing outside scope.

**Outputs**
- Authorized read/mutation/repair operations with deterministic response states.
- Negative authorization and tenant-isolation test coverage.
- Updated API documentation aligned with actual response/error behavior.

**Depends on**
- **Blocked by**: Merge checkpoint A.
- **Can run in parallel with**: Workstream 3 and, after its read contract is
  stable, Workstream 4.
- **Merge checkpoint B**: API contract tests and authorization matrix must pass
  before UI-management flows are merged or browser tests are finalized.

**QA focus**
- Owner/admin/member/viewer/non-member/cross-organization matrix.
- No access change after responsibility mutation.
- No partial writes for invalid assignee, malformed body, or final-Owner removal.
- No cross-team or cross-tenant responsibility disclosure.
## Workflow Context and Review-Gate Preservation
- [ ] **Task IDs**: T020–T023, with T022 explicitly parallelizable.
- [ ] Inject advisory responsibility context using the approved mapping: Specify/
- [ ] review → Product Owner; plan/implement → Lead Engineer; design → Designer;
- [ ] verify → QA; release/delivery → Release Manager; escalation/fallback → Owner.
- [ ] Use explicit assignees first, Owner fallback second, and repair-needed when
- [ ] unresolved (FR-017, FR-018).
- [ ] Preserve existing human review gates and approval permissions.
- [ ] Add workflow/context regression tests for explicit, fallback, multiple-assignee,
- [ ] and unresolved cases.
- [ ] **Proposed sub-agent assignment**: Workflow and agent-context engineer.

**Scoped files**
Allowed implementation paths after tasks are generated:

- `src/worker.ts`
- `src/lib/pipeline-engine.ts`
- `src/lib/context-builder.ts`
- Related stage/review files identified by `plan.md`
- Focused workflow tests under `tests/`
- `docs/concepts/agents-and-workers.md`
- `docs/concepts/pipelines-and-stages.md`

Do **not** modify responsibility schema/domain logic, HTTP routes, or web UI.

**Outputs**
- Advisory responsibility context at the intended stage/review boundaries.
- No implicit authorization or approval behavior change.
- Workflow-context and review-gate regression test evidence.

**Depends on**
- **Blocked by**: Merge checkpoint A and a finalized list of consuming stages in
  `plan.md`.
- **Can run in parallel with**: Workstream 2.
- **Merge checkpoint C**: Integration owner validates context output with the
  existing review harness before merging with UI/browser work.

**QA focus**
- Stage-to-responsibility mapping and primary-assignee ordering.
- Explicit-before-fallback resolution.
- Repair-needed instead of arbitrary routing.
- Human-gate and approval behavior unchanged.
## Project Management UI and User Guidance
- [ ] **Task IDs**: T024–T027, with T026 explicitly parallelizable.
- [ ] Provide owner/admin assignment management using the approved API contract.
- [ ] Display responsibility name, ordered assignees, primary assignee, and explicit,
- [ ] Owner fallback, or repair-needed status (FR-015, FR-020).
- [ ] Keep assignment management distinct from access-role management in copy and
- [ ] interaction behavior (FR-013, FR-020).
- [ ] Provide an authorized repair flow and denied/readonly states for other roles.
- [ ] Add browser E2E coverage and supporting UI documentation.
- [ ] **Proposed sub-agent assignment**: Web UI and accessibility engineer.

**Scoped files**
Allowed implementation paths after tasks are generated:

- `src/web/main.tsx`
- `src/web/styles.css`
- `src/web/team-page.tsx` only if project/team navigation requires it
- Browser E2E tests and fixtures under `tests/` or repository-established E2E
  locations
- User-facing concept documentation under `docs/concepts/`

Do **not** modify server routes, domain/schema logic, or worker/pipeline code.

**Outputs**
- Usable project responsibility management and read states.
- Clearly differentiated explicit, fallback, and repair-needed presentation.
- Browser evidence for management, repair, readonly, and denied paths.

**Depends on**
- **Blocked by**: Merge checkpoint A for displayed resolution semantics; Merge
  checkpoint B for mutation contract and errors.
- **Can run in parallel with**: Workstream 3 after Merge checkpoint B.
- **Merge checkpoint D**: Browser smoke/E2E tests pass against the merged API
  and domain behavior before release-candidate regression.

**QA focus**
- Primary/back-up ordering after save/reload.
- Explicit, Owner fallback, unresolved, invalid-member, and repair states.
- Owner/admin edit versus member readonly versus viewer/non-member denial.
- Accessibility of state labels and controls; no access-role side effect.
- Capture browser evidence for status and repair-required states.
