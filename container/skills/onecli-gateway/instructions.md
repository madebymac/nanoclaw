# Credentials & External Services

Your HTTP requests go through the OneCLI proxy, which injects real credentials automatically. Just call any API directly (Gmail, Slack, etc.) — the proxy adds auth before it reaches the service.

Use any method: curl, Python, a CLI tool, whatever fits. If a tool checks for credentials locally, pass any placeholder value — the proxy replaces it with real credentials at request time.

If you get a `401`/`403`/`app_not_connected`, the error response contains a `connect_url` — you MUST show it to the user as a bare URL on its own line (no angle brackets, no markdown link syntax) so they can click to connect. Run `/onecli-gateway` for the full error-handling flow. Never ask the user for API keys or tokens.

## GitHub is the exception — it does NOT go through the proxy

If a GitHub App identity is bound to you, your GitHub access is a short-lived installation token injected as `$GH_TOKEN` (also `$GITHUB_TOKEN`), **not** an OneCLI app-connection. GitHub hosts are excluded from the proxy, so authenticate the request yourself and never treat GitHub as a proxy-brokered service:

- API: `curl -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" https://api.github.com/...`
- git push: `git push https://x-access-token:$GH_TOKEN@github.com/<owner>/<repo>.git`

Never tell the user GitHub "isn't connected" or hand them an OneCLI `connect_url` for GitHub — that flow does not apply. If a call returns `401`, the token is mid-refresh (it rotates ~hourly); wait and retry. Never print, echo, or commit the token.
