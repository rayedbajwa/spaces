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
FROM oven/bun:1.4-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# ---- Stage 2: build the frontend ---------------------------------------------
FROM oven/bun:1.4-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bun run build:web

# ---- Stage 3: runtime --------------------------------------------------------
FROM oven/bun:1.4-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Agents clone repositories, create worktrees, commit and push: git is required.
# ca-certificates for HTTPS to GitHub/Anthropic; openssh-client for ssh remotes.
# su-exec lets the entrypoint fix the /data volume's ownership and then drop to bun.
# chromium (+ fonts) backs the agents' browser tools (Playwright drives it headless).
RUN apk add --no-cache git ca-certificates openssh-client su-exec chromium nss freetype harfbuzz ttf-freefont
ENV SPACES_BROWSER_PATH=/usr/bin/chromium-browser

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
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

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
