# Interface Contracts: Figma Integration, MCP Tooling, and Design System Knowledge Base

**Feature Branch**: `006-figma-integration`  
**Date**: 2026-09-23  
**Status**: Completed  

---

## 1. REST API Contracts (`src/server.ts`)

### 1.1 Verify Figma Credentials
- **Endpoint**: `POST /api/integrations/figma/verify`
- **Auth**: Organization Admin / Owner session (`requireOrgAdmin`)
- **Request Body** (optional, when testing unsaved token):
  ```json
  {
    "token": "figd_personal_access_token_xyz"
  }
  ```
- **Success Response (200 OK)**:
  ```json
  {
    "ok": true,
    "user": {
      "id": "10492810",
      "handle": "sarah_designer",
      "email": "sarah@example.com"
    }
  }
  ```
- **Failure Response (400 / 401)**:
  ```json
  {
    "ok": false,
    "error": "Figma rejected credentials (401 Unauthorized): Invalid token or revoked access."
  }
  ```

---

### 1.2 Connect Personal Access Token (PAT)
- **Endpoint**: `POST /api/integrations/figma/token`
- **Auth**: Organization Admin / Owner session (`requireOrgAdmin`)
- **Request Body**:
  ```json
  {
    "token": "figd_personal_access_token_xyz",
    "displayName": "Figma (Acme Design Team)"
  }
  ```
- **Success Response (200 OK)**:
  ```json
  {
    "ok": true,
    "integration": {
      "kind": "figma",
      "status": "connected",
      "displayName": "Figma (sarah@example.com)",
      "credentialsOk": true,
      "lastSyncedAt": "2026-09-23T14:32:00.000Z"
    }
  }
  ```

---

### 1.3 Knowledge Catalog & File Validation
- **Endpoint**: `POST /api/knowledge/sources/validate`
- **Request Body**:
  ```json
  {
    "kind": "figma",
    "config": {
      "fileUrls": ["https://www.figma.com/design/Vf123Abc456/Acme-Design-System"],
      "extractTokens": true,
      "extractComponents": true
    }
  }
  ```
- **Success Response (200 OK)**:
  ```json
  {
    "valid": true,
    "resolvedFiles": [
      {
        "fileKey": "Vf123Abc456",
        "name": "Acme-Design-System",
        "accessible": true
      }
    ]
  }
  ```

---

## 2. Autonomous Agent Tools Contract (`src/lib/figma-tools.ts`)

Tools exposed to Pi Coding Agent SDK sessions during AIDLC stages when Figma is connected.

### 2.1 `figma_inspect_node`

Inspects a specific Figma frame, component, or node, returning layout geometry, flexbox attributes, styling tokens, and child structure.

- **Name**: `figma_inspect_node`
- **Parameters**:
  ```json
  {
    "type": "object",
    "properties": {
      "url": {
        "type": "string",
        "description": "Figma file or node URL, e.g. https://www.figma.com/design/:fileKey/:title?node-id=10-25"
      },
      "fileKey": {
        "type": "string",
        "description": "Figma file key (if URL is not provided)"
      },
      "nodeId": {
        "type": "string",
        "description": "Figma node ID, e.g. 10:25 or 10-25"
      },
      "depth": {
        "type": "integer",
        "minimum": 1,
        "maximum": 4,
        "default": 2,
        "description": "Hierarchy traversal depth"
      }
    }
  }
  ```
- **Return Contract**:
  ```text
  Frame: "Checkout Modal" (Type: FRAME, Bounds: 600x480)
  Auto-Layout: VERTICAL, Gap: 16px, Padding: [T:24px, R:24px, B:24px, L:24px]
  Fills: #FFFFFF (Solid, 100%)
  Strokes: #E2E8F0 (1px)
  Corner Radius: 12px

  Children:
  1. Header (FRAME) - Layout: HORIZONTAL, Space-Between
     - Title: "Order Summary" (Font: Inter SemiBold 18px / 24px, Color: #0F172A)
     - CloseButton (INSTANCE) - Size: 24x24
  2. Content (FRAME) - Layout: VERTICAL, Gap: 12px
     ...
  3. Actions (FRAME) - Layout: HORIZONTAL, Align: End, Gap: 8px
     - CancelButton (INSTANCE) - "Cancel"
     - ConfirmButton (INSTANCE) - "Complete Purchase" (Background: #2563EB)
  ```

---

### 2.2 `figma_get_file_styles`

Retrieves design tokens (color palettes, text styles, elevation effects) declared in a Figma file.

- **Name**: `figma_get_file_styles`
- **Parameters**:
  ```json
  {
    "type": "object",
    "properties": {
      "url": { "type": "string", "description": "Figma file URL" },
      "fileKey": { "type": "string", "description": "Figma file key" }
    }
  }
  ```
- **Return Contract**:
  ```text
  Color Styles:
  - brand/primary: #2563EB
  - brand/secondary: #64748B
  - semantic/success: #16A34A
  - semantic/danger: #DC2626
  - neutral/surface: #FFFFFF
  - neutral/background: #F8FAFC

  Text Styles:
  - Heading/H1: Inter Bold 32px (line-height: 40px)
  - Heading/H2: Inter SemiBold 24px (line-height: 32px)
  - Body/Regular: Inter Regular 14px (line-height: 20px)
  - Caption: Inter Medium 12px (line-height: 16px)

  Elevation Styles:
  - shadow/sm: 0 1px 2px rgba(0,0,0,0.05)
  - shadow/md: 0 4px 6px -1px rgba(0,0,0,0.1)
  ```

---

### 2.3 `figma_get_components`

Retrieves published components and component set variants from a Figma file.

- **Name**: `figma_get_components`
- **Parameters**:
  ```json
  {
    "type": "object",
    "properties": {
      "url": { "type": "string", "description": "Figma file URL" },
      "fileKey": { "type": "string", "description": "Figma file key" }
    }
  }
  ```
- **Return Contract**:
  ```text
  Components in Acme Design System:
  1. Component: Button (Component Set)
     Variants:
     - Intent: Primary, Secondary, Danger, Ghost
     - Size: Sm, Md, Lg
     - State: Default, Hover, Active, Disabled
     Description: Core clickable button element conforming to WCAG 2.1 AA.
     Node Link: https://www.figma.com/design/Vf123Abc456?node-id=10:100

  2. Component: TextInput
     Variants:
     - Size: Sm, Md
     - State: Empty, Filled, Focused, Error
     Description: Single line text entry with optional leading icon and helper text.
     Node Link: https://www.figma.com/design/Vf123Abc456?node-id=20:50
  ```

---

## 3. Knowledge Connector Interface Contract (`src/lib/knowledge-connectors.ts`)

```typescript
export async function importFigma(source: KnowledgeSourceRow): Promise<SyncBatch>
export function validateSourceConfig(kind: 'figma', config: Record<string, unknown>): string | undefined
```

- Input config:
  - `fileKeys`: string array, extracted from input `fileUrls` or entered directly.
  - `extractTokens`: boolean (default `true`)
  - `extractComponents`: boolean (default `true`)
- Batch results:
  - `documents`: array of `KnowledgeDocumentInput` representing design tokens, component families, and style catalogs.
  - `cursor`: `{ fileVersions: Record<string, string>, lastModified: string }`
  - `complete`: true when all target files have been processed.
  - `hasMore`: false when finished.
