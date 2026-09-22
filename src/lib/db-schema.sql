-- AIDLC Pipeline factory schema (Phase 2 + Phase 4A)
-- Idempotent DDL — safe to run multiple times, and also safe to run on a
-- fresh database (the fresh-install stub at the top ensures the ALTER
-- statements later on always find the tables they expect).

-- ============================================================================
-- Fresh-install stubs
-- ---------------------------------------------------------------------------
-- Later sections have ALTER TABLE / FOREIGN KEY REFERENCES that assume
-- pipeline_runs exists. This block was previously created only in the "Phase 2"
-- section further down, so on a brand-new database the ALTERs at line ~77
-- would fail with "relation pipeline_runs does not exist". Creating a minimal
-- stub here (idempotent — the full CREATE later is a no-op if the table
-- already exists) lets fresh installs succeed without changing existing
-- deployments.
-- ============================================================================
-- Full pipeline_runs definition. Kept in sync with the (now-idempotent)
-- CREATE below in the Phase 2 section. Fresh installs materialize the full
-- schema here; existing databases already have this table and hit the
-- no-op path.
CREATE TABLE IF NOT EXISTS pipeline_runs (
  run_id            UUID PRIMARY KEY,
  project_namespace TEXT NOT NULL,
  project_label     TEXT NOT NULL,
  project_path      TEXT NOT NULL,
  pipeline_name     TEXT NOT NULL,
  feature           TEXT,
  status            TEXT NOT NULL CHECK (status IN ('queued','running','paused','completed','error')),
  pause_kind        TEXT CHECK (pause_kind IN ('clarification','review')),
  current_stage     TEXT,
  session_file      TEXT,
  error_message     TEXT,
  options_json      JSONB NOT NULL DEFAULT '{}'::jsonb,
  template_json     JSONB NOT NULL DEFAULT '{}'::jsonb,
  retry_count       INT NOT NULL DEFAULT 0,
  owning_worker_id  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- Phase 4A: Projects, repos, integrations
-- A project is the top-level unit users interact with. It can span multiple
-- repositories (local paths or GitHub-hosted) and multiple external
-- integrations (GitHub, Jira, Confluence). Runs (pipeline_runs) target a
-- single repo within a project.
-- ============================================================================

CREATE TABLE IF NOT EXISTS projects (
  project_id   UUID PRIMARY KEY,
  name         TEXT NOT NULL,
  slug         TEXT NOT NULL UNIQUE,
  description  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS projects_slug_idx ON projects (slug);

CREATE TABLE IF NOT EXISTS project_repos (
  repo_id      UUID PRIMARY KEY,
  project_id   UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  label        TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('local','github')),
  local_path   TEXT,
  github_repo  TEXT,            -- "owner/name"
  is_primary   BOOLEAN NOT NULL DEFAULT false,
  added_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (kind <> 'local'  OR local_path IS NOT NULL),
  CHECK (kind <> 'github' OR github_repo IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS project_repos_project_idx ON project_repos (project_id);
-- At most one primary per project
CREATE UNIQUE INDEX IF NOT EXISTS project_repos_one_primary
  ON project_repos (project_id) WHERE is_primary;

CREATE TABLE IF NOT EXISTS project_integrations (
  integration_id     UUID PRIMARY KEY,
  project_id         UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  kind               TEXT NOT NULL CHECK (kind IN ('github','jira','confluence')),
  status             TEXT NOT NULL DEFAULT 'not_connected'
                       CHECK (status IN ('not_connected','pending','connected','error')),
  display_name       TEXT,
  config_json        JSONB NOT NULL DEFAULT '{}'::jsonb,
  credentials_json   JSONB,   -- encrypted at rest in Phase 4B/4C
  last_synced_at     TIMESTAMPTZ,
  last_sync_error    TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_integrations_project_idx ON project_integrations (project_id);
-- One integration record per (project, kind) — a project has at most one
-- GitHub connection, one Jira, one Confluence. Multi-account is a later phase.
CREATE UNIQUE INDEX IF NOT EXISTS project_integrations_unique_kind
  ON project_integrations (project_id, kind);

CREATE OR REPLACE FUNCTION touch_project() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS projects_touch ON projects;
CREATE TRIGGER projects_touch
  BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION touch_project();

DROP TRIGGER IF EXISTS project_integrations_touch ON project_integrations;
CREATE TRIGGER project_integrations_touch
  BEFORE UPDATE ON project_integrations
  FOR EACH ROW EXECUTE FUNCTION touch_project();

-- Link pipeline_runs to projects + repos.
ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(project_id) ON DELETE SET NULL;
ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS repo_id    UUID REFERENCES project_repos(repo_id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS pipeline_runs_project_id_idx ON pipeline_runs (project_id);

-- Cross-stage handoff thread (Phase 6 memory). Each row is one prior stage's
-- output tail, injected into subsequent stages' preambles so context survives
-- Pi session resets when per-stage models swap.
-- summary/summary_hash are populated by the token compactor
-- (src/lib/context-compactor.ts) — a Haiku-generated summary of the tail,
-- keyed by SHA-1 of the raw tail so repeated content across runs reuses it.
CREATE TABLE IF NOT EXISTS run_thread_entries (
  entry_id     BIGSERIAL PRIMARY KEY,
  run_id       UUID NOT NULL REFERENCES pipeline_runs(run_id) ON DELETE CASCADE,
  step_index   INT  NOT NULL,
  step_id      TEXT NOT NULL,
  stage        TEXT NOT NULL,
  model        TEXT,
  tail         TEXT NOT NULL,
  summary      TEXT,
  summary_hash TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS run_thread_entries_run_idx
  ON run_thread_entries (run_id, entry_id);
CREATE INDEX IF NOT EXISTS run_thread_entries_summary_hash_idx
  ON run_thread_entries (summary_hash) WHERE summary_hash IS NOT NULL;

-- Per-project long-term memory (replaces data/projects/<ns>/memory.json).
CREATE TABLE IF NOT EXISTS project_memory (
  project_id   UUID PRIMARY KEY REFERENCES projects(project_id) ON DELETE CASCADE,
  manual_text  TEXT NOT NULL DEFAULT '',
  auto_summary TEXT NOT NULL DEFAULT '',
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- App-level integrations (one row per external system for the whole app).
-- Supersedes per-project integrations for the common case: teams have one
-- GitHub account, one Jira instance, one Slack workspace. project_integrations
-- table is retained for legacy data but no longer written.
-- ============================================================================
CREATE TABLE IF NOT EXISTS app_integrations (
  kind             TEXT PRIMARY KEY CHECK (kind IN ('github','jira','confluence','slack')),
  status           TEXT NOT NULL DEFAULT 'not_connected'
                     CHECK (status IN ('not_connected','pending','connected','error')),
  display_name     TEXT,
  config_json      JSONB NOT NULL DEFAULT '{}'::jsonb,
  credentials_json JSONB,
  last_synced_at   TIMESTAMPTZ,
  last_sync_error  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION touch_app_integration() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS app_integrations_touch ON app_integrations;
CREATE TRIGGER app_integrations_touch BEFORE UPDATE ON app_integrations
  FOR EACH ROW EXECUTE FUNCTION touch_app_integration();

-- ============================================================================
-- Per-project orchestrator (Phase 5A/5B)
-- One config row per project. Governs autonomous mode + concurrency policy.
-- ============================================================================

CREATE TABLE IF NOT EXISTS project_orchestrators (
  project_id       UUID PRIMARY KEY REFERENCES projects(project_id) ON DELETE CASCADE,
  autonomous_mode  BOOLEAN NOT NULL DEFAULT false,
  max_concurrent   INT NOT NULL DEFAULT 1,
  config_json      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Warm sub-agent pool: one row per (project, role) with persistent session file.
CREATE TABLE IF NOT EXISTS project_agents (
  agent_id         UUID PRIMARY KEY,
  project_id       UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  role             TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'idle'
                     CHECK (status IN ('idle','warming','busy','dead')),
  session_file     TEXT,
  current_job_id   UUID,
  warmed_at        TIMESTAMPTZ,
  last_used_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS project_agents_project_role
  ON project_agents (project_id, role);
CREATE INDEX IF NOT EXISTS project_agents_project_status_idx
  ON project_agents (project_id, status);

-- Per-project job queue. Every unit of work (pipeline run, single task, verify fix,
-- webhook-triggered work) lands here first. The dispatcher process picks jobs
-- respecting each project's max_concurrent policy.
CREATE TABLE IF NOT EXISTS project_jobs (
  job_id           UUID PRIMARY KEY,
  project_id       UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  kind             TEXT NOT NULL
                     CHECK (kind IN ('pipeline_run','task_run','workstream_run','verify_fix','webhook')),
  payload_json     JSONB NOT NULL DEFAULT '{}'::jsonb,
  priority         INT NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued','claimed','running','completed','error','cancelled')),
  trigger_source   TEXT NOT NULL
                     CHECK (trigger_source IN ('user','task_tracker','verify_loop','webhook','api','reaper')),
  run_id           UUID REFERENCES pipeline_runs(run_id) ON DELETE SET NULL,
  claimed_by       TEXT,
  started_at       TIMESTAMPTZ,
  ended_at         TIMESTAMPTZ,
  error_message    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_jobs_project_status_idx
  ON project_jobs (project_id, status, priority DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS project_jobs_status_idx ON project_jobs (status);

-- Wake dispatcher immediately on new work.
CREATE OR REPLACE FUNCTION notify_project_job() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('project_job', NEW.project_id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS project_jobs_notify_insert ON project_jobs;
CREATE TRIGGER project_jobs_notify_insert
  AFTER INSERT ON project_jobs
  FOR EACH ROW EXECUTE FUNCTION notify_project_job();

-- Per-project source snapshots from integrations (replaces data/projects/<ns>/sources/*.json).
CREATE TABLE IF NOT EXISTS project_source_snapshots (
  snapshot_id  BIGSERIAL PRIMARY KEY,
  project_id   UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  source       TEXT NOT NULL,
  scope        TEXT,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  title        TEXT NOT NULL,
  content      TEXT NOT NULL,
  url          TEXT,
  metadata     JSONB,
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_source_snapshots_project_idx
  ON project_source_snapshots (project_id, fetched_at DESC);

-- ============================================================================

CREATE TABLE IF NOT EXISTS pipeline_runs (
  run_id            UUID PRIMARY KEY,
  project_namespace TEXT NOT NULL,
  project_label     TEXT NOT NULL,
  project_path      TEXT NOT NULL,
  pipeline_name     TEXT NOT NULL,
  feature           TEXT,
  status            TEXT NOT NULL CHECK (status IN ('queued','running','paused','completed','error')),
  pause_kind        TEXT CHECK (pause_kind IN ('clarification','review')),
  current_stage     TEXT,
  session_file      TEXT,
  error_message     TEXT,
  options_json      JSONB NOT NULL,
  template_json     JSONB NOT NULL,
  retry_count       INT NOT NULL DEFAULT 0,
  owning_worker_id  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Additive migration for existing installations
ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS retry_count INT NOT NULL DEFAULT 0;
ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS owning_worker_id TEXT;

-- GitHub-hosted repos are cloned into a local workspace so runs can target them.
-- clone_status: pending | cloning | ready | error. local_path is filled once ready.
ALTER TABLE project_repos ADD COLUMN IF NOT EXISTS clone_status TEXT;
ALTER TABLE project_repos ADD COLUMN IF NOT EXISTS clone_error  TEXT;

-- Linear joins the app-level integrations. Re-create the kind CHECK so the
-- enum can grow (constraint name is Postgres' default for an inline CHECK).
ALTER TABLE app_integrations DROP CONSTRAINT IF EXISTS app_integrations_kind_check;
ALTER TABLE app_integrations ADD CONSTRAINT app_integrations_kind_check
  CHECK (kind IN ('github','jira','confluence','slack','linear'));

-- Per-project knowledge scope: which connected integrations agents may query for
-- this project and how queries are narrowed (Jira project keys, Linear teams,
-- Confluence spaces, GitHub repos). '{}' = every connected source, unscoped.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS knowledge_json JSONB NOT NULL DEFAULT '{}'::jsonb;
-- Repositories and work areas suggested for the project (after onboarding, after plan).
ALTER TABLE projects ADD COLUMN IF NOT EXISTS suggestions_json JSONB;

-- Live workers. Each worker registers on start and heartbeats; the server only
-- treats an answer as delivered when the owning worker is alive, otherwise it
-- re-queues the paused run so a new worker restarts the stage.
CREATE TABLE IF NOT EXISTS workers (
  worker_id          TEXT PRIMARY KEY,
  started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_heartbeat_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Per-project workers (spawned by src/supervisor.ts) record which project they
-- serve, their OS pid and what they are doing, so the UI can show hot/idle state.
ALTER TABLE workers ADD COLUMN IF NOT EXISTS project_id     UUID;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS pid            INT;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS active_jobs    INT NOT NULL DEFAULT 0;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS paused_runs    INT NOT NULL DEFAULT 0;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS supervised     BOOLEAN NOT NULL DEFAULT false;

-- Catalog of every repository the connected GitHub account can see, with its
-- README-derived use case. Synced on connect and periodically; lets the plan
-- stage name repositories (which are then cloned on demand) without anyone
-- selecting them up front.
-- ============================================================================
-- Authentication, teams and invites
-- Users sign in with email+password (argon2id via Bun.password) or GitHub.
-- A team owns projects ("spaces"); members have roles; invites are token links.
-- ============================================================================
CREATE TABLE IF NOT EXISTS users (
  user_id        UUID PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  password_hash  TEXT,
  github_login   TEXT UNIQUE,
  avatar_url     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  session_id     UUID PRIMARY KEY,
  user_id        UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  token_hash     TEXT NOT NULL UNIQUE,
  active_team_id UUID,
  user_agent     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions (user_id);

CREATE TABLE IF NOT EXISTS teams (
  team_id     UUID PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  created_by  UUID REFERENCES users(user_id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id    UUID NOT NULL REFERENCES teams(team_id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS team_members_user_idx ON team_members (user_id);

CREATE TABLE IF NOT EXISTS team_invites (
  invite_id    UUID PRIMARY KEY,
  team_id      UUID NOT NULL REFERENCES teams(team_id) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('admin','member','viewer')),
  token_hash   TEXT NOT NULL UNIQUE,
  invited_by   UUID REFERENCES users(user_id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  accepted_at  TIMESTAMPTZ,
  accepted_by  UUID REFERENCES users(user_id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS team_invites_team_idx ON team_invites (team_id);

-- Projects belong to a team. Legacy projects (NULL) are adopted by the first team.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES teams(team_id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS projects_team_idx ON projects (team_id);

-- Three context layers, following AIDLC "spaces": the ORGANIZATION shares
-- memory, knowledge and the repository catalog with every team; each TEAM
-- (a space) keeps its own memory, knowledge defaults and projects; each
-- PROJECT keeps its own memory, artifacts and imported knowledge.
CREATE TABLE IF NOT EXISTS org_memory (
  singleton    BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  name         TEXT NOT NULL DEFAULT 'Organization',
  manual_text  TEXT NOT NULL DEFAULT '',
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS team_memory (
  team_id      UUID PRIMARY KEY REFERENCES teams(team_id) ON DELETE CASCADE,
  manual_text  TEXT NOT NULL DEFAULT '',
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Team-level default knowledge scope (same shape as projects.knowledge_json);
-- a project without its own scope inherits it.
ALTER TABLE teams ADD COLUMN IF NOT EXISTS knowledge_json JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Knowledge snapshots can be shared org-wide (team_id and project_id NULL),
-- per team (team_id set), or per project (project_id set).
ALTER TABLE project_source_snapshots ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE project_source_snapshots ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES teams(team_id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS project_source_snapshots_team_idx ON project_source_snapshots (team_id, fetched_at DESC);

CREATE TABLE IF NOT EXISTS github_repo_index (
  full_name       TEXT PRIMARY KEY,
  description     TEXT,
  language        TEXT,
  topics          JSONB NOT NULL DEFAULT '[]'::jsonb,
  default_branch  TEXT,
  usecase         TEXT,
  is_private      BOOLEAN NOT NULL DEFAULT false,
  updated_at      TIMESTAMPTZ,
  indexed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pipeline_runs_project_idx ON pipeline_runs (project_namespace, created_at DESC);
CREATE INDEX IF NOT EXISTS pipeline_runs_status_idx  ON pipeline_runs (status);

CREATE TABLE IF NOT EXISTS pipeline_steps (
  run_id      UUID NOT NULL REFERENCES pipeline_runs(run_id) ON DELETE CASCADE,
  step_index  INT  NOT NULL,
  step_id     TEXT NOT NULL,
  stage       TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('pending','running','paused','completed','error','skipped')),
  started_at  TIMESTAMPTZ,
  ended_at    TIMESTAMPTZ,
  error_message TEXT,
  PRIMARY KEY (run_id, step_index)
);

CREATE TABLE IF NOT EXISTS pipeline_events (
  event_id    BIGSERIAL PRIMARY KEY,
  run_id      UUID NOT NULL REFERENCES pipeline_runs(run_id) ON DELETE CASCADE,
  step_index  INT,
  kind        TEXT NOT NULL,
  payload     JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pipeline_events_run_idx ON pipeline_events (run_id, event_id);

CREATE TABLE IF NOT EXISTS pipeline_gates (
  gate_id     UUID PRIMARY KEY,
  run_id      UUID NOT NULL REFERENCES pipeline_runs(run_id) ON DELETE CASCADE,
  step_index  INT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('clarification','review')),
  status      TEXT NOT NULL CHECK (status IN ('open','resolved')),
  prompt      TEXT,
  response    TEXT,
  opened_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS pipeline_gates_run_idx ON pipeline_gates (run_id, opened_at DESC);

CREATE TABLE IF NOT EXISTS pipeline_artifacts (
  artifact_id BIGSERIAL PRIMARY KEY,
  run_id      UUID NOT NULL REFERENCES pipeline_runs(run_id) ON DELETE CASCADE,
  step_index  INT,
  path        TEXT NOT NULL,
  size_bytes  BIGINT,
  content_sha TEXT,
  metadata    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pipeline_artifacts_run_idx ON pipeline_artifacts (run_id);

-- Trigger: NOTIFY on new event so SSE tailers wake up immediately.
CREATE OR REPLACE FUNCTION notify_pipeline_event() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('pipeline_event', NEW.run_id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pipeline_events_notify ON pipeline_events;
CREATE TRIGGER pipeline_events_notify
  AFTER INSERT ON pipeline_events
  FOR EACH ROW
  EXECUTE FUNCTION notify_pipeline_event();

-- Keep updated_at fresh on pipeline_runs.
CREATE OR REPLACE FUNCTION touch_pipeline_run() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pipeline_runs_touch ON pipeline_runs;
CREATE TRIGGER pipeline_runs_touch
  BEFORE UPDATE ON pipeline_runs
  FOR EACH ROW
  EXECUTE FUNCTION touch_pipeline_run();

-- ---------------------------------------------------------------------------
-- Organization knowledge (RAG). Sources are synced in the background into
-- documents and retrieval-sized chunks; chunks carry a full-text index always
-- and a pgvector embedding when the extension is available (added by
-- applySchema() as a guarded step so a database without pgvector still works).
-- A source belongs to the organization (team_id NULL) or to one team.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS knowledge_sources (
  source_id              UUID PRIMARY KEY,
  team_id                UUID REFERENCES teams(team_id) ON DELETE CASCADE,
  kind                   TEXT NOT NULL CHECK (kind IN ('confluence','jira','linear','github_repo','github_issues','url','manual')),
  label                  TEXT NOT NULL,
  config_json            JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled                BOOLEAN NOT NULL DEFAULT true,
  sync_interval_minutes  INT NOT NULL DEFAULT 360,
  cursor_json            JSONB NOT NULL DEFAULT '{}'::jsonb,
  sync_requested_at      TIMESTAMPTZ,
  last_sync_started_at   TIMESTAMPTZ,
  last_sync_finished_at  TIMESTAMPTZ,
  last_sync_status       TEXT CHECK (last_sync_status IN ('running','ok','error')),
  last_sync_error        TEXT,
  last_sync_stats        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by             UUID REFERENCES users(user_id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_sources_team_idx ON knowledge_sources (team_id);

CREATE TABLE IF NOT EXISTS knowledge_documents (
  document_id        UUID PRIMARY KEY,
  source_id          UUID NOT NULL REFERENCES knowledge_sources(source_id) ON DELETE CASCADE,
  external_id        TEXT NOT NULL,
  title              TEXT NOT NULL,
  url                TEXT,
  content            TEXT NOT NULL,
  content_hash       TEXT NOT NULL,
  metadata_json      JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_updated_at  TIMESTAMPTZ,
  fetched_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  indexed_at         TIMESTAMPTZ,
  embedding_status   TEXT NOT NULL DEFAULT 'pending' CHECK (embedding_status IN ('pending','done','skipped','error')),
  embedding_error    TEXT,
  UNIQUE (source_id, external_id)
);
CREATE INDEX IF NOT EXISTS knowledge_documents_source_idx ON knowledge_documents (source_id, fetched_at DESC);
CREATE INDEX IF NOT EXISTS knowledge_documents_embedding_status_idx ON knowledge_documents (embedding_status);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  chunk_id         BIGSERIAL PRIMARY KEY,
  document_id      UUID NOT NULL REFERENCES knowledge_documents(document_id) ON DELETE CASCADE,
  source_id        UUID NOT NULL REFERENCES knowledge_sources(source_id) ON DELETE CASCADE,
  team_id          UUID,
  chunk_index      INT NOT NULL,
  heading_path     TEXT[] NOT NULL DEFAULT '{}',
  content          TEXT NOT NULL,
  content_tsv      TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', left(content, 100000))) STORED,
  embedding_model  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_chunks_tsv_idx      ON knowledge_chunks USING GIN (content_tsv);
CREATE INDEX IF NOT EXISTS knowledge_chunks_document_idx ON knowledge_chunks (document_id, chunk_index);
CREATE INDEX IF NOT EXISTS knowledge_chunks_team_idx     ON knowledge_chunks (team_id);

-- Archived projects keep everything but are hidden from the board and refuse
-- new work. Deleting a project requires archiving it first.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS projects_archived_idx ON projects (archived_at) WHERE archived_at IS NOT NULL;

-- Runs can be cancelled (archiving a project cancels its in-flight work).
ALTER TABLE pipeline_runs DROP CONSTRAINT IF EXISTS pipeline_runs_status_check;
ALTER TABLE pipeline_runs ADD CONSTRAINT pipeline_runs_status_check
  CHECK (status IN ('queued','running','paused','completed','error','cancelled'));

-- Paused projects: queued jobs wait and running runs stop at their next stage
-- boundary (pause_kind 'user'); resuming re-queues them. Everything is kept.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ;
ALTER TABLE pipeline_runs DROP CONSTRAINT IF EXISTS pipeline_runs_pause_kind_check;
ALTER TABLE pipeline_runs ADD CONSTRAINT pipeline_runs_pause_kind_check
  CHECK (pause_kind IN ('clarification','review','user'));

-- Readable project codes: a prefix derived from the team (space) name plus a
-- per-prefix counter, e.g. PLAT-12. Backfilled at boot for older rows.
ALTER TABLE teams ADD COLUMN IF NOT EXISTS code_prefix TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS teams_code_prefix_idx ON teams (code_prefix) WHERE code_prefix IS NOT NULL;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS code TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS code_number INT;
CREATE UNIQUE INDEX IF NOT EXISTS projects_code_idx ON projects (code) WHERE code IS NOT NULL;

-- OAuth app credentials per provider, set from the Integrations panel by an
-- owner/admin (secret sealed with ENCRYPTION_KEY). .env values are a fallback.
CREATE TABLE IF NOT EXISTS oauth_apps (
  provider           TEXT PRIMARY KEY CHECK (provider IN ('github','atlassian','slack','linear')),
  client_id          TEXT NOT NULL,
  client_secret_enc  TEXT NOT NULL,
  updated_by         UUID REFERENCES users(user_id) ON DELETE SET NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Provider app details beyond the client credentials (GitHub App id, slug,
-- install url, sealed private key; Slack manifest source, …).
ALTER TABLE oauth_apps ADD COLUMN IF NOT EXISTS config_json JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Token usage and cost per model call, rolled up per run / project / organization.
CREATE TABLE IF NOT EXISTS run_usage (
  usage_id           BIGSERIAL PRIMARY KEY,
  run_id             UUID NOT NULL,
  project_namespace  TEXT NOT NULL,
  stage              TEXT,
  provider           TEXT NOT NULL,
  model              TEXT NOT NULL,
  input_tokens       BIGINT NOT NULL DEFAULT 0,
  output_tokens      BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens  BIGINT NOT NULL DEFAULT 0,
  cache_write_tokens BIGINT NOT NULL DEFAULT 0,
  cost_usd           NUMERIC(12, 6) NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE run_usage ADD COLUMN IF NOT EXISTS response_id TEXT;
ALTER TABLE run_usage ADD COLUMN IF NOT EXISTS response_model TEXT;
-- sdk: priced from the SDK's price table; estimated: from the catalog price of the model that actually answered; provider: exact cost reported by the provider (OpenRouter generation API); none: unknown.
ALTER TABLE run_usage ADD COLUMN IF NOT EXISTS cost_source TEXT NOT NULL DEFAULT 'sdk';
CREATE INDEX IF NOT EXISTS run_usage_run_idx ON run_usage (run_id);
CREATE INDEX IF NOT EXISTS run_usage_project_idx ON run_usage (project_namespace, created_at DESC);

-- Organization model-routing policy (preference, provider order, premium, pins).
ALTER TABLE org_memory ADD COLUMN IF NOT EXISTS model_policy_json JSONB NOT NULL DEFAULT '{}'::jsonb;

-- LLM provider API keys, managed under Organization → Models (sealed with ENCRYPTION_KEY).
CREATE TABLE IF NOT EXISTS provider_keys (
  provider            TEXT PRIMARY KEY CHECK (provider IN ('anthropic','openai','openrouter')),
  key_enc             TEXT NOT NULL,
  updated_by          UUID REFERENCES users(user_id) ON DELETE SET NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_verified_at    TIMESTAMPTZ,
  last_verify_status  TEXT,
  last_verify_error   TEXT
);

-- ============================================================================
-- Organizations: the tenant boundary. Every team belongs to one organization;
-- organization-level state (memory + model policy, provider keys, OAuth apps,
-- integrations, knowledge sources, promotions, repository catalog) is scoped
-- by org_id. Deployments from before tenancy are migrated onto one default
-- organization, keeping their data intact.
-- ============================================================================
CREATE TABLE IF NOT EXISTS organizations (
  org_id      UUID PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  created_by  UUID REFERENCES users(user_id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE teams              ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE;
ALTER TABLE org_memory         ADD COLUMN IF NOT EXISTS org_id UUID;
ALTER TABLE provider_keys      ADD COLUMN IF NOT EXISTS org_id UUID;
ALTER TABLE oauth_apps         ADD COLUMN IF NOT EXISTS org_id UUID;
ALTER TABLE app_integrations   ADD COLUMN IF NOT EXISTS org_id UUID;
ALTER TABLE github_repo_index  ADD COLUMN IF NOT EXISTS org_id UUID;
ALTER TABLE knowledge_sources  ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE;

-- Migrate pre-tenancy rows onto one default organization.
DO $$
DECLARE def UUID;
BEGIN
  IF EXISTS (SELECT 1 FROM teams WHERE org_id IS NULL)
     OR EXISTS (SELECT 1 FROM org_memory WHERE org_id IS NULL)
     OR EXISTS (SELECT 1 FROM provider_keys WHERE org_id IS NULL)
     OR EXISTS (SELECT 1 FROM oauth_apps WHERE org_id IS NULL)
     OR EXISTS (SELECT 1 FROM app_integrations WHERE org_id IS NULL)
     OR EXISTS (SELECT 1 FROM github_repo_index WHERE org_id IS NULL)
     OR EXISTS (SELECT 1 FROM knowledge_sources WHERE org_id IS NULL) THEN
    SELECT org_id INTO def FROM organizations WHERE slug = 'default' LIMIT 1;
    IF def IS NULL THEN
      def := gen_random_uuid();
      INSERT INTO organizations (org_id, name, slug)
      VALUES (def, coalesce((SELECT name FROM org_memory ORDER BY updated_at DESC LIMIT 1), 'Organization'), 'default');
    END IF;
    UPDATE teams SET org_id = def WHERE org_id IS NULL;
    UPDATE org_memory SET org_id = def WHERE org_id IS NULL;
    UPDATE provider_keys SET org_id = def WHERE org_id IS NULL;
    UPDATE oauth_apps SET org_id = def WHERE org_id IS NULL;
    UPDATE app_integrations SET org_id = def WHERE org_id IS NULL;
    UPDATE github_repo_index SET org_id = def WHERE org_id IS NULL;
    UPDATE knowledge_sources SET org_id = def WHERE org_id IS NULL;
  END IF;
END $$;

-- org_memory: one row per organization (was a singleton).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'org_memory' AND column_name = 'singleton') THEN
    ALTER TABLE org_memory DROP CONSTRAINT IF EXISTS org_memory_pkey;
    ALTER TABLE org_memory DROP COLUMN singleton;
    DELETE FROM org_memory WHERE org_id IS NULL;
    ALTER TABLE org_memory ALTER COLUMN org_id SET NOT NULL;
    ALTER TABLE org_memory ADD PRIMARY KEY (org_id);
  END IF;
END $$;

-- Per-organization primary keys for tables that were keyed by provider/kind/name alone.
DO $$
DECLARE t RECORD;
BEGIN
  FOR t IN SELECT * FROM (VALUES ('provider_keys', 'provider'), ('oauth_apps', 'provider'), ('app_integrations', 'kind'), ('github_repo_index', 'full_name')) AS v(tbl, col) LOOP
    IF (SELECT count(*) FROM information_schema.key_column_usage k
         JOIN information_schema.table_constraints c ON c.constraint_name = k.constraint_name AND c.table_name = k.table_name
        WHERE c.table_name = t.tbl AND c.constraint_type = 'PRIMARY KEY') = 1 THEN
      EXECUTE format('DELETE FROM %I WHERE org_id IS NULL', t.tbl);
      EXECUTE format('ALTER TABLE %I ALTER COLUMN org_id SET NOT NULL', t.tbl);
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', t.tbl, t.tbl || '_pkey');
      EXECUTE format('ALTER TABLE %I ADD PRIMARY KEY (org_id, %I)', t.tbl, t.col);
    END IF;
  END LOOP;
END $$;
CREATE INDEX IF NOT EXISTS teams_org_idx ON teams (org_id);
CREATE INDEX IF NOT EXISTS knowledge_sources_org_idx ON knowledge_sources (org_id);

-- Deleting an organization deletes everything that belongs to it: rows left
-- behind would otherwise be readable by a later organization reusing an id and
-- would keep encrypted keys alive with no owner.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['org_memory', 'provider_keys', 'oauth_apps', 'app_integrations', 'github_repo_index'] LOOP
    EXECUTE format('DELETE FROM %I WHERE org_id NOT IN (SELECT org_id FROM organizations)', t);
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints c
       WHERE c.table_name = t AND c.constraint_type = 'FOREIGN KEY' AND c.constraint_name = t || '_org_id_fkey'
    ) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (org_id) REFERENCES organizations(org_id) ON DELETE CASCADE', t, t || '_org_id_fkey');
    END IF;
  END LOOP;
END $$;

-- ============================================================================
-- One-time repair for installations that existed before tenancy: the migration
-- above puts every team into one default organization, which is right for a
-- single company but wrong where unrelated accounts each made their own team.
-- Teams are grouped into connected components through shared members; the
-- component holding the installation's first account keeps the existing
-- organization (with its keys, integrations and knowledge), and every other
-- component becomes its own organization, starting empty. Runs once, tracked
-- by a marker row so ordinary later teams are never split off.
-- ============================================================================
CREATE TABLE IF NOT EXISTS tenancy_repairs (
  name        TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  details     JSONB NOT NULL DEFAULT '{}'::jsonb
);

DO $$
DECLARE
  owner_user UUID;
  owner_comp UUID;
  def_org    UUID;
  rec        RECORD;
  new_org    UUID;
  base_slug  TEXT;
  cand_slug  TEXT;
  n          INT;
  created    INT := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM tenancy_repairs WHERE name = 'split-legacy-organizations') THEN RETURN; END IF;

  SELECT org_id INTO def_org FROM organizations ORDER BY (slug = 'default') DESC, created_at ASC LIMIT 1;
  IF def_org IS NULL THEN
    INSERT INTO tenancy_repairs (name, details) VALUES ('split-legacy-organizations', jsonb_build_object('organizationsCreated', 0));
    RETURN;
  END IF;

  -- Label every team with the lowest team_id it reaches through shared members.
  DROP TABLE IF EXISTS _team_comp;
  CREATE TEMP TABLE _team_comp ON COMMIT DROP AS SELECT DISTINCT team_id, team_id AS comp FROM team_members;
  LOOP
    WITH linked AS (
      -- Postgres has no min(uuid); compare as text, which keeps the labelling stable.
      SELECT a.team_id, MIN(b.comp::text)::uuid AS comp
        FROM _team_comp a
        JOIN team_members ma ON ma.team_id = a.team_id
        JOIN team_members mb ON mb.user_id = ma.user_id
        JOIN _team_comp b ON b.team_id = mb.team_id
       GROUP BY a.team_id
    )
    UPDATE _team_comp t SET comp = l.comp FROM linked l WHERE l.team_id = t.team_id AND l.comp < t.comp;
    EXIT WHEN NOT FOUND;
  END LOOP;

  -- The first account ever created is the installation owner; its component stays put.
  SELECT user_id INTO owner_user FROM users ORDER BY created_at ASC LIMIT 1;
  SELECT c.comp INTO owner_comp
    FROM _team_comp c JOIN team_members m ON m.team_id = c.team_id
   WHERE m.user_id = owner_user
   ORDER BY c.comp LIMIT 1;

  FOR rec IN
    SELECT c.comp AS comp,
           (SELECT COALESCE(NULLIF(btrim(u.name), ''), split_part(u.email, '@', 1))
              FROM _team_comp c2
              JOIN team_members m ON m.team_id = c2.team_id
              JOIN users u ON u.user_id = m.user_id
             WHERE c2.comp = c.comp
             ORDER BY u.created_at ASC LIMIT 1) AS owner_name
      FROM _team_comp c
     WHERE owner_comp IS NOT NULL AND c.comp <> owner_comp
     GROUP BY c.comp
  LOOP
    base_slug := btrim(regexp_replace(lower(COALESCE(rec.owner_name, 'org')), '[^a-z0-9]+', '-', 'g'), '-');
    IF base_slug = '' THEN base_slug := 'org'; END IF;
    cand_slug := base_slug;
    n := 2;
    WHILE EXISTS (SELECT 1 FROM organizations WHERE slug = cand_slug) LOOP
      cand_slug := base_slug || '-' || n;
      n := n + 1;
    END LOOP;
    new_org := gen_random_uuid();
    INSERT INTO organizations (org_id, name, slug)
      VALUES (new_org, COALESCE(rec.owner_name, 'Organization') || '''s organization', cand_slug);
    INSERT INTO org_memory (org_id, name)
      VALUES (new_org, COALESCE(rec.owner_name, 'Organization') || '''s organization')
      ON CONFLICT (org_id) DO NOTHING;
    UPDATE teams SET org_id = new_org WHERE team_id IN (SELECT team_id FROM _team_comp WHERE comp = rec.comp);
    created := created + 1;
  END LOOP;

  -- A knowledge source scoped to a team belongs to that team's organization.
  UPDATE knowledge_sources s SET org_id = t.org_id
    FROM teams t WHERE t.team_id = s.team_id AND s.org_id IS DISTINCT FROM t.org_id;

  -- Projects created before teams existed belong to the owner organization's oldest team,
  -- otherwise no one can reach them once every route is scoped.
  UPDATE projects SET team_id = (SELECT team_id FROM teams WHERE org_id = def_org ORDER BY created_at ASC LIMIT 1)
   WHERE team_id IS NULL AND EXISTS (SELECT 1 FROM teams WHERE org_id = def_org);

  INSERT INTO tenancy_repairs (name, details) VALUES ('split-legacy-organizations', jsonb_build_object('organizationsCreated', created));
END $$;

-- ============================================================================
-- Second one-time repair: app credentials follow the person who set them up.
-- Splitting the legacy organization moves teams, but rows like a GitHub App
-- stay with the old organization even when the person who created it now
-- belongs to another one — so their install looks lost. Each app moves to its
-- creator's organization (or, for GitHub, to the organization of the account
-- that owns it on GitHub), together with the integrations it powers, and only
-- when the destination has nothing for that provider.
-- ============================================================================
DO $$
DECLARE
  app     RECORD;
  target  UUID;
  n_orgs  INT;
  moved   INT := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM tenancy_repairs WHERE name = 'move-app-credentials-to-owner') THEN RETURN; END IF;

  FOR app IN SELECT provider, org_id, updated_by, config_json FROM oauth_apps LOOP
    target := NULL;
    -- The account that saved the credentials, when it belongs to exactly one organization.
    IF app.updated_by IS NOT NULL THEN
      SELECT count(DISTINCT t.org_id), MIN(t.org_id::text)::uuid INTO n_orgs, target
        FROM team_members m JOIN teams t ON t.team_id = m.team_id
       WHERE m.user_id = app.updated_by;
      IF n_orgs <> 1 THEN target := NULL; END IF;
    END IF;
    -- Otherwise, for GitHub, the account that owns the app on GitHub.
    IF target IS NULL AND app.provider = 'github' AND COALESCE(app.config_json->>'ownerLogin', '') <> '' THEN
      SELECT count(DISTINCT t.org_id), MIN(t.org_id::text)::uuid INTO n_orgs, target
        FROM users u
        JOIN team_members m ON m.user_id = u.user_id
        JOIN teams t ON t.team_id = m.team_id
       WHERE lower(u.github_login) = lower(app.config_json->>'ownerLogin');
      IF n_orgs <> 1 THEN target := NULL; END IF;
    END IF;

    CONTINUE WHEN target IS NULL OR target = app.org_id;
    CONTINUE WHEN EXISTS (SELECT 1 FROM oauth_apps b WHERE b.org_id = target AND b.provider = app.provider);

    UPDATE oauth_apps SET org_id = target WHERE org_id = app.org_id AND provider = app.provider;
    -- The connections this app powers move with it (Atlassian covers Jira and Confluence).
    UPDATE app_integrations i SET org_id = target
     WHERE i.org_id = app.org_id
       AND i.kind = ANY (CASE app.provider WHEN 'atlassian' THEN ARRAY['jira', 'confluence'] ELSE ARRAY[app.provider] END)
       AND NOT EXISTS (SELECT 1 FROM app_integrations j WHERE j.org_id = target AND j.kind = i.kind);
    moved := moved + 1;
  END LOOP;

  INSERT INTO tenancy_repairs (name, details) VALUES ('move-app-credentials-to-owner', jsonb_build_object('appsMoved', moved));
END $$;

-- Project responsibilities: human accountability, separate from team access roles.
CREATE TABLE IF NOT EXISTS project_responsibilities (
  responsibility_id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('standard','custom')),
  standard_key TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (length(trim(name)) > 0),
  CHECK ((kind = 'standard' AND standard_key IS NOT NULL) OR (kind = 'custom' AND standard_key IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS project_responsibilities_active_name_idx
  ON project_responsibilities (project_id, normalized_name) WHERE is_active;
CREATE UNIQUE INDEX IF NOT EXISTS project_responsibilities_standard_key_idx
  ON project_responsibilities (project_id, standard_key) WHERE standard_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS project_responsibilities_project_idx
  ON project_responsibilities (project_id, display_order, responsibility_id);

CREATE TABLE IF NOT EXISTS responsibility_assignments (
  assignment_id UUID PRIMARY KEY,
  responsibility_id UUID NOT NULL REFERENCES project_responsibilities(responsibility_id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL DEFAULT 0 CHECK (ordinal >= 0),
  is_active BOOLEAN NOT NULL DEFAULT true,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  assigned_by UUID REFERENCES users(user_id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS responsibility_assignments_active_unique_idx
  ON responsibility_assignments (responsibility_id, user_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS responsibility_assignments_order_idx
  ON responsibility_assignments (responsibility_id, ordinal, user_id);

CREATE TABLE IF NOT EXISTS responsibility_audit (
  audit_id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  responsibility_id UUID REFERENCES project_responsibilities(responsibility_id) ON DELETE SET NULL,
  actor_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  before_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  after_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS responsibility_audit_project_idx
  ON responsibility_audit (project_id, created_at DESC);

DROP TRIGGER IF EXISTS project_responsibilities_touch ON project_responsibilities;
CREATE TRIGGER project_responsibilities_touch
  BEFORE UPDATE ON project_responsibilities
  FOR EACH ROW EXECUTE FUNCTION touch_project();

-- What the board shows for a project, derived from its feature files
-- (lib/project-state.ts). Recomputed when a run of the project changed since,
-- when marked stale, or when older than a few minutes; never on every request.
CREATE TABLE IF NOT EXISTS project_state (
  project_id     UUID PRIMARY KEY REFERENCES projects(project_id) ON DELETE CASCADE,
  -- The checkout the artifacts were read from; a different one (a clone that
  -- finished, a new primary repository) makes them out of date.
  project_path   TEXT NOT NULL DEFAULT '',
  artifacts_json JSONB NOT NULL,
  tasks_done     INTEGER NOT NULL DEFAULT 0,
  stale          BOOLEAN NOT NULL DEFAULT false,
  stale_since    TIMESTAMPTZ,
  computed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE project_state ADD COLUMN IF NOT EXISTS project_path TEXT NOT NULL DEFAULT '';
