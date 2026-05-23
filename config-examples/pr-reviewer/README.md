# PR Reviewer Agent

A scheduled agent that automatically reviews open pull requests using Claude Opus. It polls your GitHub repos once per minute, skips PRs already reviewed at the current head commit, and posts GitHub reviews as a GitHub App bot identity.

## What it does

- Polls configured repos for open PRs
- Skips any PR where the bot has already reviewed the current head commit
- Re-reviews PRs where new commits have been pushed since the last bot review
- Posts a full code review (APPROVE or REQUEST_CHANGES) with inline comments
- Notifies you on start and finish of each review batch

## Setup

### 1. Create a GitHub App

- Go to **github.com/settings/apps/new**
- Name it (e.g. `my-review-bot` → appears as `my-review-bot[bot]`)
- Set Callback URL to your NanoClaw dashboard: `http://localhost:10254/v1/apps/github/callback`
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

In **both** `poll-script.js` and `agent-prompt.md`:
- Set `botLogin` / `BOT_LOGIN` to your GitHub App's bot identity (e.g. `my-review-bot[bot]`)

In `poll-script.js`:
- Set `repos` to the list of repos to watch

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
