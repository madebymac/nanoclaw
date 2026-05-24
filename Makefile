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
# `make deploy`. flock serializes the whole deploy phase (bootstrap +
# build + restart) against the shared .git/index.lock, node_modules/,
# dist/, image tag, OneCLI compose project, and systemd unit registration.
# The loser blocks until the first finishes, then no-ops through every
# step (env exists → skip; OneCLI installed → skip; unit registered →
# skip; git already up-to-date → skip; pnpm install satisfied → no-op;
# build no-op) and proceeds straight to the restart. Scoped to CURDIR so
# two unrelated nanoclaw checkouts on the same host don't block each
# other.
BUILD_LOCK := /tmp/nanoclaw-build-$(shell printf %s "$(CURDIR)" | sha1sum | cut -c1-8).lock

# `make deploy` is the only command an operator (or the self-upgrade
# poller) ever needs. It is self-bootstrapping and idempotent:
#
#   For each instance in INSTANCES (from instances.conf):
#     1. Render instances/<name>/.env if missing.
#     2. Install OneCLI under ~/.onecli-<name>/ if missing.
#     3. Register the per-instance systemd user unit if missing.
#   Then once:
#     4. git pull --ff-only
#     5. pnpm install --frozen-lockfile
#     6. pnpm build
#     7. ./container/build.sh
#   Finally, restart every instance unit (tolerant — a single failed
#   restart logs WARN, the loop continues, deploy exits non-zero overall).
#
# Steps 1-3 are idempotent file-presence checks, so running deploy on a
# fully-installed host is a normal build + restart. Running it on a
# brand-new host (or after `git pull` brings in a new instance name) just
# installs the missing bits inline. Self-upgrade alone is enough to take
# a fresh instance from "name added to instances.conf" to running.
deploy: guard-instances
	flock $(BUILD_LOCK) -c '\
	  set -e; \
	  for inst in $(INSTANCES); do \
	    unit=nanoclaw-v2-$$(printf %s "$(CURDIR):$$inst" | sha1sum | cut -c1-8); \
	    if [ ! -f instances/$$inst/.env ]; then \
	      echo "==> [$$inst] rendering instances/$$inst/.env"; \
	      scripts/render-instance-env.sh $$inst; \
	    fi; \
	    if [ ! -d $$HOME/.onecli-$$inst ]; then \
	      echo "==> [$$inst] installing OneCLI"; \
	      NCL_INSTANCE=$$inst pnpm exec tsx setup/index.ts --step onecli; \
	    fi; \
	    if [ ! -f $$HOME/.config/systemd/user/$$unit.service ]; then \
	      echo "==> [$$inst] registering systemd unit $$unit"; \
	      NCL_INSTANCE=$$inst pnpm exec tsx setup/index.ts --step service; \
	    fi; \
	  done; \
	  git pull --ff-only && \
	  pnpm install --frozen-lockfile && \
	  pnpm build && \
	  ./container/build.sh'
	@rc=0; for inst in $(INSTANCES); do \
	  unit=nanoclaw-v2-$$(printf %s "$(CURDIR):$$inst" | sha1sum | cut -c1-8); \
	  echo "Restarting $$inst ($$unit)"; \
	  systemctl --user restart $$unit || { echo "  WARN: $$inst restart failed" >&2; rc=1; }; \
	done; exit $$rc

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
