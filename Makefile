.PHONY: deploy build restart logs status

# Multi-instance is the only supported mode. The Makefile reads INSTANCES
# from instances.conf and loops over every name. There is no
# single-install fallback — if INSTANCES is empty or instances.conf is
# missing, every target fails loudly.
INSTANCES := $(shell . ./instances.conf 2>/dev/null && echo "$$INSTANCES")

# Hard guard: every user-facing target depends on this. Keeps the failure
# at the front (clear message) instead of deep inside a `systemctl` call.
guard-instances:
	@if [ -z "$(INSTANCES)" ]; then \
	  echo "error: INSTANCES is empty or instances.conf is missing." >&2; \
	  echo "       Set INSTANCES in instances.conf (e.g. INSTANCES=\"review general\")." >&2; \
	  exit 1; \
	fi

# Unit-name formula (used inline in each target's shell loop so the per-
# iteration variable expands correctly). MUST stay in lock-step with
# getInstallSlug() in src/install-slug.ts: sha1("<CWD>:<name>")[:8].

# Build-step lock. Self-upgrade ticks from each instance's host all fire
# `make deploy`. flock serializes the whole deploy (pull + install +
# bootstrap + build + restart) against shared mutable state: .git/index,
# node_modules/, dist/, image tag, OneCLI compose projects, and systemd
# user units. The loser blocks until the winner finishes, then no-ops
# through every idempotent step (git already up-to-date → no commits;
# pnpm install satisfied → no-op; env files exist → skip; OneCLI compose
# project already running → skip; systemd unit registered → skip; build
# no-op) and proceeds to its restart. Scoped to CURDIR so two unrelated
# nanoclaw checkouts on the same host don't block each other.
BUILD_LOCK := /tmp/nanoclaw-build-$(shell printf %s "$(CURDIR)" | sha1sum | cut -c1-8).lock

