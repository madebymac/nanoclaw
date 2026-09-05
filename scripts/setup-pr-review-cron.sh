#!/usr/bin/env bash
set -euo pipefail

# setup-pr-review-cron.sh — install the crontab entry that drives PR review.
#
# `ncl pr-review-run` is designed to be invoked from an external scheduler —
# the host process never ticks it internally (see .env.example). This script
# installs one idempotent crontab line so the reviewer agent group actually
# scans and dispatches. Safe to re-run: it checks for an existing entry
# tagged with the marker comment before appending, so repeat runs don't stack
# duplicate lines.
#
# Prerequisite: PR_REVIEW_ENABLED=true and PR_REVIEW_AGENT_GROUP_ID must be
# set in .env (and the service restarted) before this cron entry does
# anything useful — see docs/pr-review.md.
#
# Usage:
#   scripts/setup-pr-review-cron.sh [--cadence '*/5 * * * *'] [--remove]
#
#   --cadence <cron-expr>  Schedule (default: every 5 minutes)
#   --remove               Remove the managed entry instead of installing it

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NCL_BIN="$SCRIPT_DIR/bin/ncl"
MARKER="# nanoclaw-pr-review-cron"
CADENCE='*/5 * * * *'
ACTION=install

while [ $# -gt 0 ]; do
  case "$1" in
    --cadence)
      CADENCE="$2"
      shift 2
      ;;
    --remove)
      ACTION=remove
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [ ! -x "$NCL_BIN" ]; then
  echo "error: $NCL_BIN not found or not executable" >&2
  exit 1
fi

EXISTING="$(crontab -l 2>/dev/null || true)"
FILTERED="$(printf '%s\n' "$EXISTING" | grep -vF "$MARKER" | grep -v '^$' || true)"

if [ "$ACTION" = remove ]; then
  printf '%s\n' "$FILTERED" | crontab -
  echo "Removed managed pr-review crontab entry (if it was present)."
  exit 0
fi

LINE="$CADENCE $NCL_BIN pr-review-run >/dev/null 2>&1 $MARKER"

{
  [ -n "$FILTERED" ] && printf '%s\n' "$FILTERED"
  printf '%s\n' "$LINE"
} | crontab -

echo "Installed: $LINE"
echo "Verify with: crontab -l"
