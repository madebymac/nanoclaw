#!/usr/bin/env bash
#
# Render instances/<name>/.env from instances/example/.env.example,
# substituting auto-derived OneCLI port placeholders.
#
# Reads instances.conf (sourceable bash) from the repo root for:
#   INSTANCES            — space-separated instance names, defines index order
#   ONECLI_BASE_PORT     — first instance's app port
#   ONECLI_PORT_STRIDE   — spacing between instance triples
#
# Refuses to overwrite an existing .env so user-added tokens are never lost.
#
# Usage: scripts/render-instance-env.sh <instance-name>

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <instance-name>" >&2
  exit 2
fi

NAME="$1"
SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -P "$SCRIPT_DIR/.." && pwd)"
CONF="$REPO_ROOT/instances.conf"
TEMPLATE="$REPO_ROOT/instances/example/.env.example"
TARGET_DIR="$REPO_ROOT/instances/$NAME"
TARGET="$TARGET_DIR/.env"

if [ ! -f "$CONF" ]; then
  echo "error: $CONF not found" >&2
  exit 1
fi
if [ ! -f "$TEMPLATE" ]; then
  echo "error: template $TEMPLATE not found" >&2
  exit 1
fi

# shellcheck source=/dev/null
. "$CONF"

# Find the instance index in INSTANCES (0-based).
INDEX=-1
i=0
for inst in $INSTANCES; do
  if [ "$inst" = "$NAME" ]; then
    INDEX=$i
    break
  fi
  i=$((i + 1))
done

if [ "$INDEX" -lt 0 ]; then
  echo "error: instance '$NAME' not listed in INSTANCES in $CONF" >&2
  echo "       add it there first, then re-run." >&2
  exit 1
fi

APP_PORT=$((ONECLI_BASE_PORT + INDEX * ONECLI_PORT_STRIDE))
GATEWAY_PORT=$((APP_PORT + 1))
POSTGRES_PORT=$((APP_PORT + 2))
ONECLI_URL="http://127.0.0.1:${APP_PORT}"

mkdir -p "$TARGET_DIR"

if [ -e "$TARGET" ]; then
  echo "error: $TARGET already exists — refusing to overwrite (would clobber tokens)" >&2
  echo "       delete it and re-run if you really want to regenerate." >&2
  exit 1
fi

# Substitute placeholders. Add new __PLACEHOLDER__ keys here if the template grows.
sed \
  -e "s|__ONECLI_URL__|${ONECLI_URL}|g" \
  -e "s|__ONECLI_APP_PORT__|${APP_PORT}|g" \
  -e "s|__ONECLI_GATEWAY_PORT__|${GATEWAY_PORT}|g" \
  -e "s|__ONECLI_POSTGRES_PORT__|${POSTGRES_PORT}|g" \
  "$TEMPLATE" > "$TARGET"

cat <<EOF
Created $TARGET
  index:         $INDEX
  app port:      $APP_PORT
  gateway port:  $GATEWAY_PORT
  postgres port: $POSTGRES_PORT
  ONECLI_URL:    $ONECLI_URL

Next: run \`make install-instance NAME=$NAME\` to install OneCLI and the
systemd unit. Channel tokens (TELEGRAM_BOT_TOKEN etc.) don't need to be
hand-edited here — install channels via /add-telegram, /add-slack, etc.
from a Claude Code session with NCL_INSTANCE=$NAME set, exactly like
single-install. The set-env step is instance-aware and will write tokens
to $TARGET for you.
EOF
