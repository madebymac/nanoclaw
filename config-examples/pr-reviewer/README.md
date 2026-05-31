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

### 2a. Alternative: bot identity without OneCLI Pro

If you don't have OneCLI Pro (the self-hosted GitHub App bot identity is a Pro
feature), you can mint installation tokens yourself directly from the App's
private key — no gateway connection required. The bot identity is exactly the
same (`my-review-bot[bot]`); only the token source changes.

**1. Gather the App's credentials.** From your GitHub App settings:

- **App ID** — the numeric ID on the App's settings page.
- **Private key** — generate one under "Private keys" and download the `.pem`.
  Store it on the host outside the repo (e.g. `~/.nanoclaw/github-app.pem`,
  `chmod 600`). It never goes in `.env` or the repo.
- **Installation ID** — install the App on your repos, then read it from the URL
  at `github.com/settings/installations/<INSTALLATION_ID>`.

**2. Mint a token with the broker.** `scripts/github-app-token.mjs` signs a JWT
with the private key and exchanges it for a short-lived (≈1h) installation
token:

```bash
export GITHUB_APP_ID=123456
export GITHUB_APP_PRIVATE_KEY_PATH=$HOME/.nanoclaw/github-app.pem
export GITHUB_APP_INSTALLATION_ID=789012
TOKEN=$(node scripts/github-app-token.mjs)
```

The private key is read from disk and the token is captured into a shell
variable — neither is printed into the agent's context. Use the broker from
**scripts** (like the pre-agent `poll-script.js`) or as a git credential helper.
Don't have the agent itself run the broker and read its stdout, or the token
lands in the conversation.

**3. Use the token.** For the GitHub API, send it as a bearer token instead of
relying on the proxy to inject one:

```js
const token = execSync('node scripts/github-app-token.mjs', {
  env: { ...process.env, GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_PATH, GITHUB_APP_INSTALLATION_ID },
}).toString().trim();
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};
```

For git operations, wire it as a credential helper so each fetch/push gets a
fresh token without it ever being logged:

```bash
git config --global credential.https://github.com.helper \
  '!f() { echo "username=x-access-token"; echo "password=$(node /path/to/scripts/github-app-token.mjs)"; }; f'
```

Installation tokens expire after ~1h, so always mint a fresh one per run (or per
git operation via the helper) rather than caching it. The poll script in this
example assumes the proxy injects credentials; with this approach, drop in the
bearer token above instead.

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
