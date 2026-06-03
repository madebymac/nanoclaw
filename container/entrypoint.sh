#!/bin/bash
# NanoClaw agent container entrypoint.
#
# The host passes initial session parameters via stdin as a single JSON blob,
# then the agent-runner opens the session DBs at /workspace/{inbound,outbound}.db
# and enters its poll loop. All further IO flows through those DBs.
#
# We capture stdin to a file first so /tmp/input.json is available for
# post-mortem inspection if the container exits unexpectedly, then exec bun
# so that bun becomes PID 1's direct child (under tini) and receives signals.

set -e

# GitHub App token refresh support (see #66).
#
# GH_TOKEN is a short-lived (~1h) installation token. When the container
# lives longer than 1h, the host refreshes it by writing a new value to
# /tmp/.gh-token via `docker exec`. BASH_ENV=/tmp/.gh-token-env (set in the
# Dockerfile) makes every non-interactive bash subshell re-export GH_TOKEN
# from that file, so the refresh is transparent to the agent.
#
# Write the initial token to /tmp/.gh-token so the BASH_ENV hook has a file
# to read from on the very first bash command.
if [ -n "$GH_TOKEN" ]; then
  printf '%s' "$GH_TOKEN" > /tmp/.gh-token
  chmod 600 /tmp/.gh-token
fi

# Create the BASH_ENV hook. It's written at runtime (not baked into the image)
# so it is always in sync with whatever path BASH_ENV points to. The hook is
# intentionally minimal: one file read, two exports, no subshells.
cat > /tmp/.gh-token-env << 'SHEOF'
if [ -f /tmp/.gh-token ]; then
  read -r _nanoclaw_gh_t < /tmp/.gh-token 2>/dev/null || true
  if [ -n "$_nanoclaw_gh_t" ]; then
    export GH_TOKEN="$_nanoclaw_gh_t"
    export GITHUB_TOKEN="$_nanoclaw_gh_t"
  fi
  unset _nanoclaw_gh_t
fi
SHEOF

cat > /tmp/input.json

exec bun run /app/src/index.ts < /tmp/input.json
