# Automatic PR review

An opt-in scan that watches for open pull requests the review bot hasn't
looked at yet and hands them to the reviewer agent for review. Scheduling
lives **outside** the host process — a system cron (or launchd / systemd
timer) invokes `ncl pr-review run` on whatever cadence the operator chose.

## How it works

```
  system cron (crontab / launchd / systemd timer)
           │   * * * * * /path/to/ncl pr-review run
           ▼
  ncl client ──Unix socket── host process (runPrReviewTick)
                                │
                                │ 1. mint the reviewer agent's GitHub App installation token
                                │ 2. GET /installation/repositories     ← all repos the App sees
                                │ 3. for each open, non-draft PR:
                                │      GET reviews + issue/review comments
                                │      → has the bot (<app-slug>[bot]) already touched it?
                                │ 4. if not (and not already dispatched recently):
                                │      inject a `task` instruction into the reviewer agent's
                                │      session  +  wake the container
                                ▼
                  reviewer agent reviews the PR with its own
                  GitHub access — inline comments + APPROVE /
                  REQUEST_CHANGES / COMMENT
```

Steps 1–3 are **pure GitHub REST** — no AI tokens are spent deciding whether a
PR needs review. The agent (and its tokens) are only engaged in step 4, when a
PR genuinely needs a review.

## Why cron, not an in-process timer

The host stays the sole writer to every session DB (a load-bearing invariant
called out in `src/session-manager.ts`). Running the scan inside the host
via `ncl pr-review run` keeps writes single-source. A standalone script that
opened `inbound.db` directly would race the host's writes and corrupt the
DB on the cross-mount.

The flip-side: the cadence now lives in your crontab, not in env vars. No
`PR_REVIEW_INTERVAL_MS` to tune.

## Enabling it

1. The reviewer agent group must already have a GitHub App identity
   (`ncl github-apps create --agent-group-id <id> ...`), since that's both how
   the host mints a token to scan and how the agent authenticates to review.

2. In `.env` (or the environment):
   ```bash
   PR_REVIEW_ENABLED=true
   PR_REVIEW_AGENT_GROUP_ID=<reviewer agent group id>
   # optional:
   PR_REVIEW_COOLDOWN_MS=1800000               # re-dispatch window if no review lands (floored at 60000)
   ```
   Restart the host so it picks up the new env vars.

3. Add a system cron entry, e.g. every minute:
   ```cron
   * * * * * /path/to/nanoclaw/ncl pr-review run >/dev/null 2>&1
   ```
   On macOS, a launchd `StartInterval` agent works equivalently; on Linux a
   `systemd` user timer is the modern equivalent. The `ncl` client talks to
   the running host over `data/ncl.sock`, so the host must be running for
   ticks to do anything (a tick fired with the host down logs and exits non-zero).

With `PR_REVIEW_ENABLED=false` or unset, `ncl pr-review run` returns
`{status: "disabled"}` and does no work — safe to leave the cron entry in
place across enable/disable cycles.

You can also run a tick by hand for diagnosis:
```bash
ncl pr-review run
# → {"status":"ran","dispatched":2}
```

## Scope and behaviour

- **Repos:** every repo the reviewer's GitHub App installation can access. Add
  or remove repos from the App and the scan follows automatically.
- **Trigger:** an open, non-draft PR with **no** review or comment authored by
  the bot account (`<app-slug>[bot]`). Once the bot has reviewed (or commented),
  the PR is never re-triggered — matching the "PRs that have not yet had any
  comments by the review bot" rule.
- **Bot-authored PRs:** a PR whose author is a bot account (`user.type ==
  "Bot"` or a `[bot]` login), or whose description carries a Claude Code
  footer (`Generated with [Claude Code]` / a `claude.ai/code/session_` link —
  Claude Code opens PRs under the human's account), is flagged in the review
  prompt. The reviewer is told the author has no physical device, so it must
  not ask for on-device screenshots or manual testing evidence, nor block on
  their absence; it judges automated tests / CI instead and leaves any real
  device check as a non-blocking note for the human maintainer
  (`isBotAuthored` in `scan.ts`).
- **No duplicate nagging:** a dispatched PR is recorded in `pr_review_dispatch`
  (central DB, migration 017). It won't be re-instructed until the cooldown
  elapses (covers an agent run that errored before posting a review) or new
  commits change the PR's head SHA.
- **Concurrent ticks:** if your cron fires faster than a tick completes
  (e.g. `* * * * *` but a tick scanning many repos takes 90s), the second
  invocation returns `{status: "busy"}` and exits. No two ticks ever run at
  once.
- **Where the instruction lands:** the reviewer agent's session, as a `task`
  message (the same shape a user-scheduled task uses), in its `agent-shared`
  session. The host posts no chat status of its own; any start/finish
  notification comes from the agent (see `config-examples/pr-reviewer/`).

## Key files

| File | Purpose |
|------|---------|
| `src/modules/pr-review/index.ts` | `runPrReviewTick()` — the per-invocation orchestration (exported, no timer) |
| `src/cli/resources/pr-review.ts` | Registers `pr-review run` so cron can call into the host via `ncl` |
| `src/modules/pr-review/github.ts` | Read-only GitHub REST helpers (repos, open PRs, bot-touched check) |
| `src/modules/pr-review/scan.ts` | Pure `shouldDispatch` decision (unit-tested, no I/O) |
| `src/modules/pr-review/dispatch.ts` | Injects the review `task`, wakes the container |
| `src/modules/pr-review/db.ts` | `pr_review_dispatch` tracking (dedupe) |
| `src/github-app-broker.ts` | `mintInstallationToken` + `fetchAppLogin` (bot login) |
