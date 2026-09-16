# Spaces — developer entry points
#
#   make setup      first-time: .env, bun install, Postgres, schema
#   make up         start Postgres + web server + supervisor in the background
#   make status     what is running, workers, queue depth
#   make e2e        bring the stack up and run the end-to-end pipeline suite
#   make down       stop the server, supervisor and Postgres
#
# Background processes write logs and pids to .run/ (git-ignored).

SHELL := /bin/bash
.DEFAULT_GOAL := help

RUN_DIR   := .run
PORT      ?= 3000
BASE_URL  ?= http://localhost:$(PORT)
E2E_CONCURRENCY ?= 3
E2E_TIMEOUT_MIN ?= 25
E2E_MODEL       ?= anthropic/claude-haiku-4-5
# Templates for `make e2e` (space separated). Empty = every template.
E2E_TEMPLATES   ?=
# Single template for `make e2e-one T=aidlc-express`
T ?= aidlc-express

.PHONY: help setup env install db-up db-down migrate build typecheck test lint \
        up server supervisor worker down restart status logs wait \
        e2e e2e-one e2e-canary docs docs-serve clean

help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"; printf "\nUsage: make <target>\n\n"} /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)
	@echo ""
	@echo "Variables: PORT=$(PORT) E2E_CONCURRENCY=$(E2E_CONCURRENCY) E2E_TIMEOUT_MIN=$(E2E_TIMEOUT_MIN) E2E_MODEL=$(E2E_MODEL) T=$(T)"

# ---- setup -------------------------------------------------------------------

setup: env install db-up migrate build ## First-time setup: .env, deps, Postgres, schema, frontend build
	@echo "✓ setup complete — edit .env (ENCRYPTION_KEY, ANTHROPIC_API_KEY, OAuth apps), then: make up"

env: ## Create .env from .env.example if missing
	@if [ ! -f .env ]; then cp .env.example .env; \
	  key=$$(openssl rand -base64 48 | tr -d '\n'); \
	  sed -i.bak "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$$key|" .env && rm -f .env.bak; \
	  echo "created .env with a fresh ENCRYPTION_KEY — set ANTHROPIC_API_KEY and OAuth credentials"; \
	else echo ".env exists"; fi

install: ## bun install
	bun install

db-up: ## Start Postgres (Docker) and wait until ready
	bun run db:up

db-down: ## Stop Postgres
	docker compose down

migrate: ## Apply the idempotent schema
	bun run db:migrate

build: ## Build the web bundle
	bun run build:web

typecheck: ## TypeScript typecheck
	bun run typecheck

test: ## Unit + smoke tests (smoke tests need a running server)
	bun test

lint: typecheck ## Alias for typecheck

# ---- run the stack -------------------------------------------------------------

$(RUN_DIR):
	@mkdir -p $(RUN_DIR)

up: $(RUN_DIR) db-up migrate server supervisor wait ## Start Postgres, web server and supervisor in the background
	@echo "✓ up — UI: $(BASE_URL)   logs: $(RUN_DIR)/server.log $(RUN_DIR)/supervisor.log"

server: $(RUN_DIR) ## Start the web server in the background (skips if the port already answers)
	@if curl -sf -o /dev/null $(BASE_URL)/health; then echo "server already answering on $(BASE_URL) — leaving it"; \
	else PORT=$(PORT) nohup bun run src/server.ts >> $(RUN_DIR)/server.log 2>&1 & echo $$! > $(RUN_DIR)/server.pid; echo "server starting (pid $$(cat $(RUN_DIR)/server.pid))"; fi

supervisor: $(RUN_DIR) ## Start the per-project worker supervisor in the background
	@if pgrep -f "src/supervisor.ts" >/dev/null; then echo "supervisor already running — leaving it"; \
	else nohup bun run src/supervisor.ts >> $(RUN_DIR)/supervisor.log 2>&1 & echo $$! > $(RUN_DIR)/supervisor.pid; echo "supervisor starting (pid $$(cat $(RUN_DIR)/supervisor.pid))"; fi

worker: $(RUN_DIR) ## Start a single shared worker instead of the supervisor
	@nohup bun run src/worker.ts >> $(RUN_DIR)/worker.log 2>&1 & echo $$! > $(RUN_DIR)/worker.pid; echo "worker starting (pid $$(cat $(RUN_DIR)/worker.pid))"

