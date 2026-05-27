# PR Reviewer Agent

A scheduled agent that automatically reviews open pull requests using Claude Opus. It polls your GitHub repos once per minute, skips PRs already reviewed at the current head commit, and posts GitHub reviews as a GitHub App bot identity.

## What it does

- Polls configured repos for open PRs
- Skips draft PRs and PRs authored by the bot itself
- Skips any PR where the bot has already reviewed the current head commit
- Re-reviews PRs where new commits have been pushed since the last bot review
- Posts a full code review (APPROVE, REQUEST_CHANGES, or COMMENT for bot-authored PRs) with inline comments
- Notifies you on start and finish of each review batch

## Setup

### 1. Create a GitHub App

- Go to **github.com/settings/apps/new**
- Name it (e.g. `my-review-bot` → appears as `my-review-bot[bot]`)
- Set Callback URL to your OneCLI gateway's GitHub callback:
  - Default local install: `http://127.0.0.1:10254/api/apps/github/callback`
  - Multi-instance install: `http://127.0.0.1:<ONECLI_APP_PORT>/api/apps/github/callback` (port lives in `instances.conf` / `instances/<name>/.env`)
  - Remote install: `https://<your-host>/api/apps/github/callback` — ensure that host/port is publicly reachable
  - Use `127.0.0.1`, not `localhost` — NextAuth normalizes the callback to `127.0.0.1`, and GitHub treats the two as distinct strings, so a `localhost` registration will fail to match.
  - **Upgrading from an older install?** The path changed from `/v1/apps/github/callback` to `/api/apps/github/callback`, and if you're on a non-default port the host part changes too. Update the App's callback URL in github.com/settings/apps before reconnecting.
- Check **"Request user authorization (OAuth) during installation"**
- Set Repository permissions:
  - **Contents**: Read
  - **Pull requests**: Read and write
  - **Metadata**: Read (required)
- Install the app on your target repos and accept the permissions at github.com/settings/installations

### 2. Connect the app in NanoClaw

- Open the NanoClaw dashboard → Connections → GitHub App
- Enter your App ID and slug, upload the private key
- Complete the OAuth flow

### 3. Configure the files

In `poll-script.js`:
- Replace `my-review-bot[bot]` with your GitHub App's bot identity
- Set `repos` to the list of repos to watch

In `agent-prompt.md`:
- Replace every occurrence of `my-review-bot[bot]` with your GitHub App's bot identity

> **Important:** these two values must stay in sync. If they diverge, the reviewer won't recognise its own past reviews and will re-review the same PR on every poll cycle.

### 4. Schedule the task

In a conversation with your NanoClaw agent:

```
Schedule a recurring task every minute with this script and prompt.
Script: [contents of poll-script.js]
Prompt: [contents of agent-prompt.md, with {PR_LIST} as a placeholder]
```

When the task fires, the agent reads the PR list from the script output and substitutes it into `{PR_LIST}` in the prompt before forwarding to the reviewer sub-agent. This substitution is done by the agent itself — `{PR_LIST}` is not a framework template variable.

## Files

| File | Purpose |
|------|---------|
| `poll-script.js` | Pre-agent script — checks for unreviewed PRs, returns list |
| `agent-prompt.md` | Instructions passed to the Opus reviewer sub-agent |
