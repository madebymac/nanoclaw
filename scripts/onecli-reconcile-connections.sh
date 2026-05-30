#!/usr/bin/env bash
#
# Reconcile OneCLI so app connections work for the nanoclaw agent:
#   1. move stray app connections + app configs into the agent's project,
#   2. grant the UI's synthetic admin@localhost user access to that project
#      so FUTURE connects land there directly (the long-term fix), and
#   3. reap the empty throwaway projects/orgs the UI already auto-created.
#
# Why this exists
# ---------------
# The nanoclaw host talks to its OneCLI gateway with an API key seeded into
# a deterministic project, `proj-<instance>`. App connections and the app
# (OAuth) configs that back them are project-scoped, so the agent only ever
# sees the ones that live in `proj-<instance>`.
#
# Connections, however, are made through the OneCLI *web UI* — and in local
# mode the UI auto-logs-in as a synthetic `admin@localhost` user and drops
# everything into ITS OWN auto-created project (a random id like
# `cmyemojwswdjcvyi`), not `proj-<instance>`. The UI reports success, but
# the connection (and its `app_configs` OAuth-app registration) land in a
# project the agent never reads. The agent then says "can't connect to
# <provider>" even though it genuinely connected.
#
# Two tables matter and both must be moved:
#   - app_connections — the connected account / installation + its tokens.
#   - app_configs     — the OAuth *app* registration (client id/secret) the
#                       provider needs to re-auth / refresh. A connection
#                       whose config is stranded in another project works
#                       off its cached token but breaks on refresh/reconnect
#                       (from the agent's project, /api/apps shows
#                       `config: null`).
#
# This script reconciles both: for each instance it moves any row sitting in
# a foreign project into `proj-<instance>`, aligning organization_id to that
# project's org. It is idempotent — a row already in the right project is
# left untouched — and best-effort: a problem with one instance/table logs
# a WARN and never aborts the others (so it is safe to wire into
# `make deploy`).
#
# Conflict handling: at most ONE stray is moved per provider per table (the
# most recently updated), and only when `proj-<instance>` does not already
# hold one for that provider. Any remaining strays — older duplicates of the
# same provider, or providers the target already has — are left in place and
# surfaced as a WARN for manual resolution. (app_configs additionally has a
# UNIQUE (organization_id, provider) constraint; since each instance is one
# org → one project, the project-level guard also satisfies it. If a move
# ever did violate it, the atomic statement rolls back and we WARN.)
#
# Long-term fix (grant + reap): moving rows is only a band-aid for things
# connected before the fix. The durable fix is to make `admin@localhost` —
# the user every local-mode UI session logs in as — an owner of the agent's
# org, so the UI can target `proj-<instance>` and future connects land there
# directly (validated: after the grant, a fresh UI login reuses the org
# instead of spawning a new throwaway project). We then reap the throwaway
# projects/orgs the UI already auto-created for that user. The reap is
# deliberately conservative — it only deletes a project that is NOT the
# target, was `created_by_user_email = 'admin@localhost'`, and holds NO
# app_connections / app_configs (so the move above can never lose data), plus
# the org behind it once that org has no projects left and no non-admin
# members. The target project/org and anything with real data are never
# touched. Both are idempotent: once the grant is in place no new throwaways
# appear, so subsequent runs are no-ops.
#
# STOPGAP / external coupling: this reaches directly into OneCLI's internal
# Postgres schema (`app_connections`, `app_configs`, `projects`). OneCLI is
# an external image pinned by tag, so a schema change upstream would break
# this silently (you'd hit the "target project not found" / no-op path). It
# exists only to work around the local-mode web UI dropping things into its
# own `admin@localhost` project instead of the API key's project; delete it
# once the UI lands them in the right project. The `proj-<instance>` /
# `org-<instance>` names are a convention of the external gateway
# provisioning that nanoclaw's per-instance API key is bound to (the key in
# instances/<name>/.env ONECLI_API_KEY lives in `proj-<instance>`). Nothing
# in THIS repo creates that project, so a "target project not found" warning
# means the external provisioning didn't run or used a different name.
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