wait: ## Wait until the server answers
	@for i in $$(seq 1 60); do curl -sf -o /dev/null $(BASE_URL)/health && exit 0; sleep 1; done; \
	echo "server did not answer on $(BASE_URL) — see $(RUN_DIR)/server.log"; exit 1

down: ## Stop server, supervisor, workers and Postgres
	@pkill -TERM -f "src/supervisor.ts" 2>/dev/null || true
	@pkill -TERM -f "src/worker.ts" 2>/dev/null || true
	@pkill -TERM -f "src/server.ts" 2>/dev/null || true
	@for i in $$(seq 1 30); do pgrep -f "src/(server|supervisor|worker).ts" >/dev/null || break; sleep 1; done
	@rm -f $(RUN_DIR)/*.pid
	@docker compose down
	@echo "✓ down"

restart: ## Restart server and supervisor (runs are re-queued/paused, never lost)
	@pkill -TERM -f "src/supervisor.ts" 2>/dev/null || true
	@pkill -TERM -f "src/server.ts" 2>/dev/null || true
	@for i in $$(seq 1 30); do pgrep -f "src/(server|supervisor|worker).ts" >/dev/null || break; sleep 1; done
	@$(MAKE) --no-print-directory server supervisor wait

status: ## Show processes, live workers and queue depth
	@echo "processes:"; pgrep -fl "src/(server|supervisor|worker).ts" | sed 's/^/  /' || echo "  (none)"
	@echo "server: $$(curl -s -o /dev/null -w '%{http_code}' $(BASE_URL)/health)  $(BASE_URL)"
	@curl -s $(BASE_URL)/api/workers 2>/dev/null | python3 -c "import json,sys; ws=json.load(sys.stdin)['workers']; print('workers:', len(ws)); [print('  ', w['workerId'][:48], w['state'], 'jobs', w['activeJobs']) for w in ws]" 2>/dev/null || true
	@docker compose exec -T postgres psql -U aidlc -d aidlc -tAc "SELECT 'queue: '||count(*) FILTER (WHERE status='queued')||' queued, '||count(*) FILTER (WHERE status IN ('claimed','running'))||' running' FROM project_jobs" 2>/dev/null || true

logs: ## Tail server and supervisor logs
	@tail -n 40 -f $(RUN_DIR)/server.log $(RUN_DIR)/supervisor.log

# ---- end-to-end ----------------------------------------------------------------

e2e: up ## Bring the stack up and run the e2e pipeline suite (all templates, or E2E_TEMPLATES="a b")
	E2E_BASE_URL=$(BASE_URL) E2E_CONCURRENCY=$(E2E_CONCURRENCY) E2E_TIMEOUT_MIN=$(E2E_TIMEOUT_MIN) E2E_MODEL=$(E2E_MODEL) \
	  bun run scripts/e2e-pipelines.ts $(E2E_TEMPLATES)

e2e-canary: up ## Quick e2e on the smallest template (init → specify)
	E2E_BASE_URL=$(BASE_URL) E2E_TIMEOUT_MIN=8 E2E_MODEL=$(E2E_MODEL) bun run scripts/e2e-pipelines.ts test-minimal

e2e-one: up ## e2e for one template: make e2e-one T=aidlc-feature
	E2E_BASE_URL=$(BASE_URL) E2E_TIMEOUT_MIN=$(E2E_TIMEOUT_MIN) E2E_MODEL=$(E2E_MODEL) E2E_KEEP=1 bun run scripts/e2e-pipelines.ts $(T)

# ---- docs ----------------------------------------------------------------------

docs: ## Build the documentation site (strict) into site/
	uvx --python 3.12 --from mkdocs-material mkdocs build --strict

docs-serve: ## Serve the documentation locally on :8000
	uvx --python 3.12 --from mkdocs-material mkdocs serve

# ---- housekeeping --------------------------------------------------------------

clean: ## Remove build output, run logs and e2e fixtures
	rm -rf public site $(RUN_DIR) e2e-report.md
	rm -rf $$HOME/.aidlc/e2e
