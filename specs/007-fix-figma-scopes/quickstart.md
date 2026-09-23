# Quickstart: Fix Invalid Figma OAuth Scopes

**Feature Branch**: `007-fix-figma-scopes`  
**Date**: 2026-09-23  

## What changed

The Figma OAuth provider template now requests the single valid read-only scope
`files:read` instead of three scopes (`current_user:read`, `file_content:read`,
`library_assets:read`), two of which Figma does not recognize. The administrator
guidance (`notes`) was updated to match.

## Verifying the change (in `rayedbajwa/spaces`)

```bash
cd /data/aidlc/workspaces/rayedbajwa/spaces

# Confirm the correction
grep -n "files:read\|current_user:read\|file_content:read\|library_assets:read" src/lib/oauth.ts

# Typecheck
bun run typecheck

# Run the OAuth + Figma unit tests (no DB required for these)
bun test tests/oauth.test.ts tests/figma-tools.test.ts tests/figma-api.test.ts
```

Expected: `src/lib/oauth.ts` shows `scopes: ['files:read']` and no longer lists the
removed identifiers; all tests pass.

## Manual OAuth flow (requires a configured Figma app and keys)

1. In Spaces → Organization → Integrations, configure the Figma OAuth app and click
   **Connect Figma**.
2. Confirm the browser address bar `scope=` parameter is exactly `files:read`.
3. Approve consent in Figma (it should present the consent screen rather than an
   "invalid scope" error), and confirm the card reports **Connected** with the account
   handle.

Per project memory, this live flow requires real Figma keys and is documented but not
run in CI; the automated unit test is the CI gate.