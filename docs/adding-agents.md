# Adding an agent (with its own standalone bot)

NanoClaw runs as a **single host process** that can drive **many standalone bots
at once — one Telegram @handle per agent**. Each bot is an independent identity:
users see a distinct `@your_agent_bot`, and messages to it route to that agent's
own sessions.

This runbook is the end-to-end flow for adding agent #N. It uses the `ncl`
admin CLI (run it on the host, or from a global-scope agent container).

> **How it works under the hood.** Each bot is modelled as its own
> `channel_type` of the form `<family>#<slug>` (e.g. `telegram#andy`), stored in
> the `channel_accounts` table. The bot token is a **host-side** secret — read
> by the host to run the bot, never injected into a container. See
> [the channels section of CLAUDE.md](../CLAUDE.md) and
> [docs/isolation-model.md](isolation-model.md) for the model.

## Prerequisites

- NanoClaw is set up and the host service is running (`/setup` done).
- You can run `ncl` (host shell, or an owner agent with `cli_scope=global`).

## 1. Create a Telegram bot with BotFather

1. In Telegram, message **@BotFather** → `/newbot`.
2. Pick a display name and a username ending in `bot` (e.g. `andy_assistant_bot`).
3. Copy the **bot token** (looks like `123456:ABC-DEF...`).
4. *(For group chats only)* BotFather → `/mybots` → your bot → **Bot Settings →
   Group Privacy → Turn off**, so the bot can see group messages.

## 2. Create the agent group

```bash
ncl groups create --name "Andy" --folder andy
# note the returned agent group id, e.g. ag-andy-xxxx
```

## 3. Register the bot and bind it to the agent

```bash
ncl channel-accounts create \
  --slug andy \
  --bot-token 123456:ABC-DEF... \
  --agent-group-id ag-andy-xxxx \
  --label "@andy_assistant_bot"
```

- `--slug` is the short, unique name for this bot (lowercase, e.g. `andy`). It
  becomes the bot's `channel_type` (`telegram#andy`).
- `--family` defaults to `telegram`.
- The bot token is **write-only** — `ncl channel-accounts list/get` never echo
  it. To rotate it later: `ncl channel-accounts set-token --id telegram#andy --bot-token <new>` (the bot restarts live).

The bot **starts immediately — no host restart**. `create` returns
`live_started: true` on success; if it returns `false` with a `note`, that
explains why (e.g. the host is still booting) and a restart will pick it up.
Removing a bot (`ncl channel-accounts delete --id telegram#andy`) also stops it
live.

## 4. Pair the chat

With the host running, DM your new bot the pairing code:

```bash
ncl ... # if using the guided flow, /init-first-agent or /manage-channels can drive pairing
# or run the pairing step directly:
pnpm exec tsx setup/index.ts --step pair-telegram -- --intent wire-to:andy
```

Send the 4-digit code (shown in the `PAIR_TELEGRAM_ISSUED` output) as a message
**from the chat you want to register** — DM the bot for a personal assistant. On
success the chat is registered under `telegram#andy` and **auto-wired** to the
`andy` agent, so the bot just works (DMs respond to everything; group chats are
mention-only by default — adjust with `/manage-channels`).

That's it. Message your bot and it talks to its agent.

## Optional: act as a GitHub App bot

If this agent should operate as a self-hosted GitHub App (e.g. open PRs as a bot
identity — a feature OneCLI paywalls), register a GitHub App identity. NanoClaw
mints a short-lived installation token from your private key at container spawn
and injects it as `GH_TOKEN`/`GITHUB_TOKEN`. The **private key stays on the host
filesystem and never enters the container or any chat context** — only the
short-lived token does.

1. Create a GitHub App, install it on the target org/repos, and download its
   private key. Put the `.pem` outside the repo with `chmod 600`.
2. Register it:

```bash
ncl github-apps create \
  --agent-group-id ag-andy-xxxx \
  --app-id 123456 \
  --installation-id 7891011 \
  --private-key-path /home/you/.secrets/andy-app.pem
# --api-url https://ghe.example.com/api/v3   # for GitHub Enterprise
```

No restart needed: the token is minted fresh on each container spawn, so the
identity takes effect on the agent's next wake. (One identity per agent group —
`create` errors if the group already has one; `ncl github-apps delete --id <id>`
to replace it.)

## Troubleshooting

| Symptom | Check |
|---|---|
| Bot never responds | Host restarted after `channel-accounts create`? `ncl channel-accounts list` shows it? Token correct? |
| Bot online but ignores group messages | BotFather Group Privacy turned **off** (step 1.4). In groups the bot is mention-only by default. |
| Pairing code rejected | Codes are single-use and regenerate on a wrong guess; use the latest code shown. The host must be running during pairing. |
| `gh`/git not authenticated in the agent | `ncl github-apps get <id>` — is the `private_key_path` readable by the host user and `chmod 600`? Check host logs for "GitHub App token" warnings. |

For credentials the agent itself calls (Anthropic, Gmail, etc.), see the OneCLI
section of [CLAUDE.md](../CLAUDE.md) — that's a separate, agent-side vault.