# Move strays in one table into the current instance's target project.
# Uses the loop-local `pg`, `inst`, `target`; sets the global `rc` on any
# issue (best-effort — returns rather than aborting the caller).
#
#   reconcile_table <table> <noun> <recency-tiebreaker-col>
#     <table>   app_connections | app_configs
#     <noun>    human label for output, e.g. "connection" / "app config"
#     <recency> secondary ORDER BY column after updated_at, used to pick the
#               keeper per provider (connected_at for connections,
#               created_at for configs — app_configs has no connected_at).
reconcile_table() {
  local table="$1" noun="$2" tiebreak="$3"
  local strays moved leftover

  # set -e is off, so distinguish a query *error* (psql exits non-zero via
  # ON_ERROR_STOP) from a genuinely empty result — otherwise a transient
  # failure would masquerade as "nothing to do" and silently report clean.
  if ! strays="$(pg -c "SELECT provider || ' (in ' || COALESCE(project_id, '<none>') || ')' \
                   FROM $table WHERE project_id IS DISTINCT FROM '$target' \
                   ORDER BY provider")"; then
    echo "  WARN: [$inst] failed to query $table, skipping" >&2
    rc=1
    return
  fi
  if [ -z "${strays//[$'\n']/}" ]; then
    echo "==> [$inst] $table already in $target — nothing to do"
    return
  fi

  echo "==> [$inst] found $noun(s) in $table outside $target:"
  while IFS= read -r line; do
    [ -n "$line" ] && echo "      - $line"
  done <<< "$strays"

  # `candidates` deterministically selects AT MOST ONE stray per provider —
  # the most recently updated — and only for providers the target doesn't
  # already have. We then update exactly those ids. This avoids the trap of
  # filtering inside the UPDATE itself: a `WHERE NOT EXISTS (… project_id =
  # target …)` guard is evaluated against the statement's pre-update MVCC
  # snapshot, so two strays of the same provider would BOTH pass the guard
  # and BOTH move, silently creating a duplicate. Picking the id set up
  # front sidesteps that — any other strays for that provider stay put and
  # are surfaced as leftover below.
  if ! moved="$(pg -c "WITH candidates AS ( \
      SELECT DISTINCT ON (ac.provider) ac.id \
      FROM $table ac \
      WHERE ac.project_id IS DISTINCT FROM '$target' \
        AND NOT EXISTS ( \
          SELECT 1 FROM $table t \
          WHERE t.project_id = '$target' AND t.provider = ac.provider) \
      ORDER BY ac.provider, ac.updated_at DESC, ac.$tiebreak DESC), \
    moved AS ( \
      UPDATE $table ac \
      SET project_id = '$target', \
          organization_id = (SELECT organization_id FROM projects WHERE id = '$target'), \
          updated_at = now() \
      FROM candidates c \
      WHERE ac.id = c.id \
      RETURNING 1) \
    SELECT count(*) FROM moved")"; then
    echo "  WARN: [$inst] move query for $table failed; rows left unchanged" >&2
    rc=1
    return
  fi
  moved="${moved//[[:space:]]/}"
  echo "      moved ${moved:-0} $noun(s) into $target"

  # Anything still misfiled is either a provider the target already had, or
  # an older duplicate stray we deliberately didn't move. Surface it.
  leftover="$(pg -c "SELECT provider || ' (in ' || COALESCE(project_id, '<none>') || ')' \
                     FROM $table \
                     WHERE project_id IS DISTINCT FROM '$target' ORDER BY provider")" || true
  if [ -n "${leftover//[$'\n']/}" ]; then
    echo "  WARN: [$inst] $noun(s) left outside $target (target already has that" >&2
    echo "        provider, or a duplicate stray remains): $(echo $leftover | tr '\n' ' ')" >&2
    echo "        Resolve by hand if the misfiled one is the keeper." >&2
    rc=1
  fi
}

