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

The OneCLI dashboard GitHub App connection (step 2) requires a Pro subscription on self-hosted installs. If you want bot identity on a free self-hosted setup, use the token broker script (`scripts/github-app-token.mjs`) instead.

**Why this approach:** The private key must never appear in the LLM's context window (it would be sent to the model provider and logged). The broker reads the key from disk, builds a signed JWT, and exchanges it for a short-lived installation token. The agent only ever sees the token — never the key.

**How the pieces fit:** the broker runs *inside* the agent container (the scheduled poll script and the agent both run there). Two things follow from that:

- The container does **not** mount the repo's `scripts/` directory, so the broker isn't reachable at `scripts/github-app-token.mjs` from inside. You copy the script into a directory you *do* mount (below). (`node` itself is available — the agent image is `node:22-slim`.)
- NanoClaw deliberately gives containers a minimal environment — there is **no per-group "set an env var" knob**. You supply the three required env vars (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH`, `GITHUB_APP_INSTALLATION_ID`) by **sourcing a small vars file** (also mounted) at the top of the poll script.

So everything the broker needs — the script, the `.pem`, and the vars file — lives in one host directory you mount read-only into the container. Only the `.pem` is sensitive; the two numeric IDs and the key path are not, so keeping them in a plaintext vars file is fine.

#### Setup

**1. Download the private key.** github.com/settings/apps → your app → "Private keys" → "Generate a private key". You'll get a `.pem`.

**2. Put the broker, the key, and a vars file in a dedicated host directory.** Create a directory outside the repo (never under the repo tree or `groups/`) and drop all three there:

```bash
mkdir -p ~/gh-app && chmod 700 ~/gh-app
cp scripts/github-app-token.mjs ~/gh-app/        # the broker, so it's reachable in-container
mv ~/Downloads/your-app.*.pem ~/gh-app/github-app.pem
chmod 600 ~/gh-app/github-app.pem
```

Create `~/gh-app/github-app.vars` (a plain shell file the poll script will `source`). Note `GITHUB_APP_PRIVATE_KEY_PATH` is the path **as seen inside the container** — mounts land under `/workspace/extra/` (see step 4):

```bash
# ~/gh-app/github-app.vars
GITHUB_APP_ID=123456                                            # App settings → "About" → App ID
GITHUB_APP_INSTALLATION_ID=78901234                             # trailing number in github.com/settings/installations/<id>
GITHUB_APP_PRIVATE_KEY_PATH=/workspace/extra/gh-app/github-app.pem
```

> ⚠️ **Naming matters — the mount allowlist blocks certain substrings.** The mount security layer rejects any host path containing `.env`, `.secret`, `credentials`, `private_key`, `id_rsa`, `.ssh`, `.aws`, and similar (full list: `src/modules/mount-security/index.ts`). That's why the vars file is `github-app.vars`, **not** `github-app.env`, and the directory is `~/gh-app`, not `~/.nanoclaw-secrets`. Avoid those substrings in the directory name and both filenames or the mount is silently rejected.

**3. Allow the directory in the mount allowlist.** The allowlist lives at `~/.config/nanoclaw/mount-allowlist.json` (outside the repo). Add `~/gh-app` as a read-only root:

```json
{
  "allowedRoots": [
    { "path": "~/gh-app", "allowReadWrite": false, "description": "GitHub App key + vars for token broker" }
  ],
  "blockedPatterns": [],
  "nonMainReadOnly": true
}
```

(Merge this into your existing allowlist if you already have one — don't overwrite other roots.)

**4. Mount the directory into the agent group.** Step 3 only says the directory is *allowed* — you still have to attach it to the group's container config (the `additional_mounts` field). There's no dedicated `ncl` verb for this, so write it directly with the in-tree query wrapper, then restart so the new mount is picked up (mounts are bound at container spawn):

```bash
pnpm exec tsx scripts/q.ts data/v2.db \
  "UPDATE container_configs SET additional_mounts='[{\"hostPath\":\"~/gh-app\",\"readonly\":true}]' WHERE agent_group_id='<agent-group-id>'"
ncl groups restart --id <agent-group-id>
```

(`~` in `hostPath` is expanded when the mount is validated, so it's fine to store it literally. Run `ncl groups list` to find the agent group id.)

The directory now appears inside the container at `/workspace/extra/gh-app/` — so the key is `/workspace/extra/gh-app/github-app.pem` and the vars file is `/workspace/extra/gh-app/github-app.vars`. Update `GITHUB_APP_PRIVATE_KEY_PATH` in `github-app.vars` to that full path, and use the matching paths in step 5. (Mounting the directory — rather than each file — means rotating the key or editing the vars file never requires touching the mount config again.)

**5. Source the vars and mint a token in the poll script.** At the top of `poll-script.js`'s shell (or wherever the agent shells out), load the vars then call the broker:

```bash
set -a; . /workspace/extra/gh-app/github-app.vars; set +a
TOKEN=$(node /workspace/extra/gh-app/github-app-token.mjs)
curl -H "Authorization: token $TOKEN" \
  https://api.github.com/repos/owner/repo/pulls
```

Installation tokens last one hour, so re-run the broker whenever you need a fresh one rather than caching it. The agent never reads the `.pem` — only the resulting token crosses into its context.

#### Updating these values later

| You want to change… | Do this | Restart needed? |
|---|---|---|
| `GITHUB_APP_ID` / `GITHUB_APP_INSTALLATION_ID` | Edit `~/gh-app/github-app.vars` on the host | No — the file is re-sourced on every poll |
| The private key (rotation) | Replace `~/gh-app/github-app.pem` in place (keep the filename) | No — read fresh on each broker run |
| Key filename / location, or which directory is mounted | Update `github-app.vars`, the allowlist, and the `additional_mounts` config (the `q.ts` write in step 4), then `ncl groups restart --id <group>` | **Yes** — mounts are bound at container spawn |

The rule of thumb: editing the **contents** of an already-mounted file takes effect on the next run with no restart; changing **which paths are mounted** requires `ncl groups restart`.

> **Note:** the bot identity you reference in `poll-script.js` and `agent-prompt.md` (step 3) must match the App you connected here — `<your-app-slug>[bot]` — regardless of whether you used the dashboard connection or this broker script.

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
