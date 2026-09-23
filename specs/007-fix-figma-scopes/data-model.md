# Data Model: Fix Invalid Figma OAuth Scopes

**Feature Branch**: `007-fix-figma-scopes`  
**Date**: 2026-09-23  
**Status**: No schema change  

## Summary

This feature changes **no persistent data model**. It corrects a static provider
template constant (the Figma OAuth scope list) in `src/lib/oauth.ts`.

## Entities impacted

None. The relevant persisted entity is `app_integrations` (Figma tokens stored in
`credentials_json`, encrypted via `crypto-vault.ts`), and it is **unchanged**:

- Existing Figma tokens (OAuth and PAT) remain valid — the scope list only affects
  authorization requests issued at connect time, not already-issued tokens.
- No new columns, tables, constraints, or migrations are required.

## In-memory/static model touched

| Field | Location | Before | After |
|-------|----------|--------|-------|
| `PROVIDER_TEMPLATES.figma.scopes` | `src/lib/oauth.ts` | `['current_user:read', 'file_content:read', 'library_assets:read']` | `['files:read']` |
| `PROVIDER_TEMPLATES.figma.notes` | `src/lib/oauth.ts` | "…Enable the read-only scopes current_user:read, file_content:read and library_assets:read…" | "…Enable the read-only scope files:read…" |

## Validation rules

- FR-001/FR-002/FR-003/FR-004: the `scopes` array MUST contain `files:read` and MUST
  NOT contain `current_user:read`, `file_content:read`, `file_variables:read`, or any
  deprecated `file_read` identifier.
- FR-005: `notes` MUST name `files:read` and MUST NOT advertise the removed scopes.

## State transitions

None. OAuth consent, token exchange, and integration `status`/`credentialsOk`
transitions in `app_integrations` are unchanged.