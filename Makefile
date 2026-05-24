.PHONY: deploy build restart logs status install

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
# `make deploy`. flock serializes the build phase against the shared
# .git/index.lock, node_modules/, dist/, and image tag — the loser
# blocks until the first finishes, then no-ops through its own build
# (git already up-to-date) and proceeds to the restart loop. Scoped to
# CURDIR so two unrelated nanoclaw checkouts on the same host don't
# block each other.
BUILD_LOCK := /tmp/nanoclaw-build-$(shell printf %s "$(CURDIR)" | sha1sum | cut -c1-8).lock

deploy: guard-instances
	flock $(BUILD_LOCK) -c '\
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

# For each instance listed in instances.conf: render its .env if missing,
# install OneCLI on the auto-assigned port triple, register the systemd
# unit.
install: guard-instances
	@for inst in $(INSTANCES); do \
	  echo "==> Installing instance: $$inst"; \
	  [ -f instances/$$inst/.env ] || scripts/render-instance-env.sh $$inst; \
	  NCL_INSTANCE=$$inst pnpm exec tsx setup/index.ts --step onecli; \
	  NCL_INSTANCE=$$inst pnpm exec tsx setup/index.ts --step service; \
	done
