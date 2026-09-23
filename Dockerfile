# syntax=docker/dockerfile:1.7

# ==============================================================================
# Spaces — production Docker image
# ==============================================================================
# Multi-stage build:
#   1. deps    — install production + dev dependencies (needed to bundle web)
#   2. build   — bundle the React frontend into public/
#   3. runtime — slim image with production deps + built assets
# ==============================================================================

# ---- Stage 1: install dependencies -------------------------------------------
FROM oven/bun:1.4 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# ---- Stage 2: build the frontend ---------------------------------------------
FROM oven/bun:1.4 AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bun run build:web

# ---- Stage 3: runtime --------------------------------------------------------
FROM oven/bun:1.4 AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Bake build identity into the image so a packaged instance reports the exact
# source revision and version even though `.dockerignore` excludes `.git` from
# the runtime stage. Pass them at build time, e.g.:
#   docker build --build-arg GIT_COMMIT="$(git rev-parse HEAD)" \
#                --build-arg SPACES_VERSION="1.2.3" -t spaces:latest .
# Platform build pipelines like Railway automatically provide RAILWAY_GIT_COMMIT_SHA.
# When omitted, the resolver falls back to git (unavailable in the image) and
# the package.json version, so the endpoint reports "unknown"/the placeholder.
ARG GIT_COMMIT
ARG RAILWAY_GIT_COMMIT_SHA
ARG SPACES_VERSION
ENV GIT_COMMIT=${GIT_COMMIT:-$RAILWAY_GIT_COMMIT_SHA} \
    SPACES_VERSION=$SPACES_VERSION

# Agents clone repositories, create worktrees, commit and push: git is required.
# ca-certificates for HTTPS to GitHub/Anthropic; openssh-client for ssh remotes.
# postgresql-client gives agents psql and pg_isready so a checkout's database
# tests can be prepared and checked without a container. Debian (not Alpine):
# Playwright's bundled Chromium needs glibc. gosu lets the entrypoint fix the
# /data volume's ownership and then drop to bun.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates openssh-client gosu curl postgresql-client \
    && rm -rf /var/lib/apt/lists/*

# Docker client and Compose plugin, without a daemon: a container cannot run
# one, but agents check for `docker` before deciding what they can verify, and
# a deployment that points DOCKER_HOST at a real engine (or mounts its socket)
# gets working containers. Set DOCKER_CLI_VERSION="" to leave both out.
ARG DOCKER_CLI_VERSION=27.3.1
ARG DOCKER_COMPOSE_VERSION=2.29.7
RUN set -eux; \
    if [ -n "$DOCKER_CLI_VERSION" ]; then \
      arch="$(dpkg --print-architecture)"; \
      case "$arch" in amd64) docker_arch=x86_64; compose_arch=x86_64 ;; arm64) docker_arch=aarch64; compose_arch=aarch64 ;; *) docker_arch=""; esac; \
      if [ -n "$docker_arch" ]; then \
        curl -fsSL "https://download.docker.com/linux/static/stable/${docker_arch}/docker-${DOCKER_CLI_VERSION}.tgz" -o /tmp/docker.tgz; \
        tar -xzf /tmp/docker.tgz -C /tmp; \
        install -m 0755 /tmp/docker/docker /usr/local/bin/docker; \
        mkdir -p /usr/local/lib/docker/cli-plugins; \
        curl -fsSL "https://github.com/docker/compose/releases/download/v${DOCKER_COMPOSE_VERSION}/docker-compose-linux-${compose_arch}" -o /usr/local/lib/docker/cli-plugins/docker-compose; \
        chmod 0755 /usr/local/lib/docker/cli-plugins/docker-compose; \
        rm -rf /tmp/docker /tmp/docker.tgz; \
      fi; \
    fi

# Durable state lives under /data (mount a volume there): cloned repos and
# governing workspaces (AIDLC_WORKSPACE_ROOT) and Pi agent sessions (HOME/.pi).
ENV HOME=/data/home
ENV AIDLC_WORKSPACE_ROOT=/data/aidlc/workspaces
# Mount a volume at /data (docker run -v … or a Railway volume). No VOLUME
# instruction: Railway's builder rejects it and Docker does not need it.
RUN mkdir -p /data/home /data/aidlc/workspaces && chown -R bun:bun /data

# Copy production node_modules + source + built assets
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /app/public ./public
COPY package.json tsconfig.json ./
COPY src ./src
COPY data ./data
COPY schemas ./schemas
COPY scripts ./scripts
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Agents' browser: Playwright's Chromium (+ its system libraries) and the
# pi-playwright skill wiring, installed to a path every user can read.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN SPACES_BROWSER_DEPS=1 bun run scripts/setup-browsers.ts && chmod -R a+rX /ms-playwright && rm -rf /var/lib/apt/lists/*

EXPOSE 3000

# The container starts as root only long enough for the entrypoint to chown the
# mounted /data volume (platforms mount volumes as root); the app itself runs
# as the non-root "bun" user (uid 1000) via su-exec.
ENTRYPOINT ["docker-entrypoint.sh"]

# Default command is the web server. Others:
#   docker run <image> bun run src/supervisor.ts   # per-project workers
#   docker run <image> bun run src/worker.ts       # single shared worker
#   docker run <image> bun run src/standalone.ts   # server + supervisor (Railway)
CMD ["bun", "run", "src/server.ts"]
