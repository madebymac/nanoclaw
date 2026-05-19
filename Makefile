.PHONY: deploy build restart logs status install

deploy:
	git pull --ff-only
	pnpm install --frozen-lockfile
	pnpm build
	./container/build.sh
	systemctl --user restart nanoclaw

build:
	pnpm build

restart:
	systemctl --user restart nanoclaw

logs:
	journalctl --user -u nanoclaw -f

status:
	systemctl --user status nanoclaw

install:
	pnpm exec tsx setup/index.ts --step service
