.PHONY: deploy build restart logs status install

# Read INSTANCES from instances.conf. Absent or empty → single-install
# mode (legacy behavior). Non-empty → multi-instance: every target
# operates on every instance listed there.
INSTANCES := $(shell . ./instances.conf 2>/dev/null && echo "$$INSTANCES")

# Unit-name formula. MUST stay in lock-step with getInstallSlug() in
# src/install-slug.ts:
#   single-install: sha1("<CWD>")[:8]
#   per-instance:   sha1("<CWD>:<name>")[:8]
unit_for = nanoclaw-v2-$(shell printf %s "$(CURDIR)$(if $(1),:$(1),)" | sha1sum | cut -c1-8)

# Build-step lock. Self-upgrade ticks from each instance's host all fire
# `make deploy`. flock serializes the build phase against the shared
# .git/index.lock, node_modules/, dist/, and image tag — the loser
# blocks until the first finishes, then no-ops through its own build
# (git already up-to-date) and proceeds to the restart loop. Scoped to
# CURDIR so two unrelated nanoclaw checkouts on the same host don't
# block each other.
BUILD_LOCK := /tmp/nanoclaw-build-$(shell printf %s "$(CURDIR)" | sha1sum | cut -c1-8).lock

deploy:
	flock $(BUILD_LOCK) -c '\
	  git pull --ff-only && \
	  pnpm install --frozen-lockfile && \
	  pnpm build && \
	  ./container/build.sh'
	@if [ -z "$(INSTANCES)" ]; then \
	  echo "Restarting single-install unit"; \
	  systemctl --user restart $(call unit_for,); \
	else \
	  for inst in $(INSTANCES); do \
	    unit=nanoclaw-v2-$$(printf %s "$(CURDIR):$$inst" | sha1sum | cut -c1-8); \
	    echo "Restarting $$inst ($$unit)"; \
	    systemctl --user restart $$unit; \
	  done; \
	fi

build:
	pnpm build

restart:
	@if [ -z "$(INSTANCES)" ]; then \
	  systemctl --user restart $(call unit_for,); \
	else \
	  for inst in $(INSTANCES); do \
	    unit=nanoclaw-v2-$$(printf %s "$(CURDIR):$$inst" | sha1sum | cut -c1-8); \
	    systemctl --user restart $$unit; \
	  done; \
	fi

logs:
	@if [ -z "$(INSTANCES)" ]; then \
	  journalctl --user -u $(call unit_for,) -f; \
	else \
	  units=""; \
	  for inst in $(INSTANCES); do \
	    unit=nanoclaw-v2-$$(printf %s "$(CURDIR):$$inst" | sha1sum | cut -c1-8); \
	    units="$$units -u $$unit"; \
	  done; \
	  journalctl --user $$units -f; \
	fi

status:
	@if [ -z "$(INSTANCES)" ]; then \
	  systemctl --user status $(call unit_for,); \
	else \
	  for inst in $(INSTANCES); do \
	    unit=nanoclaw-v2-$$(printf %s "$(CURDIR):$$inst" | sha1sum | cut -c1-8); \
	    systemctl --user status --no-pager $$unit || true; \
	  done; \
	fi

# Single-install mode: register the service unit (matches legacy behavior).
# Multi-instance mode: for each instance, render its .env if missing,
# install OneCLI if needed, then register the service unit.
install:
	@if [ -z "$(INSTANCES)" ]; then \
	  pnpm exec tsx setup/index.ts --step service; \
	else \
	  for inst in $(INSTANCES); do \
	    echo "==> Installing instance: $$inst"; \
	    [ -f instances/$$inst/.env ] || scripts/render-instance-env.sh $$inst; \
	    NCL_INSTANCE=$$inst pnpm exec tsx setup/index.ts --step onecli; \
	    NCL_INSTANCE=$$inst pnpm exec tsx setup/index.ts --step service; \
	  done; \
	fi
