#!/usr/bin/env bash
#
# Move OneCLI app connections (GitHub, Gmail, …) into the project the
# nanoclaw agent actually authenticates against.
#
# Why this exists
# ---------------
# The nanoclaw host talks to its OneCLI gateway with an API key seeded into
# a deterministic project, `proj-<instance>`. App connections are
# project-scoped, so the agent only ever sees connections that live in
# `proj-<instance>`.
#
# Connections, however, are made through the OneCLI *web UI* — and in local
# mode the UI auto-logs-in as a synthetic `admin@localhost` user and drops
# every connection into ITS OWN auto-created project (a random id like
# `cmyemojwswdjcvyi`), not `proj-<instance>`. The UI reports success, but
# the connection lands in a project the agent never reads. The agent then
# says "can't connect to <provider>" even though the connection genuinely
# exists.
#
# This script reconciles that: for each instance it moves any app
# connection sitting in a foreign project into `proj-<instance>`, aligning
# organization_id to that project's org. It is idempotent — a connection
# already in the right project is left untouched — and best-effort: a
# problem with one instance logs a WARN and never aborts the others (so it
# is safe to wire into `make deploy`).
#
# Conflict handling: if `proj-<instance>` already holds a connection for a
# provider, a stray duplicate for that same provider is NOT moved on top of
# it (which would leave two rows for one provider). The stray is reported
# and left in place for manual resolution.
#
# Usage:
#   scripts/onecli-reconcile-connections.sh            # all INSTANCES
#   scripts/onecli-reconcile-connections.sh general    # one or more names
#
# Normally invoked by `make deploy` (Phase 2, after the gateway is up).

set -uo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -P "$SCRIPT_DIR/.." && pwd)"
CONF="$REPO_ROOT/instances.conf"

# Resolve the instance list: explicit args win, otherwise INSTANCES from
# instances.conf (the same source the Makefile loops over).
if [ "$#" -gt 0 ]; then
  TARGETS="$*"
else
  if [ ! -f "$CONF" ]; then
    echo "error: $CONF not found and no instance names given" >&2
    exit 1
  fi
  # shellcheck source=/dev/null
  . "$CONF"
  TARGETS="${INSTANCES:-}"
fi

if [ -z "${TARGETS// /}" ]; then
  echo "error: no instances to reconcile (empty INSTANCES and no args)" >&2
  exit 1
fi

rc=0

for inst in $TARGETS; do
  target="proj-$inst"
  dir="$HOME/.onecli-$inst"

  # Mirror of isValidInstanceName() in src/instance-name.ts and the regex
  # in scripts/render-instance-env.sh — keep all three in sync.
  if ! printf '%s' "$inst" | grep -Eq '^[a-z0-9][a-z0-9_-]{0,31}$'; then
    echo "  WARN: [$inst] invalid instance name, skipping" >&2
    rc=1
    continue
  fi
  if [ ! -d "$dir" ]; then
    echo "  WARN: [$inst] OneCLI install dir $dir missing, skipping" >&2
    rc=1
    continue
  fi

  # psql runner for this instance's gateway postgres. -X (no .psqlrc),
  # -A -t (unaligned, tuples-only) so single-value queries come back clean.
  pg() {
    docker compose -p "onecli-$inst" --project-directory "$dir" exec -T postgres \
      psql -U onecli -d onecli -X -A -t -v ON_ERROR_STOP=1 "$@"
  }

  # Wait briefly for postgres — `make deploy` runs this right after a
  # gateway `up -d`, so the container may still be warming up.
  pg_ready=false
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if pg -c 'SELECT 1' >/dev/null 2>&1; then
      pg_ready=true
      break
    fi
    sleep 1
  done
  if [ "$pg_ready" != true ]; then
    echo "  WARN: [$inst] postgres not reachable (is the OneCLI gateway up?), skipping" >&2
    rc=1
    continue
  fi

  # Target project is seeded alongside the nanoclaw API key; if it's
  # missing something is wrong with the install — warn rather than create.
  if [ -z "$(pg -c "SELECT 1 FROM projects WHERE id = '$target' LIMIT 1")" ]; then
    echo "  WARN: [$inst] target project '$target' not found, skipping" >&2
    rc=1
    continue
  fi

  # What's currently misfiled (anything not already in the target project)?
  strays="$(pg -c "SELECT provider || ' (in ' || COALESCE(project_id, '<none>') || ')' \
                   FROM app_connections WHERE project_id IS DISTINCT FROM '$target' \
                   ORDER BY provider")"
  if [ -z "${strays//[$'\n']/}" ]; then
    echo "==> [$inst] app connections already in $target — nothing to do"
    continue
  fi

  echo "==> [$inst] found connection(s) outside $target:"
  while IFS= read -r line; do
    [ -n "$line" ] && echo "      - $line"
  done <<< "$strays"

  # Move strays into the target project, aligning organization_id to the
  # target project's org. Skip any provider that already has a connection
  # in the target project (NOT EXISTS guard) so we never create a duplicate
  # provider row. (Rare: two strays of the same provider in different
  # foreign projects would both match — left for manual cleanup, surfaced
  # by the post-move report below.)
  moved="$(pg -c "WITH moved AS ( \
      UPDATE app_connections ac \
      SET project_id = '$target', \
          organization_id = (SELECT organization_id FROM projects WHERE id = '$target'), \
          updated_at = now() \
      WHERE ac.project_id IS DISTINCT FROM '$target' \
        AND NOT EXISTS ( \
          SELECT 1 FROM app_connections t \
          WHERE t.project_id = '$target' AND t.provider = ac.provider) \
      RETURNING 1) \
    SELECT count(*) FROM moved")"
  moved="${moved//[[:space:]]/}"
  echo "      moved ${moved:-0} connection(s) into $target"

  # Anything still misfiled was skipped by the duplicate guard.
  leftover="$(pg -c "SELECT provider FROM app_connections \
                     WHERE project_id IS DISTINCT FROM '$target' ORDER BY provider")"
  if [ -n "${leftover//[$'\n']/}" ]; then
    echo "  WARN: [$inst] left in place (a connection for the same provider already" >&2
    echo "        exists in $target): $(echo $leftover | tr '\n' ' ')" >&2
    echo "        Resolve by hand if the misfiled one is the keeper." >&2
    rc=1
  fi
done

exit $rc
