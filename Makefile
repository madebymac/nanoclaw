.PHONY: deploy build restart logs status install
.PHONY: build-shared deploy-all install-all
.PHONY: new-instance install-onecli install-instance

# Single-install (legacy) unit name: hash of CWD only.
UNIT := nanoclaw-v2-$(shell printf %s "$(CURDIR)" | sha1sum | cut -c1-8)

# Per-instance unit name: hash of "CWD:<instance>". Mirrors getSystemdUnit()
# in src/install-slug.ts. The `%` is the instance name (e.g. `deploy-review`
# → instance = `review`).
unit_for = nanoclaw-v2-$(shell printf %s "$(CURDIR):$(1)" | sha1sum | cut -c1-8)

# ----- single-install targets (unchanged) -----------------------------------

deploy:
	git pull --ff-only
	pnpm install --frozen-lockfile
	pnpm build
	./container/build.sh
	systemctl --user restart $(UNIT)

build:
	pnpm build

restart:
	systemctl --user restart $(UNIT)

logs:
	journalctl --user -u $(UNIT) -f

status:
	systemctl --user status $(UNIT)

install:
	pnpm exec tsx setup/index.ts --step service

# ----- multi-instance targets -----------------------------------------------
#
# Layout:
#   instances/<name>/.env          per-instance config (Telegram token,
#                                  ONECLI_URL on a free port, etc.)
#   instances/<name>/data/         per-instance DB + sessions + ncl socket
#   instances/<name>/groups/       per-instance agent group filesystems
#   instances/<name>/logs/         per-instance service logs
#
# Each instance gets its own systemd unit, derived from CURDIR + name, so
# `make install-review` and `make install-general` install two distinct
# services pointing at the same checkout. One `pnpm build` / image build
# serves both — only the host process is per-instance.
#
# Usage:
#   make install-review                  # generate + load review's systemd unit
#   make deploy-review                   # pull + build + restart review
#   make logs-review                     # tail review's host log
#   make deploy-all INSTANCES="review general"
#
# To use, populate `instances/<name>/.env` first. See instances/example/.

INSTANCES ?=

build-shared:
	git pull --ff-only
	pnpm install --frozen-lockfile
	pnpm build
	./container/build.sh

deploy-all: build-shared
	@if [ -z "$(INSTANCES)" ]; then \
	  echo "deploy-all requires INSTANCES=\"name1 name2 ...\"" >&2; exit 1; \
	fi
	@for inst in $(INSTANCES); do \
	  unit=nanoclaw-v2-$$(printf %s "$(CURDIR):$$inst" | sha1sum | cut -c1-8); \
	  echo "Restarting $$inst ($$unit)"; \
	  systemctl --user restart $$unit; \
	done

install-all:
	@if [ -z "$(INSTANCES)" ]; then \
	  echo "install-all requires INSTANCES=\"name1 name2 ...\"" >&2; exit 1; \
	fi
	@for inst in $(INSTANCES); do \
	  echo "Installing service for instance $$inst"; \
	  NCL_INSTANCE=$$inst pnpm exec tsx setup/index.ts --step service; \
	done

# Per-instance pattern targets — `make deploy-review` etc.
deploy-%: build-shared
	systemctl --user restart $(call unit_for,$*)

restart-%:
	systemctl --user restart $(call unit_for,$*)

logs-%:
	journalctl --user -u $(call unit_for,$*) -f

status-%:
	systemctl --user status $(call unit_for,$*)

install-%:
	NCL_INSTANCE=$* pnpm exec tsx setup/index.ts --step service

# ----- name-arg targets (zero-manual UX) ------------------------------------
#
# `make new-instance NAME=review` → render instances/review/.env from
# instances.conf (auto-assigns OneCLI port triple).
#
# `make install-onecli NAME=review` → install OneCLI gateway + CLI for this
# instance under its own docker-compose project on the assigned port triple.
# Wraps the upstream onecli.sh installer with COMPOSE_PROJECT_NAME + best-
# effort port override env vars.
#
# `make install-instance NAME=review` → end-to-end: render env (if missing) +
# install OneCLI + register systemd unit. The one command that takes a fresh
# instance entry in instances.conf to a running service.

NAME ?=

new-instance:
	@if [ -z "$(NAME)" ]; then echo "usage: make new-instance NAME=<name>" >&2; exit 2; fi
	scripts/render-instance-env.sh $(NAME)

install-onecli:
	@if [ -z "$(NAME)" ]; then echo "usage: make install-onecli NAME=<name>" >&2; exit 2; fi
	@if [ ! -f instances/$(NAME)/.env ]; then \
	  echo "instances/$(NAME)/.env missing — run \`make new-instance NAME=$(NAME)\` first" >&2; \
	  exit 1; \
	fi
	NCL_INSTANCE=$(NAME) pnpm exec tsx setup/onecli.ts

install-instance:
	@if [ -z "$(NAME)" ]; then echo "usage: make install-instance NAME=<name>" >&2; exit 2; fi
	@if [ ! -f instances/$(NAME)/.env ]; then \
	  $(MAKE) new-instance NAME=$(NAME); \
	fi
	$(MAKE) install-onecli NAME=$(NAME)
	NCL_INSTANCE=$(NAME) pnpm exec tsx setup/index.ts --step service
