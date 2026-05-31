#!/usr/bin/env bash
#
# Reconcile OneCLI so app connections work for the nanoclaw agent:
#   1. move stray app connections + app configs into the agent's project,
#   2. grant the UI's synthetic admin@localhost user access to that project,
#   3. make that project admin@localhost's DEFAULT project, so the UI opens
#      there and FUTURE connects land there directly (the long-term fix), and
#   4. reap the empty throwaway projects/orgs the UI already auto-created.
#
# Why this exists
# ---------------
# The nanoclaw host talks to its OneCLI gateway with an API key seeded into a
# project. App connections and the app (OAuth) configs that back them are
# project-scoped, so the agent only ever sees the ones that live in that
# project.
#
# Connections, however, are made through the OneCLI *web UI* — and in local
# mode the UI auto-logs-in as a synthetic `admin@localhost` user and drops
# everything into ITS OWN auto-created project (a random id like
# `cmyemojwswdjcvyi`), not the API key's project. The UI reports success, but
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
# This script reconciles both: it moves any row sitting in a foreign project
# into the target project, aligning organization_id to that project's org. It
# is idempotent — a row already in the right project is left untouched — and
# best-effort: a problem with one table logs a WARN and never aborts the
# others (so it is safe to wire into `make deploy`).
#
# Conflict handling: at most ONE stray is moved per provider per table (the
# most recently updated), and only when the target does not already hold one
# for that provider. Any remaining strays — older duplicates of the same
# provider, or providers the target already has — are left in place and
# surfaced as a WARN for manual resolution.
#
# Long-term fix (grant + default project + reap): moving rows is only a
# band-aid for things connected before the fix. The durable fix makes the
# user every local-mode UI session logs in as — `admin@localhost` — operate
# inside the agent's project:
#   - grant it ownership of the agent's org, and
#   - set the target project as its DEFAULT project.
# The local-mode UI bounces to /create-org whenever the NextAuth session has
# no projectId, and that projectId comes from findUserDefaultProject(), which
# keys off a project's `created_by` — NOT org membership. So org ownership
# alone isn't enough; pointing the target project's `created_by` at
# admin@localhost makes the UI open directly in the agent's project.
#
# We then reap the throwaway projects/orgs the UI already auto-created for
# that user. The reap is deliberately conservative — it only deletes a
# project that is NOT the target, was `created_by_user_email =
# 'admin@localhost'`, and holds NO app_connections / app_configs.
#
# STOPGAP / external coupling: this reaches directly into OneCLI's internal
# Postgres schema (`app_connections`, `app_configs`, `projects`, `api_keys`).
# OneCLI is an external image pinned by tag, so a schema change upstream would
# break this silently. It exists only to work around the local-mode web UI
# dropping things into its own `admin@localhost` project instead of the API
# key's project; delete it once the UI lands them in the right project.
#
# The target project is resolved from the API key the host actually uses
# (ONECLI_API_KEY in the project-root .env) — its project is read straight
# out of the gateway's `api_keys` table.
#
# Usage:
#   scripts/onecli-reconcile-connections.sh
#
# Normally invoked by `make deploy` (Phase 2, after the gateway is up).

set -uo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -P "$SCRIPT_DIR/.." && pwd)"

# Fixed single-install OneCLI layout (mirrors setup/onecli.ts + Makefile).
ONECLI_PROJECT="onecli"
ONECLI_DIR="$HOME/.onecli"

rc=0

if [ ! -d "$ONECLI_DIR" ]; then
  echo "  WARN: OneCLI install dir $ONECLI_DIR missing, skipping" >&2
  exit 1
fi

# psql runner for the gateway postgres. -X (no .psqlrc), -A -t (unaligned,
# tuples-only) so single-value queries come back clean.
pg() {
  docker compose -p "$ONECLI_PROJECT" --project-directory "$ONECLI_DIR" exec -T postgres \
    psql -U onecli -d onecli -X -A -t -v ON_ERROR_STOP=1 "$@"
}

