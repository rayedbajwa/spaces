# Quickstart: Figma Integration, MCP Tooling, and Design System Knowledge Base

**Feature Branch**: `006-figma-integration`  
**Date**: 2026-09-23  

This guide walks through configuring the Figma integration, ingesting design system files into the Spaces Knowledge Base, and utilizing agent design inspection tools in AIDLC workflows.

---

## 1. Prerequisites

1. Spaces server running with PostgreSQL.
2. A Figma account with access to team design files or design systems.
3. A Figma Personal Access Token (PAT) or OAuth Application credentials:
   - To generate a PAT: In Figma, click your profile icon → **Settings** → **Personal access tokens** → **Generate new token**. Select `File content` (`read`) and `Variables` (`read`) scopes.

---

## 2. Connecting Figma in Spaces

1. Open Spaces in your browser (e.g. `http://localhost:3000`).
2. Navigate to **Organization** → **Integrations**.
3. Locate the **Design & Prototyping** category.
4. Click **Configure** on the **Figma** card:
   - **Method A (PAT)**: Select "Personal Access Token", paste your token, and click **Connect**.
   - **Method B (OAuth)**: Provide your OAuth Client ID and Secret registered in Figma's developer console, then click **Connect with Figma**.
5. Once connected, the card status will turn green (**Connected**) displaying your Figma account name/handle.

---

## 3. Ingesting Design Systems into the Knowledge Base

1. In the navigation sidebar, click **Knowledge**.
2. Click **New Source** and choose **Figma Design System**.
3. Provide a recognizable label, e.g. `Core Design System`.
4. Enter your Figma file URL (e.g., `https://www.figma.com/design/Vf123Abc456/Acme-Design-System`).
5. Select the extraction options:
   - [x] **Extract Design Tokens** (Colors, Typography, Elevation)
   - [x] **Extract Components & Variants**
6. Click **Save & Sync**.
7. Observe the sync progress. Once finished, search the knowledge base for queries like:
   - `"primary button variants"`
   - `"brand color palette"`
   - `"typography heading scale"`
   Verify that hits return formatted Markdown definitions with direct deep links to Figma nodes.

---

## 4. Agent Inspection in AIDLC Workflows

When working on a feature with UI requirements:
1. Mention the Figma frame or component URL in your feature spec, prompt, or task (e.g. `https://www.figma.com/design/Vf123Abc456/Acme-Design-System?node-id=45-102`).
2. The autonomous agent automatically detects the design link and calls `figma_inspect_node`.
3. The tool retrieves:
   - Exact layout constraints (Flexbox direction, spacing, padding, alignments).
   - Exact CSS typography (font family, weight, size, line-height).
   - Fill colors, stroke borders, corner radii, and component variants.
4. The agent writes UI implementation code (e.g. React/CSS) directly matching the design tokens without visual guesswork.

---

## 5. Review Gates & Design Verification

1. When a feature reaches the `verify` or review gate stage, any linked Figma designs appear as primary design artifacts.
2. The **Designer** and **Lead Engineer** review gates present the linked Figma node alongside an automated design system compliance summary.

---

## 6. Development & Test Commands

From the `rayedbajwa/spaces` repository checkout:

```bash
# Run unit & integration tests for Figma tools and categories
bun test tests/integration-categories.test.ts
bun test tests/figma-tools.test.ts
bun test tests/knowledge-connectors.test.ts

# Run TypeScript type check
bun run typecheck

# Build the frontend web bundle
bun run build:web
```
