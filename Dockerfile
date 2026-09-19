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

# Agents clone repositories, create worktrees, commit and push: git is required.
# ca-certificates for HTTPS to GitHub/Anthropic; openssh-client for ssh remotes.
# Debian (not Alpine): Playwright's bundled Chromium needs glibc. gosu lets the
# entrypoint fix the /data volume's ownership and then drop to bun.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates openssh-client gosu \
    && rm -rf /var/lib/apt/lists/*

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
