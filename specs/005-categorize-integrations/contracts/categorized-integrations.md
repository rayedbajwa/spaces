# Interface Contracts: Categorized Integrations

This document defines the interface contracts for the integration categorization module, component props, and API interaction models.

## 1. Domain Module Interface (`src/lib/integration-categories.ts`)

```typescript
import type { OAuthProviderId } from './oauth'
import type { AppIntegrationKind } from './app-integrations'

export type IntegrationCategoryId = 'source_control' | 'project_management' | 'communication'

export type CategoryReadinessState =
  | 'connected'
  | 'partial'
  | 'needs_reconnect'
  | 'configured_unconnected'
  | 'empty'

export interface IntegrationCategoryDefinition {
  readonly id: IntegrationCategoryId
  readonly label: string
  readonly description: string
  readonly emptyGuidance: string
  readonly providers: readonly OAuthProviderId[]
  readonly kinds: readonly AppIntegrationKind[]
}

export interface CategoryStatusSummary {
  readonly categoryId: IntegrationCategoryId
  readonly state: CategoryReadinessState
  readonly summaryBadge: string
  readonly badgeVariant: 'completed' | 'idle' | 'error'
  readonly totalProviders: number
  readonly configuredProviders: number
  readonly totalKinds: number
  readonly connectedKinds: number
  readonly reconnectNeededCount: number
}

export interface AppLike {
  provider: string
  configured: boolean
  kinds: string[]
}

export interface ConnectionLike {
  kind: string
  status: string
  credentialsOk?: boolean
}

/**
 * Ordered list of canonical integration categories.
 * Displayed in top-to-bottom order across all views.
 */
export const INTEGRATION_CATEGORIES: readonly IntegrationCategoryDefinition[]

/**
 * Returns the category definition for a given OAuth provider.
 * Throws or returns undefined if provider is unknown.
 */
export function getCategoryForProvider(provider: string): IntegrationCategoryDefinition | undefined

/**
 * Returns the category definition for a given integration kind.
 * Throws or returns undefined if kind is unknown.
 */
export function getCategoryForKind(kind: string): IntegrationCategoryDefinition | undefined

/**
 * Calculates health summary and badge text for a category based on the current
 * loaded OAuth apps and connection states.
 */
export function calculateCategoryStatus(
  category: IntegrationCategoryDefinition,
  apps: readonly AppLike[],
  connections: readonly ConnectionLike[],
): CategoryStatusSummary
```

---

## 2. UI Component Contract (`src/web/integrations.tsx`)

### Component: `IntegrationsPanel`

```typescript
export interface IntegrationsPanelProps {
  /** When true, renders inside an existing container without outer title / margins. */
  embedded?: boolean
  /** When true, renders in read-only mode for top-strip modal inspection without admin buttons. */
  readOnly?: boolean
}

export function IntegrationsPanel(props: IntegrationsPanelProps): JSX.Element
```

### Render Contract

1. **Category Ordering**:
   - The component MUST render categories in the exact order:
     1. Source Control (`source_control`)
     2. Project Management (`project_management`)
     3. Message Channels / Communication (`communication`)
2. **Category Section Markup**:
   - Each category MUST be wrapped in a `<section className="integration-category">`.
   - Header MUST display:
     - Title (`<h3>{category.label}</h3>`)
     - Category status badge (`<span className="mini-badge ...">`)
     - Descriptive blurb (`<p className="panel-subtitle">`)
3. **Empty State Display**:
   - When a category has zero configured apps and zero connections, it MUST render:
     - `<div className="integration-category-empty card">`
     - Clear narrative guidance (`category.emptyGuidance`)
     - In management mode (`readOnly === false`): Call to action buttons to set up available providers in that category
     - In read-only mode (`readOnly === true`): Subtle indicator that no tools are connected yet
4. **Provider Card Display**:
   - Each provider belonging to the category renders in `<section className="card integration ...">` within that category.
   - Multiprovider support: Atlassian displays both Jira and Confluence sub-items under Project Management.
5. **Interactive Controls Preservation**:
   - When `canManage = true`: App setup/edit forms, connect triggers, and disconnect confirmation dialogs MUST remain operational within their category cards.
   - When `readOnly = true`: All administrative mutating controls are omitted; only status labels and display names are rendered.

---

## 3. Top Navigation Status Contract (`src/web/shell.tsx`)

```typescript
export interface TopStripProps {
  integrationsConnected: number
  integrationsTotal: number
  onIntegrations: () => void
  attentionCount: number
  onToggleSidebar: () => void
  sidebarOpen: boolean
}
```

- Clicking the `.strip-chip` triggers `onIntegrations()`, opening the modal containing `<IntegrationsPanel readOnly />`.
- Global count format `Integrations X/Y` is retained on the top strip chip.

---

## 4. API Endpoints Contract (Backward-Compatible)

Existing backend HTTP endpoints remain unchanged in schema and response format:

### `GET /api/oauth-apps`
- **Auth**: Requires Org Admin
- **Response**: `200 OK` Array of `OAuthAppSummary`
- **Backward Compatibility**: Fully preserved.

### `GET /api/integrations`
- **Auth**: Requires Org Admin (for management) or authenticated user
- **Response**: `200 OK` Array of `AppIntegrationRow & { credentialsOk: boolean }`
- **Backward Compatibility**: Fully preserved.

### `DELETE /api/integrations/:kind`
- **Auth**: Requires Org Admin
- **Response**: `200 OK` `{ ok: true }`
- **Backward Compatibility**: Fully preserved.
