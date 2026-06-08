# Automatic PR review

An opt-in, host-side cron that watches for open pull requests the review bot
hasn't looked at yet and hands them to the reviewer agent for review.

## How it works

```
            ┌─ host process (in-process timer, default every 60s) ──────────┐
            │                                                                │
            │  1. mint the reviewer agent's GitHub App installation token    │
            │  2. GET /installation/repositories     ← all repos the App sees │
            │  3. for each open, non-draft PR:                                │
            │       GET reviews + issue/review comments                       │
            │       → has the bot (<app-slug>[bot]) already touched it?        │
            │  4. if not (and not already dispatched recently):               │
            │       inject a `task` instruction into the reviewer agent's      │
            │       session  +  wake the container                            │
            └────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
                    reviewer agent reviews the PR with its own
                    GitHub access — inline comments + APPROVE /
                    REQUEST_CHANGES / COMMENT
```

Steps 1–3 are **pure GitHub REST** — no AI tokens are spent deciding whether a
PR needs review. The agent (and its tokens) are only engaged in step 4, when a
PR genuinely needs a review.

## Why a programmatic check

The naive approach — wake the agent on a schedule and let it figure out what to
review — burns model tokens on every tick even when there's nothing to do. Here
the host does the cheap detection itself and only pays for the agent when there
is real work.

## Enabling it

The reviewer agent group must already have a GitHub App identity
(`ncl github-apps create --agent-group-id <id> ...`), since that's both how the
host mints a token to scan and how the agent authenticates to review. Then set
in `.env` (or the environment):

```bash
PR_REVIEW_ENABLED=true
PR_REVIEW_AGENT_GROUP_ID=<reviewer agent group id>
# optional:
PR_REVIEW_INTERVAL_MS=60000     # scan cadence (floored at 15000)
PR_REVIEW_COOLDOWN_MS=1800000   # re-dispatch window if no review lands (floored at 60000)
PR_REVIEW_STATUS_MESSAGING_GROUP_ID=<id>  # see "Status updates" below
```

Restart the host. With `PR_REVIEW_ENABLED` unset the job never starts.

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
- **Where the instruction lands:** the reviewer agent's most recent active
  session, as a `task` message (the same shape a user-scheduled task uses). The
  agent doesn't reply in chat unless something needs the owner's attention.

## Key files

| File | Purpose |
|------|---------|
| `src/modules/pr-review/index.ts` | The timer + per-tick orchestration (start/stop wired in `src/index.ts`) |
| `src/modules/pr-review/github.ts` | Read-only GitHub REST helpers (repos, open PRs, bot-touched check) |
| `src/modules/pr-review/scan.ts` | Pure `shouldDispatch` decision (unit-tested, no I/O) |
| `src/modules/pr-review/dispatch.ts` | Injects the review `task` + wakes the container |
| `src/modules/pr-review/db.ts` | `pr_review_dispatch` tracking (dedupe) |
| `src/github-app-broker.ts` | `mintInstallationToken` + `fetchAppLogin` (bot login) |
