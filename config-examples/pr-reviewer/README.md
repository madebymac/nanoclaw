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
- Set Callback URL to your NanoClaw dashboard's GitHub callback — e.g. `http://localhost:10254/v1/apps/github/callback` for local development, or `https://your-host/v1/apps/github/callback` when running remotely
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

The agent will substitute the live PR list from the script output into `{PR_LIST}` before passing the prompt to the reviewer sub-agent.

## Files

| File | Purpose |
|------|---------|
| `poll-script.js` | Pre-agent script — checks for unreviewed PRs, returns list |
| `agent-prompt.md` | Instructions passed to the Opus reviewer sub-agent |
