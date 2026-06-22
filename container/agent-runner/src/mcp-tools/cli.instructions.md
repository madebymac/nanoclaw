## Admin CLI (`ncl`)

The `ncl` command is available at `/usr/local/bin/ncl`. It lets you query and modify NanoClaw's central configuration. Run `ncl help` for the full list of resources and verbs.

### Usage

```
ncl <resource> <verb> [--flags]
ncl <resource> help   # full schema, fields, enums
```

Under `group` scope (the default), `--id` and group-related args are auto-filled — you don't need to pass them.

### Common commands

```bash
ncl groups get              # your group config
ncl groups config get       # container config
ncl destinations list       # where you can send messages
ncl members list            # who can access this group
ncl sessions list           # active sessions

ncl groups restart          # restart container (write — needs approval)
ncl groups config update --model claude-haiku-4-5-20251001
ncl groups config add-mcp-server --name rss --command npx --args '["some-rss-mcp"]'
ncl members add --user telegram:jane
```

### Access rules

- **Read** (list, get): immediate, no approval.
- **Write** (create, update, delete, restart, config update, add, remove): returns `approval-pending` immediately — the command has **not** run yet. An admin approves or rejects; the result arrives as a system message. Do not poll or retry.

### Important

- Config changes via `ncl groups config update` take effect only after `ncl groups restart`.
- Flags use `--hyphen-case`; `list` defaults to 200 rows (`--limit N` to override).
