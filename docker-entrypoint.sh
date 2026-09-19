#!/bin/sh
# Fix ownership of the /data volume, then run as the non-root "bun" user.
#
# Platforms mount volumes owned by root (Railway, plain `docker volume`), while
# the image runs as uid 1000. When the container starts as root we hand /data to
# bun and drop privileges; when it already runs as bun (USER override, rootless
# Docker) there is nothing to fix and we just exec the command.
set -e
DATA_DIR="${DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR/home" "$DATA_DIR/aidlc/workspaces"
  # Only the top levels and anything not yet owned by bun: a full recursive
  # chown over many cloned repositories would slow every restart.
  chown bun:bun "$DATA_DIR" "$DATA_DIR/home" "$DATA_DIR/aidlc" "$DATA_DIR/aidlc/workspaces" 2>/dev/null || true
  find "$DATA_DIR" -maxdepth 2 ! -user bun -exec chown bun:bun {} + 2>/dev/null || true
  exec gosu bun "$@"
fi
exec "$@"