# Wait briefly for postgres — `make deploy` runs this right after a gateway
# `up -d`, so the container may still be warming up.
pg_ready=false
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if pg -c 'SELECT 1' >/dev/null 2>&1; then
    pg_ready=true
    break
  fi
  sleep 1
done
if [ "$pg_ready" != true ]; then
  echo "  WARN: postgres not reachable (is the OneCLI gateway up?), skipping" >&2
  exit 1
fi

# Resolve the target project from the API key the host uses. Read
# ONECLI_API_KEY from the project-root .env, then look up its project in the
# gateway's api_keys table (the key value is hashed in some schemas; we try
# an exact-value match and fall back to the sole project if there's only one).
API_KEY="$(sed -n 's/^ONECLI_API_KEY=//p' "$REPO_ROOT/.env" 2>/dev/null | head -n1 | tr -d '"'"'"' \r')"

target=""
if [ -n "$API_KEY" ]; then
  target="$(pg -c "SELECT project_id FROM api_keys WHERE key = '$API_KEY' OR token = '$API_KEY' LIMIT 1" 2>/dev/null | tr -d '[:space:]')" || target=""
fi

# Fallback: if the key lookup found nothing (different schema / hashed key)
# and there's exactly one non-throwaway project, use it.
if [ -z "$target" ]; then
  target="$(pg -c "SELECT id FROM projects WHERE created_by_user_email IS DISTINCT FROM 'admin@localhost' LIMIT 2" 2>/dev/null | tr -d ' \r')"
  # If that returned more than one line (multiple candidates) we can't pick
  # safely — bail.
  if [ "$(printf '%s' "$target" | grep -c .)" != "1" ]; then
    echo "  WARN: could not resolve the agent's OneCLI project from ONECLI_API_KEY" >&2
    echo "        (no api_keys match and not exactly one non-UI project). Skipping." >&2
    exit 1
  fi
fi

if [ -z "$target" ]; then
  echo "  WARN: target project not found, skipping" >&2
  exit 1
fi

# Move strays in one table into the target project. Uses the global
# `target`; sets the global `rc` on any issue (best-effort).
#
#   reconcile_table <table> <noun> <recency-tiebreaker-col>
reconcile_table() {
  local table="$1" noun="$2" tiebreak="$3"
  local strays moved leftover

  # set -e is off, so distinguish a query *error* (psql exits non-zero via
  # ON_ERROR_STOP) from a genuinely empty result.
  if ! strays="$(pg -c "SELECT provider || ' (in ' || COALESCE(project_id, '<none>') || ')' \
                   FROM $table WHERE project_id IS DISTINCT FROM '$target' \
                   ORDER BY provider")"; then
    echo "  WARN: failed to query $table, skipping" >&2
    rc=1
    return
  fi
  if [ -z "${strays//[$'\n']/}" ]; then
    echo "==> $table already in $target — nothing to do"
    return
  fi

  echo "==> found $noun(s) in $table outside $target:"
  while IFS= read -r line; do
    [ -n "$line" ] && echo "      - $line"
  done <<< "$strays"

  # `candidates` deterministically selects AT MOST ONE stray per provider —
  # the most recently updated — and only for providers the target doesn't
  # already have. We then update exactly those ids.
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
    echo "  WARN: move query for $table failed; rows left unchanged" >&2
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
    echo "  WARN: $noun(s) left outside $target (target already has that" >&2
    echo "        provider, or a duplicate stray remains): $(echo $leftover | tr '\n' ' ')" >&2
    echo "        Resolve by hand if the misfiled one is the keeper." >&2
    rc=1
  fi
}

