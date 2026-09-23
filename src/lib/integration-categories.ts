import type { OAuthProviderId } from './oauth'
import type { AppIntegrationKind } from './app-integrations'

export type IntegrationCategoryId = 'source_control' | 'project_management' | 'design' | 'communication'

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

export const INTEGRATION_CATEGORIES: readonly IntegrationCategoryDefinition[] = [
  {
    id: 'source_control',
    label: 'Source Control',
    description: 'Repository catalog, cloning, branch synchronization, pull request generation, and Git sign-in.',
    emptyGuidance: 'Connect source control so autonomous agents can clone repositories, inspect codebase structure, and deliver verified pull requests.',
    providers: ['github'],
    kinds: ['github'],
  },
  {
    id: 'project_management',
    label: 'Project Management',
    description: 'Issue tracking, sprint planning, project initiatives, and specification documents for agent context and knowledge base ingestion.',
    emptyGuidance: 'Connect project management tools to link specs with active issues, sync initiatives, and ingest product knowledge.',
    providers: ['atlassian', 'linear'],
    kinds: ['jira', 'confluence', 'linear'],
  },
  {
    id: 'design',
    label: 'Design & Prototyping',
    description: 'Figma files, design tokens, style definitions, and component libraries for agent visual inspection and knowledge base ingestion.',
    emptyGuidance: 'Connect Figma so autonomous agents can inspect design mockups, extract layout tokens, and match components to design specs.',
    providers: ['figma'],
    kinds: ['figma'],
  },
  {
    id: 'communication',
    label: 'Message Channels / Communication',
    description: 'Dedicated channels per project (#spaces-<code>) with run progress, verification summaries, and human-in-the-loop review alerts.',
    emptyGuidance: 'Connect message channels to receive stage updates, review notifications, and pipeline approval gates directly in your team\'s chat.',
    providers: ['slack'],
    kinds: ['slack'],
  },
] as const

const PROVIDER_TO_CATEGORY = new Map<string, IntegrationCategoryDefinition>()
const KIND_TO_CATEGORY = new Map<string, IntegrationCategoryDefinition>()

for (const cat of INTEGRATION_CATEGORIES) {
  for (const provider of cat.providers) {
    PROVIDER_TO_CATEGORY.set(provider, cat)
  }
  for (const kind of cat.kinds) {
    KIND_TO_CATEGORY.set(kind, cat)
  }
}

export function getCategoryForProvider(provider: string): IntegrationCategoryDefinition | undefined {
  if (!provider) return undefined
  return PROVIDER_TO_CATEGORY.get(provider)
}

export function getCategoryForKind(kind: string): IntegrationCategoryDefinition | undefined {
  if (!kind) return undefined
  return KIND_TO_CATEGORY.get(kind)
}

export function calculateCategoryStatus(
  category: IntegrationCategoryDefinition,
  apps: readonly AppLike[],
  connections: readonly ConnectionLike[],
): CategoryStatusSummary {
  const categoryProviders = new Set(category.providers)
  const categoryKinds = new Set(category.kinds)

  const configuredProviders = apps.filter(
    (app) => categoryProviders.has(app.provider as OAuthProviderId) && app.configured
  ).length

  const relevantConns = connections.filter((c) => categoryKinds.has(c.kind as AppIntegrationKind))

  const reconnectNeededCount = relevantConns.filter((c) => c.credentialsOk === false).length
  const connectedKinds = relevantConns.filter(
    (c) => c.status === 'connected' && c.credentialsOk !== false
  ).length

  let state: CategoryReadinessState
  let summaryBadge: string
  let badgeVariant: 'completed' | 'idle' | 'error'

  if (reconnectNeededCount > 0) {
    state = 'needs_reconnect'
    summaryBadge = 'Reconnect needed'
    badgeVariant = 'error'
  } else if (connectedKinds > 0 && connectedKinds === category.kinds.length) {
    state = 'connected'
    summaryBadge = 'Connected'
    badgeVariant = 'completed'
  } else if (connectedKinds > 0) {
    state = 'partial'
    summaryBadge = `${connectedKinds} connected`
    badgeVariant = 'completed'
  } else if (configuredProviders > 0) {
    state = 'configured_unconnected'
    summaryBadge = 'App set up'
    badgeVariant = 'idle'
  } else {
    state = 'empty'
    summaryBadge = 'Not connected'
    badgeVariant = 'idle'
  }

  return {
    categoryId: category.id,
    state,
    summaryBadge,
    badgeVariant,
    totalProviders: category.providers.length,
    configuredProviders,
    totalKinds: category.kinds.length,
    connectedKinds,
    reconnectNeededCount,
  }
}
