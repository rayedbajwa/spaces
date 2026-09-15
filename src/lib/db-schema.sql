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