# Ensure the UI's synthetic admin@localhost user owns the agent's org (so
# future UI connects target proj-<instance>), then reap the empty throwaway
# projects/orgs it already created. Uses loop-local `pg`, `inst`, `target`;
# sets global `rc` on issues. See the "Long-term fix" header note.
ensure_admin_access_and_reap() {
  local admin_id target_org n_proj

  # admin@localhost exists only after someone has opened the UI at least once.
  if ! admin_id="$(pg -c "SELECT id FROM users WHERE email = 'admin@localhost' LIMIT 1")"; then
    echo "  WARN: [$inst] failed to look up admin@localhost user" >&2
    rc=1
    return
  fi
  admin_id="$(printf '%s' "$admin_id" | tr -d '[:space:]')"
  if [ -z "$admin_id" ]; then
    echo "==> [$inst] no admin@localhost user yet (UI never opened) — nothing to grant/reap"
    return
  fi

  if ! target_org="$(pg -c "SELECT organization_id FROM projects WHERE id = '$target' LIMIT 1")"; then
    echo "  WARN: [$inst] failed to read organization for $target" >&2
    rc=1
    return
  fi
  target_org="$(printf '%s' "$target_org" | tr -d '[:space:]')"
  if [ -z "$target_org" ]; then
    echo "  WARN: [$inst] $target has no organization; skipping admin grant/reap" >&2
    rc=1
    return
  fi

  # 1) Grant — idempotent, non-destructive.
  if ! pg -c "INSERT INTO organization_members (organization_id, user_id, user_email, role, created_at) \
              VALUES ('$target_org', '$admin_id', 'admin@localhost', 'owner', now()) \
              ON CONFLICT DO NOTHING" >/dev/null; then
    echo "  WARN: [$inst] failed to grant admin@localhost access to $target_org" >&2
    rc=1
    return
  fi
  echo "==> [$inst] admin@localhost owns $target_org (UI connects can target $target)"

  # 2) Reap. Pre-count throwaway projects (those NOT the target, created by
  #    admin@localhost, with no app_connections/app_configs) so we can skip
  #    the transaction entirely — and the destructive deletes — when there's
  #    nothing to do. Anything still holding rows is left for the reconcile
  #    leftover-WARN, never auto-deleted.
  n_proj="$(pg -c "SELECT count(*) FROM projects p \
      WHERE p.id <> '$target' \
        AND p.created_by_user_email = 'admin@localhost' \
        AND NOT EXISTS (SELECT 1 FROM app_connections c WHERE c.project_id = p.id) \
        AND NOT EXISTS (SELECT 1 FROM app_configs cf WHERE cf.project_id = p.id)")" || true
  n_proj="$(printf '%s' "$n_proj" | tr -d '[:space:]')"
  if [ "${n_proj:-0}" = "0" ]; then
    echo "      no throwaway projects to reap"
    return
  fi

  # Single atomic transaction. Temp tables pin the exact id sets so every
  # DELETE is scoped to admin@localhost's empty throwaways; the target
  # project/org and anything with data are excluded by construction. OneCLI
  # seeds each project with a default agent + api key + audit logs (RESTRICT
  # FKs), so clear those before the project; clear org members/invites before
  # the org. ON_ERROR_STOP rolls the whole thing back on any error.
  if ! pg >/dev/null <<SQL
BEGIN;
CREATE TEMP TABLE _tw_proj ON COMMIT DROP AS
  SELECT p.id, p.organization_id
  FROM projects p
  WHERE p.id <> '$target'
    AND p.created_by_user_email = 'admin@localhost'
    AND NOT EXISTS (SELECT 1 FROM app_connections c WHERE c.project_id = p.id)
    AND NOT EXISTS (SELECT 1 FROM app_configs cf WHERE cf.project_id = p.id);
DELETE FROM audit_logs           WHERE project_id IN (SELECT id FROM _tw_proj);
DELETE FROM api_keys             WHERE project_id IN (SELECT id FROM _tw_proj);
DELETE FROM agents               WHERE project_id IN (SELECT id FROM _tw_proj);
DELETE FROM onboarding_surveys   WHERE project_id IN (SELECT id FROM _tw_proj);
DELETE FROM platform_deployments WHERE project_id IN (SELECT id FROM _tw_proj);
DELETE FROM vault_connections    WHERE project_id IN (SELECT id FROM _tw_proj);
DELETE FROM projects             WHERE id IN (SELECT id FROM _tw_proj);
CREATE TEMP TABLE _tw_org ON COMMIT DROP AS
  SELECT DISTINCT o.id
  FROM organizations o
  JOIN _tw_proj t ON t.organization_id = o.id
  WHERE o.id <> '$target_org'
    AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.organization_id = o.id)
    AND NOT EXISTS (SELECT 1 FROM organization_members m
                    WHERE m.organization_id = o.id AND m.user_email <> 'admin@localhost');
DELETE FROM organization_members WHERE organization_id IN (SELECT id FROM _tw_org);
DELETE FROM invitations          WHERE organization_id IN (SELECT id FROM _tw_org);
DELETE FROM user_provisions      WHERE organization_id IN (SELECT id FROM _tw_org);
DELETE FROM organizations        WHERE id IN (SELECT id FROM _tw_org);
COMMIT;
SQL
  then
    echo "  WARN: [$inst] throwaway reap failed (rolled back, nothing deleted)" >&2
    rc=1
    return
  fi
  echo "      reaped $n_proj throwaway project(s) + empty org(s) created by admin@localhost"
}

rc=0

for inst in $TARGETS; do
  # External-gateway convention: the per-instance API key (and the agent)
  # live in a project named `proj-<instance>`. See the header note.
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

  # Move the OAuth app registration first, then the connection that uses it.
  reconcile_table app_configs "app config" created_at
  reconcile_table app_connections "connection" connected_at

  # Then make the fix durable: grant the UI user access + reap throwaways.
  ensure_admin_access_and_reap
done

exit $rc
