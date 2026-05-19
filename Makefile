.PHONY: deploy build restart logs status install

UNIT := nanoclaw-v2-$(shell printf %s "$(CURDIR)" | sha1sum | cut -c1-8)

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
