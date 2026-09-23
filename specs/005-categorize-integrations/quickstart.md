# Quickstart: Categorized Integrations

This guide explains how to view, manage, and extend categorized integrations in Spaces.

## Overview

Spaces groups all external SDLC integrations into three canonical categories:
1. **Source Control**: GitHub (repositories, code reviews, PR delivery)
2. **Project Management**: Jira, Linear, Confluence (issue tracking, initiatives, knowledge base)
3. **Message Channels / Communication**: Slack (notifications, stage summaries, approvals)

---

## Viewing and Managing Integrations

### 1. Organization Management View (Admin / Owners)
1. In the sidebar, navigate to **Organization** (`/organization`).
2. Select the **Integrations** tab.
3. Observe the three distinct category sections:
   - **Source Control**
   - **Project Management**
   - **Message Channels / Communication**
4. Each section provides:
   - A summary badge indicating health (`✓ Connected`, `1 of 2 connected`, `⚠ Reconnect needed`, or `Not connected`).
   - A descriptive blurb explaining the role of this category.
   - Provider cards for each tool in the category.
   - Setup actions (`Set up app`, `Manage app`), OAuth connection triggers, and disconnection controls.
5. If no tools in a category are connected, an empty-state guidance card explains what capabilities are missing and how to connect them.

### 2. Read-Only Status Modal (All Users)
1. From any page in Spaces, click the **Integrations** chip in the top navigation strip (e.g. `Integrations 2/4`).
2. The modal dialog opens, displaying the same three categories with read-only badges and connection details.
3. Administrative controls (such as secret editing or disconnect buttons) are hidden in this view.

---

## Code Architecture

### Key Files

- `src/lib/integration-categories.ts`:
  - Central domain taxonomy and mappings.
  - `INTEGRATION_CATEGORIES` list and `calculateCategoryStatus()` helper.
- `src/web/integrations.tsx`:
  - React UI implementation grouping cards by `INTEGRATION_CATEGORIES`.
  - Supports both management mode and `readOnly` modal mode.
- `src/web/styles.css`:
  - Category layout, section headers, badges, and empty-state styles.
- `tests/integration-categories.test.ts`:
  - Unit tests covering category completeness, mapping, and status calculations.

---

## Development & Verification Commands

Run unit tests:
```bash
bun test tests/integration-categories.test.ts
```

Run TypeScript type check:
```bash
bun run typecheck
```

Build the web frontend bundle:
```bash
bun run build:web
```

Run all tests:
```bash
bun test
```
