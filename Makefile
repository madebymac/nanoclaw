.PHONY: deploy build restart logs status install

deploy:
	git pull
	pnpm install
	pnpm build
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
	sudo cp systemd/nanoclaw.service /etc/systemd/system/
	sudo systemctl daemon-reload
	sudo systemctl enable nanoclaw
