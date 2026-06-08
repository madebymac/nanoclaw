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
   PR_REVIEW_STATUS_MESSAGING_GROUP_ID=<id>    # see "Status updates" below
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

## Status updates (optional)

By default the reviewer agent stays silent — it leaves inline comments on the
PR and that's it. If you set `PR_REVIEW_STATUS_MESSAGING_GROUP_ID` to the id
of a `messaging_group` (e.g. a Telegram group chat the review bot is in),
each dispatch produces two updates in that chat:

1. **Review requested** — posted by the host the instant a PR is handed off,
   before the container even wakes (so you see the ping in real time):
   `Review requested: acme/widgets#42 / Title: ... / Author: @octocat / <url>`.
2. **Review complete** — the agent's own reply once it has submitted its
   review, with the verdict (`APPROVED` / `CHANGES_REQUESTED` / `COMMENTED`),
   the PR link, and a one-paragraph summary.

To make (2) work, dispatch resolves the reviewer's session against the
configured messaging group in `shared` mode, so the bot's natural chat reply
flows back to the same chat. Without the env var, the original silent
`agent-shared` behaviour is preserved.

**Best-effort.** The completion message relies on the agent following the
chat-reply instruction in its prompt. If the agent run is interrupted (the
container is killed mid-review, the GitHub token expires, an unhandled
error trips it) you will see the "review requested" ping but no
completion notice. The PR-review cooldown (`PR_REVIEW_COOLDOWN_MS`) still
applies, so the same PR will be re-dispatched on the next scan after the
cooldown elapses.

## Scope and behaviour

- **Repos:** every repo the reviewer's GitHub App installation can access. Add
  or remove repos from the App and the scan follows automatically.
- **Trigger:** an open, non-draft PR with **no** review or comment authored by
  the bot account (`<app-slug>[bot]`). Once the bot has reviewed (or commented),
  the PR is never re-triggered — matching the "PRs that have not yet had any
  comments by the review bot" rule.
- **No duplicate nagging:** a dispatched PR is recorded in `pr_review_dispatch`
  (central DB, migration 017). It won't be re-instructed until the cooldown
  elapses (covers an agent run that errored before posting a review) or new
  commits change the PR's head SHA.
- **Concurrent ticks:** if your cron fires faster than a tick completes
  (e.g. `* * * * *` but a tick scanning many repos takes 90s), the second
  invocation returns `{status: "busy"}` and exits. No two ticks ever run at
  once.
- **Where the instruction lands:** the reviewer agent's session, as a `task`
  message (the same shape a user-scheduled task uses). Session resolution
  depends on `PR_REVIEW_STATUS_MESSAGING_GROUP_ID` — see "Status updates" above.

## Key files

| File | Purpose |
|------|---------|
| `src/modules/pr-review/index.ts` | `runPrReviewTick()` — the per-invocation orchestration (exported, no timer) |
| `src/cli/resources/pr-review.ts` | Registers `pr-review run` so cron can call into the host via `ncl` |
| `src/modules/pr-review/github.ts` | Read-only GitHub REST helpers (repos, open PRs, bot-touched check) |
| `src/modules/pr-review/scan.ts` | Pure `shouldDispatch` decision (unit-tested, no I/O) |
| `src/modules/pr-review/dispatch.ts` | Injects the review `task`, optionally posts the status, wakes the container |
| `src/modules/pr-review/db.ts` | `pr_review_dispatch` tracking (dedupe) |
| `src/github-app-broker.ts` | `mintInstallationToken` + `fetchAppLogin` (bot login) |
