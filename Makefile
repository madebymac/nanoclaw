.PHONY: deploy build restart logs status install

deploy:
	git pull
	pnpm install --frozen-lockfile
	pnpm build
	./container/build.sh
	sudo systemctl restart nanoclaw

build:
	pnpm build

restart:
	sudo systemctl restart nanoclaw

logs:
	journalctl -u nanoclaw -f

status:
	sudo systemctl status nanoclaw

install:
	pnpm exec tsx setup/index.ts --step service