# Ensure the UI's synthetic admin@localhost user owns the agent's org AND has
# the target project as its default project (so the UI opens there and future
# connects land there), then reap the empty throwaway projects/orgs it already
# created. Uses the global `target`; sets global `rc` on issues.
ensure_admin_access_and_reap() {
  local admin_id target_org n_proj

  # admin@localhost exists only after someone has opened the UI at least once.
  if ! admin_id="$(pg -c "SELECT id FROM users WHERE email = 'admin@localhost' LIMIT 1")"; then
    echo "  WARN: failed to look up admin@localhost user" >&2
    rc=1
    return
  fi
  admin_id="$(printf '%s' "$admin_id" | tr -d '[:space:]')"
  if [ -z "$admin_id" ]; then
    echo "==> no admin@localhost user yet (UI never opened) — nothing to grant/reap"
    return
  fi

  if ! target_org="$(pg -c "SELECT organization_id FROM projects WHERE id = '$target' LIMIT 1")"; then
    echo "  WARN: failed to read organization for $target" >&2
    rc=1
    return
  fi
  target_org="$(printf '%s' "$target_org" | tr -d '[:space:]')"
  if [ -z "$target_org" ]; then
    echo "  WARN: $target has no organization; skipping admin grant/reap" >&2
    rc=1
    return
  fi

  # 1) Grant — idempotent, non-destructive. ON CONFLICT targets the PK
  #    (organization_id, user_id) and UPDATEs the role, so a pre-existing
  #    lower-role membership is upgraded to 'owner'.
  if ! pg -c "INSERT INTO organization_members (organization_id, user_id, user_email, role, created_at) \
              VALUES ('$target_org', '$admin_id', 'admin@localhost', 'owner', now()) \
              ON CONFLICT (organization_id, user_id) DO UPDATE SET role = 'owner'" >/dev/null; then
    echo "  WARN: failed to grant admin@localhost access to $target_org" >&2
    rc=1
    return
  fi
  echo "==> admin@localhost owns $target_org (UI connects can target $target)"

  # 2) Make the target the admin user's DEFAULT project. See the "Long-term
  #    fix" header note. Idempotent.
  if ! pg -c "UPDATE projects SET created_by_user_id = '$admin_id', created_by_user_email = 'admin@localhost' \
              WHERE id = '$target' AND created_by_user_id IS DISTINCT FROM '$admin_id'; \
              UPDATE users SET onboarding_completed_at = COALESCE(onboarding_completed_at, now()) \
              WHERE id = '$admin_id'" >/dev/null; then
    echo "  WARN: failed to set $target as admin@localhost's default project" >&2
    rc=1
    return
  fi
  echo "==> $target is admin@localhost's default project (UI opens there)"

  # 3) Reap. Pre-count throwaway projects (those NOT the target, created by
  #    admin@localhost, with no app_connections/app_configs) so we can skip
  #    the transaction entirely when there's nothing to do.
  if ! n_proj="$(pg -c "SELECT count(*) FROM projects p \
      WHERE p.id <> '$target' \
        AND p.created_by_user_email = 'admin@localhost' \
        AND NOT EXISTS (SELECT 1 FROM app_connections c WHERE c.project_id = p.id) \
        AND NOT EXISTS (SELECT 1 FROM app_configs cf WHERE cf.project_id = p.id)")"; then
    echo "  WARN: failed to count throwaway projects; skipping reap" >&2
    rc=1
    return
  fi
  n_proj="$(printf '%s' "$n_proj" | tr -d '[:space:]')"
  if [ "${n_proj:-0}" = "0" ]; then
    echo "      no throwaway projects to reap"
    return
  fi

  # Single atomic transaction. Temp tables pin the exact id sets so every
  # DELETE is scoped to admin@localhost's empty throwaways; the target
  # project/org and anything with data are excluded by construction.
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
    echo "  WARN: throwaway reap failed (rolled back, nothing deleted)" >&2
    rc=1
    return
  fi
  echo "      reaped $n_proj throwaway project(s) + empty org(s) created by admin@localhost"
}

# Target project is seeded alongside the nanoclaw API key; if it's missing
# something is wrong with the install — warn rather than create.
if [ -z "$(pg -c "SELECT 1 FROM projects WHERE id = '$target' LIMIT 1")" ]; then
  echo "  WARN: target project '$target' not found, skipping" >&2
  exit 1
fi

# Move the OAuth app registration first, then the connection that uses it.
reconcile_table app_configs "app config" created_at
reconcile_table app_connections "connection" connected_at

# Then make the fix durable: grant the UI user access + reap throwaways.
ensure_admin_access_and_reap

exit $rc
