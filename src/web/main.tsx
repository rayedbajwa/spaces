import { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { marked } from 'marked'
import { AuthRoot, navigate, useAuth } from './auth'
import { AppSidebar, PageHead, SearchBox, TopStrip, type ArchivedCardSummary } from './shell'
import { NewRepoCard, type NewRepositoryProposal } from './new-repo'
import { ProjectUsagePanel, UsageChip, formatUsd, type UsageSummary } from './usage'
import { TeamPage } from './team-page'
import { OrgPage } from './org-page'
import { IntegrationsPanel } from './integrations'
import { stepForColumn, isEligibleDrop } from '../lib/board-drop'
import './styles.css'

/** Human-readable tab names (the tab ids double as URL/state keys). */
const TAB_LABELS: Record<string, string> = {
  overview: 'Overview',
  specs: 'Specs',
  testplan: 'Test plan',
  implementation: 'Implementation',
  qa: 'QA',
  assistant: 'Assistant',
  context: 'Context',
  memory: 'Memory',
  promotions: 'Lessons',
  tracker: 'Tracker',
}

/**
 * Markdown → HTML for assistant answers. `marked` does not sanitise, so strip
 * the few things that could execute: script/style/iframe blocks, inline event
 * handlers and javascript: URLs.
 */
function renderMarkdown(text: string): string {
  const html = marked.parse(text ?? '', { async: false, gfm: true, breaks: true }) as string
  return html
    .replace(/<(script|style|iframe|object|embed)[\s\S]*?<\/\1>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1="#"')
}

/** Messages that report a failure get the red toast treatment. */
function isErrorMessage(message: string): boolean {
  return /^(could not|cannot|can't|error|failed|.*failed:|wizard failed|clone retry failed|disconnect failed)/i.test(message.trim())
}

type RunStatus = 'running' | 'paused' | 'completed' | 'error' | 'cancelled'
type PauseKind = 'clarification' | 'review' | 'user'
type TimelineStatus = 'running' | 'paused' | 'completed' | 'error'
type TimelineKind = 'run' | 'stage' | 'review' | 'input'
type BoardStatus = 'backlog' | 'initialized' | 'specified' | 'planned' | 'tasked' | 'implementing' | 'done'
type ProjectModalTab = 'overview' | 'specs' | 'testplan' | 'implementation' | 'qa' | 'assistant' | 'context' | 'memory' | 'promotions' | 'tracker'

type TimelineEntry = {
  id: string
  kind: TimelineKind
  stage?: string
  title: string
  detail?: string
  status: TimelineStatus
  createdAt: string
}

type RunSnapshot = {
  runId: string
  projectNamespace: string
  projectLabel: string
  projectPath: string
  feature?: string
  pipeline?: string
  stages: string[]
  reviewHarness: boolean
  humanInLoop: boolean
  status: RunStatus
  stage?: string
  pauseKind?: PauseKind
  log: string
  usage?: UsageSummary
  executiveSummary?: string
  timeline: TimelineEntry[]
  sessionFile?: string
  resumable?: boolean
  error?: string
  interrupted?: boolean
  queued?: boolean
  rerunnable?: boolean
  retryCount?: number
  createdAt: string
  updatedAt: string
}

type DryRunResponse = {
  status: 'dry-run'
  plan: unknown
}

type CreateRunResponse = RunSnapshot | DryRunResponse | { error: string }

type BoardArtifactLink = {
  label: string
  stepLabel: string
  href: string
  relativePath: string
  contentHash?: string
}

type ArtifactDiffEntry = {
  id: string
  relativePath: string
  label: string
  stepLabel: string
  change: 'added' | 'updated' | 'removed'
  previousHash?: string
  currentHash?: string
  createdAt: string
}

type BoardCard = {
  projectNamespace: string
  projectLabel: string
  projectPath: string
  status: BoardStatus
  verificationStatus: 'pass' | 'partial' | 'fail' | 'missing'
  currentAgent: string
  estimate: string
  gateReadiness: GateReadiness[]
  usage?: UsageSummary
  automationState?: {
    state: 'idle' | 'running' | 'needs_approval' | 'needs_clarification' | 'error' | 'blocked' | 'completed'
    message: string
    currentStage?: string
    assistantPrompt?: string
    actionLabel?: string
    updatedAt: string
  }
  updatedAt: string
  feature?: string
  latestRun?: {
    runId: string
    status: RunStatus
    stage?: string
  }
  recommendedAction?: {
    step: string
    label: string
    tab: ProjectModalTab
    reason: string
  }
  artifactLinks: BoardArtifactLink[]
  archivedAt?: string
  pausedAt?: string
  /** Readable code (PLAT-12); also the page URL /spaces/PLAT-12. */
  code?: string
  artifactDiffs: ArtifactDiffEntry[]
  statusOverride?: BoardStatus
}

type BoardColumn = {
  id: BoardStatus
  title: string
  cards: BoardCard[]
}

type BoardResponse = {
  columns: BoardColumn[]
  archivedCount?: number
}

type ProjectMemoryResponse = {
  namespace: string
  projectLabel: string
  text: string
  manualText: string
  autoSummary: string
  updatedAt?: string
}

type ContextBundle = {
  projectNamespace: string
  projectPath: string
  org: Record<string, string>
  project: {
    memory: string
    manualMemory: string
    autoSummary: string
    sources: Array<{ source: string; title: string; fetchedAt: string }>
  }
  featureArtifacts: Array<{ label: string; path: string; content: string }>
  sourceSnapshots: Array<{ source: string; title: string; entityType: string; fetchedAt: string; content: string }>
  promptBundle: string
}

type PromotionProposal = {
  id: string
  projectNamespace: string
  title: string
  content: string
  targetFile: string
  status: 'pending' | 'approved' | 'rejected'
  createdAt: string
  decidedAt?: string
  decisionNotes?: string
}

type QAArtifactPreview = {
  label: string
  path: string
  exists: boolean
  content?: string
}

type SubAgentResult = {
  workstream: string
  outputFile: string
  summary: string
  log: string
  runtimeMs: number
  estimatedTokens: number
}

type SubagentWorkstreamStatus = {
  workstream: string
  status: 'running' | 'completed' | 'error'
  summary?: string
  log?: string
  outputFile?: string
  runtimeMs?: number
  estimatedTokens?: number
  branch?: string
  baseBranch?: string
  pullRequestUrl?: string
}

type SubagentJobSnapshot = {
  projectNamespace: string
  status: 'idle' | 'running' | 'completed' | 'error'
  featureDir?: string
  workstreams: SubagentWorkstreamStatus[]
  startedAt?: string
  completedAt?: string
  updatedAt: string
  error?: string
}

type QAOverview = {
  featureDir?: string
  verificationPassed: boolean
  verificationStatus: 'pass' | 'partial' | 'fail' | 'missing'
  artifacts: QAArtifactPreview[]
  subagents: SubAgentResult[]
  currentJob: SubagentJobSnapshot
  jobHistory: SubagentJobSnapshot[]
}

type ProjectBootstrapResponse = {
  projectNamespace: string
  projectLabel: string
  projectPath: string
  created: boolean
  initializedGit: boolean
}

type WizardRepoDraft = {
  id: string
  label: string
  kind: 'local' | 'github'
  localPath: string
  githubRepo: string
  isPrimary: boolean
}

type RepoCloneStatus = 'pending' | 'cloning' | 'ready' | 'error'

type ProjectRepoRecord = {
  repoId: string
  label: string
  kind: 'local' | 'github'
  localPath?: string
  githubRepo?: string
  isPrimary: boolean
  cloneStatus?: RepoCloneStatus
  cloneError?: string
}

type DeletionPreview = {
  allowed: boolean
  archived: boolean
  confirmPhrase: string
  activity: { active: boolean; reasons: string[] }
  runs: number
  jobs: number
  snapshots: number
  repos: Array<{ label: string; kind: string; localPath: string | null; githubRepo: string | null; action: 'delete-clone' | 'delete-workspace' | 'keep-shared' | 'keep-local' | 'none' }>
}

type ProjectDetailRecord = {
  projectId: string
  slug: string
  name: string
  repos: ProjectRepoRecord[]
  code?: string | null
  archivedAt?: string | null
  pausedAt?: string | null
  integrations: Array<{ integrationId: string; kind: string; status: string; displayName?: string }>
  suggestionsJson?: {
    generatedAt: string
    basis: 'project' | 'plan'
    repositories: Array<{ fullName: string; reason: string; confidence: string; role: string; registered: boolean }>
    workAreas: Array<{ name: string; description: string; repositories: string[]; paths: string[]; risks?: string }>
    notes?: string
    newRepository?: NewRepositoryProposal
  } | null
}

type KnowledgeHit = {
  source: 'jira' | 'linear' | 'confluence' | 'github'
  id: string
  title: string
  url?: string
  snippet?: string
  type?: string
  status?: string
  updatedAt?: string
}

const KNOWLEDGE_SOURCE_LABEL: Record<KnowledgeHit['source'], string> = { jira: 'Jira', linear: 'Linear', confluence: 'Confluence', github: 'GitHub' }

type GitHubRepoOption = {
  fullName: string
  description?: string
  private: boolean
  defaultBranch?: string
}

type OnboardingStep = {
  id: 'clone' | 'init' | 'sync' | 'learn' | 'memory' | 'suggest' | 'setup'
  label: string
  hints: string[]
  status: 'pending' | 'active' | 'done' | 'skipped' | 'error'
  detail?: string
}

type OnboardingSnapshot = {
  projectId: string
  status: 'idle' | 'running' | 'ready' | 'error'
  steps: OnboardingStep[]
  runnable: boolean
  error?: string
}

const CLONE_STATUS_LABEL: Record<RepoCloneStatus, string> = {
  pending: 'clone queued',
  cloning: 'cloning…',
  ready: 'cloned',
  error: 'clone failed',
}

type WizardIntegrationDraft = {
  kind: 'github' | 'jira' | 'confluence'
  enabled: boolean
  displayName: string
}

type WizardState = {
  step: 1 | 2 | 3 | 4
  name: string
  description: string
  repos: WizardRepoDraft[]
  integrations: WizardIntegrationDraft[]
  firstFeature: string
  planContext: string
  model: string
  thinking: string
  pipelineName: string
}

type ChatEntry = {
  role: 'user' | 'assistant'
  content: string
  createdAt?: string
  kind?: 'chat' | 'input' | 'review' | 'agent'
  runId?: string
  sessionFile?: string
  relatedStages?: string[]
  relatedArtifacts?: Array<{ label: string; path: string; excerpt?: string }>
}

type TaskTrackerItem = {
  id: string
  parallel: boolean
  story?: string
  description: string
  raw: string
  group: string
  checked: boolean
  status: 'todo' | 'in_progress' | 'done' | 'blocked'
  note?: string
  lastRunReport?: string
  updatedAt: string
}

type GateReadiness = {
  stage: string
  tab: ProjectModalTab | 'qa' | 'assistant' | 'specs' | 'testplan' | 'implementation'
  color: 'green' | 'yellow' | 'red'
  reason: string
}

function newRepoDraft(isPrimary = false): WizardRepoDraft {
  return {
    id: `repo-${Math.random().toString(36).slice(2, 9)}`,
    label: '',
    kind: 'local',
    localPath: '',
    githubRepo: '',
    isPrimary,
  }
}

const INTEGRATION_KINDS = ['github', 'jira', 'confluence', 'slack', 'linear'] as const

const defaultWizard: WizardState = {
  step: 1,
  name: '',
  description: '',
  repos: [newRepoDraft(true)],
  integrations: [
    { kind: 'github', enabled: false, displayName: '' },
    { kind: 'jira', enabled: false, displayName: '' },
    { kind: 'confluence', enabled: false, displayName: '' },
  ],
  firstFeature: '',
  planContext: '',
  model: '', // empty = the server's default model (DEFAULT_MODEL / first configured provider)
  thinking: '',
  pipelineName: 'aidlc-classic',
}

function App() {
  const { me, refresh: refreshMe } = useAuth()
  // Undefined (older payload) counts as ready so the UI never blocks by mistake; the server still refuses.
  const modelsReady = me?.modelsReady !== false
  const serverDefaultModel = me?.defaultModel ? `auto: ${me.defaultModel}` : 'auto (organization routing)'
  const [board, setBoard] = useState<BoardResponse>({ columns: [] })
  const [selectedCard, setSelectedCard] = useState<BoardCard | null>(null)
  const [isProjectModalOpen, setIsProjectModalOpen] = useState(false)
  const [activeProjectTab, setActiveProjectTab] = useState<ProjectModalTab>('overview')
  // Themed modal for stage-input prompts (feature/constitution/checklistDomain).
  // Set to a request object with a resolver Promise; the modal renders and
  // calls resolve(value|null) on submit/cancel. Replaces window.prompt().
  const [stageInputPrompt, setStageInputPrompt] = useState<{
    title: string
    label: string
    placeholder: string
    resolve: (value: string | null) => void
  } | null>(null)

  function promptForStageInput(field: 'feature' | 'constitution' | 'checklistDomain'): Promise<string | null> {
    const config = {
      feature: {
        title: 'Feature to specify',
        label: 'Describe the feature the AI should specify.',
        placeholder: 'e.g. "Add reusable signing templates so users can share configs across projects."',
      },
      constitution: {
        title: 'Constitution statement',
        label: 'The guiding principles for this project.',
        placeholder: 'e.g. "Every change must ship with a test. No breaking changes without a migration path."',
      },
      checklistDomain: {
        title: 'Checklist domain',
        label: 'Which area should the checklist cover?',
        placeholder: 'e.g. "auth", "billing", "release readiness"',
      },
    }[field]
    return new Promise((resolve) => {
      setStageInputPrompt({ ...config, resolve })
    })
  }
  const [wizard, setWizard] = useState<WizardState>(defaultWizard)
  const [isWizardOpen, setIsWizardOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [statusMessage, setStatusMessage] = useState('')
  // Team settings page (/teams/<slug>) replaces the board while open.
  const [teamPageSlug, setTeamPageSlug] = useState<string | null>(null)
  const [orgPageOpen, setOrgPageOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [boardQuery, setBoardQuery] = useState('')
  const archivedCardsRef = useRef<BoardCard[]>([])
  // Archived projects live in a dropdown, never on the board itself.
  const [boardView, setBoardView] = useState<'board' | 'list'>(() => {
    try { return window.localStorage.getItem('spaces:boardView') === 'list' ? 'list' : 'board' } catch { return 'board' }
  })
  useEffect(() => { try { window.localStorage.setItem('spaces:boardView', boardView) } catch { /* ignore */ } }, [boardView])
  // Non-error status messages fade out on their own; errors stay until dismissed.
  useEffect(() => {
    if (!statusMessage || isErrorMessage(statusMessage)) return
    const timer = window.setTimeout(() => setStatusMessage(''), 7000)
    return () => window.clearTimeout(timer)
  }, [statusMessage])
  const [currentRun, setCurrentRun] = useState<RunSnapshot | null>(null)
  const [projectMemory, setProjectMemory] = useState('')
  const [autoMemorySummary, setAutoMemorySummary] = useState('')
  const [memoryStatus, setMemoryStatus] = useState('No project selected.')
  const [sharedContext, setSharedContext] = useState<ContextBundle | null>(null)
  const [qaOverview, setQaOverview] = useState<QAOverview | null>(null)
  const [promotions, setPromotions] = useState<PromotionProposal[]>([])
  const [promotionTitle, setPromotionTitle] = useState('')
  const [promotionContent, setPromotionContent] = useState('')
  const [estimateInput, setEstimateInput] = useState('')
  const [chatInput, setChatInput] = useState('')
  const [chatEntries, setChatEntries] = useState<ChatEntry[]>([])
  const [chatSearch, setChatSearch] = useState('')
  const [chatKindFilter, setChatKindFilter] = useState<'all' | 'chat' | 'input' | 'review' | 'agent'>('all')
  const [clarification, setClarification] = useState('')
  const [taskTrackerItems, setTaskTrackerItems] = useState<TaskTrackerItem[]>([])
  const [taskGraph, setTaskGraph] = useState<{ nodes: Array<{ id: string; label: string; phase: string; story?: string; parallel: boolean; status: string }>; edges: Array<{ from: string; to: string }> }>({ nodes: [], edges: [] })
  const [orchestrator, setOrchestrator] = useState<{ autonomousMode: boolean; maxConcurrent: number; speedMode?: 'fast' | 'balanced' | 'quality' } | null>(null)
  const [projectJobs, setProjectJobs] = useState<Array<{ jobId: string; kind: string; status: string; displayStatus: string; runStage?: string; runPauseKind?: string; runError?: string; runPipeline?: string; triggerSource: string; runId?: string; createdAt: string }>>([])
  const [projectAgents, setProjectAgents] = useState<Array<{ agentId: string; role: string; status: string; lastUsedAt?: string }>>([])
  const [inspectedRun, setInspectedRun] = useState<RunSnapshot | null>(null)
  const [projectDetail, setProjectDetail] = useState<ProjectDetailRecord | null>(null)
  // Delete-project flow: preview of what goes, then a typed "delete" confirmation.
  const [deletion, setDeletion] = useState<{ open: boolean; loading: boolean; preview: DeletionPreview | null; confirm: string; busy: boolean; error: string }>({ open: false, loading: false, preview: null, confirm: '', busy: false, error: '' })
  const [githubRepos, setGithubRepos] = useState<GitHubRepoOption[] | null>(null)
  const [githubReposNote, setGithubReposNote] = useState('')
  const [onboarding, setOnboarding] = useState<{ projectName: string; snapshot: OnboardingSnapshot } | null>(null)
  const [onboardingHintIndex, setOnboardingHintIndex] = useState(0)
  // After onboarding: suggested repositories/work areas to review before the first run.
  type WizardSuggestions = NonNullable<ProjectDetailRecord['suggestionsJson']>
  const [onboardingReview, setOnboardingReview] = useState<{ projectId: string; suggestions: WizardSuggestions; adding: string[]; resolve: () => void } | null>(null)

  /** Register a suggested repo on the just-created project (clone starts in the background). */
  async function addSuggestedRepo(projectId: string, fullName: string) {
    setOnboardingReview((c) => c ? { ...c, adding: [...c.adding, fullName] } : c)
    try {
      await postJson(`/api/projects/${projectId}/repos`, { label: fullName.split('/')[1] ?? fullName, kind: 'github', githubRepo: fullName, isPrimary: false })
      setOnboardingReview((c) => c ? { ...c, suggestions: { ...c.suggestions, repositories: c.suggestions.repositories.map((r) => r.fullName === fullName ? { ...r, registered: true } : r) } } : c)
    } catch (error) {
      setStatusMessage(`Could not add ${fullName}: ${toMessage(error)}`)
    } finally {
      setOnboardingReview((c) => c ? { ...c, adding: c.adding.filter((n) => n !== fullName) } : c)
    }
  }
  // "Import from Jira / Linear" in the wizard: search state + items to attach after creation.
  const [importSearch, setImportSearch] = useState<{ source: 'jira' | 'linear' | 'confluence' | 'github'; query: string; results: KnowledgeHit[]; loading: boolean; note: string }>({ source: 'linear', query: '', results: [], loading: false, note: '' })
  const [importedItems, setImportedItems] = useState<Array<{ source: 'jira' | 'linear' | 'confluence' | 'github'; id: string; title: string; url?: string }>>([])
  const [knowledgeSources, setKnowledgeSources] = useState<string[]>([])

  // Per-project knowledge scope (Context tab): which integrations/repos this project's agents may query.
  const [knowledgeScope, setKnowledgeScope] = useState<{
    config: { sources?: KnowledgeHit['source'][]; jira?: { projects?: string[] }; linear?: { teams?: string[]; projects?: string[] }; confluence?: { spaces?: string[] }; github?: { repos?: string[] } }
    connected: KnowledgeHit['source'][]
    registeredRepos: string[]
    effective?: { sources: string[] }
  } | null>(null)
  const [knowledgeScopeBusy, setKnowledgeScopeBusy] = useState(false)
  // Worker serving the open project (per-project supervisor or the shared worker).
  const [projectWorker, setProjectWorker] = useState<{ state: 'hot' | 'warm' | 'stale' | 'shared' | 'none'; sharedWorkers: number; worker: { workerId: string; pid?: number; activeJobs: number; pausedRuns: number; lastHeartbeatAt: string } | null } | null>(null)

  // Repositories the current plan says the feature touches (from plan.md "## Repositories"),
  // matched against registered repos so missing ones can be added in one click.
  type PlanRepo = { name: string; note: string; flaggedUnregistered: boolean; githubRepo?: string; registered: boolean; repoId?: string; cloneStatus?: string }
  const [planRepos, setPlanRepos] = useState<PlanRepo[]>([])
  const [repoForm, setRepoForm] = useState<{ open: boolean; kind: 'github' | 'local'; label: string; githubRepo: string; localPath: string; busy: boolean; note: string }>({ open: false, kind: 'github', label: '', githubRepo: '', localPath: '', busy: false, note: '' })

  async function loadPlanRepos(namespace: string) {
    try {
      const payload = await getJson<{ repositories: PlanRepo[] }>(`/api/projects/${namespace}/plan-repos`)
      setPlanRepos(payload.repositories ?? [])
    } catch { setPlanRepos([]) }
  }

  async function refreshProjectRepos() {
    if (!projectDetail) return
    try {
      const detail = await getJson<ProjectDetailRecord>(`/api/projects/${projectDetail.projectId}`)
      setProjectDetail(detail)
    } catch { /* keep current */ }
    if (selectedProjectNamespace) await loadPlanRepos(selectedProjectNamespace)
  }

  /** Register a repo on the open project; GitHub repos start cloning immediately. */
  async function addProjectRepo(input: { kind: 'github' | 'local'; label: string; githubRepo?: string; localPath?: string }) {
    if (!projectDetail) return
    setRepoForm((c) => ({ ...c, busy: true, note: '' }))
    try {
      await postJson(`/api/projects/${projectDetail.projectId}/repos`, {
        label: input.label.trim() || (input.githubRepo?.split('/')[1] ?? input.localPath?.split('/').pop() ?? 'repo'),
        kind: input.kind,
        githubRepo: input.kind === 'github' ? input.githubRepo?.trim() : undefined,
        localPath: input.kind === 'local' ? input.localPath?.trim() : undefined,
        isPrimary: false,
      })
      setRepoForm({ open: false, kind: 'github', label: '', githubRepo: '', localPath: '', busy: false, note: '' })
      setStatusMessage(`Added repository ${input.githubRepo ?? input.localPath}${input.kind === 'github' ? ' — cloning in the background.' : '.'}`)
      await refreshProjectRepos()
    } catch (error) {
      setRepoForm((c) => ({ ...c, busy: false, note: `Could not add repository: ${toMessage(error)}` }))
    }
  }

  async function updateProjectRepo(repo: ProjectRepoRecord, patch: { label?: string; githubRepo?: string; localPath?: string; isPrimary?: boolean }) {
    if (!projectDetail) return
    try {
      await fetch(`/api/projects/${projectDetail.projectId}/repos/${repo.repoId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
      await refreshProjectRepos()
    } catch (error) {
      setStatusMessage(`Could not update repository: ${toMessage(error)}`)
    }
  }

  async function loadProjectWorker(projectId: string) {
    try {
      setProjectWorker(await getJson<NonNullable<typeof projectWorker>>(`/api/projects/${projectId}/worker`))
    } catch { setProjectWorker(null) }
  }
  const [knowledgeScopeNote, setKnowledgeScopeNote] = useState('')

  async function loadProjectKnowledge(projectId: string) {
    try {
      setKnowledgeScope(await getJson<NonNullable<typeof knowledgeScope>>(`/api/projects/${projectId}/knowledge`))
    } catch { setKnowledgeScope(null) }
  }

  async function saveProjectKnowledge() {
    if (!projectDetail || !knowledgeScope) return
    setKnowledgeScopeBusy(true)
    try {
      const response = await fetch(`/api/projects/${projectDetail.projectId}/knowledge`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(knowledgeScope.config),
      })
      const payload = await response.json() as { config: NonNullable<typeof knowledgeScope>['config']; effective: { sources: string[] }; error?: string }
      if (payload.error) throw new Error(payload.error)
      setKnowledgeScope((c) => c ? { ...c, config: payload.config, effective: payload.effective } : c)
      setKnowledgeScopeNote(`Saved. Agents on this project can now query: ${payload.effective.sources.length ? payload.effective.sources.map((s) => KNOWLEDGE_SOURCE_LABEL[s as KnowledgeHit['source']]).join(', ') : 'nothing (no sources selected)'}.`)
      if (selectedProjectNamespace) void loadProjectContext(selectedProjectNamespace)
    } catch (error) {
      setKnowledgeScopeNote(`Could not save: ${toMessage(error)}`)
    } finally {
      setKnowledgeScopeBusy(false)
    }
  }

  function setScopeList(path: 'jira.projects' | 'linear.teams' | 'linear.projects' | 'confluence.spaces' | 'github.repos', raw: string) {
    const list = raw.split(',').map((v) => v.trim()).filter(Boolean)
    setKnowledgeScope((c) => {
      if (!c) return c
      const [group, key] = path.split('.') as ['jira' | 'linear' | 'confluence' | 'github', string]
      return { ...c, config: { ...c.config, [group]: { ...(c.config[group] ?? {}), [key]: list } } }
    })
  }

  async function loadKnowledgeSources() {
    try {
      const payload = await getJson<{ sources: string[] }>('/api/knowledge/sources')
      setKnowledgeSources(payload.sources)
    } catch { setKnowledgeSources([]) }
  }

  async function runImportSearch() {
    const query = importSearch.query.trim()
    if (!query) return
    setImportSearch((c) => ({ ...c, loading: true, note: '' }))
    try {
      const response = await fetch(`/api/knowledge/search?source=${importSearch.source}&q=${encodeURIComponent(query)}&limit=10`)
      const payload = await response.json() as { hits: KnowledgeHit[]; error?: string }
      setImportSearch((c) => ({ ...c, loading: false, results: payload.hits ?? [], note: payload.error ?? (payload.hits?.length ? '' : 'No matches.') }))
    } catch (error) {
      setImportSearch((c) => ({ ...c, loading: false, results: [], note: toMessage(error) }))
    }
  }

  /** Pull one ticket/doc into the wizard: fills name/description/first feature and queues it as a project source. */
  async function useImportedItem(hit: KnowledgeHit) {
    setImportSearch((c) => ({ ...c, loading: true }))
    try {
      const response = await fetch(`/api/knowledge/item?source=${hit.source}&id=${encodeURIComponent(hit.id)}`)
      const doc = await response.json() as { title: string; content: string; url?: string; error?: string }
      if (doc.error) throw new Error(doc.error)
      const body = doc.content.replace(/^# .*\n/, '').trim()
      setWizard((c) => ({
        ...c,
        name: c.name.trim() || doc.title,
        description: c.description.trim() || body.slice(0, 1500),
        firstFeature: c.firstFeature.trim() || `${hit.id}: ${doc.title}\n\n${body.slice(0, 2500)}`,
      }))
      setImportedItems((c) => c.some((i) => i.source === hit.source && i.id === hit.id) ? c : [...c, { source: hit.source, id: hit.id, title: doc.title, url: doc.url }])
      setImportSearch((c) => ({ ...c, loading: false, note: `Imported ${hit.id}. It will be attached to the project as a knowledge source.` }))
    } catch (error) {
      setImportSearch((c) => ({ ...c, loading: false, note: `Import failed: ${toMessage(error)}` }))
    }
  }

  // Rotate the active onboarding step's sub-messages while it runs.
  useEffect(() => {
    if (!onboarding || onboarding.snapshot.status !== 'running') return
    const timer = setInterval(() => setOnboardingHintIndex((i) => i + 1), 2200)
    return () => clearInterval(timer)
  }, [onboarding?.snapshot.status])
  const [appIntegrations, setAppIntegrations] = useState<Array<{ kind: string; status: string; displayName?: string; updatedAt: string; credentialsOk?: boolean }>>([])
  const [isIntegrationsModalOpen, setIsIntegrationsModalOpen] = useState(false)
  const connectedIntegrationCount = INTEGRATION_KINDS.reduce(
    (n, kind) => n + (appIntegrations.some((i) => i.kind === kind && i.status === 'connected') ? 1 : 0),
    0,
  )
  const allIntegrationsConnected = connectedIntegrationCount === INTEGRATION_KINDS.length
  const [clarifyForm, setClarifyForm] = useState({ boardItem: '', repoPath: '', runtime: '', storage: '', notification: '', testFramework: '', extra: '' })
  const [draggedProjectNamespace, setDraggedProjectNamespace] = useState('')
  // Full card of the currently-dragged project so drop targets can inspect
  // its recommendedAction to decide whether this lane is a legal destination.
  // Cleared on dragEnd regardless of whether the drop was accepted.
  const [draggedCard, setDraggedCard] = useState<BoardCard | null>(null)
  const [memoryBusy, setMemoryBusy] = useState(false)
  const [qaBusy, setQaBusy] = useState(false)
  const [promotionBusy, setPromotionBusy] = useState(false)
  const runEventSourceRef = useRef<EventSource | null>(null)
  // Tracks which runId the SSE is currently subscribed to. Used to detect
  // when we switch projects/runs so we can close the old stream — without
  // this, opening a project that has no active run leaves the previous
  // project's live SSE writing into currentRun (cross-project log leak).
  const connectedRunIdRef = useRef<string | null>(null)
  const subagentEventSourceRef = useRef<EventSource | null>(null)

  function disconnectRunEvents(): void {
    runEventSourceRef.current?.close()
    runEventSourceRef.current = null
    connectedRunIdRef.current = null
  }

  const selectedProjectNamespace = selectedCard?.projectNamespace
  const canAnswer = currentRun?.status === 'paused' && currentRun?.resumable !== false

  useEffect(() => {
    void refreshBoard()
    void loadAppIntegrations()
    return () => {
      disconnectRunEvents()
      subagentEventSourceRef.current?.close()
    }
  }, [])

  // Auto-refresh the board every 10s while the tab is visible. Skips when
  // hidden (e.g. background tab) to avoid wasted requests, and refreshes
  // immediately on visibility-change so re-focusing catches up quickly.
  useEffect(() => {
    const REFRESH_MS = 10_000
    let interval: ReturnType<typeof setInterval> | undefined
    function start() {
      if (interval) return
      interval = setInterval(() => { void refreshBoard() }, REFRESH_MS)
    }
    function stop() {
      if (interval) { clearInterval(interval); interval = undefined }
    }
    function onVisibility() {
      if (document.hidden) {
        stop()
      } else {
        void refreshBoard()
        start()
      }
    }
    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      stop()
    }
  }, [])

  // Auto-poll latest-run + jobs every 10s while a project modal is open.
  // Catches missed SSE updates, discovers externally-triggered runs, and
  // clears stale currentRun stubs when the actual run moves on.
  useEffect(() => {
    if (!isProjectModalOpen || !selectedProjectNamespace) return
    const namespace = selectedProjectNamespace
    const interval = setInterval(() => {
      void loadLatestRun(namespace)
      void loadProjectJobs(namespace)
    }, 10_000)
    return () => clearInterval(interval)
  }, [isProjectModalOpen, selectedProjectNamespace])

  const selectedCardFresh = useMemo(() => {
    if (!selectedProjectNamespace) return selectedCard
    for (const column of board.columns) {
      const match = column.cards.find((card) => card.projectNamespace === selectedProjectNamespace)
      if (match) return match
    }
    return selectedCard
  }, [board, selectedCard, selectedProjectNamespace])

  async function refreshBoard() {
    try {
      const nextBoard = await getJson<BoardResponse>('/api/board')
      setBoard(nextBoard)
      if (selectedProjectNamespace) {
        for (const column of nextBoard.columns) {
          const match = column.cards.find((card) => card.projectNamespace === selectedProjectNamespace)
          if (match) {
            setSelectedCard(match)
            break
          }
        }
      }
    } catch (error) {
      setStatusMessage(`Could not load board: ${toMessage(error)}`)
    }
  }

  /** Leave the project page: back to the board, URL reset to /. */
  function closeProject() {
    setIsProjectModalOpen(false)
    document.title = 'Spaces'
    if (window.location.pathname.startsWith('/spaces/')) window.history.pushState({}, '', '/')
  }

  /** Open a project from its readable code (the /spaces/<code> URL). */
  async function openProjectByCode(code: string, viaUrl = true) {
    try {
      const detail = await getJson<{ slug: string }>(`/api/projects/by-code/${encodeURIComponent(code)}`)
      await openProjectBySlug(detail.slug, viaUrl)
    } catch (error) {
      setStatusMessage(`Could not open project ${code.toUpperCase()}: ${toMessage(error)}`)
      if (viaUrl) window.history.replaceState({}, '', '/')
    }
  }

  /** Open a project by slug, wherever its card lives (board or archived). */
  async function openProjectBySlug(slug: string, viaUrl = false, preferredTab?: ProjectModalTab) {
    const everything = await getJson<BoardResponse>('/api/board?archived=1')
    const card = everything.columns.flatMap((c) => c.cards).find((c) => c.projectNamespace === slug)
    if (!card) { setStatusMessage('That project is not visible in your current team.'); if (viaUrl) window.history.replaceState({}, '', '/'); return }
    await openProject(card, preferredTab, viaUrl)
  }

  async function openProject(card: BoardCard, preferredTab?: ProjectModalTab, viaUrl = false) {
    // The project is a page with its own URL, so links and refreshes land on it.
    const path = `/spaces/${encodeURIComponent(card.code ?? card.projectNamespace)}`
    if (window.location.pathname !== path) {
      if (viaUrl) window.history.replaceState({}, '', path)
      else window.history.pushState({}, '', path)
    }
    document.title = `${card.code ? `${card.code} · ` : ''}${card.projectLabel} · Spaces`
    // Tear down any previously-connected run SSE before switching projects.
    // loadLatestRun() below will re-open one if the new project has an active
    // run; if it doesn't, the stream stays closed. Without this, the previous
    // project's live log keeps overwriting currentRun during the switch.
    disconnectRunEvents()
    setSelectedCard(card)
    setEstimateInput(card.estimate.replace(/ \((user|ai)\)$/,'').replace(/ \(ai-est\)$/,''))
    setIsProjectModalOpen(true)
    const defaultTab: ProjectModalTab = card.automationState?.state === 'needs_approval' || card.automationState?.state === 'needs_clarification'
      ? 'assistant'
      : 'overview'
    setActiveProjectTab(preferredTab ?? defaultTab)
    setChatEntries([])
    setChatInput('')
    setCurrentRun(null)
    await Promise.all([
      loadProjectMemory(card.projectNamespace),
      loadProjectContext(card.projectNamespace),
      loadProjectQA(card.projectNamespace),
      loadPromotions(),
      loadAssistantHistory(card.projectNamespace),
      loadLatestRun(card.projectNamespace),
      loadTaskTracker(card.projectNamespace),
      loadOrchestrator(card.projectNamespace),
      loadProjectJobs(card.projectNamespace),
    ])
  }

  async function loadOrchestrator(namespace: string) {
    try {
      setOrchestrator(await getJson<{ autonomousMode: boolean; maxConcurrent: number; speedMode?: 'fast' | 'balanced' | 'quality' }>(`/api/projects/${namespace}/orchestrator`))
    } catch {
      setOrchestrator(null)
    }
    // Resolve the DB projectId + integrations by looking up project by slug.
    try {
      const projects = await getJson<Array<{ projectId: string; slug: string }>>('/api/projects')
      const proj = projects.find((p) => p.slug === namespace)
      if (proj) {
        const detail = await getJson<ProjectDetailRecord>(`/api/projects/${proj.projectId}`)
        setProjectDetail(detail)
        void loadProjectKnowledge(detail.projectId)
        void loadProjectWorker(detail.projectId)
        void loadPlanRepos(namespace)
      } else {
        setProjectDetail(null)
      }
    } catch {
      setProjectDetail(null)
    }
  }

  async function openDeletion() {
    if (!projectDetail) return
    setDeletion({ open: true, loading: true, preview: null, confirm: '', busy: false, error: '' })
    try {
      const preview = await getJson<DeletionPreview>(`/api/projects/${projectDetail.projectId}/deletion-check`)
      setDeletion((d) => ({ ...d, loading: false, preview }))
    } catch (error) {
      setDeletion((d) => ({ ...d, loading: false, error: error instanceof Error ? error.message : String(error) }))
    }
  }

  /** Archived projects for the sidebar menu (newest archived first). */
  async function loadArchivedCards(): Promise<BoardCard[]> {
    const archivedBoard = await getJson<BoardResponse>('/api/board?archived=1')
    const cards = archivedBoard.columns.flatMap((c) => c.cards).filter((c) => c.archivedAt).sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? ''))
    archivedCardsRef.current = cards
    return cards
  }
  function openArchived(summary: ArchivedCardSummary) {
    const card = archivedCardsRef.current.find((c) => c.projectNamespace === summary.projectNamespace)
    if (card) void openProject(card)
  }

  async function setPaused(pause: boolean) {
    if (!projectDetail) return
    setDeletion((d) => ({ ...d, busy: true, error: '' }))
    try {
      const response = await fetch(`/api/projects/${projectDetail.projectId}/${pause ? 'pause' : 'resume'}`, { method: 'POST' })
      const payload = (await response.json().catch(() => ({}))) as { error?: string; pausedAt?: string | null; pausingRuns?: number; heldJobs?: number; resumedRuns?: number }
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`)
      setProjectDetail((d) => (d ? { ...d, pausedAt: payload.pausedAt ?? null } : d))
      setDeletion((d) => ({ ...d, busy: false }))
      setStatusMessage(pause
        ? `${projectDetail.name} paused.${payload.pausingRuns ? ` ${payload.pausingRuns} running run(s) will stop at the next stage boundary.` : ''}${payload.heldJobs ? ` ${payload.heldJobs} queued job(s) are held.` : ''}`
        : `${projectDetail.name} resumed.${payload.resumedRuns ? ` ${payload.resumedRuns} paused run(s) re-queued.` : ''}`)
      await refreshBoard()
    } catch (error) {
      setDeletion((d) => ({ ...d, busy: false, error: error instanceof Error ? error.message : String(error) }))
    }
  }

  async function setArchived(archive: boolean) {
    if (!projectDetail) return
    const busy = selectedCardFresh?.automationState && !['idle', 'completed'].includes(selectedCardFresh.automationState.state)
    if (archive && !window.confirm(`Archive ${projectDetail.name}?${busy ? ' Its queued, running or paused work will be cancelled.' : ''} Nothing is deleted; you can unarchive later.`)) return
    setDeletion((d) => ({ ...d, busy: true, error: '' }))
    try {
      const response = await fetch(`/api/projects/${projectDetail.projectId}/${archive ? 'archive' : 'unarchive'}`, { method: 'POST' })
      const payload = (await response.json().catch(() => ({}))) as { error?: string; archivedAt?: string | null; cancelled?: { jobsCancelled: number; runsCancelled: number } }
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`)
      setProjectDetail((d) => (d ? { ...d, archivedAt: payload.archivedAt ?? null } : d))
      setDeletion({ open: false, loading: false, preview: null, confirm: '', busy: false, error: '' })
      const cancelledNote = payload.cancelled && (payload.cancelled.runsCancelled || payload.cancelled.jobsCancelled) ? ` Cancelled ${payload.cancelled.runsCancelled} run(s) and ${payload.cancelled.jobsCancelled} job(s).` : ''
      setStatusMessage(archive ? `${projectDetail.name} archived.${cancelledNote} Find it under Archived above the board; unarchive any time.` : `${projectDetail.name} unarchived.`)
      if (archive) { closeProject(); setSelectedCard(null); setCurrentRun(null) }
      await refreshBoard()
    } catch (error) {
      setDeletion((d) => ({ ...d, busy: false, error: error instanceof Error ? error.message : String(error) }))
    }
  }

  async function confirmDeletion() {
    if (!projectDetail) return
    setDeletion((d) => ({ ...d, busy: true, error: '' }))
    try {
      const response = await fetch(`/api/projects/${projectDetail.projectId}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: deletion.confirm }) })
      const payload = (await response.json().catch(() => ({}))) as { error?: string; runsDeleted?: number; removedPaths?: string[] }
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`)
      setDeletion({ open: false, loading: false, preview: null, confirm: '', busy: false, error: '' })
      closeProject()
      setSelectedCard(null)
      setCurrentRun(null)
      setProjectDetail(null)
      setStatusMessage(`Project deleted: ${payload.runsDeleted ?? 0} runs and ${payload.removedPaths?.length ?? 0} workspace paths removed.`)
      await refreshBoard()
    } catch (error) {
      setDeletion((d) => ({ ...d, busy: false, error: error instanceof Error ? error.message : String(error) }))
    }
  }

  async function loadAppIntegrations() {
    try {
      setAppIntegrations(await getJson<Array<{ kind: string; status: string; displayName?: string; updatedAt: string; credentialsOk?: boolean }>>('/api/integrations'))
    } catch { setAppIntegrations([]) }
  }

  const githubConnected = appIntegrations.some((i) => i.kind === 'github' && i.status === 'connected')

  /** Repos visible to the connected GitHub account, for the wizard autocomplete. Loaded once per open. */
  async function loadGitHubRepos(force = false) {
    if (githubRepos && !force) return
    if (!githubConnected) {
      setGithubRepos([])
      setGithubReposNote('Connect GitHub under Integrations to pick from your repositories.')
      return
    }
    try {
      const response = await fetch('/api/github/repos')
      const payload = await response.json() as { repos: GitHubRepoOption[]; workspaceRoot?: string; error?: string }
      setGithubRepos(payload.repos ?? [])
      setGithubReposNote(
        payload.error
          ? payload.error
          : `${payload.repos.length} repositories available. Selected repos are cloned to ${payload.workspaceRoot ?? 'the local workspace'} when the project is created.`,
      )
    } catch (error) {
      setGithubRepos([])
      setGithubReposNote(`Could not load GitHub repositories: ${toMessage(error)}`)
    }
  }

  async function retryRepoClone(repo: ProjectRepoRecord) {
    if (!projectDetail) return
    try {
      await postJson(`/api/projects/${projectDetail.projectId}/repos/${repo.repoId}/clone`, {})
      setStatusMessage(`Re-cloning ${repo.githubRepo ?? repo.label}…`)
      // Poll the detail a few times so the status flips without a manual refresh.
      for (let i = 0; i < 40; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000))
        const detail = await getJson<ProjectDetailRecord>(`/api/projects/${projectDetail.projectId}`)
        setProjectDetail(detail)
        const current = detail.repos.find((r) => r.repoId === repo.repoId)
        if (!current || current.cloneStatus === 'ready' || current.cloneStatus === 'error') break
      }
    } catch (error) {
      setStatusMessage(`Clone retry failed: ${toMessage(error)}`)
    }
  }



  async function loadProjectJobs(namespace: string) {
    try {
      setProjectJobs(await getJson<typeof projectJobs>(`/api/projects/${namespace}/jobs`))
    } catch {
      setProjectJobs([])
    }
    try {
      setProjectAgents(await getJson<Array<{ agentId: string; role: string; status: string; lastUsedAt?: string }>>(`/api/projects/${namespace}/agents`))
    } catch {
      setProjectAgents([])
    }
  }

  async function loadRunLog(runId: string) {
    try {
      const snap = await getJson<RunSnapshot>(`/api/runs/${runId}`)
      setInspectedRun(snap)
    } catch (error) {
      setStatusMessage(`Could not load run ${runId.slice(0, 8)}: ${toMessage(error)}`)
    }
  }

  async function toggleAutonomousMode() {
    if (!selectedProjectNamespace || !orchestrator) return
    try {
      const updated = await fetch(`/api/projects/${selectedProjectNamespace}/orchestrator`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ autonomousMode: !orchestrator.autonomousMode }),
      }).then((r) => r.json())
      setOrchestrator(updated)
    } catch (error) {
      setStatusMessage(`Failed to toggle autonomous mode: ${toMessage(error)}`)
    }
  }

  async function setSpeedMode(mode: 'fast' | 'balanced' | 'quality') {
    if (!selectedProjectNamespace || !orchestrator) return
    try {
      const updated = await fetch(`/api/projects/${selectedProjectNamespace}/orchestrator`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ speedMode: mode }),
      }).then((r) => r.json())
      setOrchestrator(updated)
      setStatusMessage(`Speed mode set to ${mode}. Next run will use ${mode === 'fast' ? 'Haiku across most stages' : mode === 'quality' ? 'Sonnet+extended-thinking (Opus for merges)' : 'per-stage defaults'}.`)
    } catch (error) {
      setStatusMessage(`Failed to set speed mode: ${toMessage(error)}`)
    }
  }

  async function loadProjectMemory(namespace: string) {
    setMemoryBusy(true)
    try {
      const memory = await getJson<ProjectMemoryResponse>(`/api/projects/${namespace}/memory`)
      setProjectMemory(memory.manualText)
      setAutoMemorySummary(memory.autoSummary)
      setMemoryStatus(memory.updatedAt ? `Updated ${formatTimestamp(memory.updatedAt)}` : 'No project memory yet.')
    } catch (error) {
      setProjectMemory('')
      setAutoMemorySummary('')
      setMemoryStatus(`Could not load memory: ${toMessage(error)}`)
    } finally {
      setMemoryBusy(false)
    }
  }

  async function loadProjectContext(namespace: string) {
    try {
      setSharedContext(await getJson<ContextBundle>(`/api/projects/${namespace}/context`))
    } catch {
      setSharedContext(null)
    }
  }

  async function loadProjectQA(namespace: string) {
    setQaBusy(true)
    try {
      const qa = await getJson<QAOverview>(`/api/projects/${namespace}/qa`)
      setQaOverview(qa)
      if (qa.currentJob.status === 'running') {
        connectSubagentEvents(namespace)
      }
    } catch {
      setQaOverview(null)
    } finally {
      setQaBusy(false)
    }
  }

  async function loadPromotions() {
    try {
      setPromotions(await getJson<PromotionProposal[]>('/api/org/promotions'))
    } catch {
      setPromotions([])
    }
  }

  async function loadAssistantHistory(namespace: string) {
    // The server keeps the conversation per project (in memory) so the
    // assistant has continuity; reload it when the project opens.
    try {
      const payload = await getJson<{ history: ChatEntry[] }>(`/api/projects/${namespace}/assistant/history`)
      setChatEntries(payload.history ?? [])
    } catch {
      setChatEntries([])
    }
  }

  async function loadLatestRun(namespace: string) {
    try {
      const snap = await getJson<RunSnapshot | null>(`/api/projects/${namespace}/latest-run`)
      setCurrentRun(snap)
      // Wire up SSE only for active runs. If there's no active run, we MUST
      // still tear down any pre-existing SSE (from a previous project) —
      // otherwise its stream keeps writing into currentRun, showing another
      // project's logs in this one's modal.
      if (snap && (snap.status === 'running' || snap.status === 'paused')) {
        connectRunEvents(snap.runId)
      } else {
        disconnectRunEvents()
      }
    } catch {
      setCurrentRun(null)
      disconnectRunEvents()
    }
  }

  async function loadTaskTracker(namespace: string) {
    // Server parses tasks.md from the project's primary local repo and returns
    // grouped items. No persistence — checkbox/status changes are display-only
    // (see updateTaskTracker no-op below).
    try {
      const response = await getJson<{ featureDir?: string; items: TaskTrackerItem[]; graph?: { nodes: Array<{ id: string; label: string; phase: string; story?: string; parallel: boolean; status: string }>; edges: Array<{ from: string; to: string }> } }>(`/api/projects/${namespace}/task-tracker`)
      setTaskTrackerItems(response.items ?? [])
      setTaskGraph(response.graph ?? { nodes: [], edges: [] })
    } catch {
      setTaskTrackerItems([])
      setTaskGraph({ nodes: [], edges: [] })
    }
  }

  async function saveProjectMemory() {
    if (!selectedProjectNamespace) return
    setMemoryBusy(true)
    try {
      const memory = await postJson<ProjectMemoryResponse>(`/api/projects/${selectedProjectNamespace}/memory`, { text: projectMemory })
      setProjectMemory(memory.manualText)
      setAutoMemorySummary(memory.autoSummary)
      setMemoryStatus(`Saved ${formatTimestamp(memory.updatedAt ?? new Date().toISOString())}`)
      await loadProjectContext(selectedProjectNamespace)
    } catch (error) {
      setMemoryStatus(`Save failed: ${toMessage(error)}`)
    } finally {
      setMemoryBusy(false)
    }
  }

  function validateWizardStep(step: number): string | null {
    if (step === 1) {
      if (!wizard.name.trim()) return 'Project name is required.'
    }
    if (step === 2) {
      // Repos are optional: the project gets a governing workspace for specs and
      // memory, and the plan stage names the code repositories, which are then
      // cloned on demand from the synced GitHub catalog.
      const filled = wizard.repos.filter((r) => r.label.trim() || r.localPath.trim() || r.githubRepo.trim())
      for (const r of filled) {
        if (!r.label.trim()) return `Every repo needs a label.`
        if (r.kind === 'local' && !r.localPath.trim()) return `Local repo "${r.label}" needs a path.`
        if (r.kind === 'github' && !r.githubRepo.trim()) return `GitHub repo "${r.label}" needs an owner/name.`
      }
    }
    return null
  }

  function goToStep(next: 1 | 2 | 3 | 4) {
    const validation = validateWizardStep(wizard.step)
    if (validation && next > wizard.step) {
      setStatusMessage(validation)
      return
    }
    setStatusMessage('')
    setWizard((c) => ({ ...c, step: next }))
  }

  async function submitWizard(runAidlc: boolean) {
    for (const step of [1, 2, 3, 4] as const) {
      const err = validateWizardStep(step)
      if (err) { setStatusMessage(err); setWizard((c) => ({ ...c, step })); return }
    }

    setBusy(true)
    try {
      const createBody = {
        name: wizard.name.trim(),
        description: wizard.description.trim() || undefined,
        // Empty drafts are dropped; the server adds the governing workspace as primary.
        repos: wizard.repos
          .filter((r) => r.label.trim() || r.localPath.trim() || r.githubRepo.trim())
          .map((r) => ({
            label: r.label.trim() || (r.kind === 'github' ? r.githubRepo.trim().split('/')[1] ?? 'repo' : r.localPath.trim().split('/').pop() ?? 'repo'),
            kind: r.kind,
            localPath: r.kind === 'local' ? r.localPath.trim() : undefined,
            githubRepo: r.kind === 'github' ? r.githubRepo.trim() : undefined,
            isPrimary: false,
          })),
        // Integrations moved to app level; no per-project slots created.
        integrations: [],
      }
      const project = await postJson<{ projectId: string; slug: string; name: string; repos: Array<{ repoId: string; isPrimary: boolean; kind: string }>; onboarding?: OnboardingSnapshot }>('/api/projects', { ...createBody, model: wizard.model || undefined, feature: wizard.firstFeature.trim() || undefined })
      setStatusMessage(`Created project "${project.name}".`)

      // Attach imported tickets/docs as project knowledge before onboarding reads them.
      for (const item of importedItems) {
        try {
          await postJson(`/api/projects/${project.projectId}/sources/import`, { source: item.source, id: item.id })
        } catch (error) {
          setStatusMessage(`Project created; attaching ${item.id} failed: ${toMessage(error)}`)
        }
      }

      // Onboarding runs server-side: clone remote repos first, inventory the code,
      // let an agent learn it, and store project memory. Wait for it here (with
      // live progress in the wizard) so the first run starts with real context.
      const snapshot = await waitForOnboarding(project.projectId, project.name, project.onboarding)

      // Suggested repositories / work areas: let the user add repos before the
      // first run starts, so implementation lands in real checkouts.
      try {
        const payload = await getJson<{ suggestions: WizardSuggestions | null }>(`/api/projects/${project.projectId}/suggestions`)
        const suggestions = payload.suggestions
        if (suggestions && (suggestions.repositories.some((r) => !r.registered) || suggestions.workAreas.length > 0 || suggestions.newRepository)) {
          await new Promise<void>((resolve) => setOnboardingReview({ projectId: project.projectId, suggestions, adding: [], resolve }))
          setOnboardingReview(null)
        }
      } catch {
        // suggestions are optional
      }

      if (runAidlc && wizard.firstFeature.trim()) {
        if (!snapshot.runnable) {
          setStatusMessage(`Project "${project.name}" created, but it can't be run yet: ${snapshot.error ?? 'no repository is available locally.'}`)
        } else {
          try {
            const response = await postJson<CreateRunResponse>('/api/runs', {
              projectId: project.projectId,
              pipeline: wizard.pipelineName,
              feature: wizard.firstFeature.trim(),
              constitution: wizard.description || wizard.name,
              planContext: wizard.planContext || 'Use AIDLC governance defaults, include test cases in specify, and include test planning in the implementation plan.',
              model: wizard.model || undefined,
              thinking: wizard.thinking || undefined,
            })
            if ('error' in response) {
              setStatusMessage(`Project created but run failed: ${response.error}`)
            } else if ('runId' in response) {
              setCurrentRun(response)
              connectRunEvents(response.runId)
              setStatusMessage(`Started ${wizard.pipelineName} on "${wizard.name}".`)
            }
          } catch (error) {
            // The project exists either way; never leave the wizard stuck open on a run error.
            setStatusMessage(`Project created but run failed: ${toMessage(error)}`)
          }
        }
      } else if (snapshot.status === 'error' && snapshot.error) {
        setStatusMessage(`Project "${project.name}" created. Onboarding had problems: ${snapshot.error}`)
      }

      setIsWizardOpen(false)
      setOnboarding(null)
      setImportedItems([])
      setImportSearch((c) => ({ ...c, query: '', results: [], note: '' }))
      setWizard(defaultWizard)
      await refreshBoard()
      await openProjectBySlug(project.slug).catch(() => undefined)
    } catch (error) {
      setOnboarding(null)
      setStatusMessage(`Wizard failed: ${toMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  /** Poll onboarding until it settles, mirroring progress into the wizard panel. */
  async function waitForOnboarding(projectId: string, projectName: string, initial?: OnboardingSnapshot): Promise<OnboardingSnapshot> {
    let snapshot = initial ?? await getJson<OnboardingSnapshot>(`/api/projects/${projectId}/onboarding`)
    setOnboarding({ projectName, snapshot })
    const deadline = Date.now() + 30 * 60_000
    while (snapshot.status === 'running' || snapshot.status === 'idle') {
      if (Date.now() > deadline) break
      await new Promise((resolve) => setTimeout(resolve, 1500))
      try {
        snapshot = await getJson<OnboardingSnapshot>(`/api/projects/${projectId}/onboarding`)
        setOnboarding({ projectName, snapshot })
      } catch {
        // transient fetch failure — keep polling
      }
    }
    return snapshot
  }

  function connectRunEvents(runId: string) {
    // Idempotent — if we're already subscribed to this exact run, do nothing.
    if (connectedRunIdRef.current === runId && runEventSourceRef.current) return
    disconnectRunEvents()
    const eventSource = new EventSource(`/api/runs/${runId}/events`)
    runEventSourceRef.current = eventSource
    connectedRunIdRef.current = runId

    eventSource.onmessage = (event) => {
      const next = JSON.parse(event.data) as RunSnapshot
      setCurrentRun(next)
      if (next.status === 'completed') {
        setStatusMessage('AI completed the configured AIDLC flow.')
        void Promise.all([
          refreshBoard(),
          next.projectNamespace ? loadProjectQA(next.projectNamespace) : Promise.resolve(),
          next.projectNamespace ? loadProjectContext(next.projectNamespace) : Promise.resolve(),
        ])
        eventSource.close()
      } else if (next.status === 'error') {
        setStatusMessage(`Error: ${next.error ?? 'Unknown error'}`)
        void refreshBoard()
        eventSource.close()
      } else if (next.status === 'paused') {
        setStatusMessage(next.pauseKind === 'review' ? `Waiting for review on ${next.stage}.` : `Clarification needed on ${next.stage}.`)
      } else {
        setStatusMessage(`AI is working on ${next.stage ?? 'the project'}...`)
      }
    }

    eventSource.onerror = () => {
      eventSource.close()
    }
  }

  function connectSubagentEvents(namespace: string) {
    subagentEventSourceRef.current?.close()
    const eventSource = new EventSource(`/api/projects/${namespace}/subagents/events`)
    subagentEventSourceRef.current = eventSource
    eventSource.onmessage = (event) => {
      const snapshot = JSON.parse(event.data) as SubagentJobSnapshot
      setQaOverview((current) => current ? { ...current, currentJob: snapshot } : current)
      if (snapshot.status === 'completed' || snapshot.status === 'error') {
        eventSource.close()
        void loadProjectQA(namespace)
      }
    }
    eventSource.onerror = () => {
      eventSource.close()
    }
  }

  async function runParallelSubAgents() {
    if (!selectedProjectNamespace) return
    setQaBusy(true)
    try {
      const snapshot = await postJson<SubagentJobSnapshot>(`/api/projects/${selectedProjectNamespace}/subagents/run`, { maxAgents: 4 })
      setQaOverview((current) => current ? { ...current, currentJob: snapshot } : current)
      connectSubagentEvents(selectedProjectNamespace)
      setStatusMessage('Started parallel sub-agents.')
    } catch (error) {
      setStatusMessage(`Could not run sub-agents: ${toMessage(error)}`)
    } finally {
      setQaBusy(false)
    }
  }

  /** Rerun a failed/interrupted/finished run from the stage it stopped at, or from an explicit stage. */
  async function rerunRun(fromStage?: string, extraBody: Record<string, string> = {}) {
    if (!currentRun) return
    setBusy(true)
    try {
      const body = { ...(fromStage ? { fromStage } : {}), ...extraBody }
      const raw = await fetch(`/api/runs/${currentRun.runId}/rerun`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await raw.json() as Partial<RunSnapshot> & { error?: string; field?: 'feature' | 'constitution' | 'checklistDomain' }
      if (raw.status === 400 && data.field) {
        // Server tells us which required input is missing. Prompt for it and
        // retry with the value. Prevents the confusing "specify requires
        // --feature" loop where clicking Rerun just fails identically.
        const value = await promptForStageInput(data.field)
        if (!value) {
          setStatusMessage(`Cancelled — rerun still needs a ${data.field}.`)
          return
        }
        // Recurse once with the supplied value merged in.
        await rerunRun(fromStage, { ...extraBody, [data.field]: value })
        return
      }
      if (!raw.ok) throw new Error(data.error ?? `HTTP ${raw.status}`)
      const response = data as RunSnapshot
      setCurrentRun(response)
      connectRunEvents(response.runId)
      setStatusMessage(fromStage && fromStage !== 'start' ? `Re-running from stage ${fromStage}.` : 'Re-running from the start.')
      if (response.projectNamespace) await loadProjectJobs(response.projectNamespace)
    } catch (error) {
      setStatusMessage(`Could not rerun: ${toMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  /** Pause (at the next stage boundary), resume a user pause, or cancel the current run. */
  async function controlRun(action: 'pause' | 'resume' | 'cancel') {
    if (!currentRun) return
    if (action === 'cancel' && !window.confirm(`Cancel this run${currentRun.stage ? ` at stage ${currentRun.stage}` : ''}? Finished stages keep their artifacts; the run itself ends as cancelled.`)) return
    setBusy(true)
    try {
      const response = await postJson<RunSnapshot>(`/api/runs/${currentRun.runId}/${action}`, {})
      setCurrentRun(response)
      if (action === 'cancel') disconnectRunEvents()
      else connectRunEvents(response.runId)
      setStatusMessage(action === 'pause' ? (response.status === 'paused' ? 'Run paused.' : 'Pause requested — the run stops when the current stage finishes.') : action === 'resume' ? 'Run resumed.' : 'Run cancelled.')
      await refreshBoard()
    } catch (error) {
      setStatusMessage(`Could not ${action} the run: ${toMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  async function sendAnswer(answer: string) {
    if (!currentRun || !answer.trim()) return
    setBusy(true)
    try {
      const response = await postJson<RunSnapshot>(`/api/runs/${currentRun.runId}/answer`, { answer })
      setCurrentRun(response)
      connectRunEvents(response.runId)
      if (response.projectNamespace) {
        await loadAssistantHistory(response.projectNamespace)
      }
      setClarification('')
    } catch (error) {
      if (selectedProjectNamespace) {
        await loadLatestRun(selectedProjectNamespace)
      }
      setStatusMessage(`Could not continue run: ${toMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  async function submitGuidedClarification() {
    const parts = [
      clarifyForm.boardItem && `Board item: ${clarifyForm.boardItem}`,
      clarifyForm.repoPath && `Implementation repository/path: ${clarifyForm.repoPath}`,
      clarifyForm.runtime && `Language/runtime: ${clarifyForm.runtime}`,
      clarifyForm.storage && `Storage: ${clarifyForm.storage}`,
      clarifyForm.notification && `Notification channel: ${clarifyForm.notification}`,
      clarifyForm.testFramework && `Test framework: ${clarifyForm.testFramework}`,
      clarifyForm.extra && `Extra notes: ${clarifyForm.extra}`,
    ].filter(Boolean)

    await sendAnswer(parts.join('\n'))
  }

  async function sendChat() {
    if (!selectedProjectNamespace || !chatInput.trim()) return
    const message = chatInput.trim()
    setChatEntries((current) => [...current, { role: 'user', content: message }])
    setChatInput('')
    setBusy(true)
    try {
      const response = await postJson<{ answer: string; history: ChatEntry[]; actions?: string[]; focusRunId?: string }>(`/api/projects/${selectedProjectNamespace}/chat`, { message })
      const actionNote = response.actions?.length ? `\n\n_Actions taken: ${response.actions.join('; ')}_` : ''
      if (response.history?.length) {
        setChatEntries(response.history.map((entry, index, all) => index === all.length - 1 && entry.role === 'assistant' ? { ...entry, content: `${entry.content}${actionNote}` } : entry))
      } else {
        setChatEntries((current) => [...current, { role: 'assistant', content: `${response.answer}${actionNote}` }])
      }
      // The assistant may have re-run, approved or started something: refresh what it touched.
      if (response.actions?.length) {
        await Promise.all([loadLatestRun(selectedProjectNamespace), loadProjectJobs(selectedProjectNamespace), refreshBoard()])
      }
    } catch (error) {
      setChatEntries((current) => [...current, { role: 'assistant', content: `Error: ${toMessage(error)}` }])
    } finally {
      setBusy(false)
    }
  }

  async function createPromotion() {
    if (!selectedProjectNamespace || !promotionTitle.trim() || !promotionContent.trim()) return
    setPromotionBusy(true)
    try {
      await postJson(`/api/projects/${selectedProjectNamespace}/promotions`, {
        title: promotionTitle,
        content: promotionContent,
        targetFile: 'principles.md',
      })
      setPromotionTitle('')
      setPromotionContent('')
      await loadPromotions()
      setStatusMessage('Promotion proposal submitted.')
    } catch (error) {
      setStatusMessage(`Could not submit promotion: ${toMessage(error)}`)
    } finally {
      setPromotionBusy(false)
    }
  }

  async function decidePromotion(proposalId: string, decision: 'approved' | 'rejected') {
    setPromotionBusy(true)
    try {
      await postJson(`/api/org/promotions/${proposalId}/decision`, { decision })
      await loadPromotions()
      if (selectedProjectNamespace) {
        await Promise.all([loadProjectContext(selectedProjectNamespace), loadProjectMemory(selectedProjectNamespace)])
      }
      setStatusMessage(`Promotion ${decision}.`)
    } catch (error) {
      setStatusMessage(`Could not update promotion: ${toMessage(error)}`)
    } finally {
      setPromotionBusy(false)
    }
  }

  // stepForColumn + isEligibleDrop moved to src/lib/board-drop.ts so they can
  // be unit-tested without a DOM. Both are pure functions imported at the top.

  async function handleBoardDrop(card: BoardCard, targetLane: BoardStatus) {
    setDraggedProjectNamespace('')
    if (!isEligibleDrop(card, targetLane)) {
      setStatusMessage(`Can't move ${card.projectLabel} to ${targetLane} — that's not the next eligible step for this project.`)
      return
    }
    const rec = card.recommendedAction!
    const proceed = window.confirm(`Run "${rec.label}" for ${card.projectLabel}?\n\n${rec.reason}`)
    if (!proceed) return
    await executeStep(rec.step, rec.tab, card)
  }

  /**
   * Kick off a pipeline step. Normally scoped to the currently-open project
   * (via selectedProjectNamespace). Pass `targetCard` to run against a
   * different project without opening its modal first — used by board drag+drop
   * so a card dropped onto its next-eligible lane triggers the action inline.
   */
  async function executeStep(step: string, preferredTab?: ProjectModalTab, targetCard?: BoardCard) {
    const namespace = targetCard?.projectNamespace ?? selectedProjectNamespace
    if (!namespace) return
    // If we're running for a different project than the one currently open,
    // switch the modal over so the user sees the log stream + status for the
    // right project.
    if (targetCard && targetCard.projectNamespace !== selectedProjectNamespace) {
      await openProject(targetCard, preferredTab)
    }
    // Stage-specific required inputs — prompt the user before hitting the API
    // instead of round-tripping a 400. Matches the validation in
    // src/server.ts /api/.../execute-step.
    const extraBody: Record<string, string> = {}
    if (step === 'specify') {
      const value = await promptForStageInput('feature')
      if (!value) {
        setStatusMessage('Cancelled — the specify stage needs a feature description.')
        return
      }
      extraBody.feature = value
    } else if (step === 'constitution') {
      const value = await promptForStageInput('constitution')
      if (!value) {
        setStatusMessage('Cancelled — the constitution stage needs a statement.')
        return
      }
      extraBody.constitution = value
    } else if (step === 'checklist') {
      const value = await promptForStageInput('checklistDomain')
      if (!value) {
        setStatusMessage('Cancelled — the checklist stage needs a domain.')
        return
      }
      extraBody.checklistDomain = value
    }
    setBusy(true)
    try {
      const raw = await fetch(`/api/projects/${namespace}/execute-step`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ step, ...extraBody }),
      })
      if (raw.status === 404) {
        // Stale project card — refresh the board and close the modal so the
        // user isn't stuck on a project that no longer exists in the DB.
        setStatusMessage('This project no longer exists in the database. Refreshing…')
        await refreshBoard()
        closeProject()
        setSelectedCard(null)
        setCurrentRun(null)
        return
      }
      let result = (await raw.json()) as { ok: boolean; message: string; state?: string; runId?: string; error?: string; hint?: string }
      if (raw.status === 409 && /already produced its artifact/.test(result.error ?? '') && window.confirm(`${result.error}\n\nRun ${step} again anyway? Its artifact will be regenerated.`)) {
        const again = await fetch(`/api/projects/${namespace}/execute-step`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ step, ...extraBody, force: true }) })
        result = (await again.json()) as typeof result
        if (again.status >= 400) { setStatusMessage(`Could not execute ${step}: ${result.error ?? 'unknown error'}`); return }
      } else if (raw.status >= 400) {
        setStatusMessage(`Could not execute ${step}: ${result.error ?? 'unknown error'}`)
        return
      }
      setStatusMessage(result.message)
      // Open SSE for the newly enqueued run so the log streams live in the
      // AI agent output bar. Without this, the bar shows status but no log.
      if (result.runId) {
        setCurrentRun({
          runId: result.runId,
          projectNamespace: namespace,
          projectLabel: '',
          projectPath: '',
          pipeline: `adhoc-${step}`,
          stages: [step],
          reviewHarness: true,
          humanInLoop: true,
          status: 'running',
          stage: step,
          log: '',
          executiveSummary: `Queued ${step}...`,
          timeline: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as RunSnapshot)
        connectRunEvents(result.runId)
      }
      await Promise.all([refreshBoard(), loadProjectQA(namespace), loadProjectContext(namespace), loadTaskTracker(namespace)])
      if (preferredTab) setActiveProjectTab(preferredTab)
      if (result.state === 'needs_approval' || result.state === 'needs_clarification') {
        setActiveProjectTab('assistant')
      }
    } catch (error) {
      setStatusMessage(`Could not execute ${step}: ${toMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  async function saveEstimate() {
    // Estimate persistence retired in the legacy cleanup — the board now derives
    // estimate state from the latest run. UI kept as a display-only text box.
    setStatusMessage('Estimate persistence is retired; the board shows a derived estimate from the latest run.')
  }

  async function updateTaskTracker(_taskId: string, _update: Partial<Pick<TaskTrackerItem, 'checked' | 'status' | 'note' | 'lastRunReport'>>) {
    // Task-tracker persistence retired in the legacy cleanup. Tasks are read
    // straight from tasks.md via the artifact endpoint; no per-item state kept.
    setStatusMessage('Task tracker persistence is retired; edit tasks.md directly.')
  }

  async function runSpecificTask(taskId: string) {
    if (!selectedProjectNamespace) return
    setBusy(true)
    try {
      await postJson(`/api/projects/${selectedProjectNamespace}/tasks/${encodeURIComponent(taskId)}/run`, {})
      await Promise.all([loadTaskTracker(selectedProjectNamespace), loadProjectQA(selectedProjectNamespace), refreshBoard()])
      setActiveProjectTab('implementation')
      setStatusMessage(`Started task ${taskId}.`)
    } catch (error) {
      setStatusMessage(`Could not run task ${taskId}: ${toMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  async function runSpecificWorkstream(taskId: string) {
    if (!selectedProjectNamespace) return
    setBusy(true)
    try {
      await postJson(`/api/projects/${selectedProjectNamespace}/workstreams/run`, { taskId })
      await Promise.all([loadTaskTracker(selectedProjectNamespace), loadProjectQA(selectedProjectNamespace), refreshBoard()])
      setActiveProjectTab('implementation')
      setStatusMessage(`Started workstream for ${taskId}.`)
    } catch (error) {
      setStatusMessage(`Could not run workstream for ${taskId}: ${toMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const filteredPromotions = promotions.filter((item) => !selectedProjectNamespace || item.projectNamespace === selectedProjectNamespace)
  const specArtifacts = (selectedCardFresh?.artifactLinks ?? []).filter((artifact) => ['Specified', 'Planned'].includes(artifact.stepLabel))
  const testArtifacts = (selectedCardFresh?.artifactLinks ?? []).filter((artifact) => ['Test Plan', 'Parallelize', 'Verify', 'Orchestrate'].includes(artifact.stepLabel))
  const gateReadiness = selectedCardFresh?.gateReadiness ?? []

  const runInFlight = currentRun?.status === 'running' || currentRun?.status === 'paused'
  const hasArtifact = (label: string) => (selectedCardFresh?.artifactLinks ?? []).some((a) => a.stepLabel === label)
  function stepEligibility(step: string): { ok: boolean; reason?: string } {
    if (runInFlight) {
      return {
        ok: false,
        reason: currentRun?.queued
          ? `A ${currentRun.stages?.join(' → ') || 'run'} run is queued and waiting for a worker slot. It starts as soon as the worker is free.`
          : `A run is currently ${currentRun?.status}. Wait or resolve it before starting another.`,
      }
    }
    switch (step) {
      case 'init': return { ok: true }
      case 'research': return { ok: true }
      case 'specify': return { ok: true }
      case 'clarify': return hasArtifact('Specified') ? { ok: true } : { ok: false, reason: 'Needs a spec first (run specify).' }
      case 'plan': return hasArtifact('Specified') ? { ok: true } : { ok: false, reason: 'Needs a spec first (run specify).' }
      case 'tasks': return hasArtifact('Planned') ? { ok: true } : { ok: false, reason: 'Needs a plan first (run plan).' }
      case 'testplan': return hasArtifact('Tasked') ? { ok: true } : { ok: false, reason: 'Needs tasks first (run tasks).' }
      case 'parallelize': return hasArtifact('Tasked') ? { ok: true } : { ok: false, reason: 'Needs tasks first (run tasks).' }
      case 'analyze':
        return hasArtifact('Specified') && hasArtifact('Planned') && hasArtifact('Tasked')
          ? { ok: true }
          : { ok: false, reason: 'Analyze requires spec, plan, and tasks.' }
      case 'implement':
        return hasArtifact('Tasked') && hasArtifact('Test Plan') && hasArtifact('Parallelize')
          ? { ok: true }
          : { ok: false, reason: 'Implementation needs tasks, a test plan, and a parallel workstream breakdown.' }
      case 'orchestrate':
        return hasArtifact('Parallelize')
          ? { ok: true }
          : { ok: false, reason: 'Orchestrate needs a parallel workstream breakdown.' }
      case 'verify':
        return hasArtifact('Tasked')
          ? { ok: true }
          : { ok: false, reason: 'Cannot verify before tasks exist.' }
      default: return { ok: true }
    }
  }
  const groupedTasks = taskTrackerItems.reduce<Array<{ group: string; items: TaskTrackerItem[] }>>((groups, item) => {
    const existing = groups.find((group) => group.group === item.group)
    if (existing) {
      existing.items.push(item)
    } else {
      groups.push({ group: item.group, items: [item] })
    }
    return groups
  }, [])
  const filteredChatEntries = chatEntries.filter((entry) => {
    if (chatKindFilter !== 'all' && (entry.kind ?? 'chat') !== chatKindFilter) {
      return false
    }
    if (!chatSearch.trim()) {
      return true
    }
    const haystack = [
      entry.content,
      entry.runId ?? '',
      entry.sessionFile ?? '',
      ...(entry.relatedStages ?? []),
      ...(entry.relatedArtifacts ?? []).map((artifact) => `${artifact.label} ${artifact.path} ${artifact.excerpt ?? ''}`),
    ].join(' ').toLowerCase()
    return haystack.includes(chatSearch.toLowerCase())
  })

  const groupedChatEntries = filteredChatEntries.reduce<Array<{ key: string; label: string; entries: ChatEntry[] }>>((groups, entry) => {
    const key = entry.runId ?? entry.sessionFile ?? 'general'
    const label = entry.runId
      ? `Run ${entry.runId.slice(0, 8)}`
      : entry.sessionFile
        ? `Session ${entry.sessionFile.split('/').pop()}`
        : 'General assistant history'
    const existing = groups.find((group) => group.key === key)
    if (existing) {
      existing.entries.push(entry)
    } else {
      groups.push({ key, label, entries: [entry] })
    }
    return groups
  }, [])

  // URL ↔ project page: /spaces/<code> opens that project; Back returns to the board.
  useEffect(() => {
    const fromPath = () => {
      const isOrg = window.location.pathname === '/organization'
      setOrgPageOpen(isOrg)
      if (isOrg) setIsIntegrationsModalOpen(false)
      if (isOrg) { setTeamPageSlug(null); setIsProjectModalOpen(false); return }
      const teamMatch = /^\/teams\/([^/]+)/.exec(window.location.pathname)
      if (teamMatch) { setTeamPageSlug(decodeURIComponent(teamMatch[1]!)); setIsProjectModalOpen(false); return }
      setTeamPageSlug(null)
      const match = /^\/spaces\/([^/]+)/.exec(window.location.pathname)
      if (match) void openProjectByCode(decodeURIComponent(match[1]!), true)
      else { setIsProjectModalOpen(false); document.title = 'Spaces'; void refreshMe() }
    }
    fromPath()
    window.addEventListener('popstate', fromPath)
    return () => window.removeEventListener('popstate', fromPath)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Escape closes the top-most overlay (the stage-input prompt handles its own).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || stageInputPrompt) return
      if (inspectedRun) setInspectedRun(null)
      else if (isIntegrationsModalOpen) setIsIntegrationsModalOpen(false)
      else if (isWizardOpen && !onboarding) setIsWizardOpen(false)
      else if (isProjectModalOpen) closeProject()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [stageInputPrompt, inspectedRun, isIntegrationsModalOpen, isWizardOpen, onboarding, isProjectModalOpen])

  const allCards = board.columns.flatMap((column) => column.cards.map((card) => ({ card, column })))
  const boardQ = boardQuery.trim().toLowerCase()
  const cardMatches = (card: BoardCard) => !boardQ || [card.projectLabel, card.code ?? '', card.projectNamespace, card.feature ?? ''].some((v) => String(v).toLowerCase().includes(boardQ))
  const visibleCards = allCards.filter(({ card }) => cardMatches(card))
  const boardHasProjects = allCards.length > 0
  const attentionCount = allCards.filter(({ card }) => card.automationState && ['needs_approval', 'needs_clarification', 'error', 'blocked'].includes(card.automationState.state)).length
  const openWizard = () => {
    if (!modelsReady) { setStatusMessage('Add a model provider key under Models before creating a project.'); navigate('/organization?section=models'); return }
    setWizard(defaultWizard); setImportedItems([]); setGithubRepos(null); void loadKnowledgeSources(); setIsWizardOpen(true)
  }

  return (
    <main className="app-shell">
      <TopStrip
        integrationsConnected={connectedIntegrationCount}
        integrationsTotal={INTEGRATION_KINDS.length}
        onIntegrations={() => { void loadAppIntegrations(); setIsIntegrationsModalOpen(true) }}
        attentionCount={attentionCount}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
      />
      <div className="shell-body">
        <AppSidebar
          open={sidebarOpen}
          onNavigate={() => setSidebarOpen(false)}
          archivedCount={board.archivedCount ?? 0}
          loadArchived={loadArchivedCards}
          onOpenArchived={openArchived}
        />
        <section className="main-panel">

      {statusMessage && (
        <div className={`toast ${isErrorMessage(statusMessage) ? 'toast-error' : ''}`} role="status">
          <span>{statusMessage}</span>
          <button className="ghost-button toast-close" onClick={() => setStatusMessage('')} type="button" aria-label="Dismiss">×</button>
        </div>
      )}

      {orgPageOpen && <OrgPage />}
      {teamPageSlug && <TeamPage slug={teamPageSlug} teams={me?.teams ?? []} />}

      {!isProjectModalOpen && !teamPageSlug && !orgPageOpen && (<>
      <PageHead title="Projects" count={boardHasProjects ? `${allCards.length}` : undefined}>
        {boardHasProjects && <SearchBox value={boardQuery} onChange={setBoardQuery} placeholder="Search projects…" />}
        <button className={modelsReady ? 'primary-button' : 'secondary-button'} onClick={openWizard} type="button" title={modelsReady ? undefined : 'Add a model provider key first'}>+ New project</button>
      </PageHead>
      {!modelsReady && (
        <div className="setup-banner" role="status">
          <div className="setup-banner-text">
            <strong>Add a model key to start creating projects.</strong>
            <span>Spaces runs its agents on your own Anthropic, OpenAI or OpenRouter key. Keys are stored encrypted and verified when saved.</span>
          </div>
          <button type="button" className="primary-button" onClick={() => navigate('/organization?section=models')}>Open Models</button>
        </div>
      )}
      {!boardHasProjects ? (
        <section className="card welcome-panel">
          <div className="welcome-copy">
            <p className="eyebrow">{(board.archivedCount ?? 0) > 0 ? 'Nothing active' : 'Nothing here yet'}</p>
            <h2>{(board.archivedCount ?? 0) > 0 ? `All ${board.archivedCount} project${board.archivedCount === 1 ? ' is' : 's are'} archived` : 'Start your first project in this team'}</h2>
            {(board.archivedCount ?? 0) > 0 && <p className="hero-copy">Open them from <strong>Archived</strong> in the sidebar, where you can unarchive or delete them. Or start something new.</p>}
            <p className="hero-copy">
              Describe what you want to build, or import a Jira / Linear ticket. Onboarding clones your repositories, learns them,
              initialises the Spec Kit workspace and runs the AIDLC pipeline while you watch.
            </p>
            <div className="button-row">
              <button className="primary-button" onClick={openWizard} type="button" disabled={!modelsReady} title={modelsReady ? undefined : 'Add a model provider key first'}>New project</button>
              {!allIntegrationsConnected && (
                <button className="secondary-button" onClick={() => { void loadAppIntegrations(); setIsIntegrationsModalOpen(true) }} type="button">Connect integrations</button>
              )}
            </div>
          </div>
          <ol className="welcome-steps">
            <li><strong>Describe</strong><span>Name the project and its first feature. Repositories are optional; the plan names them from your GitHub catalog, and if nothing matches, discovery proposes a new one to create.</span></li>
            <li><strong>Onboard</strong><span>Repos are cloned and learned, memory and the governing workspace are built, dev environments set up.</span></li>
            <li><strong>Run</strong><span>Specify → plan → tasks → implement → review → deliver, with approval gates you control.</span></li>
          </ol>
        </section>
      ) : (
      <section className="board-panel card panel">
        <div className="board-toolbar">
          <div className="board-summary">
            {boardQ && <strong>{visibleCards.length} of {allCards.length} match</strong>}
            {attentionCount > 0 && (
              <span className="mini-badge paused">{attentionCount} need{attentionCount === 1 ? 's' : ''} attention</span>
            )}
            <span className="board-hint">Open a card to inspect it. Drag a card to its next lane to run that step.</span>
          </div>
          <div className="segmented" role="tablist" aria-label="View">
            <button className={boardView === 'board' ? 'active' : ''} onClick={() => setBoardView('board')} type="button" role="tab" aria-selected={boardView === 'board'}>Board</button>
            <button className={boardView === 'list' ? 'active' : ''} onClick={() => setBoardView('list')} type="button" role="tab" aria-selected={boardView === 'list'}>List</button>
          </div>
        </div>

        {boardView === 'list' && (
          <div className="table-wrap">
            <table className="project-table">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Stage</th>
                  <th>Feature</th>
                  <th>Status</th>
                  <th>Verify</th>
                  <th>Gates</th>
                  <th>Next action</th>
                </tr>
              </thead>
              <tbody>
                {visibleCards.map(({ card, column }) => (
                  <tr key={card.projectNamespace} onClick={() => void openProject(card)}>
                    <td>
                      <strong>{card.code && <span className="code-badge">{card.code}</span>} {card.projectLabel}</strong>
                      <small>{card.projectNamespace}</small>
                    </td>
                    <td><span className="mini-badge idle">{column.title}</span></td>
                    <td className="cell-feature">{card.feature || <span className="text-subtle">No active feature</span>}</td>
                    <td>
                      <span className={`mini-badge ${card.latestRun?.status ?? 'idle'}`}>{card.status}</span>
                      {card.automationState && card.automationState.state !== 'idle' && card.automationState.state !== 'completed' && (
                        <button
                          className={`automation-badge ${card.automationState.state}`}
                          onClick={(event) => { event.stopPropagation(); void openProject(card, 'assistant') }}
                          type="button"
                        >
                          {card.automationState.state.replace('_', ' ')}
                        </button>
                      )}
                    </td>
                    <td><span className={`mini-badge ${card.verificationStatus === 'pass' ? 'completed' : card.verificationStatus === 'fail' ? 'error' : 'idle'}`}>{card.verificationStatus}</span></td>
                    <td>
                      <div className="compact-gates" style={{ marginTop: 0 }}>
                        {card.gateReadiness.map((gate) => (
                          <button
                            key={`${card.projectNamespace}-${gate.stage}`}
                            className={`compact-gate ${gate.color}`}
                            title={`${gate.stage}: ${gate.reason}`}
                            onClick={(event) => { event.stopPropagation(); void openProject(card, gate.tab as ProjectModalTab) }}
                            type="button"
                          >
                            {gate.stage.slice(0, 2)}
                          </button>
                        ))}
                      </div>
                    </td>
                    <td>
                      {card.recommendedAction ? (
                        <button
                          className="secondary-button small-button"
                          onClick={(event) => { event.stopPropagation(); void openProject(card, card.recommendedAction!.tab) }}
                          type="button"
                          title={card.recommendedAction.reason}
                        >
                          {card.recommendedAction.label}
                        </button>
                      ) : <span className="text-subtle">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {boardView === 'board' && (
        <div className="board-columns">
          {board.columns.map((column) => {
            const dragging = !!draggedCard
            const eligible = dragging && isEligibleDrop(draggedCard, column.id)
            const disabled = dragging && !eligible
            const columnStep = stepForColumn(column.id)
            // Every lane keeps its full share of the width, empty or not, so the
            // board always reads as the whole pipeline.
            const collapsed = false
            if (collapsed) {
              return (
                <section
                  key={column.id}
                  className={`board-column board-column-collapsed ${disabled ? 'board-column-disabled' : ''}`}
                  title={`${column.title}: no projects`}
                  onDragOver={(event) => { if (eligible) event.preventDefault() }}
                >
                  <span className="collapsed-title">{column.title}</span>
                  <span className="column-count">0</span>
                </section>
              )
            }
            return (
            <section
              key={column.id}
              className={`board-column ${eligible ? 'board-column-droppable' : ''} ${disabled ? 'board-column-disabled' : ''}`}
              // Only preventDefault on eligible drop targets — that's the HTML5
              // drag-and-drop convention for signaling "yes, drop here". On
              // disabled columns the browser shows the not-allowed cursor.
              onDragOver={(event) => { if (eligible) event.preventDefault() }}
              onDrop={(event) => {
                event.preventDefault()
                if (draggedCard && eligible) void handleBoardDrop(draggedCard, column.id)
              }}
              title={dragging
                ? (eligible
                  ? `Drop here to run "${draggedCard!.recommendedAction!.label}" for ${draggedCard!.projectLabel}`
                  : `${draggedCard!.projectLabel}'s next eligible step is ${draggedCard!.recommendedAction?.label ?? '(none)'} — not this lane`)
                : undefined}
            >
              <div className="board-column-header">
                <h3>{column.title}</h3>
                <span className="column-count">{column.cards.length}</span>
              </div>
              {columnStep && dragging && !eligible && (
                <p className="empty-state" style={{ fontSize: 11, opacity: 0.6, margin: 0, padding: '4px 6px 8px' }}>
                  Not the next step for {draggedCard!.projectLabel}
                </p>
              )}
              <div className="board-stack">
                {column.cards.filter(cardMatches).length === 0 && !dragging && <p className="empty-state">{boardQ ? 'No matches' : 'No projects'}</p>}
                {column.cards.filter(cardMatches).map((card) => (
                  <article
                    key={card.projectNamespace}
                    className="board-card board-summary-card"
                    // Only draggable if there's actually a next-step action to
                    // trigger. Projects sitting in 'done' with no follow-up
                    // step shouldn't be draggable at all — nothing to trigger.
                    draggable={!!card.recommendedAction}
                    onDragStart={() => { setDraggedProjectNamespace(card.projectNamespace); setDraggedCard(card) }}
                    onDragEnd={() => { setDraggedProjectNamespace(''); setDraggedCard(null) }}
                    onClick={() => void openProject(card)}
                  >
                    <div className="board-card-top">
                      <strong>{card.code && <span className="code-badge">{card.code}</span>} {card.projectLabel}</strong>
                      <span className={`mini-badge ${card.latestRun?.status ?? 'idle'}`}>{card.status}</span>
                      {card.archivedAt && <span className="mini-badge archived">archived</span>}
                      {card.pausedAt && !card.archivedAt && <span className="mini-badge paused">paused</span>}
                    </div>
                    <p className="board-card-copy">{card.feature || 'No active feature yet'}</p>
                    <div className="summary-grid">
                      <div><span>Project</span><strong>{card.projectNamespace}</strong></div>
                      <div><span>Agent</span><strong>{card.currentAgent}</strong></div>
                      <div><span>Estimate</span><strong>{card.estimate}</strong></div>
                      <div><span>Verify</span><strong>{card.verificationStatus}</strong></div>
                      {card.usage && card.usage.calls > 0 && <div><span>Spend</span><strong>{formatUsd(card.usage.costUsd)}</strong></div>}
                    </div>
                    {card.automationState && card.automationState.state !== 'idle' && card.automationState.state !== 'completed' && (
                      <button
                        className={`automation-badge ${card.automationState.state}`}
                        onClick={(event) => {
                          event.stopPropagation()
                          void openProject(card, 'assistant')
                        }}
                        type="button"
                      >
                        {card.automationState.state.replace('_', ' ')}
                      </button>
                    )}
                    <div className="compact-gates">
                      {card.gateReadiness.map((gate) => (
                        <button
                          key={`${card.projectNamespace}-${gate.stage}`}
                          className={`compact-gate ${gate.color}`}
                          title={`${gate.stage}: ${gate.reason}`}
                          onClick={(event) => {
                            event.stopPropagation()
                            void openProject(card, gate.tab as ProjectModalTab)
                          }}
                          type="button"
                        >
                          {gate.stage.slice(0, 2)}
                        </button>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )})}
        </div>
        )}
      </section>
      )}
      </>)}

      {isProjectModalOpen && !teamPageSlug && !orgPageOpen && selectedCardFresh && (
        <section className="project-page" aria-label={selectedCardFresh.projectLabel}>
          <div className="project-page-shell">
            <header className="project-hero">
              <div className="project-hero-main">
                <div className="project-tile" aria-hidden="true">{(selectedCardFresh.code ?? selectedCardFresh.projectLabel).split('-')[0].slice(0, 4)}</div>
                <div className="project-hero-text">
                  <div className="breadcrumb">
                    <button type="button" className="ghost-button" onClick={() => closeProject()} title="Back to the board (Esc)">← Board</button>
                    {selectedCardFresh.code && (
                      <button type="button" className="code-badge code-badge-button" title="Copy project link" onClick={() => { void navigator.clipboard?.writeText(`${window.location.origin}/spaces/${selectedCardFresh.code}`); setStatusMessage(`Link to ${selectedCardFresh.code} copied.`) }}>
                        {selectedCardFresh.code}
                      </button>
                    )}
                    {projectDetail?.archivedAt && <span className="mini-badge archived">archived</span>}
                    {projectDetail?.pausedAt && !projectDetail.archivedAt && <span className="mini-badge paused">paused</span>}
                  </div>
                  <h1 className="project-title">{selectedCardFresh.projectLabel}</h1>
                  <p className="project-feature">{selectedCardFresh.feature || 'No active feature yet'}</p>
                  <div className="team-chips">
                    <span className={`chip lane ${selectedCardFresh.status}`}><strong>{selectedCardFresh.status}</strong> lane</span>
                    <span className={`chip run ${selectedCardFresh.latestRun?.status ?? 'idle'}`}>
                      {selectedCardFresh.latestRun ? <>run <strong>{selectedCardFresh.latestRun.status}</strong>{selectedCardFresh.latestRun.stage ? ` · ${selectedCardFresh.latestRun.stage}` : ''}</> : 'no runs yet'}
                    </span>
                    <span className={`chip verify ${selectedCardFresh.verificationStatus}`}>verify <strong>{selectedCardFresh.verificationStatus}</strong></span>
                    <UsageChip usage={selectedCardFresh.usage} label="spend" />
                    {projectDetail && <span className="chip"><strong>{projectDetail.repos.filter((r) => r.label !== 'governance').length}</strong> repositor{projectDetail.repos.filter((r) => r.label !== 'governance').length === 1 ? 'y' : 'ies'}</span>}
                    {selectedCardFresh.automationState && selectedCardFresh.automationState.state !== 'idle' && selectedCardFresh.automationState.state !== 'completed' && (
                      <button className={`chip attention chip-button`} onClick={() => setActiveProjectTab('assistant')} type="button">{selectedCardFresh.automationState.state.replace('_', ' ')} →</button>
                    )}
                  </div>
                </div>
              </div>
            </header>

            <div className="tab-row project-tabs" role="tablist">
              {(['overview', 'specs', 'testplan', 'implementation', 'qa', 'assistant', 'context', 'memory', 'promotions'] as ProjectModalTab[]).map((tab) => {
                const needsAttention = tab === 'assistant' && selectedCardFresh.automationState && ['needs_approval', 'needs_clarification', 'error', 'blocked'].includes(selectedCardFresh.automationState.state)
                return (
                  <button
                    key={tab}
                    className={`tab-button ${activeProjectTab === tab ? 'active' : ''}`}
                    onClick={() => setActiveProjectTab(tab)}
                    type="button"
                    role="tab"
                    aria-selected={activeProjectTab === tab}
                  >
                    {TAB_LABELS[tab] ?? tab}
                    {needsAttention && <span className="tab-dot" aria-label="needs attention" />}
                  </button>
                )
              })}
            </div>

            <div className="modal-body">

            {selectedCardFresh.recommendedAction && (
              <div className="recommended-banner">
                <div>
                  <strong>Next step: {selectedCardFresh.recommendedAction.label}</strong>
                  <p>{selectedCardFresh.recommendedAction.reason}</p>
                </div>
                <div className="button-row">
                  <button
                    className="primary-button"
                    disabled={busy}
                    onClick={() => void executeStep(selectedCardFresh.recommendedAction!.step, selectedCardFresh.recommendedAction!.tab)}
                    type="button"
                  >
                    {selectedCardFresh.recommendedAction.label}
                  </button>
                  <button className="secondary-button" onClick={() => setActiveProjectTab(selectedCardFresh.recommendedAction!.tab)} type="button">
                    Open {TAB_LABELS[selectedCardFresh.recommendedAction.tab] ?? selectedCardFresh.recommendedAction.tab}
                  </button>
                </div>
              </div>
            )}


            <div className="gate-strip">
              {gateReadiness.map((gate) => (
                <button
                  key={gate.stage}
                  className={`gate-pill ${gate.color}`}
                  title={gate.reason}
                  onClick={() => setActiveProjectTab(gate.tab as ProjectModalTab)}
                  type="button"
                >
                  <strong>{gate.stage}</strong>
                  <span>{gate.reason}</span>
                </button>
              ))}
            </div>

            {activeProjectTab === 'overview' && (
              <div className="modal-grid project-overview">
                <div className="stat-grid project-stats">
                  <div className="stat card"><span className="stat-label">Lane</span><strong className="stat-value stat-text">{selectedCardFresh.status}</strong><span className="stat-sub">{selectedCardFresh.currentAgent ? `agent: ${selectedCardFresh.currentAgent}` : 'no agent active'}</span></div>
                  <div className="stat card"><span className="stat-label">Run</span><strong className="stat-value stat-text">{selectedCardFresh.latestRun?.status ?? '—'}</strong><span className="stat-sub">{selectedCardFresh.latestRun?.stage ? `stage ${selectedCardFresh.latestRun.stage}` : 'no run yet'}</span></div>
                  <div className="stat card"><span className="stat-label">Verification</span><strong className="stat-value stat-text">{selectedCardFresh.verificationStatus}</strong><span className="stat-sub">{selectedCardFresh.estimate}</span></div>
                  <div className="stat card"><span className="stat-label">Jobs</span><strong className="stat-value">{projectJobs.filter((j) => ['running', 'queued', 'claimed'].includes(j.displayStatus)).length}</strong><span className="stat-sub">{projectJobs.filter((j) => j.displayStatus === 'paused').length} paused · {projectJobs.length} recent</span></div>
                </div>
                <ProjectUsagePanel projectNamespace={selectedCardFresh.projectNamespace} live={selectedCardFresh.latestRun?.status === 'running' || selectedCardFresh.latestRun?.status === 'paused'} />
                <section className="card panel slim-panel">
                  <h3>Summary</h3>
                  <div className="auto-memory-box compact-box">
                    <pre>{currentRun?.executiveSummary || 'No executive summary yet — it appears once a run completes a stage.'}</pre>
                  </div>
                  <label>
                    Estimate
                    <input value={estimateInput} onChange={(event) => setEstimateInput(event.target.value)} placeholder="e.g. 1-2 weeks" />
                  </label>
                  <div className="button-row">
                    <button className="secondary-button" onClick={() => void saveEstimate()} disabled={busy || !estimateInput.trim()} type="button">Save estimate</button>
                  </div>
                  <h3>Repositories</h3>
                  {projectDetail?.suggestionsJson?.newRepository && !projectDetail.repos.some((r) => r.kind === 'github' && r.githubRepo?.split('/')[1]?.toLowerCase() === projectDetail.suggestionsJson!.newRepository!.name.toLowerCase()) && (
                    <NewRepoCard
                      projectId={projectDetail.projectId}
                      proposal={projectDetail.suggestionsJson.newRepository}
                      onCreated={async (fullName) => { setStatusMessage(`Created ${fullName} on GitHub — cloning in the background.`); await refreshProjectRepos() }}
                      onAttachExisting={(fullName) => setRepoForm((c) => ({ ...c, open: true, kind: 'github', githubRepo: fullName, label: fullName.split('/').pop() ?? fullName }))}
                    />
                  )}
                  {projectDetail?.suggestionsJson && (projectDetail.suggestionsJson.repositories.length > 0 || projectDetail.suggestionsJson.workAreas.length > 0) && (
                    <div className="repo-row" style={{ borderColor: 'rgba(94, 106, 210, 0.45)' }}>
                      <div className="repo-row-main">
                        <strong>Suggested from the {projectDetail.suggestionsJson.basis === 'plan' ? 'plan' : 'project description and your GitHub catalog'}</strong>
                        <span className="repo-row-source">{formatTimestamp(projectDetail.suggestionsJson.generatedAt)}</span>
                        <button
                          className="ghost-button"
                          type="button"
                          style={{ marginLeft: 'auto', padding: '0 6px', fontSize: 11 }}
                          onClick={() => projectDetail && void postJson(`/api/projects/${projectDetail.projectId}/suggestions`, { basis: hasArtifact('Planned') ? 'plan' : 'project' }).then(() => refreshProjectRepos()).catch((error) => setStatusMessage(`Could not refresh suggestions: ${toMessage(error)}`))}
                        >refresh</button>
                      </div>
                      {projectDetail.suggestionsJson.repositories.filter((s) => !s.registered).map((s) => (
                        <div key={s.fullName} className="repo-row-main">
                          <code>{s.fullName}</code>
                          <span className="mini-badge idle">{s.confidence}</span>
                          {s.role && <span className="mini-badge idle">{s.role}</span>}
                          <span className="repo-row-source">{s.reason}</span>
                          <button className="secondary-button" type="button" style={{ marginLeft: 'auto' }} disabled={repoForm.busy} onClick={() => void addProjectRepo({ kind: 'github', label: s.fullName.split('/')[1] ?? s.fullName, githubRepo: s.fullName })}>
                            Add &amp; clone
                          </button>
                        </div>
                      ))}
                      {projectDetail.suggestionsJson.repositories.filter((s) => s.registered).length > 0 && (
                        <span className="repo-row-source">Already on the project: {projectDetail.suggestionsJson.repositories.filter((s) => s.registered).map((s) => s.fullName).join(', ')}</span>
                      )}
                      {projectDetail.suggestionsJson.workAreas.length > 0 && (
                        <div style={{ marginTop: 6 }}>
                          <strong style={{ fontSize: 12 }}>Work areas</strong>
                          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                            {projectDetail.suggestionsJson.workAreas.map((w) => (
                              <li key={w.name} style={{ fontSize: 12, marginBottom: 4 }}>
                                <strong>{w.name}</strong> — {w.description}
                                {w.repositories.length > 0 && <span className="repo-row-source"> · repos: {w.repositories.join(', ')}</span>}
                                {w.paths.length > 0 && <span className="repo-row-source"> · paths: {w.paths.join(', ')}</span>}
                                {w.risks && <span className="repo-row-source"> · risk: {w.risks}</span>}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {projectDetail.suggestionsJson.notes && <span className="field-hint">{projectDetail.suggestionsJson.notes}</span>}
                    </div>
                  )}
                  {planRepos.some((r) => !r.registered) && (
                    <div className="repo-row" style={{ borderColor: 'rgba(245, 158, 11, 0.4)' }}>
                      <strong>The plan depends on repositories not on this project</strong>
                      <span className="repo-row-source">From plan.md “## Repositories”. Add them so implementation and QA can run in the right checkouts.</span>
                      {planRepos.filter((r) => !r.registered).map((r) => (
                        <div key={r.name} className="repo-row-main">
                          <code>{r.name}</code>
                          {r.note && <span className="repo-row-source">{r.note}</span>}
                          {r.githubRepo ? (
                            <button className="secondary-button" type="button" style={{ marginLeft: 'auto' }} disabled={repoForm.busy} onClick={() => void addProjectRepo({ kind: 'github', label: r.githubRepo!.split('/')[1] ?? r.name, githubRepo: r.githubRepo })}>
                              Add &amp; clone
                            </button>
                          ) : (
                            <button className="ghost-button" type="button" style={{ marginLeft: 'auto' }} onClick={() => setRepoForm((c) => ({ ...c, open: true, label: r.name, kind: githubConnected ? 'github' : 'local' }))}>
                              Add…
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="repo-list">
                    {(projectDetail?.repos ?? []).length === 0 && <p className="empty-state">No repositories registered.</p>}
                    {(projectDetail?.repos ?? []).map((repo) => (
                      <div key={repo.repoId} className="repo-row">
                        <div className="repo-row-main">
                          <strong>{repo.label}</strong>
                          <span className="repo-row-source">{repo.kind === 'github' ? repo.githubRepo : repo.localPath}</span>
                          {repo.isPrimary
                            ? <span className="mini-badge">primary</span>
                            : <button className="ghost-button" type="button" style={{ padding: '0 6px', fontSize: 11 }} title="Make this the primary repo (Spec Kit artifacts live there)" onClick={() => void updateProjectRepo(repo, { isPrimary: true })}>make primary</button>}
                          {planRepos.some((r) => r.registered && r.repoId === repo.repoId) && <span className="mini-badge idle" title="Referenced by the current plan">in plan</span>}
                          <button
                            className="ghost-button"
                            type="button"
                            style={{ padding: '0 6px', fontSize: 11, marginLeft: 'auto' }}
                            onClick={() => {
                              const next = window.prompt(repo.kind === 'github' ? 'GitHub repo (owner/name)' : 'Local path', repo.kind === 'github' ? repo.githubRepo ?? '' : repo.localPath ?? '')
                              if (next && next.trim()) void updateProjectRepo(repo, repo.kind === 'github' ? { githubRepo: next.trim() } : { localPath: next.trim() })
                            }}
                          >edit</button>
                          {repo.localPath && (
                            <button
                              className="ghost-button"
                              type="button"
                              style={{ padding: '0 6px', fontSize: 11 }}
                              title="Re-read this repository and refresh project memory/context"
                              onClick={() => projectDetail && void postJson(`/api/projects/${projectDetail.projectId}/repos/${repo.repoId}/learn`, {}).then(() => setStatusMessage(`Re-learning ${repo.label}; project memory will update shortly.`)).catch((error) => setStatusMessage(`Could not re-learn: ${toMessage(error)}`))}
                            >relearn</button>
                          )}
                          {repo.kind === 'github' && repo.cloneStatus && (
                            <span className={`mini-badge ${repo.cloneStatus === 'error' ? 'error' : repo.cloneStatus === 'ready' ? 'success' : 'pending'}`}>
                              {CLONE_STATUS_LABEL[repo.cloneStatus]}
                            </span>
                          )}
                        </div>
                        {repo.kind === 'github' && repo.localPath && <span className="repo-row-path">{repo.localPath}</span>}
                        {repo.kind === 'github' && repo.cloneStatus === 'error' && (
                          <div className="repo-row-error">
                            <span className="error-text">{repo.cloneError}</span>
                            <button className="ghost-button" type="button" onClick={() => void retryRepoClone(repo)}>Retry clone</button>
                          </div>
                        )}
                      </div>
                    ))}
                    {!repoForm.open ? (
                      <div className="button-row">
                        <button className="secondary-button" type="button" onClick={() => setRepoForm((c) => ({ ...c, open: true, kind: githubConnected ? 'github' : 'local' }))}>+ Add repository</button>
                      </div>
                    ) : (
                      <div className="repo-row">
                        <div className="repo-row-main">
                          <select value={repoForm.kind} onChange={(event) => setRepoForm((c) => ({ ...c, kind: event.target.value as 'github' | 'local' }))}>
                            <option value="github">GitHub (owner/name)</option>
                            <option value="local">Local path</option>
                          </select>
                          <input placeholder="Label" value={repoForm.label} onChange={(event) => setRepoForm((c) => ({ ...c, label: event.target.value }))} />
                          {repoForm.kind === 'github' ? (
                            <input
                              list="github-repo-options"
                              placeholder="owner/name"
                              value={repoForm.githubRepo}
                              onFocus={() => void loadGitHubRepos()}
                              onChange={(event) => setRepoForm((c) => ({ ...c, githubRepo: event.target.value, label: c.label || event.target.value.split('/')[1] || '' }))}
                              autoComplete="off"
                            />
                          ) : (
                            <input placeholder="/absolute/path" value={repoForm.localPath} onChange={(event) => setRepoForm((c) => ({ ...c, localPath: event.target.value }))} />
                          )}
                        </div>
                        <div className="button-row">
                          <button
                            className="primary-button"
                            type="button"
                            disabled={repoForm.busy || (repoForm.kind === 'github' ? !/^[\w.-]+\/[\w.-]+$/.test(repoForm.githubRepo.trim()) : !repoForm.localPath.trim())}
                            onClick={() => void addProjectRepo({ kind: repoForm.kind, label: repoForm.label, githubRepo: repoForm.githubRepo, localPath: repoForm.localPath })}
                          >{repoForm.busy ? 'Adding…' : repoForm.kind === 'github' ? 'Add & clone' : 'Add'}</button>
                          <button className="ghost-button" type="button" onClick={() => setRepoForm((c) => ({ ...c, open: false, note: '' }))}>Cancel</button>
                          {repoForm.note && <span className="error-text" style={{ margin: 0 }}>{repoForm.note}</span>}
                        </div>
                        <datalist id="github-repo-options">
                          {(githubRepos ?? []).map((option) => <option key={option.fullName} value={option.fullName}>{option.description?.slice(0, 80) ?? option.fullName}</option>)}
                        </datalist>
                      </div>
                    )}
                  </div>
                  <h3>Recent changes</h3>
                  <div className="diff-group">
                    {selectedCardFresh.artifactDiffs.length === 0 && <p className="empty-state">No artifact diffs yet.</p>}
                    {selectedCardFresh.artifactDiffs.map((diff) => (
                      <div key={diff.id} className="diff-chip"><span>{diff.change}</span><strong>{diff.label}</strong></div>
                    ))}
                  </div>
                </section>
                {projectDetail && (
                  <section className="card panel slim-panel danger-zone">
                    <h3>{projectDetail.archivedAt ? 'Archived project' : 'Pause, archive or delete'}</h3>
                    {!projectDetail.archivedAt && (
                      <div className="button-row" style={{ marginBottom: 8 }}>
                        {projectDetail.pausedAt
                          ? <button type="button" className="primary-button" disabled={deletion.busy} onClick={() => void setPaused(false)}>Resume project</button>
                          : <button type="button" className="secondary-button" disabled={deletion.busy} onClick={() => void setPaused(true)}>Pause project</button>}
                        <span className="panel-subtitle">
                          {projectDetail.pausedAt
                            ? `Paused ${new Date(projectDetail.pausedAt).toLocaleString()}. Queued jobs are held and runs stopped at a stage boundary; resuming picks them up where they left off.`
                            : 'Holds queued jobs and lets running runs finish their current stage, then stops. Nothing is lost; resume any time.'}
                        </span>
                      </div>
                    )}
                    {projectDetail.archivedAt && (
                      <p className="panel-subtitle" style={{ margin: '0 0 8px' }}>Archived {new Date(projectDetail.archivedAt).toLocaleString()}. Hidden from the board; runs and jobs are refused until it is unarchived. Nothing has been removed.</p>
                    )}
                    {deletion.error && !deletion.open && <p className="error-text">{deletion.error}</p>}
                    {!deletion.open && !projectDetail.archivedAt && (
                      <div className="button-row">
                        <button type="button" className="secondary-button" disabled={deletion.busy} onClick={() => void setArchived(true)}>Archive project</button>
                        <span className="panel-subtitle">Recommended. Cancels anything queued, running or paused, keeps every run, artifact and memory, and moves the project to the Archived menu above the board. Reversible. Deletion is only offered for archived projects.</span>
                      </div>
                    )}
                    {!deletion.open && projectDetail.archivedAt && (
                      <div className="button-row">
                        <button type="button" className="secondary-button" disabled={deletion.busy} onClick={() => void setArchived(false)}>Unarchive</button>
                        <button type="button" className="danger-button" disabled={deletion.busy} onClick={() => void openDeletion()}>Delete permanently…</button>
                        <span className="panel-subtitle">Deleting cannot be undone: runs, memory, snapshots, the governing workspace and clones only this project uses are removed.</span>
                      </div>
                    )}
                    {deletion.open && (
                      <div className="knowledge-inline-form">
                        {deletion.loading && <span className="panel-subtitle">Checking what would be removed…</span>}
                        {deletion.error && <p className="error-text">{deletion.error}</p>}
                        {deletion.preview && !deletion.preview.allowed && <p className="error-text">Only owners or admins of this project's team can delete it.</p>}
                        {deletion.preview && !deletion.preview.archived && <p className="error-text">Archive the project first. Deletion is permanent; archiving keeps everything and can be undone.</p>}
                        {deletion.preview?.activity.active && (
                          <p className="error-text">Still active: {deletion.preview.activity.reasons.join('; ')}. Finish or cancel that work first.</p>
                        )}
                        {deletion.preview && !deletion.preview.activity.active && (
                          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                            <li>{deletion.preview.runs} run{deletion.preview.runs === 1 ? '' : 's'}, {deletion.preview.jobs} job{deletion.preview.jobs === 1 ? '' : 's'}, {deletion.preview.snapshots} imported snapshot{deletion.preview.snapshots === 1 ? '' : 's'}, memory, agents and orchestrator settings</li>
                            {deletion.preview.repos.map((r) => (
                              <li key={`${r.label}-${r.localPath ?? r.githubRepo ?? ''}`}>
                                <strong>{r.label}</strong>{' '}
                                {r.action === 'delete-workspace' && <>— governing workspace <code>{r.localPath}</code> will be removed</>}
                                {r.action === 'delete-clone' && <>— clone <code>{r.localPath ?? r.githubRepo}</code> will be removed</>}
                                {r.action === 'keep-shared' && <>— kept, another project also uses it</>}
                                {r.action === 'keep-local' && <>— your local checkout <code>{r.localPath}</code> is kept (only its worktrees are removed)</>}
                                {r.action === 'none' && <>— nothing on disk</>}
                              </li>
                            ))}
                          </ul>
                        )}
                        {deletion.preview && deletion.preview.allowed && deletion.preview.archived && !deletion.preview.activity.active && (
                          <div className="knowledge-inline-form">
                            <p className="error-text" style={{ margin: 0 }}>This cannot be undone. There is no trash and no restore.</p>
                            <div className="confirm-phrase">
                              <span className="panel-subtitle" style={{ margin: 0 }}>Type this to confirm:</span>
                              <code className="confirm-phrase-text" onClick={() => { void navigator.clipboard?.writeText(deletion.preview!.confirmPhrase); setStatusMessage('Confirmation phrase copied.') }} title="Click to copy">{deletion.preview.confirmPhrase}</code>
                              <button type="button" className="ghost-button" onClick={() => { void navigator.clipboard?.writeText(deletion.preview!.confirmPhrase); setStatusMessage('Confirmation phrase copied.') }}>Copy</button>
                            </div>
                            <div className="button-row">
                              <input value={deletion.confirm} onChange={(e) => setDeletion((d) => ({ ...d, confirm: e.target.value }))} placeholder={deletion.preview.confirmPhrase} autoFocus style={{ flex: 1 }} />
                              <button type="button" className="danger-button" disabled={deletion.busy || deletion.confirm.trim().toLowerCase().replace(/\s+/g, ' ') !== deletion.preview.confirmPhrase} onClick={() => void confirmDeletion()}>{deletion.busy ? 'Deleting…' : 'Delete permanently'}</button>
                            </div>
                          </div>
                        )}
                        <div className="button-row">
                          <button type="button" className="ghost-button" disabled={deletion.busy} onClick={() => setDeletion({ open: false, loading: false, preview: null, confirm: '', busy: false, error: '' })}>Cancel</button>
                        </div>
                      </div>
                    )}
                  </section>
                )}
                <section className="card panel slim-panel">
                  <h3>Orchestrator</h3>
                  {projectWorker && (
                    <p className="panel-subtitle" style={{ margin: '0 0 8px' }}>
                      Worker:{' '}
                      <span className={`mini-badge ${projectWorker.state === 'hot' ? 'running' : projectWorker.state === 'warm' || projectWorker.state === 'shared' ? 'completed' : 'idle'}`}>
                        {projectWorker.state === 'hot' && `● hot — ${projectWorker.worker?.activeJobs ?? 0} job${(projectWorker.worker?.activeJobs ?? 0) === 1 ? '' : 's'} running`}
                        {projectWorker.state === 'warm' && `○ warm — idle${(projectWorker.worker?.pausedRuns ?? 0) > 0 ? `, holding ${projectWorker.worker?.pausedRuns} paused run(s)` : ''}`}
                        {projectWorker.state === 'shared' && `shared worker (${projectWorker.sharedWorkers} online)`}
                        {projectWorker.state === 'stale' && 'stale — heartbeat missed'}
                        {projectWorker.state === 'none' && 'none — spawns when work is queued'}
                      </span>
                      {projectWorker.worker?.pid && <span style={{ marginLeft: 8 }}>pid {projectWorker.worker.pid}</span>}
                    </p>
                  )}
                  <p className="panel-subtitle">
                    Project-scoped run queue. One run in-flight per project by default; verify-loop
                    fixes and re-runs are serialized. Autonomous mode auto-approves human gates
                    (use only when you trust the pipeline to run unattended).
                  </p>
                  <div className="summary-grid details-grid">
                    <div>
                      <span>Autonomous mode</span>
                      <strong>
                        <button type="button" className={orchestrator?.autonomousMode ? 'primary-button' : 'ghost-button'} onClick={() => void toggleAutonomousMode()}>
                          {orchestrator?.autonomousMode ? 'ON' : 'OFF'}
                        </button>
                      </strong>
                    </div>
                    <div><span>Max concurrent</span><strong>{orchestrator?.maxConcurrent ?? '—'}</strong></div>
                    <div>
                      <span>Speed mode</span>
                      <strong>
                        <select
                          value={orchestrator?.speedMode ?? 'balanced'}
                          onChange={(e) => void setSpeedMode(e.target.value as 'fast' | 'balanced' | 'quality')}
                          style={{ width: 'auto', marginTop: 0, padding: '4px 8px', fontSize: 12 }}
                          title="Fast = Haiku across most stages (cheap, quick). Balanced = per-stage defaults. Quality = Sonnet + extended thinking (Opus for merges)."
                        >
                          <option value="fast">Fast</option>
                          <option value="balanced">Balanced</option>
                          <option value="quality">Quality</option>
                        </select>
                      </strong>
                    </div>
                    {/* Queue mechanics (what max_concurrent limits): count the jobs' own states, not their runs'. */}
                    <div><span>In-flight jobs</span><strong>{projectJobs.filter((j) => j.status === 'running' || j.status === 'claimed').length}</strong></div>
                    <div><span>Paused runs</span><strong>{projectJobs.filter((j) => j.displayStatus === 'paused').length}</strong></div>
                    <div><span>Queued</span><strong>{projectJobs.filter((j) => j.status === 'queued').length}</strong></div>
                    <div>
                      <span>Warm agents</span>
                      <strong>
                        {projectAgents.length === 0 ? '—' : projectAgents.map((a) => `${a.role}:${a.status}`).join(', ')}
                      </strong>
                    </div>
                  </div>
                  <h3 style={{ marginTop: 12 }}>Recent jobs</h3>
                  <p className="panel-subtitle" style={{ marginTop: 0 }}>Click a job to open its log in a modal.</p>
                  <div className="diff-group">
                    {projectJobs.length === 0 && <p className="empty-state">No jobs yet.</p>}
                    {projectJobs.slice(0, 8).map((j) => (
                      <button
                        key={j.jobId}
                        type="button"
                        className="diff-chip"
                        style={{ cursor: j.runId ? 'pointer' : 'default', background: 'transparent', border: '1px solid #e5e7eb', textAlign: 'left', width: '100%' }}
                        disabled={!j.runId}
                        title={j.runId ? `Load log for run ${j.runId.slice(0, 8)}…` : 'This job has no run to inspect.'}
                        onClick={() => j.runId && void loadRunLog(j.runId)}
                      >
                        <span
                          className={`mini-badge ${j.displayStatus === 'completed' ? 'completed' : j.displayStatus === 'error' ? 'error' : j.displayStatus === 'paused' ? 'paused' : j.displayStatus === 'queued' || j.displayStatus === 'superseded' || j.displayStatus === 'cancelled' ? 'idle' : 'running'}`}
                          title={j.displayStatus === 'superseded' ? 'An earlier attempt replaced by a later job for the same run (worker restart or rerun).' : j.runError ? j.runError : j.status !== j.displayStatus ? `Queue job state: ${j.status}; run state: ${j.displayStatus}` : undefined}
                        >
                          {j.displayStatus}{j.displayStatus === 'paused' && j.runPauseKind ? ` · ${j.runPauseKind}` : ''}
                        </span>
                        <strong>{j.runPipeline ?? j.kind}</strong>
                        {j.runStage && <small style={{ marginLeft: 8 }}>stage {j.runStage}</small>}
                        <small style={{ marginLeft: 8 }}>{j.triggerSource}</small>
                        {j.runId && <small style={{ marginLeft: 8, color: '#6b7280' }}>run {j.runId.slice(0, 8)}</small>}
                      </button>
                    ))}
                  </div>
                </section>
                <section className="card panel slim-panel">
                  <h3>Artifacts</h3>
                  <div className="artifact-group">
                    {selectedCardFresh.artifactLinks.map((artifact) => (
                      <a key={artifact.relativePath} className="artifact-link" href={artifact.href} target="_blank" rel="noreferrer">
                        <span>{artifact.stepLabel}</span>
                        <strong>{artifact.label}</strong>
                      </a>
                    ))}
                  </div>
                </section>
              </div>
            )}

            {activeProjectTab === 'specs' && (
              <section className="card panel slim-panel">
                <div className="section-header-row">
                  <h3>Specification workspace</h3>
                  <div className="button-row">
                    <button className="secondary-button" disabled={busy || !stepEligibility('specify').ok} title={stepEligibility('specify').reason} onClick={() => void executeStep('specify', 'specs')} type="button">Run specify</button>
                    <button className="primary-button" disabled={busy || !stepEligibility('plan').ok} title={stepEligibility('plan').reason} onClick={() => void executeStep('plan', 'specs')} type="button">Run plan</button>
                  </div>
                </div>
                <div className="artifact-group">
                  {specArtifacts.length === 0 && <p className="empty-state">No spec or planning artifacts yet.</p>}
                  {specArtifacts.map((artifact) => (
                    <a key={artifact.relativePath} className="artifact-link" href={artifact.href} target="_blank" rel="noreferrer">
                      <span>{artifact.stepLabel}</span>
                      <strong>{artifact.label}</strong>
                    </a>
                  ))}
                </div>
              </section>
            )}

            {activeProjectTab === 'testplan' && (
              <section className="card panel slim-panel">
                <div className="section-header-row">
                  <h3>Test planning workspace</h3>
                  <div className="button-row">
                    <button className="primary-button" disabled={busy || !stepEligibility('testplan').ok} title={stepEligibility('testplan').reason} onClick={() => void executeStep('testplan', 'testplan')} type="button">Run test plan</button>
                  </div>
                </div>
                <div className="artifact-group">
                  {testArtifacts.filter((artifact) => artifact.stepLabel === 'Test Plan').length === 0 && <p className="empty-state">No test plan artifact yet.</p>}
                  {testArtifacts.filter((artifact) => artifact.stepLabel === 'Test Plan').map((artifact) => (
                    <a key={artifact.relativePath} className="artifact-link" href={artifact.href} target="_blank" rel="noreferrer">
                      <span>{artifact.stepLabel}</span>
                      <strong>{artifact.label}</strong>
                    </a>
                  ))}
                </div>
              </section>
            )}

            {activeProjectTab === 'implementation' && (
              <div className="modal-grid triple-grid">
                <section className="card panel slim-panel" style={{ gridColumn: '1 / -1' }}>
                  <div className="section-header-row">
                    <div>
                      <h3>Task dependency graph</h3>
                      <p className="panel-subtitle">Derived from tasks.md — [P] tasks are dashed, phases flow left → right, colored by status (green=done, yellow=in progress, red=blocked, gray=todo).</p>
                    </div>
                    <div className="entry-links">
                      <span className="mini-badge idle">{taskGraph.nodes.length} nodes</span>
                      <span className="mini-badge idle">{taskGraph.edges.length} edges</span>
                    </div>
                  </div>
                  <TaskDependencyGraph graph={taskGraph} />
                </section>
                <section className="card panel slim-panel">
                  <div className="section-header-row">
                    <div>
                      <h3>Task tracker</h3>
                      <p className="panel-subtitle">Read-only view of tasks.md, grouped by story/phase.</p>
                    </div>
                    <div className="button-row">
                      <button className="secondary-button" disabled={busy || !stepEligibility('tasks').ok} title={stepEligibility('tasks').reason} onClick={() => void executeStep('tasks', 'implementation')} type="button">Run tasks</button>
                      <button className="secondary-button" disabled={busy || !stepEligibility('parallelize').ok} title={stepEligibility('parallelize').reason} onClick={() => void executeStep('parallelize', 'implementation')} type="button">Run parallelize</button>
                    </div>
                  </div>
                  <div className="tracker-list">
                    {groupedTasks.length === 0 && <p className="empty-state">No tasks parsed from tasks.md yet.</p>}
                    {groupedTasks.map((group) => (
                      <section key={group.group} className="tracker-group">
                        <div className="tracker-group-header">
                          <strong>{group.group}</strong>
                          <span>{group.items.length} tasks</span>
                        </div>
                        {group.items.map((task) => (
                          <article key={task.id} className="tracker-item">
                            <div className="tracker-item-top">
                              <label className="tracker-checkbox" title="Status is read from tasks.md ([X] vs [ ]). Edit tasks.md to change.">
                                <input checked={task.checked} readOnly type="checkbox" />
                                <strong>{task.id}</strong>
                              </label>
                              <div className="entry-links">
                                <span className={`mini-badge ${task.status === 'done' ? 'completed' : task.status === 'in_progress' ? 'running' : task.status === 'blocked' ? 'error' : 'idle'}`}>{task.status}</span>
                                {task.parallel && <span className="mini-badge completed">parallel</span>}
                                {task.story && <span className="mini-badge idle">{task.story}</span>}
                              </div>
                            </div>
                            <p>{task.description}</p>
                            <small>{task.raw}</small>
                            {task.lastRunReport && <a className="artifact-link inline-link compact-link" href={`/api/projects/${selectedProjectNamespace}/artifact?path=${encodeURIComponent(task.lastRunReport)}`} target="_blank" rel="noreferrer"><strong>Last run report</strong></a>}
                            <div className="button-row">
                              {/* Status is derived from tasks.md ([X] vs [ ]). Manual mark buttons removed
                                  when persistence was retired in the legacy cleanup — edit tasks.md to change state. */}
                              {task.status === 'done' ? (
                                <span className="mini-badge completed" title="Task marked complete in tasks.md">done — no action needed</span>
                              ) : task.status === 'blocked' ? (
                                <span className="mini-badge error" title="Task marked blocked in tasks.md">blocked</span>
                              ) : (
                                <>
                                  <button
                                    className="primary-button"
                                    disabled={busy || runInFlight || !hasArtifact('Test Plan')}
                                    title={
                                      !hasArtifact('Test Plan') ? 'Cannot run tasks before a test plan exists. Run testplan first.'
                                      : runInFlight ? `A run is currently ${currentRun?.status}. Wait or resolve it first.`
                                      : undefined
                                    }
                                    onClick={() => void runSpecificTask(task.id)}
                                    type="button"
                                  >Run task</button>
                                  {task.parallel && (
                                    <button
                                      className="secondary-button"
                                      disabled={busy || runInFlight || !hasArtifact('Test Plan')}
                                      title={
                                        !hasArtifact('Test Plan') ? 'Cannot run workstreams before a test plan exists.'
                                        : runInFlight ? `A run is currently ${currentRun?.status}. Wait or resolve it first.`
                                        : undefined
                                      }
                                      onClick={() => void runSpecificWorkstream(task.id)}
                                      type="button"
                                    >Run workstream</button>
                                  )}
                                </>
                              )}
                            </div>
                          </article>
                        ))}
                      </section>
                    ))}
                  </div>
                </section>
                <section className="card panel slim-panel">
                  <div className="section-header-row">
                    <h3>Implementation workstreams</h3>
                    <div className="button-row">
                      <button className="primary-button" disabled={busy || !stepEligibility('implement').ok} title={stepEligibility('implement').reason} onClick={() => void executeStep('implement', 'implementation')} type="button">Run implementation</button>
                      <button className="secondary-button" disabled={busy || !stepEligibility('orchestrate').ok} title={stepEligibility('orchestrate').reason} onClick={() => void executeStep('orchestrate', 'implementation')} type="button">Run orchestrate</button>
                    </div>
                  </div>
                  <div className="artifact-group">
                    {testArtifacts.filter((artifact) => ['Parallelize', 'Orchestrate'].includes(artifact.stepLabel)).length === 0 && <p className="empty-state">No implementation workstream artifacts yet.</p>}
                    {testArtifacts.filter((artifact) => ['Parallelize', 'Orchestrate'].includes(artifact.stepLabel)).map((artifact) => (
                      <a key={artifact.relativePath} className="artifact-link" href={artifact.href} target="_blank" rel="noreferrer">
                        <span>{artifact.stepLabel}</span>
                        <strong>{artifact.label}</strong>
                      </a>
                    ))}
                  </div>
                  <div className="button-row">
                    <button className="primary-button" disabled={qaBusy} onClick={() => void runParallelSubAgents()} type="button">Run implementation agents</button>
                    <button className="secondary-button" disabled={qaBusy || !selectedProjectNamespace} onClick={() => selectedProjectNamespace && void postJson(`/api/projects/${selectedProjectNamespace}/subagents/cancel`, {})} type="button">Cancel</button>
                    <button className="secondary-button" disabled={qaBusy || !selectedProjectNamespace} onClick={() => selectedProjectNamespace && void postJson(`/api/projects/${selectedProjectNamespace}/subagents/retry`, { maxAgents: 4 }).then(() => loadProjectQA(selectedProjectNamespace))} type="button">Retry</button>
                  </div>
                </section>
                <section className="card panel slim-panel">
                  <h3>Implementation progress</h3>
                  {qaOverview?.currentJob.status === 'error' && qaOverview.currentJob.error && (
                    <p className="error-text">Sub-agent job failed: {qaOverview.currentJob.error}</p>
                  )}
                  {(qaOverview?.currentJob.workstreams ?? []).length === 0 && <p className="empty-state">No active implementation workstreams.</p>}
                  {(qaOverview?.currentJob.workstreams ?? []).map((item) => (
                    <details key={`${item.workstream}-${item.outputFile ?? ''}`} className="qa-artifact" open={item.status === 'running' || item.status === 'error'}>
                      <summary>{item.workstream} • {item.status}</summary>
                      <p className="panel-subtitle">runtime: {formatDuration(item.runtimeMs)} • tokens: {item.estimatedTokens ?? 0}</p>
                      {(item.branch || item.pullRequestUrl) && (
                        <p className="panel-subtitle">
                          {item.branch && <>branch <code>{item.branch}</code>{item.baseBranch ? <> → <code>{item.baseBranch}</code></> : null}</>}
                          {item.pullRequestUrl && <> • <a href={item.pullRequestUrl} target="_blank" rel="noreferrer">Pull request</a></>}
                        </p>
                      )}
                      <pre className="context-preview small-preview">{item.log || item.summary || 'Waiting for updates...'}</pre>
                    </details>
                  ))}
                  {currentRun && ['tasks', 'parallelize', 'implement', 'orchestrate'].includes(currentRun.stage ?? '') && (
                    <>
                      <h3>Latest implementation agent output</h3>
                      <pre className="context-preview small-preview">{currentRun.log}</pre>
                    </>
                  )}
                </section>
              </div>
            )}

            {activeProjectTab === 'qa' && (
              <div className="modal-grid">
                <section className="card panel slim-panel">
                  <div className="section-header-row">
                    <div className="context-stats">
                      <span className={`mini-badge ${qaOverview?.verificationStatus === 'pass' ? 'completed' : qaOverview?.verificationStatus === 'fail' ? 'error' : qaOverview?.verificationStatus === 'partial' ? 'paused' : 'idle'}`}>verification: {qaOverview?.verificationStatus ?? 'missing'}</span>
                      <span className="mini-badge idle">reports: {qaOverview?.subagents.length ?? 0}</span>
                    </div>
                    <div className="button-row">
                      <button className="primary-button" disabled={busy || !stepEligibility('verify').ok} title={stepEligibility('verify').reason} onClick={() => void executeStep('verify', 'qa')} type="button">Run verify</button>
                      <button className="secondary-button" disabled={busy || !stepEligibility('review').ok} title={stepEligibility('review').reason ?? 'Code-review the implementation against spec/plan/tests and CI state; posts the review on the PR and requests changes or approves.'} onClick={() => void executeStep('review', 'qa')} type="button">Run review</button>
                      <button className="secondary-button" disabled={busy || !stepEligibility('deliver').ok} title={stepEligibility('deliver').reason ?? 'Track PRs through review, merge (in stack order), deploy and UAT; pauses for approval before merging or deploying.'} onClick={() => void executeStep('deliver', 'qa')} type="button">Run deliver</button>
                      <button className="secondary-button" disabled={qaBusy || !selectedProjectNamespace} onClick={() => selectedProjectNamespace && void loadProjectQA(selectedProjectNamespace)} type="button">Refresh QA</button>
                    </div>
                  </div>
                  <h3>Verification status</h3>
                  <p className="panel-subtitle">
                    {qaOverview?.verificationStatus === 'pass' ? 'Verification passed and project can be considered done.' : qaOverview?.verificationStatus === 'partial' ? 'Verification is partial and needs more evidence.' : qaOverview?.verificationStatus === 'fail' ? 'Verification failed and requires fixes.' : 'Verification has not been completed yet.'}
                  </p>
                  <h3>Job history</h3>
                  {(qaOverview?.jobHistory ?? []).length === 0 && <p className="empty-state">No sub-agent job history yet.</p>}
                  {(qaOverview?.jobHistory ?? []).map((job, index) => (
                    <details key={`${job.startedAt ?? 'job'}-${index}`} className="qa-artifact">
                      <summary>{job.startedAt ? formatTimestamp(job.startedAt) : 'Job'} • {job.status}</summary>
                      <pre className="context-preview small-preview">{JSON.stringify(job, null, 2)}</pre>
                    </details>
                  ))}
                </section>
                <section className="card panel slim-panel">
                  <h3>Specs & planning artifacts</h3>
                  {(qaOverview?.artifacts ?? []).map((artifact) => (
                    <details key={artifact.path} className="qa-artifact">
                      <summary>{artifact.label} {artifact.exists ? '' : '(missing)'}</summary>
                      <a className="artifact-link inline-link" href={`/api/projects/${selectedProjectNamespace}/artifact?path=${encodeURIComponent(artifact.path)}`} target="_blank" rel="noreferrer">Open artifact</a>
                      <pre className="context-preview small-preview">{artifact.content || 'No content available.'}</pre>
                    </details>
                  ))}
                  <h3>Completed sub-agent reports</h3>
                  {(qaOverview?.subagents ?? []).map((agent) => (
                    <details key={agent.outputFile} className="qa-artifact">
                      <summary>{agent.workstream}</summary>
                      <p className="panel-subtitle">runtime: {formatDuration(agent.runtimeMs)} • tokens: {agent.estimatedTokens}</p>
                      <a className="artifact-link inline-link" href={`/api/projects/${selectedProjectNamespace}/artifact?path=${encodeURIComponent(agent.outputFile)}`} target="_blank" rel="noreferrer">Open report</a>
                      <pre className="context-preview small-preview">{agent.log || agent.summary}</pre>
                    </details>
                  ))}
                </section>
              </div>
            )}

            {activeProjectTab === 'context' && (
              <section className="card panel slim-panel">
                <h3>Knowledge base</h3>
                <p className="panel-subtitle">
                  Pick which connected integrations and repositories this project's agents may query. Narrow each source so searches stay relevant and cheap; leave a scope blank for "everything in that source".
                </p>
                {!knowledgeScope && <p className="empty-state">Loading knowledge scope…</p>}
                {knowledgeScope && knowledgeScope.connected.length === 0 && (
                  <p className="empty-state">No knowledge integrations are connected. Connect Jira, Linear, Confluence or GitHub under Integrations.</p>
                )}
                {knowledgeScope && knowledgeScope.connected.length > 0 && (
                  <div className="repo-list">
                    {knowledgeScope.connected.map((source) => {
                      const selected = !knowledgeScope.config.sources || knowledgeScope.config.sources.includes(source)
                      const toggle = () => setKnowledgeScope((c) => {
                        if (!c) return c
                        const current = c.config.sources ?? c.connected
                        const next = current.includes(source) ? current.filter((s) => s !== source) : [...current, source]
                        return { ...c, config: { ...c.config, sources: next } }
                      })
                      return (
                        <div key={source} className="repo-row">
                          <label className="toggle" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <input type="checkbox" checked={selected} onChange={toggle} />
                            <strong>{KNOWLEDGE_SOURCE_LABEL[source]}</strong>
                          </label>
                          {selected && source === 'jira' && (
                            <label className="field-hint">Jira project keys (comma-separated)
                              <input value={(knowledgeScope.config.jira?.projects ?? []).join(', ')} onChange={(event) => setScopeList('jira.projects', event.target.value)} placeholder="PROJ, PLAT" />
                            </label>
                          )}
                          {selected && source === 'linear' && (
                            <>
                              <label className="field-hint">Linear team keys (comma-separated)
                                <input value={(knowledgeScope.config.linear?.teams ?? []).join(', ')} onChange={(event) => setScopeList('linear.teams', event.target.value)} placeholder="ENG, DES" />
                              </label>
                              <label className="field-hint">Linear project names (comma-separated)
                                <input value={(knowledgeScope.config.linear?.projects ?? []).join(', ')} onChange={(event) => setScopeList('linear.projects', event.target.value)} placeholder="Checkout revamp" />
                              </label>
                            </>
                          )}
                          {selected && source === 'confluence' && (
                            <label className="field-hint">Confluence space keys (comma-separated)
                              <input value={(knowledgeScope.config.confluence?.spaces ?? []).join(', ')} onChange={(event) => setScopeList('confluence.spaces', event.target.value)} placeholder="DOCS, ARCH" />
                            </label>
                          )}
                          {selected && source === 'github' && (
                            <div className="field-hint">
                              Repositories in scope
                              <div className="repo-list" style={{ marginTop: 4 }}>
                                {knowledgeScope.registeredRepos.length === 0 && <span>No GitHub repos registered on this project; add owner/name below.</span>}
                                {knowledgeScope.registeredRepos.map((repo) => {
                                  const chosen = knowledgeScope.config.github?.repos?.length ? knowledgeScope.config.github.repos.includes(repo) : true
                                  return (
                                    <label key={repo} className="toggle" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                      <input type="checkbox" checked={chosen} onChange={() => {
                                        const current = knowledgeScope.config.github?.repos?.length ? knowledgeScope.config.github.repos : knowledgeScope.registeredRepos
                                        const next = current.includes(repo) ? current.filter((r) => r !== repo) : [...current, repo]
                                        setScopeList('github.repos', next.join(','))
                                      }} />
                                      {repo}
                                    </label>
                                  )
                                })}
                              </div>
                              <input style={{ marginTop: 4 }} value={(knowledgeScope.config.github?.repos ?? []).filter((r) => !knowledgeScope.registeredRepos.includes(r)).join(', ')} onChange={(event) => {
                                const extra = event.target.value.split(',').map((v) => v.trim()).filter(Boolean)
                                const kept = (knowledgeScope.config.github?.repos ?? knowledgeScope.registeredRepos).filter((r) => knowledgeScope.registeredRepos.includes(r))
                                setScopeList('github.repos', [...kept, ...extra].join(','))
                              }} placeholder="Extra repos: owner/name, owner/other" />
                            </div>
                          )}
                        </div>
                      )
                    })}
                    <div className="button-row">
                      <button className="primary-button" type="button" disabled={knowledgeScopeBusy} onClick={() => void saveProjectKnowledge()}>Save knowledge scope</button>
                      {knowledgeScope.effective && <span className="field-hint">Effective sources: {knowledgeScope.effective.sources.length ? knowledgeScope.effective.sources.map((s) => KNOWLEDGE_SOURCE_LABEL[s as KnowledgeHit['source']]).join(', ') : 'none'}</span>}
                    </div>
                    {knowledgeScopeNote && <p className="field-hint">{knowledgeScopeNote}</p>}
                  </div>
                )}
                <h3>Shared context bundle</h3>
                <div className="context-stats">
                  <span className="mini-badge idle">Org docs: {sharedContext ? Object.keys(sharedContext.org).length : 0}</span>
                  <span className="mini-badge idle">Artifacts: {sharedContext?.featureArtifacts.length ?? 0}</span>
                  <span className="mini-badge idle">Sources: {sharedContext?.sourceSnapshots.length ?? 0}</span>
                </div>
                <pre className="context-preview modal-preview">{sharedContext?.promptBundle || 'No shared context yet.'}</pre>
              </section>
            )}

            {activeProjectTab === 'memory' && (
              <section className="card panel slim-panel">
                <textarea className="memory-editor" value={projectMemory} onChange={(event) => setProjectMemory(event.target.value)} placeholder="Capture durable product context, conventions, reviewer preferences, architecture decisions, and rollout rules here." />
                <div className="auto-memory-box">
                  <h3>Auto summary</h3>
                  <pre>{autoMemorySummary || 'AI will summarize completed reviews, runs, and artifact changes here.'}</pre>
                </div>
                <div className="button-row">
                  <button className="primary-button" disabled={memoryBusy} onClick={() => void saveProjectMemory()} type="button">Save memory</button>
                  <button className="secondary-button" disabled={memoryBusy || !selectedProjectNamespace} onClick={() => selectedProjectNamespace && void loadProjectMemory(selectedProjectNamespace)} type="button">Reload memory</button>
                  <button
                    className="secondary-button"
                    disabled={memoryBusy || !selectedProjectNamespace}
                    title="Read every registered repository that has no brief yet and recompose the auto summary (repository map, per-repo briefs, inventories)."
                    onClick={() => selectedProjectNamespace && void postJson<{ learning: string[]; repos: number }>(`/api/projects/${selectedProjectNamespace}/memory/rebuild`, {})
                      .then((r) => setMemoryStatus(r.learning.length ? `Learning ${r.learning.join(', ')}… reload in a minute or two.` : `Recomposed memory from ${r.repos} repositor${r.repos === 1 ? 'y' : 'ies'}.`))
                      .catch((error) => setMemoryStatus(`Rebuild failed: ${toMessage(error)}`))}
                    type="button"
                  >Rebuild from code</button>
                </div>
                <p className="panel-subtitle">{memoryStatus}</p>
              </section>
            )}

            {activeProjectTab === 'assistant' && (
              <section className="card panel slim-panel">
                {/* Executive summary + live log now live in the always-visible bar above the tabs. */}
                {selectedCardFresh.automationState?.assistantPrompt && (
                  <div className="auto-memory-box compact-box prompt-box">
                    <h3>{selectedCardFresh.automationState.state === 'needs_approval' ? 'Approval needed' : selectedCardFresh.automationState.state === 'needs_clarification' ? 'Clarification needed' : 'Automation note'}</h3>
                    <pre>{selectedCardFresh.automationState.assistantPrompt}</pre>
                  </div>
                )}
                {canAnswer && (
                  <div className="clarify-box">
                    {selectedCardFresh.automationState?.state === 'needs_clarification' ? (
                      <div className="guided-form">
                        <label>
                          Board item link / ID
                          <input value={clarifyForm.boardItem} onChange={(event) => setClarifyForm((current) => ({ ...current, boardItem: event.target.value }))} placeholder="AIDLC-123 or board link" />
                        </label>
                        <label>
                          Implementation repository / path
                          <input value={clarifyForm.repoPath} onChange={(event) => setClarifyForm((current) => ({ ...current, repoPath: event.target.value }))} placeholder="repo URL or local path" />
                        </label>
                        <div className="input-grid wizard-inline-grid">
                          <label>
                            Language / runtime
                            <input value={clarifyForm.runtime} onChange={(event) => setClarifyForm((current) => ({ ...current, runtime: event.target.value }))} placeholder="TypeScript / Node" />
                          </label>
                          <label>
                            Storage
                            <input value={clarifyForm.storage} onChange={(event) => setClarifyForm((current) => ({ ...current, storage: event.target.value }))} placeholder="Postgres / Supabase" />
                          </label>
                          <label>
                            Notification channel
                            <input value={clarifyForm.notification} onChange={(event) => setClarifyForm((current) => ({ ...current, notification: event.target.value }))} placeholder="Email / Slack / SMS" />
                          </label>
                          <label>
                            Test framework
                            <input value={clarifyForm.testFramework} onChange={(event) => setClarifyForm((current) => ({ ...current, testFramework: event.target.value }))} placeholder="Vitest / Playwright" />
                          </label>
                        </div>
                        <label>
                          Extra notes
                          <textarea value={clarifyForm.extra} onChange={(event) => setClarifyForm((current) => ({ ...current, extra: event.target.value }))} placeholder="Anything else the agent should know" />
                        </label>
                        <div className="button-row">
                          <button className="primary-button" onClick={() => void submitGuidedClarification()} disabled={busy || !clarifyForm.boardItem.trim() || !clarifyForm.repoPath.trim()} type="button">Answer unblock template</button>
                        </div>
                      </div>
                    ) : (
                      <p className="panel-subtitle" style={{ margin: 0 }}>
                        This run is paused. Use the <strong>AI agent output</strong> bar above (or the buttons there) to approve, continue, or send clarification. This tab is only used for structured unblock templates.
                      </p>
                    )}
                  </div>
                )}
                <h3>Ask AI</h3>
                <div className="chat-toolbar">
                  <input value={chatSearch} onChange={(event) => setChatSearch(event.target.value)} placeholder="Search chat, stages, or artifacts" />
                  <select value={chatKindFilter} onChange={(event) => setChatKindFilter(event.target.value as typeof chatKindFilter)}>
                    <option value="all">All</option>
                    <option value="chat">Chat</option>
                    <option value="input">Input</option>
                    <option value="review">Review</option>
                    <option value="agent">Agent</option>
                  </select>
                </div>
                <div className="chat-log modal-chat-log grouped-chat-log">
                  {groupedChatEntries.length === 0 && <p className="empty-state">Ask AI to explain artifacts, failures, or next steps.</p>}
                  {groupedChatEntries.map((group) => (
                    <section key={group.key} className="chat-group">
                      <div className="chat-group-header">
                        <strong>{group.label}</strong>
                        <span>{group.entries.length} entries</span>
                      </div>
                      {group.entries.map((entry, index) => (
                        <div key={`${entry.role}-${index}-${entry.createdAt ?? index}`} className={`chat-entry ${entry.role}`}>
                          <strong>{entry.role === 'user' ? 'You' : 'AI'}</strong>
                          <small>{entry.kind ?? 'chat'}{entry.createdAt ? ` • ${formatTimestamp(entry.createdAt)}` : ''}</small>
                          {entry.role === 'user'
                            ? <p>{entry.content}</p>
                            : <div className="markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(entry.content) }} />}
                          {((entry.relatedStages?.length ?? 0) > 0 || (entry.relatedArtifacts?.length ?? 0) > 0) && (
                            <div className="entry-links">
                              {(entry.relatedStages ?? []).map((stage) => (
                                <button
                                  key={stage}
                                  className="mini-badge idle stage-link"
                                  onClick={() => setActiveProjectTab(mapStageToTab(stage))}
                                  type="button"
                                >
                                  stage: {stage}
                                </button>
                              ))}
                              {(entry.relatedArtifacts ?? []).map((artifact) => (
                                <a key={`${artifact.path}-${artifact.label}`} className="artifact-link inline-link compact-link" href={`/api/projects/${selectedProjectNamespace}/artifact?path=${encodeURIComponent(artifact.path)}`} target="_blank" rel="noreferrer">
                                  <strong>{artifact.label}</strong>
                                  {artifact.excerpt && <span>{artifact.excerpt}</span>}
                                </a>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </section>
                  ))}
                </div>
                <textarea
                  value={chatInput}
                  onChange={(event) => setChatInput(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && chatInput.trim() && !busy) { event.preventDefault(); void sendChat() } }}
                  placeholder="Ask about this project, its runs and logs, or tell the assistant what to do (it can run steps, answer gates, add repos)."
                />
                <div className="button-row" style={{ alignItems: 'center' }}>
                  <button className="primary-button" disabled={busy || !chatInput.trim()} onClick={() => void sendChat()} type="button">{busy ? 'Thinking…' : 'Send'}</button>
                  <span className="field-hint" style={{ margin: 0 }}>⌘/Ctrl + Enter to send</span>
                </div>
              </section>
            )}

            {activeProjectTab === 'promotions' && (
              <section className="card panel slim-panel">
                <label>
                  Lesson title
                  <input value={promotionTitle} onChange={(event) => setPromotionTitle(event.target.value)} placeholder="Explicit approval states" />
                </label>
                <label>
                  Lesson content
                  <textarea value={promotionContent} onChange={(event) => setPromotionContent(event.target.value)} placeholder="Describe the reusable principle or guideline." />
                </label>
                <div className="button-row">
                  <button className="primary-button" disabled={promotionBusy || !selectedProjectNamespace} onClick={() => void createPromotion()} type="button">Submit proposal</button>
                </div>
                <div className="promotion-list">
                  {filteredPromotions.length === 0 && <p className="empty-state">No proposals for this project.</p>}
                  {filteredPromotions.map((proposal) => (
                    <article key={proposal.id} className="promotion-item">
                      <div className="review-card-header">
                        <strong>{proposal.title}</strong>
                        <span className={`mini-badge ${proposal.status === 'pending' ? 'paused' : proposal.status === 'approved' ? 'completed' : 'error'}`}>{proposal.status}</span>
                      </div>
                      <p>{proposal.content}</p>
                      <small>{formatTimestamp(proposal.createdAt)}</small>
                      {proposal.status === 'pending' && (
                        <div className="button-row">
                          <button className="primary-button" disabled={promotionBusy} onClick={() => void decidePromotion(proposal.id, 'approved')} type="button">Approve</button>
                          <button className="secondary-button" disabled={promotionBusy} onClick={() => void decidePromotion(proposal.id, 'rejected')} type="button">Reject</button>
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              </section>
            )}
            </div>
            {/* Always-visible AI agent output — persists across every tab.
                Only surface currentRun if it belongs to the currently-open
                project — protects the log from cross-project leaks caused by
                stale SSE subscriptions or overlapping loads. */}
            <AiAgentOutputBar
              currentRun={
                currentRun && (!currentRun.projectNamespace || currentRun.projectNamespace === selectedProjectNamespace)
                  ? currentRun
                  : null
              }
              runInFlight={runInFlight}
              nextStep={(() => {
                // Derive the next actionable step from artifact state (highest-milestone rule).
                if (!selectedCardFresh) return undefined
                if (!hasArtifact('Initialized')) return { step: 'init', label: 'Initialize the project scaffolding.', reason: 'No .specify/ or AGENTS.md yet.' }
                if (!hasArtifact('Specified')) return { step: 'specify', label: 'Write the feature specification.', reason: 'No spec.md found.' }
                if (!hasArtifact('Planned')) return { step: 'plan', label: 'Design the implementation plan.', reason: 'Spec exists but no plan.md.' }
                if (!hasArtifact('Tasked')) return { step: 'tasks', label: 'Break the plan into implementable tasks.', reason: 'Plan exists but no tasks.md.' }
                if (!hasArtifact('Test Plan')) return { step: 'testplan', label: 'Draft the test plan.', reason: 'Tasks exist but no test-plan.md.' }
                if (!hasArtifact('Parallelize')) return { step: 'parallelize', label: 'Group tasks into parallel workstreams.', reason: 'No parallel-workstreams.md yet.' }
                if (!hasArtifact('Verify')) {
                  // All tracked tasks done → verification is the next move, not more implementation.
                  const tasksDone = taskTrackerItems.length > 0 && taskTrackerItems.every((item) => item.status === 'done' || item.checked)
                  if (tasksDone) return { step: 'verify', label: 'Run verification.', reason: `All ${taskTrackerItems.length} tasks are complete — no verification report yet.` }
                  return { step: 'implement', label: 'Run implementation.', reason: 'Ready to code — no verification report yet.' }
                }
                if (selectedCardFresh.verificationStatus !== 'pass') return { step: 'verify', label: 'Re-run verify.', reason: `Verification status: ${selectedCardFresh.verificationStatus ?? 'unknown'}.` }
                return { step: 'implement', label: '✅ Pipeline complete. Kick a new feature via the wizard.', reason: 'Verified and done.' }
              })()}
              onRunNext={(step) => void executeStep(step, 'implementation')}
              canAnswer={canAnswer}
              onSendAnswer={(a) => void sendAnswer(a)}
              onRerun={(fromStage) => void rerunRun(fromStage)}
              onPause={() => void controlRun('pause')}
              onResume={() => void controlRun('resume')}
              onCancel={() => void controlRun('cancel')}
              projectPaused={Boolean(projectDetail?.pausedAt)}
              busy={busy}
            />
          </div>
        </section>
      )}

      {isIntegrationsModalOpen && (
        <div className="modal-overlay" onClick={() => { setIsIntegrationsModalOpen(false); void loadAppIntegrations() }}>
          <div className="modal-shell modal-sticky" style={{ maxWidth: 900, width: '92vw' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h2 style={{ margin: 0 }}>Integrations</h2>
                <p className="panel-subtitle" style={{ marginTop: 4 }}>What is connected for the whole organization.</p>
              </div>
              <button type="button" className="ghost-button" onClick={() => { setIsIntegrationsModalOpen(false); void loadAppIntegrations() }}>Close</button>
            </div>
            <div className="modal-body">
              <IntegrationsPanel readOnly />
            </div>
          </div>
        </div>
      )}

      {inspectedRun && (
        <div className="modal-overlay" onClick={() => setInspectedRun(null)}>
          <div className="modal-shell" style={{ maxWidth: 900, width: '90vw' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h2 style={{ margin: 0 }}>Run {inspectedRun.runId.slice(0, 8)} — {inspectedRun.pipeline ?? '(no pipeline)'}</h2>
                <div className="entry-links" style={{ marginTop: 6 }}>
                  <span className={`mini-badge ${inspectedRun.status === 'completed' ? 'completed' : inspectedRun.status === 'paused' ? 'paused' : inspectedRun.status === 'error' ? 'error' : 'running'}`}>{inspectedRun.status}</span>
                  {inspectedRun.stage && <span className="mini-badge idle">stage: {inspectedRun.stage}</span>}
                  {inspectedRun.pauseKind && <span className="mini-badge paused">{inspectedRun.pauseKind}</span>}
                  <span className="mini-badge idle">{new Date(inspectedRun.createdAt).toLocaleString()}</span>
                </div>
              </div>
              <button type="button" className="ghost-button" onClick={() => setInspectedRun(null)}>Close</button>
            </div>
            {inspectedRun.feature && (
              <p className="panel-subtitle" style={{ marginTop: 8 }}>
                <strong>Feature:</strong> {inspectedRun.feature}
              </p>
            )}
            {inspectedRun.executiveSummary && (
              <div className="auto-memory-box compact-box" style={{ marginTop: 8 }}>
                <strong>Executive summary</strong>
                <pre style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>{inspectedRun.executiveSummary}</pre>
              </div>
            )}
            {inspectedRun.error && (
              <div className="auto-memory-box compact-box prompt-box" style={{ marginTop: 8, borderLeft: '3px solid #dc2626' }}>
                <strong style={{ color: '#dc2626' }}>Error</strong>
                <pre style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>{inspectedRun.error}</pre>
              </div>
            )}
            <h3 style={{ marginTop: 12 }}>Log ({(inspectedRun.log ?? '').length.toLocaleString()} chars)</h3>
            <pre
              style={{ maxHeight: '55vh', overflow: 'auto', fontSize: 12, background: '#0f172a', color: '#e2e8f0', padding: 12, borderRadius: 6, whiteSpace: 'pre-wrap' }}
            >{inspectedRun.log || '(no log recorded)'}</pre>
            <div className="button-row" style={{ marginTop: 8 }}>
              <button type="button" className="ghost-button" onClick={() => setInspectedRun(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {stageInputPrompt && (
        <StageInputPromptModal
          title={stageInputPrompt.title}
          label={stageInputPrompt.label}
          placeholder={stageInputPrompt.placeholder}
          onSubmit={(v) => { stageInputPrompt.resolve(v); setStageInputPrompt(null) }}
          onCancel={() => { stageInputPrompt.resolve(null); setStageInputPrompt(null) }}
        />
      )}

      {isWizardOpen && (
        <div className="modal-overlay" onClick={() => setIsWizardOpen(false)}>
          <div className="modal-shell wizard-shell modal-sticky" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="New project">
            <div className="modal-header">
              <div className="modal-title">
                <h2>New project</h2>
                <p className="panel-subtitle">
                  {wizard.step === 1 && 'Name your project and describe what it does.'}
                  {wizard.step === 2 && 'Repositories are optional. Specs and memory live in a governing workspace; the plan names the code repositories from your GitHub catalog and they are cloned on demand. If nothing matches, discovery proposes a new repository to create.'}
                  {wizard.step === 3 && 'Optionally connect external systems now. You can add more later.'}
                  {wizard.step === 4 && 'Review, then optionally kick off the first AIDLC run.'}
                </p>
              </div>
              {!onboarding && <button className="ghost-button icon-button" onClick={() => setIsWizardOpen(false)} type="button" aria-label="Close" title="Close (Esc)">×</button>}
            </div>
            <ol className="stepper" aria-label="Steps">
              {([[1, 'Basics'], [2, 'Repositories'], [3, 'Integrations'], [4, 'First feature']] as Array<[1 | 2 | 3 | 4, string]>).map(([s, label]) => (
                <li key={s} className={wizard.step === s ? 'active' : wizard.step > s ? 'done' : ''}>
                  <button type="button" onClick={() => goToStep(s)} disabled={busy || !!onboarding}>
                    <span className="stepper-index">{wizard.step > s ? '✓' : s}</span>
                    <span>{label}</span>
                  </button>
                </li>
              ))}
            </ol>
            <div className="modal-body">

            {wizard.step === 1 && (
              <>
                <label>
                  Project name
                  <input value={wizard.name} onChange={(event) => setWizard((c) => ({ ...c, name: event.target.value }))} placeholder="ContractFlow" />
                </label>
                <label>
                  Description
                  <textarea value={wizard.description} onChange={(event) => setWizard((c) => ({ ...c, description: event.target.value }))} placeholder="What the product is, who it serves, and what constraints AI should respect." />
                </label>
                <div className="card" style={{ padding: 12, marginTop: 8 }}>
                  <strong>Import from Jira / Linear</strong>
                  <p className="panel-subtitle" style={{ margin: '4px 0 8px' }}>
                    Start from an existing ticket, epic or doc. It fills in the name, description and first feature, and is attached to the project so agents can cite it.
                    {knowledgeSources.length === 0 && ' Connect Jira, Linear, Confluence or GitHub under Integrations to enable this.'}
                  </p>
                  <div className="button-row" style={{ alignItems: 'stretch' }}>
                    <select value={importSearch.source} onChange={(event) => setImportSearch((c) => ({ ...c, source: event.target.value as KnowledgeHit['source'], results: [] }))} disabled={knowledgeSources.length === 0}>
                      {(['linear', 'jira', 'confluence', 'github'] as const).map((source) => (
                        <option key={source} value={source} disabled={!knowledgeSources.includes(source)}>
                          {KNOWLEDGE_SOURCE_LABEL[source]}{knowledgeSources.includes(source) ? '' : ' (not connected)'}
                        </option>
                      ))}
                    </select>
                    <input
                      style={{ flex: 1 }}
                      value={importSearch.query}
                      onChange={(event) => setImportSearch((c) => ({ ...c, query: event.target.value }))}
                      onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void runImportSearch() } }}
                      placeholder={importSearch.source === 'jira' ? 'PROJ-123 or search text (JQL works too)' : importSearch.source === 'linear' ? 'ENG-123 or search text' : importSearch.source === 'confluence' ? 'Page title or CQL' : 'Issue/PR search'}
                      disabled={knowledgeSources.length === 0}
                    />
                    <button className="secondary-button" type="button" disabled={importSearch.loading || !importSearch.query.trim() || knowledgeSources.length === 0} onClick={() => void runImportSearch()}>
                      {importSearch.loading ? 'Searching…' : 'Search'}
                    </button>
                  </div>
                  {importSearch.note && <p className="field-hint">{importSearch.note}</p>}
                  {importSearch.results.length > 0 && (
                    <div className="repo-list" style={{ marginTop: 8 }}>
                      {importSearch.results.map((hit) => (
                        <div key={`${hit.source}-${hit.id}`} className="repo-row">
                          <div className="repo-row-main">
                            <strong>{hit.id}</strong>
                            <span>{hit.title}</span>
                            {hit.status && <span className="mini-badge idle">{hit.status}</span>}
                            <button className="ghost-button" type="button" style={{ marginLeft: 'auto' }} disabled={importSearch.loading} onClick={() => void useImportedItem(hit)}>Use</button>
                          </div>
                          {hit.snippet && <span className="repo-row-source">{hit.snippet}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                  {importedItems.length > 0 && (
                    <p className="field-hint">Attached: {importedItems.map((item) => `${KNOWLEDGE_SOURCE_LABEL[item.source]} ${item.id}`).join(', ')}</p>
                  )}
                </div>
              </>
            )}

            {wizard.step === 2 && (
              <>
                <div className="card" style={{ padding: 12, marginBottom: 10 }}>
                  <strong>How repositories work here</strong>
                  <p className="panel-subtitle" style={{ margin: '4px 0 0' }}>
                    Every project gets a <em>governing workspace</em> (a local git repo) that owns the Spec Kit workspace, specs, plans, tasks, reports and memory.
                    Code repositories are optional now: {githubConnected
                      ? 'GitHub is connected, so all repositories you can see are indexed with their use cases; onboarding suggests the relevant ones and the plan names the ones each feature touches — they are cloned, learned and set up automatically.'
                      : 'connect GitHub under Integrations to have your repositories indexed and suggested automatically, or add them here by owner/name or local path.'}
                  </p>
                </div>
                {wizard.repos.map((repo, idx) => (
                  <div key={repo.id} className="card" style={{ padding: 12, marginBottom: 8 }}>
                    <div className="input-grid wizard-inline-grid">
                      <label>
                        Label
                        <input value={repo.label} onChange={(event) => setWizard((c) => ({ ...c, repos: c.repos.map((r, i) => i === idx ? { ...r, label: event.target.value } : r) }))} placeholder="api" />
                      </label>
                      <label>
                        Kind
                        <select value={repo.kind} onChange={(event) => setWizard((c) => ({ ...c, repos: c.repos.map((r, i) => i === idx ? { ...r, kind: event.target.value as 'local' | 'github' } : r) }))}>
                          <option value="local">Local path</option>
                          <option value="github">GitHub (owner/name)</option>
                        </select>
                      </label>
                    </div>
                    {repo.kind === 'local' ? (
                      <label>
                        Local path
                        <input value={repo.localPath} onChange={(event) => setWizard((c) => ({ ...c, repos: c.repos.map((r, i) => i === idx ? { ...r, localPath: event.target.value } : r) }))} placeholder="/absolute/path/to/repo" />
                      </label>
                    ) : (
                      <label>
                        GitHub repo
                        <input
                          list="github-repo-options"
                          value={repo.githubRepo}
                          onFocus={() => void loadGitHubRepos()}
                          onChange={(event) => {
                            const value = event.target.value
                            setWizard((c) => ({
                              ...c,
                              repos: c.repos.map((r, i) => i === idx
                                ? { ...r, githubRepo: value, label: r.label || value.split('/')[1] || '' }
                                : r),
                            }))
                          }}
                          placeholder={githubConnected ? 'Start typing to search your GitHub repos…' : 'acme/api-server'}
                          autoComplete="off"
                        />
                        <datalist id="github-repo-options">
                          {(githubRepos ?? []).map((option) => (
                            <option key={option.fullName} value={option.fullName}>
                              {option.private ? '🔒 ' : ''}{option.description ? option.description.slice(0, 80) : option.fullName}
                            </option>
                          ))}
                        </datalist>
                        <span className="field-hint">
                          {githubReposNote || (githubConnected ? 'Pick a repository; it will be cloned locally when the project is created.' : 'Connect GitHub under Integrations to pick from your repositories, or type owner/name.')}
                        </span>
                      </label>
                    )}
                    <div className="button-row" style={{ marginTop: 8 }}>
                      <label className="toggle">
                        <input type="radio" name="primary-repo" checked={repo.isPrimary} onChange={() => setWizard((c) => ({ ...c, repos: c.repos.map((r, i) => ({ ...r, isPrimary: i === idx })) }))} />
                        Primary (runs target this by default)
                      </label>
                      {wizard.repos.length > 1 && (
                        <button className="ghost-button" type="button" onClick={() => setWizard((c) => ({ ...c, repos: c.repos.filter((_, i) => i !== idx) }))}>Remove</button>
                      )}
                    </div>
                  </div>
                ))}
                <div className="button-row">
                  <button className="secondary-button" type="button" onClick={() => setWizard((c) => ({ ...c, repos: [...c.repos, newRepoDraft(false)] }))}>+ Add another repo</button>
                </div>
              </>
            )}

            {wizard.step === 3 && (
              <div className="card" style={{ padding: 16 }}>
                <h3 style={{ marginTop: 0 }}>App-level integrations</h3>
                <p className="panel-subtitle" style={{ marginTop: 4 }}>
                  Integrations are now configured once for the whole app, not per project.
                  Every project shares the same GitHub / Atlassian / Slack connection.
                </p>
                <p style={{ marginTop: 8 }}>
                  Click <strong>Integrations</strong> on the main page to connect them
                  (before or after creating this project — doesn't matter).
                </p>
              </div>
            )}

            {onboarding && (
              <div className="wizard-onboarding-panel" aria-live="polite">
                <div className="onboarding-heading">
                  <span className={`onboarding-orb ${onboarding.snapshot.status}`} />
                  <div>
                    <strong>
                      {onboarding.snapshot.status === 'running' && `Setting up “${onboarding.projectName}”`}
                      {onboarding.snapshot.status === 'ready' && `“${onboarding.projectName}” is ready`}
                      {onboarding.snapshot.status === 'error' && `“${onboarding.projectName}” needs attention`}
                      {onboarding.snapshot.status === 'idle' && `Preparing “${onboarding.projectName}”`}
                    </strong>
                    <p className="panel-subtitle">
                      {onboarding.snapshot.status === 'running' && 'Cloning, reading and remembering your codebase so the first run starts informed.'}
                      {onboarding.snapshot.status === 'ready' && 'Repositories are local and project memory is built.'}
                      {onboarding.snapshot.status === 'error' && (onboarding.snapshot.error ?? 'Something went wrong during onboarding.')}
                      {onboarding.snapshot.status === 'idle' && 'Starting…'}
                    </p>
                  </div>
                </div>
                <ol className="onboarding-steps">
                  {onboarding.snapshot.steps.map((step) => (
                    <li key={step.id} className={`onboarding-step ${step.status}`}>
                      <span className="onboarding-step-icon">
                        {step.status === 'done' && '✓'}
                        {step.status === 'error' && '!'}
                        {step.status === 'skipped' && '–'}
                        {step.status === 'active' && <span className="onboarding-spinner" />}
                        {step.status === 'pending' && ''}
                      </span>
                      <div className="onboarding-step-body">
                        <span className="onboarding-step-label">{step.label}</span>
                        <span className="onboarding-step-detail">
                          {step.status === 'active' && (step.hints[onboardingHintIndex % Math.max(1, step.hints.length)] ?? '')}
                          {step.status !== 'active' && (step.detail ?? (step.status === 'skipped' ? 'Skipped' : ''))}
                        </span>
                      </div>
                    </li>
                  ))}
                </ol>
                {onboardingReview && (
                  <div className="card" style={{ padding: 12, marginTop: 14 }}>
                    <strong>Suggested repositories &amp; work areas</strong>
                    <p className="panel-subtitle" style={{ margin: '4px 0 8px' }}>
                      Based on {onboardingReview.suggestions.basis === 'plan' ? 'the plan' : 'your description and GitHub catalog'}. Add the repositories the work needs now, or continue and let the plan add them later.
                    </p>
                    {onboardingReview.suggestions.newRepository && (
                      <NewRepoCard
                        compact
                        projectId={onboardingReview.projectId}
                        proposal={onboardingReview.suggestions.newRepository}
                        onCreated={(fullName) => { setOnboardingReview((c) => c ? { ...c, suggestions: { ...c.suggestions, newRepository: undefined, repositories: [...c.suggestions.repositories, { fullName, reason: 'Created during discovery.', confidence: 'high', role: 'primary code', registered: true }] } } : c) }}
                      />
                    )}
                    {onboardingReview.suggestions.repositories.length > 0 && (
                      <div className="repo-list">
                        {onboardingReview.suggestions.repositories.map((r) => (
                          <div key={r.fullName} className="repo-row">
                            <div className="repo-row-main">
                              <code>{r.fullName}</code>
                              <span className="mini-badge idle">{r.confidence}</span>
                              {r.role && <span className="mini-badge idle">{r.role}</span>}
                              {r.registered
                                ? <span className="mini-badge success">on project</span>
                                : (
                                  <button className="secondary-button" type="button" style={{ marginLeft: 'auto' }} disabled={onboardingReview.adding.includes(r.fullName)} onClick={() => void addSuggestedRepo(onboardingReview.projectId, r.fullName)}>
                                    {onboardingReview.adding.includes(r.fullName) ? 'Adding…' : 'Add & clone'}
                                  </button>
                                )}
                            </div>
                            <span className="repo-row-source">{r.reason}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {onboardingReview.suggestions.workAreas.length > 0 && (
                      <>
                        <strong style={{ fontSize: 12 }}>Work areas</strong>
                        <ul style={{ margin: '4px 0 8px', paddingLeft: 18 }}>
                          {onboardingReview.suggestions.workAreas.map((w) => (
                            <li key={w.name} style={{ fontSize: 12, marginBottom: 4 }}>
                              <strong>{w.name}</strong> — {w.description}
                              {w.repositories.length > 0 && <span className="repo-row-source"> · {w.repositories.join(', ')}</span>}
                              {w.paths.length > 0 && <span className="repo-row-source"> · {w.paths.join(', ')}</span>}
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                    {onboardingReview.suggestions.notes && <p className="field-hint">{onboardingReview.suggestions.notes}</p>}
                    <div className="button-row">
                      <button className="primary-button" type="button" disabled={onboardingReview.adding.length > 0} onClick={() => onboardingReview.resolve()}>
                        Continue{wizard.firstFeature.trim() ? ' and start the first run' : ''}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
            {!onboarding && wizard.step === 4 && (
              <>
                <div className="card" style={{ padding: 12, marginBottom: 8 }}>
                  <strong>{wizard.name}</strong>
                  {wizard.description && <p style={{ margin: '4px 0' }}>{wizard.description}</p>}
                  <p style={{ margin: '4px 0', fontSize: 13 }}>
                    {(() => {
                      const filled = wizard.repos.filter((r) => r.label.trim() || r.localPath.trim() || r.githubRepo.trim()).length
                      return filled === 0
                        ? 'No code repositories yet — a governing workspace is created for specs and memory; onboarding will suggest repositories and the plan adds the ones each feature needs.'
                        : `${filled} code repo${filled === 1 ? '' : 's'} + a governing workspace for specs and memory`
                    })()}
                  </p>
                </div>
                <label>
                  First feature (optional — leave blank to just create the project)
                  <textarea value={wizard.firstFeature} onChange={(event) => setWizard((c) => ({ ...c, firstFeature: event.target.value }))} placeholder="Add an approval lane before documents can be sent for signature" />
                </label>
                <label>
                  Planning context (optional)
                  <textarea value={wizard.planContext} onChange={(event) => setWizard((c) => ({ ...c, planContext: event.target.value }))} placeholder="Extra implementation constraints or delivery expectations." />
                </label>
                <div className="input-grid wizard-inline-grid">
                  <label>
                    AI-DLC Scope
                    <select value={wizard.pipelineName} onChange={(event) => setWizard((c) => ({ ...c, pipelineName: event.target.value }))}>
                      <optgroup label="Adaptive lifecycles">
                        <option value="aidlc-classic">aidlc-classic — v1 default, no ideation</option>
                        <option value="aidlc-mvp">aidlc-mvp — skip operations, ship the core</option>
                        <option value="aidlc-feature">aidlc-feature — full lifecycle at practical depth</option>
                        <option value="aidlc-enterprise">aidlc-enterprise — full audit trail, strict change control</option>
                      </optgroup>
                      <optgroup label="Incremental">
                        <option value="aidlc-bugfix">aidlc-bugfix — fix a specific bug</option>
                        <option value="aidlc-refactor">aidlc-refactor — clean up existing code</option>
                        <option value="aidlc-security-patch">aidlc-security-patch — CVE / vulnerability response</option>
                      </optgroup>
                      <optgroup label="Focused">
                        <option value="aidlc-poc">aidlc-poc — prove feasibility fast</option>
                        <option value="aidlc-infra">aidlc-infra — infrastructure changes</option>
                        <option value="aidlc-workshop">aidlc-workshop — facilitated group session</option>
                        <option value="aidlc-express">aidlc-express — lightest run, no reviewers</option>
                      </optgroup>
                      <optgroup label="Demo / test">
                        <option value="aidlc-verify-loop">aidlc-verify-loop — demo loop-back branching</option>
                        <option value="test-minimal">test-minimal — 2-stage smoke test</option>
                      </optgroup>
                    </select>
                  </label>
                  <label>
                    Model
                    <input value={wizard.model} onChange={(event) => setWizard((c) => ({ ...c, model: event.target.value }))} placeholder={serverDefaultModel} title="Leave empty for automatic routing (Organization → Models)" />
                  </label>
                </div>
              </>
            )}

            <div className="button-row wizard-actions">
              {wizard.step > 1 && (
                <button className="ghost-button" disabled={busy} onClick={() => goToStep((wizard.step - 1) as 1 | 2 | 3 | 4)} type="button">Back</button>
              )}
              {wizard.step < 4 && (
                <button className="primary-button" disabled={busy} onClick={() => goToStep((wizard.step + 1) as 1 | 2 | 3 | 4)} type="button">Next</button>
              )}
              {wizard.step === 4 && !onboarding && (
                <>
                  <button className="secondary-button" disabled={busy} onClick={() => void submitWizard(false)} type="button">Create project only</button>
                  <button className="primary-button" disabled={busy || !wizard.firstFeature.trim()} onClick={() => void submitWizard(true)} type="button">Create + run AIDLC</button>
                </>
              )}
            </div>
            </div>
          </div>
        </div>
      )}
        </section>
      </div>
    </main>
  )
}

/**
 * Themed input modal for stage-required inputs (feature, constitution,
 * checklistDomain). Reuses the same modal-overlay/modal-shell classes as
 * every other modal in the app so it inherits the Linear-style theme,
 * blur overlay, and slide-up animation. Replaces the jarring window.prompt().
 * Submit on ⌘/Ctrl+Enter or the button; Esc or clicking the overlay cancels.
 */
function StageInputPromptModal({
  title, label, placeholder, onSubmit, onCancel,
}: {
  title: string
  label: string
  placeholder: string
  onSubmit: (value: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Autofocus on open + Esc to cancel.
  useEffect(() => {
    textareaRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  function submit() {
    const trimmed = value.trim()
    if (!trimmed) return
    onSubmit(trimmed)
  }

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-shell" style={{ maxWidth: 560, width: '90vw' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2 style={{ margin: 0 }}>{title}</h2>
            <p className="panel-subtitle" style={{ marginTop: 4 }}>{label}</p>
          </div>
          <button type="button" className="ghost-button" onClick={onCancel}>Cancel</button>
        </div>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          rows={4}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className="button-row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
          <button type="button" className="secondary-button" onClick={onCancel}>Cancel</button>
          <button type="button" className="primary-button" disabled={!value.trim()} onClick={submit}>
            Continue
          </button>
        </div>
        <p className="panel-subtitle" style={{ marginTop: 8, fontSize: 11 }}>
          ⌘/Ctrl+Enter to submit · Esc to cancel
        </p>
      </div>
    </div>
  )
}

function findBoardCardByNamespace(board: BoardResponse, namespace: string): BoardCard | null {
  for (const column of board.columns) {
    const match = column.cards.find((card) => card.projectNamespace === namespace)
    if (match) return match
  }
  return null
}

function AiAgentOutputBar({
  currentRun,
  nextStep,
  onRunNext,
  runInFlight,
  canAnswer,
  onSendAnswer,
  onRerun,
  onPause,
  onResume,
  onCancel,
  projectPaused,
  busy,
}: {
  currentRun: RunSnapshot | null
  nextStep?: { step: string; label: string; reason?: string }
  onRunNext?: (step: string) => void
  runInFlight?: boolean
  canAnswer?: boolean
  onSendAnswer?: (answer: string) => void
  onRerun?: (fromStage?: string) => void
  onPause?: () => void
  onResume?: () => void
  onCancel?: () => void
  projectPaused?: boolean
  busy?: boolean
}) {
  const [answerDraft, setAnswerDraft] = useState('')
  const logRef = useRef<HTMLPreElement>(null)
  const isActive = currentRun?.status === 'running' || currentRun?.status === 'paused'
  const needsInput = currentRun?.status === 'paused'
  // null = follow the run (open while active or waiting); true/false = the user's choice.
  const [openChoice, setOpenChoice] = useState<boolean | null>(null)
  const expanded = openChoice ?? (isActive || needsInput)
  const dockRef = useRef<HTMLElement>(null)
  // Clicking anywhere outside the dock collapses it so it never blocks the page.
  useEffect(() => {
    if (!expanded) return
    const onDown = (e: MouseEvent) => { if (dockRef.current && !dockRef.current.contains(e.target as Node)) setOpenChoice(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [expanded])
  // A new question or review request re-opens the dock even after it was dismissed.
  useEffect(() => { if (needsInput) setOpenChoice(null) }, [needsInput, currentRun?.runId])
  const stages = currentRun?.stages ?? []
  const stageIndex = currentRun?.stage ? stages.indexOf(currentRun.stage) : -1
  const canPause = currentRun?.status === 'running' && !currentRun.queued
  const canPauseQueued = currentRun?.status === 'running' && !!currentRun.queued
  const canResume = currentRun?.status === 'paused' && currentRun.pauseKind === 'user' && !projectPaused
  const canCancel = !!currentRun && ['running', 'paused'].includes(currentRun.status)

  // Follow the stream only while the reader is at the bottom; scrolling up to
  // read pauses following until they return (or press the arrow).
  const [followLog, setFollowLog] = useState(true)
  useEffect(() => {
    if (isActive && followLog && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [currentRun?.log, isActive, followLog])
  const onLogScroll = () => {
    const el = logRef.current
    if (!el) return
    setFollowLog(el.scrollHeight - el.scrollTop - el.clientHeight < 40)
  }
  const scrollLog = (where: 'top' | 'bottom') => {
    const el = logRef.current
    if (!el) return
    el.scrollTo({ top: where === 'top' ? 0 : el.scrollHeight, behavior: 'smooth' })
    setFollowLog(where === 'bottom')
  }

  return (
    <>
    {expanded && <div className="dock-backdrop" aria-hidden="true" />}
    <section ref={dockRef} className={`card panel slim-panel agent-dock ${expanded ? 'open' : 'collapsed'} ${needsInput && currentRun?.pauseKind !== 'user' ? 'needs-input' : ''} ${currentRun?.status === 'error' ? 'failed' : ''}`} aria-label="AI agent output">
      {(() => {
        const total = stages.length
        const done = currentRun?.status === 'completed' ? total : Math.max(0, stageIndex)
        const failed = currentRun?.status === 'error'
        const statusKey = !currentRun ? 'idle' : currentRun.status === 'completed' ? 'completed' : currentRun.status === 'paused' ? 'paused' : failed ? (currentRun!.interrupted ? 'paused' : 'error') : currentRun.status === 'cancelled' ? 'idle' : 'running'
        const statusText = !currentRun ? 'no run'
          : currentRun.status === 'running' ? (currentRun.queued ? 'queued' : 'running')
          : failed ? (currentRun.interrupted ? 'interrupted' : 'failed')
          : currentRun.status
        const retryStage = failed ? currentRun?.stage : undefined
        const controls = currentRun && (
          <span className="dock-controls" onClick={(e) => e.stopPropagation()}>
            {failed && onRerun && <button type="button" className="dock-icon accent" disabled={busy || runInFlight} onClick={() => onRerun(retryStage)} title={retryStage ? `Retry from stage ${retryStage}` : 'Retry from the start'} aria-label="Retry">↻</button>}
            {(canPause || canPauseQueued) && onPause && <button type="button" className="dock-icon" disabled={busy} onClick={onPause} title={canPauseQueued ? 'Hold this run before it starts' : 'Finish the current stage, then pause'} aria-label="Pause">❙❙</button>}
            {canResume && onResume && <button type="button" className="dock-icon accent" disabled={busy} onClick={onResume} title="Resume from the paused stage" aria-label="Resume">▶</button>}
            {canCancel && onCancel && <button type="button" className="dock-icon danger" disabled={busy} onClick={onCancel} title="Cancel this run" aria-label="Cancel">✕</button>}
          </span>
        )
        if (!expanded) {
          return (
            <div className="dock-mini" onClick={() => setOpenChoice(true)} role="button" aria-expanded={false} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenChoice(true) } }} title="Open the agent output">
              <span className={`dock-dot ${statusKey}`} aria-hidden="true" />
              <span className="dock-mini-title">Agent</span>
              <span className="dock-mini-status">{statusText}{currentRun?.stage ? ` · ${currentRun.stage}` : ''}{currentRun?.usage?.calls ? ` · ${formatUsd(currentRun.usage.costUsd)}` : ''}</span>
              {needsInput && currentRun?.pauseKind !== 'user' && <span className="dock-pill-badge attention">{currentRun?.pauseKind === 'review' ? 'approval needed' : 'answer needed'}</span>}
              {failed && <span className="dock-pill-badge danger">{currentRun?.interrupted ? 'worker restarted' : 'agent failed'}</span>}
              {total > 0 && (
                <span className="dock-mini-progress" title={`${done} of ${total} stages complete`}>
                  <span className="dock-bar"><span style={{ width: `${Math.round((done / total) * 100)}%` }} /></span>
                  <span className="dock-mini-count">{done}/{total}</span>
                </span>
              )}
              {controls}
              <span className="dock-chevron" aria-hidden="true">▴</span>
            </div>
          )
        }
        return (
          <div className="section-header-row dock-header" onClick={() => setOpenChoice(false)} role="button" aria-expanded tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenChoice(false) } }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h3 style={{ margin: 0 }}>
                <span className={`dock-dot ${statusKey}`} aria-hidden="true" /> Agent output
                <span className={`mini-badge ${statusKey}`}>{statusText}</span>
                <UsageChip usage={currentRun?.usage} className="dock-usage" />
                {total > 0 && <span className="mini-badge idle" title="Stages complete">{done}/{total} stages</span>}
                {currentRun?.stage && <span className="mini-badge idle">{currentRun.stage}</span>}
                {currentRun?.pauseKind && currentRun.pauseKind !== 'user' && <span className="mini-badge paused">{currentRun.pauseKind}</span>}
                {needsInput && currentRun?.pauseKind !== 'user' && <span className="mini-badge paused">needs you</span>}
              </h3>
              <p className="panel-subtitle dock-summary" style={{ margin: '4px 0 0' }}>
                {failed
                  ? (currentRun?.interrupted ? `The worker restarted during ${currentRun.stage ?? 'the run'}; retry continues from that stage.` : `Failed${currentRun?.stage ? ` at ${currentRun.stage}` : ''}: ${currentRun?.error?.split('\n')[0]?.slice(0, 160) ?? 'no error detail recorded'}`)
                  : currentRun?.executiveSummary || (currentRun ? `${currentRun.pipeline ?? 'pipeline'} · ${currentRun.feature ?? 'no feature'}` : 'No active or loaded run yet.')}
              </p>
              {total > 0 && (
                <ol className="dock-progress" aria-label="Stage progress">
                  {stages.map((stage, i) => (
                    <li key={`${stage}-${i}`} className={i < stageIndex || currentRun?.status === 'completed' ? 'done' : i === stageIndex ? (currentRun?.status === 'paused' ? 'paused' : currentRun?.status === 'running' ? 'active' : currentRun?.status === 'error' ? 'error' : 'current') : ''} title={stage}>
                      <span />{stage}
                    </li>
                  ))}
                </ol>
              )}
            </div>
            <div className="entry-links" onClick={(e) => e.stopPropagation()}>
              {(canPause || canPauseQueued) && onPause && <button type="button" className="secondary-button dock-button" disabled={busy} onClick={onPause} title={canPauseQueued ? 'Hold this run before it starts' : 'Finish the current stage, then pause'}>Pause</button>}
              {canResume && onResume && <button type="button" className="primary-button dock-button" disabled={busy} onClick={onResume}>Resume</button>}
              {canCancel && onCancel && <button type="button" className="danger-button dock-button" disabled={busy} onClick={onCancel}>Cancel</button>}
              {failed && onRerun && <button type="button" className="primary-button dock-button" disabled={busy || runInFlight} onClick={() => onRerun(retryStage)}>{retryStage ? `Retry from ${retryStage}` : 'Retry'}</button>}
              <button type="button" className="dock-icon" onClick={() => setOpenChoice(false)} title="Collapse" aria-label="Collapse">▾</button>
            </div>
          </div>
        )
      })()}
      <div className="dock-body">
      {expanded && (
        <div className="dock-log-wrap">
          <pre
            ref={logRef}
            className="context-preview modal-preview run-log"
            onScroll={onLogScroll}
          >
            {currentRun?.log || (isActive ? '⏳ Warming up… the agent should start streaming any moment. (If nothing appears within ~30s, check the worker log — the run may have hit a provider error.)' : '(no log yet)')}
          </pre>
          <div className="dock-scrollers" aria-label="Scroll the log">
            <button type="button" className="dock-icon" onClick={() => scrollLog('top')} title="Scroll to top" aria-label="Scroll to top">↑</button>
            <button type="button" className={`dock-icon ${followLog ? 'accent' : ''}`} onClick={() => scrollLog('bottom')} title={followLog ? 'Following the live output' : 'Scroll to bottom and follow'} aria-label="Scroll to bottom">↓</button>
          </div>
          {isActive && !followLog && <button type="button" className="dock-new-output" onClick={() => scrollLog('bottom')}>New output below ↓</button>}
        </div>
      )}
      {/* Paused-run answer UI — moved here from the Assistant tab so users don't have
          to navigate to answer. Shows when currentRun is paused and resumable. */}
      {expanded && currentRun?.status === 'paused' && currentRun.pauseKind === 'user' && (
        <div className="notice notice-warning">
          <div className="notice-title">
            <strong>Paused</strong>
            <span className="mini-badge paused">next stage: {currentRun.stage ?? 'unknown'}</span>
          </div>
          <p style={{ margin: '6px 0 0' }}>
            {projectPaused ? 'The whole project is paused. Resume it from the Overview tab; this run continues from the stage shown.' : 'This run is paused. Resume to continue from the stage shown, or cancel it.'}
          </p>
          {!projectPaused && onResume && <div className="button-row" style={{ marginTop: 8 }}><button type="button" className="primary-button" disabled={busy} onClick={onResume}>Resume run</button></div>}
        </div>
      )}
      {expanded && canAnswer && currentRun?.status === 'paused' && currentRun.pauseKind !== 'user' && onSendAnswer && (
        <div className="notice notice-warning">
          <div className="notice-title">
            <strong>{currentRun.pauseKind === 'review' ? 'Waiting for your review' : 'The agent has a question'}</strong>
            <span className="mini-badge paused">stage: {currentRun.stage ?? 'unknown'}</span>
          </div>
          <textarea
            autoFocus
            value={answerDraft}
            onChange={(e) => setAnswerDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && answerDraft.trim()) { e.preventDefault(); onSendAnswer(answerDraft); setAnswerDraft('') } }}
            placeholder={currentRun.pauseKind === 'review' ? 'Optional notes — applied to this stage before the run moves on when you approve. Or describe changes to request another pass.' : 'Answer the agent, or press Continue if nothing was actually asked…'}
            style={{ minHeight: 60 }}
          />
          <div className="button-row" style={{ marginTop: 8 }}>
            {currentRun.pauseKind === 'review' && (
              <button
                type="button"
                className="primary-button"
                onClick={() => { onSendAnswer(answerDraft.trim() ? `approve: ${answerDraft.trim()}` : 'approve'); setAnswerDraft('') }}
                title={answerDraft.trim() ? 'Approve; your notes are applied to this stage first, then the run continues' : 'Approve and continue to the next stage'}
              >{answerDraft.trim() ? 'Approve with notes' : 'Approve and continue'}</button>
            )}
            {currentRun.pauseKind !== 'review' && (
              <button
                type="button"
                className="primary-button"
                onClick={() => { onSendAnswer(answerDraft.trim() ? `continue: ${answerDraft.trim()}` : 'continue'); setAnswerDraft('') }}
                title="Send 'continue' — useful when the pause was a false-positive and no real question was asked."
              >Continue</button>
            )}
            <button
              type="button"
              className="secondary-button"
              disabled={!answerDraft.trim()}
              onClick={() => { onSendAnswer(answerDraft); setAnswerDraft('') }}
            >Send{answerDraft.trim() ? '' : ' (type something first)'}</button>
          </div>
        </div>
      )}
      {/* Failed or interrupted run: explain what happened and offer a rerun. */}
      {expanded && currentRun && currentRun.status === 'error' && onRerun && (
        <div className={`notice ${currentRun.interrupted ? 'notice-warning' : 'notice-error'}`}>
          <div className="notice-title">
            <strong>
              {currentRun.interrupted ? 'Run interrupted' : 'Run failed'}
              {currentRun.stage ? ` at stage ${currentRun.stage}` : ''}
            </strong>
          </div>
          <p className="notice-body">
            {currentRun.interrupted
              ? 'The worker process restarted while this run was in progress. Nothing else went wrong; earlier stages’ artifacts are intact.'
              : (currentRun.error ?? 'No error detail recorded.')}
          </p>
          <div className="button-row">
            {currentRun.stage && (
              <button type="button" className="primary-button" disabled={busy || runInFlight} onClick={() => onRerun(currentRun.stage)}>
                Rerun from {currentRun.stage}
              </button>
            )}
            <button type="button" className="secondary-button" disabled={busy || runInFlight} onClick={() => onRerun('start')}>
              Rerun from start
            </button>
          </div>
        </div>
      )}
      {/* Paused run whose worker restarted: answering restarts the stage; say so. */}
      {expanded && currentRun && currentRun.status === 'paused' && currentRun.interrupted && (
        <p style={{ marginTop: 8, fontSize: 12, color: '#9a3412' }}>
          ⚠ The worker that paused this run has restarted. Approving continues to the next stage on a fresh worker; any other answer re-runs stage {currentRun.stage ?? '?'} with your answer recorded in the timeline.
        </p>
      )}
      {expanded && nextStep && !isActive && !canAnswer && (
        <div style={{ marginTop: 10, padding: 10, background: '#f0f9ff', borderRadius: 6, borderLeft: '3px solid #0ea5e9', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <strong style={{ color: '#075985' }}>Next up:</strong>{' '}
            <span>{nextStep.label}</span>
            {nextStep.reason && <div style={{ fontSize: 12, color: '#0369a1', marginTop: 4 }}>{nextStep.reason}</div>}
          </div>
          {onRunNext && (
            <button
              type="button"
              className="primary-button"
              disabled={runInFlight}
              onClick={() => onRunNext(nextStep.step)}
              title={runInFlight ? 'A run is already in progress.' : `Run ${nextStep.step}`}
            >
              Run {nextStep.step}
            </button>
          )}
        </div>
      )}
      </div>
    </section>
    </>
  )
}

interface DepGraph {
  nodes: Array<{ id: string; label: string; phase: string; story?: string; parallel: boolean; status: string }>
  edges: Array<{ from: string; to: string }>
}

function TaskDependencyGraph({ graph }: { graph: DepGraph }) {
  if (graph.nodes.length === 0) {
    return <p className="empty-state">Dependency graph appears once tasks.md exists.</p>
  }

  // Layout: columns = distinct phases, rows = tasks stacked within each phase.
  const phaseOrder: string[] = []
  const byPhase = new Map<string, typeof graph.nodes>()
  for (const n of graph.nodes) {
    if (!byPhase.has(n.phase)) { byPhase.set(n.phase, []); phaseOrder.push(n.phase) }
    byPhase.get(n.phase)!.push(n)
  }

  const nodeW = 100
  const nodeH = 34
  const colGap = 60
  const rowGap = 14
  const padding = 16

  // Compute positions
  const positions = new Map<string, { x: number; y: number; w: number; h: number }>()
  let x = padding
  let maxColHeight = 0
  for (const phase of phaseOrder) {
    const nodes = byPhase.get(phase)!
    let y = padding + 22 // room for phase label
    for (const n of nodes) {
      positions.set(n.id, { x, y, w: nodeW, h: nodeH })
      y += nodeH + rowGap
    }
    maxColHeight = Math.max(maxColHeight, y)
    x += nodeW + colGap
  }
  const width = x - colGap + padding
  const height = maxColHeight + padding

  const colorFor = (status: string) => {
    if (status === 'done') return '#16a34a'
    if (status === 'in_progress') return '#eab308'
    if (status === 'blocked') return '#dc2626'
    return '#6b7280'
  }

  return (
    <div style={{ overflowX: 'auto', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fafafa' }}>
      <svg width={width} height={height} style={{ display: 'block' }}>
        {/* Phase labels */}
        {phaseOrder.map((phase, i) => {
          const px = padding + i * (nodeW + colGap)
          return (
            <text key={phase} x={px} y={14} fontSize={11} fontWeight={600} fill="#374151">
              {phase.length > 22 ? phase.slice(0, 20) + '…' : phase}
            </text>
          )
        })}
        {/* Edges */}
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8" />
          </marker>
        </defs>
        {graph.edges.map((e, i) => {
          const a = positions.get(e.from)
          const b = positions.get(e.to)
          if (!a || !b) return null
          const x1 = a.x + a.w
          const y1 = a.y + a.h / 2
          const x2 = b.x
          const y2 = b.y + b.h / 2
          const midX = (x1 + x2) / 2
          return (
            <path
              key={i}
              d={`M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`}
              stroke="#94a3b8"
              strokeWidth={1}
              fill="none"
              markerEnd="url(#arrow)"
            />
          )
        })}
        {/* Nodes */}
        {graph.nodes.map((n) => {
          const p = positions.get(n.id)!
          return (
            <g key={n.id}>
              <rect
                x={p.x} y={p.y} width={p.w} height={p.h}
                rx={4}
                fill="white"
                stroke={colorFor(n.status)}
                strokeWidth={n.parallel ? 2 : 1}
                strokeDasharray={n.parallel ? '4 2' : undefined}
              />
              <text x={p.x + 8} y={p.y + 14} fontSize={11} fontWeight={600} fill="#111827">{n.label}</text>
              <text x={p.x + 8} y={p.y + 27} fontSize={9} fill={colorFor(n.status)}>
                {n.status}{n.story ? ` · ${n.story}` : ''}{n.parallel ? ' · P' : ''}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

function parseTaskTracker(markdown?: string): TaskTrackerItem[] {
  if (!markdown) {
    return []
  }

  return markdown
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^- \[ \] T\d+/i.test(line))
    .map((line) => {
      const id = line.match(/T\d+/i)?.[0] ?? 'TASK'
      const parallel = line.includes('[P]')
      const story = line.match(/\[US\d+\]/i)?.[0]
      const description = line
        .replace(/^- \[ \] /, '')
        .replace(/T\d+/i, '')
        .replace(/\[P\]/g, '')
        .replace(/\[US\d+\]/gi, '')
        .trim()
      return {
        id,
        parallel,
        story,
        description,
        raw: line,
        group: story ?? 'General',
        checked: false,
        status: 'todo' as const,
        updatedAt: new Date(0).toISOString(),
      }
    })
}

function mapStageToTab(stage: string): ProjectModalTab {
  switch (stage) {
    case 'research':
    case 'specify':
    case 'plan':
      return 'specs'
    case 'tasks':
      return 'tracker'
    case 'testplan':
      return 'testplan'
    case 'parallelize':
    case 'orchestrate':
    case 'implement':
      return 'implementation'
    case 'verify':
      return 'qa'
    default:
      return 'overview'
  }
}

function buildGateReadiness(card: BoardCard, qaOverview: QAOverview | null): GateReadiness[] {
  const hasStep = (label: string) => card.artifactLinks.some((artifact) => artifact.stepLabel === label)
  const implementing = card.status === 'implementing' || card.currentAgent === 'implement' || card.currentAgent === 'parallel-subagents'

  return [
    {
      stage: 'specify',
      tab: 'specs',
      color: hasStep('Specified') ? 'green' : card.currentAgent === 'specify' ? 'yellow' : 'red',
      reason: hasStep('Specified') ? 'spec ready' : card.currentAgent === 'specify' ? 'in progress' : 'missing spec',
    },
    {
      stage: 'plan',
      tab: 'specs',
      color: hasStep('Planned') ? 'green' : card.currentAgent === 'plan' ? 'yellow' : 'red',
      reason: hasStep('Planned') ? 'plan ready' : card.currentAgent === 'plan' ? 'in progress' : 'missing plan',
    },
    {
      stage: 'tasks',
      tab: 'tracker',
      color: hasStep('Tasked') ? 'green' : card.currentAgent === 'tasks' ? 'yellow' : 'red',
      reason: hasStep('Tasked') ? 'tasks ready' : card.currentAgent === 'tasks' ? 'in progress' : 'missing tasks',
    },
    {
      stage: 'test',
      tab: 'testplan',
      color: hasStep('Test Plan') ? 'green' : card.currentAgent === 'testplan' ? 'yellow' : 'red',
      reason: hasStep('Test Plan') ? 'test plan ready' : card.currentAgent === 'testplan' ? 'in progress' : 'missing test plan',
    },
    {
      stage: 'parallel',
      tab: 'qa',
      color: hasStep('Parallelize') ? 'green' : card.currentAgent === 'parallelize' || qaOverview?.currentJob.status === 'running' ? 'yellow' : 'red',
      reason: hasStep('Parallelize') ? 'workstreams ready' : card.currentAgent === 'parallelize' || qaOverview?.currentJob.status === 'running' ? 'in progress' : 'missing workstreams',
    },
    {
      stage: 'implement',
      tab: 'assistant',
      color: implementing ? 'yellow' : (qaOverview?.subagents.length ?? 0) > 0 ? 'green' : 'red',
      reason: implementing ? 'implementation in progress' : (qaOverview?.subagents.length ?? 0) > 0 ? 'implementation reports available' : 'not implemented',
    },
    {
      stage: 'verify',
      tab: 'qa',
      color: card.verificationStatus === 'pass' ? 'green' : card.verificationStatus === 'partial' || card.currentAgent === 'verify' ? 'yellow' : 'red',
      reason: card.verificationStatus === 'pass' ? 'verification passed' : card.verificationStatus === 'partial' || card.currentAgent === 'verify' ? 'verification pending' : 'verification failed or missing',
    },
  ]
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (response.status === 401) window.dispatchEvent(new Event('spaces:unauthenticated'))
  const data = (await response.json()) as T | { error: string }
  if (!response.ok && typeof data === 'object' && data && 'error' in data) {
    throw new Error(data.error)
  }
  return data as T
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (response.status === 401) window.dispatchEvent(new Event('spaces:unauthenticated'))
  const data = (await response.json()) as T | { error: string }
  if (!response.ok && typeof data === 'object' && data && 'error' in data) {
    throw new Error(data.error)
  }
  return data as T
}

function formatTimestamp(value: string): string {
  return new Date(value).toLocaleString()
}

function formatDuration(value?: number): string {
  if (!value || value < 1000) {
    return value ? `${value}ms` : 'n/a'
  }
  return `${(value / 1000).toFixed(1)}s`
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

createRoot(document.getElementById('root')!).render(<AuthRoot><App /></AuthRoot>)
