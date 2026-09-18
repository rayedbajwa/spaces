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
INSERT INTO org_memory (singleton) VALUES (true) ON CONFLICT DO NOTHING;

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
