.PHONY: deploy build restart logs status

# Single-install. The systemd unit name MUST stay in lock-step with
# getInstallSlug() in src/install-slug.ts: sha1("<CWD>")[:8].
SLUG := $(shell printf %s "$(CURDIR)" | sha1sum | cut -c1-8)
UNIT := nanoclaw-v2-$(SLUG)

# OneCLI gateway install dir + compose project (fixed single-install).
ONECLI_DIR := $(HOME)/.onecli
ONECLI_PROJECT := onecli

# Build-step lock. Self-upgrade ticks fire `make deploy`. flock serializes
# the whole deploy (pull + install + bootstrap + build + restart) against
# shared mutable state: .git/index, node_modules/, dist/, image tag, the
# OneCLI compose project, and the systemd user unit. Scoped to CURDIR so two
# unrelated nanoclaw checkouts on the same host don't block each other.
BUILD_LOCK := /tmp/nanoclaw-build-$(SLUG).lock

# `make deploy` is the only command an operator (or the self-upgrade poller)
# ever needs. It is self-bootstrapping and idempotent, and it doubles as the
# recovery/reset command: the reap + restart tail ALWAYS runs, even if the
# upgrade phase fails, so a wedged agent container or a half-broken tree
# never leaves you stuck. Two phases:
#
# PHASE 1 — upgrade (best-effort, runs under `set -e` in a subshell).
# Ordering matters — `pnpm install` MUST run before any `pnpm exec tsx ...`
# so that `tsx` (a devDependency) is on disk when the bootstrap steps invoke
# it:
#   1. git pull --ff-only
#   2. pnpm install --frozen-lockfile
#   3. Bring up the OneCLI gateway if not already running.
#   4. Register the systemd user unit if missing.
#   5. pnpm build
#   6. ./container/build.sh
# If any step here fails the subshell aborts, deploy logs a WARN, marks a
# non-zero exit, and falls through to PHASE 2 anyway (so a dirty tree or a
# broken build still gets you a clean restart onto the last good dist/).
#
# PHASE 2 — reap + restart (ALWAYS runs):
#   7. Bounce the OneCLI gateway compose project (`docker compose up -d` —
#      preserves named volumes pgdata and app-data, and re-reads the compose
#      file / .env so template tweaks and `ONECLI_VERSION` bumps take effect).
#   8. Force-kill every agent container carrying this install's
#      `nanoclaw-install=<slug>` label — the same label scope the host's
#      startup cleanupOrphans() reaps by (see container-runtime.ts).
#   9. Restart the unit. The fresh host clears stale `processing` acks and
#      reprocesses any pending messages.
deploy:
	flock $(BUILD_LOCK) -c '\
	  rc=0; \
	  ( set -e; \
	    git pull --ff-only; \
	    pnpm install --frozen-lockfile; \
	    if ! docker compose -p $(ONECLI_PROJECT) ps --status running --quiet 2>/dev/null | grep -q .; then \
	      echo "==> bringing up OneCLI gateway"; \
	      pnpm exec tsx setup/index.ts --step onecli; \
	    fi; \
	    if [ ! -f $$HOME/.config/systemd/user/$(UNIT).service ]; then \
	      echo "==> registering systemd unit $(UNIT)"; \
	      pnpm exec tsx setup/index.ts --step service; \
	    fi; \
	    pnpm build; \
	    ./container/build.sh; \
	  ) || { echo "  WARN: upgrade phase failed ($$?) — proceeding to reap + restart" >&2; rc=1; }; \
	  if [ -d $(ONECLI_DIR) ]; then \
	    echo "Bouncing OneCLI gateway"; \
	    docker compose --project-directory $(ONECLI_DIR) -p $(ONECLI_PROJECT) up -d \
	      || { echo "  WARN: OneCLI up -d failed" >&2; rc=1; }; \
	  else \
	    echo "  WARN: OneCLI install dir missing, skipping bounce" >&2; rc=1; \
	  fi; \
	  echo "Reconciling OneCLI app connections (best-effort)"; \
	  scripts/onecli-reconcile-connections.sh \
	    || echo "  WARN: connection reconcile failed — best-effort, ignoring" >&2; \
	  ids=$$(docker ps -q --filter label=nanoclaw-install=$(SLUG)); \
	  if [ -n "$$ids" ]; then \
	    echo "==> killing $$(echo $$ids | wc -w) agent container(s) (label nanoclaw-install=$(SLUG))"; \
	    docker kill $$ids >/dev/null 2>&1 || true; \
	  fi; \
	  echo "Restarting $(UNIT)"; \
	  systemctl --user restart $(UNIT) || { echo "  WARN: restart failed" >&2; rc=1; }; \
	  exit $$rc'

build:
	pnpm build

restart:
	systemctl --user restart $(UNIT)

logs:
	journalctl --user -u $(UNIT) -f

status:
	@systemctl --user status --no-pager $(UNIT) || true
