# Research: Fix Invalid Figma OAuth Scopes

**Feature Branch**: `007-fix-figma-scopes`  
**Date**: 2026-09-23  
**Status**: Completed  

## Overview

This document resolves the single technical unknown behind the bug — what the
correct Figma OAuth scope identifiers actually are — and confirms the minimal,
safe fix.

## 1. What are valid Figma OAuth scopes?

### Decision
The Figma OAuth authorization request must use **only `files:read`**.

### Rationale
- The current provider template requests `files:read` alongside the Enterprise-only
  `file_variables:read` scope. `file_variables:read` requires a Figma Enterprise
  plan, so on standard plans Figma rejects the consent request with a "scope not
  valid" error regardless of app-side scope enablement.
- The `006-figma-integration` implementation (`git show 79fac3c:src/lib/oauth.ts`)
  recorded the scopes as `['files:read', 'file_variables:read']`. The fix removes the
  Enterprise-only `file_variables:read`, leaving only the read-only `files:read`.
- `files:read` is the canonical read-only scope that authorizes reading file contents,
  nodes, published styles (`/v1/files/:key/styles`), and published components
  (`/v1/files/:key/components`, `/component_sets`) — exactly the read-only tools
  shipped in `006-figma-integration` (`src/lib/figma-tools.ts` and the Figma knowledge
  connector `importFigma`).
- Identity verification via `GET /v1/me` is not gated by a granular scope; any valid
  OAuth token (including one scoped to `files:read`) can call it. So `files:read`
  alone covers identity verification too, and no "identity" scope is needed.

### Alternatives considered
- **Keep `file_variables:read` alongside `files:read`**: rejected. `file_variables:read`
  is Enterprise-only; requiring it would block standard-plan Figma accounts from
  connecting (spec FR-004). It is also unnecessary for the shipped read tools, which
  read styles/components rather than variable collections as a hard dependency.
- **Use the legacy alias `file_read`**: rejected. `file_read` is deprecated; the spec's
  edge cases explicitly forbid requesting deprecated identifiers (spec FR-002 directs
  `files:read`).
- **Add back any other scope (e.g. a library/assets scope)**: rejected as
  unnecessary. The implemented read tools (`figma_get_file_styles`,
  `figma_get_components`, `importFigma`) hit file-level endpoints
  (`/v1/files/:key/styles`, `/components`, `/component_sets`) already covered by
  `files:read`; no code path calls any team/organization *library* endpoint. The
  `006-figma-integration` plan only ever intended `files:read` (+ optional
  `file_variables:read`). Restricting to `files:read` alone narrows to least
  privilege and matches FR-002.

## 2. Where the change lives

### Decision
Edit the `figma` entry in `PROVIDER_TEMPLATES` in `src/lib/oauth.ts`, and add a unit
test in `tests/oauth.test.ts`.

### Rationale
- `PROVIDER_TEMPLATES.figma` is the single source of truth for both the `scopes`
  array (used by `beginAuthorization` to build the `scope=` query parameter) and the
  `notes` string (surfaced in the Integrations UI by `ManualCredentials` in
  `src/web/integrations.tsx`). Correcting one place fixes both the authorization URL
  and the administrator-facing guidance.
- A `grep` across the repo confirms `files:read` and `file_variables:read` appear in
  product code only in `src/lib/oauth.ts` (other hits are `specs/006-*` artifacts).
  No docs, schema, or UI hardcode the scope names other than echoing
  `app.scopes`/`app.notes`.

### Alternatives considered
- **Per-plan whitelisting in `beginAuthorization`**: rejected — special-casing a
  provider in the generic helper adds complexity for no benefit; the provider template
  is the correct place for provider-specific scope concerns.
- **A data-driven scope map/migration**: rejected — scopes are static provider
  metadata, not persisted application state; no migration is warranted (spec FR-006
  and the absence of any schema dependency confirm this).

## 3. Data migration / rollback

### Decision
No database change; no migration.

### Rationale
- The scope list applies only to the authorization URL generated at connect time.
  Existing connected Figma tokens (OAuth and PAT) are stored in
  `app_integrations.credentials_json` and are unaffected by a scope-name correction
  on future authorization requests.
- Rollback is a source revert of the one changed line; there is no data to repair.

## Summary of decisions

| Area | Decision | Key justification |
|------|----------|-------------------|
| Scope set | `['files:read']` only | Canonical read-only scope covering styles/components/files; the removed `file_variables:read` scope is Enterprise-only |
| Edit site | `PROVIDER_TEMPLATES.figma` in `src/lib/oauth.ts` | Single source of truth for scope + admin guidance |
| Migration | None | Static provider metadata; existing tokens unaffected |
| Test | `tests/oauth.test.ts` unit test | Asserts corrected scope set and guidance (FR-001…FR-005) |