# `make deploy` is the only command an operator (or the self-upgrade
# poller) ever needs. It is self-bootstrapping and idempotent, and it
# doubles as the recovery/reset command: the reap + restart tail ALWAYS
# runs, even if the upgrade phase fails, so a wedged agent container or a
# half-broken tree never leaves you stuck. Two phases:
#
# PHASE 1 — upgrade (best-effort, runs under `set -e` in a subshell).
# Ordering matters — `pnpm install` MUST run before any `pnpm exec tsx
# ...` so that `tsx` (a devDependency) is on disk when the bootstrap
# steps invoke it:
#   1. git pull --ff-only
#   2. pnpm install --frozen-lockfile
#   3. For each instance in INSTANCES (from instances.conf):
#        a. Render instances/<name>/.env if missing.
#        b. `docker compose -p onecli-<name> up -d` if not already running.
#        c. Register the per-instance systemd user unit if missing.
#   4. pnpm build
#   5. ./container/build.sh
# If any step here fails the subshell aborts, deploy logs a WARN, marks a
# non-zero exit, and falls through to PHASE 2 anyway (so a dirty tree or a
# broken build still gets you a clean restart onto the last good dist/).
#
# PHASE 2 — reap + restart (ALWAYS runs, tolerant per-instance). For each
# instance:
#   6. Bounce the OneCLI gateway compose project (`docker compose up -d` —
#      preserves named volumes pgdata and app-data, and re-reads the
#      compose file / per-instance .env so template tweaks and
#      `ONECLI_VERSION` bumps take effect).
#   7. Force-kill every agent container carrying this instance's
#      `nanoclaw-install=<slug>` label — the same label scope the host's
#      startup cleanupOrphans() reaps by (see container-runtime.ts). This
#      clears a wedged container immediately rather than waiting on the
#      restarted host to notice it.
#   8. Restart the instance unit. The fresh host clears stale `processing`
#      acks and reprocesses any pending messages.
# A single failed bounce/restart logs WARN; the loop continues and deploy
# exits non-zero overall.
#
# Steps 3a-c are idempotent presence checks, so deploy on a fully-
# installed host is just pull + install + build + reap + restart. On a
# brand-new host (or after adding a name to instances.conf) the missing
# bits install inline. Self-upgrade alone is enough to take a fresh
# instance from "name added to instances.conf" to running.
#
# NOTE: the slug formula below MUST stay in lock-step with getInstallSlug()
# in src/install-slug.ts: sha1("<CWD>:<name>")[:8] — it names the systemd
# unit AND scopes the container-kill label.
deploy: guard-instances
	flock $(BUILD_LOCK) -c '\
	  rc=0; \
	  ( set -e; \
	    git pull --ff-only; \
	    pnpm install --frozen-lockfile; \
	    for inst in $(INSTANCES); do \
	      unit=nanoclaw-v2-$$(printf %s "$(CURDIR):$$inst" | sha1sum | cut -c1-8); \
	      if [ ! -f instances/$$inst/.env ]; then \
	        echo "==> [$$inst] rendering instances/$$inst/.env"; \
	        scripts/render-instance-env.sh $$inst; \
	      fi; \
	      if ! docker compose -p onecli-$$inst ps --status running --quiet 2>/dev/null | grep -q .; then \
	        echo "==> [$$inst] bringing up OneCLI gateway"; \
	        NCL_INSTANCE=$$inst pnpm exec tsx setup/index.ts --step onecli; \
	      fi; \
	      if [ ! -f $$HOME/.config/systemd/user/$$unit.service ]; then \
	        echo "==> [$$inst] registering systemd unit $$unit"; \
	        NCL_INSTANCE=$$inst pnpm exec tsx setup/index.ts --step service; \
	      fi; \
	    done; \
	    pnpm build; \
	    ./container/build.sh; \
	  ) || { echo "  WARN: upgrade phase failed ($$?) — proceeding to reap + restart" >&2; rc=1; }; \
	  for inst in $(INSTANCES); do \
	    slug=$$(printf %s "$(CURDIR):$$inst" | sha1sum | cut -c1-8); \
	    if [ -d $$HOME/.onecli-$$inst ]; then \
	      echo "Bouncing OneCLI gateway for $$inst"; \
	      docker compose --project-directory $$HOME/.onecli-$$inst -p onecli-$$inst up -d \
	        || { echo "  WARN: $$inst OneCLI up -d failed" >&2; rc=1; }; \
	    else \
	      echo "  WARN: $$inst OneCLI install dir missing, skipping bounce" >&2; rc=1; \
	    fi; \
	    ids=$$(docker ps -q --filter label=nanoclaw-install=$$slug); \
	    if [ -n "$$ids" ]; then \
	      echo "==> [$$inst] killing $$(echo $$ids | wc -w) agent container(s) (label nanoclaw-install=$$slug)"; \
	      docker kill $$ids >/dev/null 2>&1 || true; \
	    fi; \
	    echo "Restarting $$inst (nanoclaw-v2-$$slug)"; \
	    systemctl --user restart nanoclaw-v2-$$slug || { echo "  WARN: $$inst restart failed" >&2; rc=1; }; \
	  done; \
	  exit $$rc'

build:
	pnpm build

restart: guard-instances
	@rc=0; for inst in $(INSTANCES); do \
	  systemctl --user restart nanoclaw-v2-$$(printf %s "$(CURDIR):$$inst" | sha1sum | cut -c1-8) || { echo "  WARN: $$inst restart failed" >&2; rc=1; }; \
	done; exit $$rc

logs: guard-instances
	@units=""; for inst in $(INSTANCES); do \
	  units="$$units -u nanoclaw-v2-$$(printf %s "$(CURDIR):$$inst" | sha1sum | cut -c1-8)"; \
	done; \
	journalctl --user $$units -f

status: guard-instances
	@for inst in $(INSTANCES); do \
	  systemctl --user status --no-pager nanoclaw-v2-$$(printf %s "$(CURDIR):$$inst" | sha1sum | cut -c1-8) || true; \
	done
