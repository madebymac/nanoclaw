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
	sed -e 's|__USER__|$(shell id -un)|g' -e 's|__WORKDIR__|$(CURDIR)|g' systemd/nanoclaw.service | sudo tee /etc/systemd/system/nanoclaw.service > /dev/null
	sudo systemctl daemon-reload
	sudo systemctl enable --now nanoclaw
