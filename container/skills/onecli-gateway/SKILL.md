---
name: onecli-gateway
description: >-
  OneCLI Gateway: transparent HTTPS proxy that injects stored credentials
  into outbound calls. You MUST use this skill when the user asks you to
  read emails, check calendar, check Stripe payments, or interact with ANY
  external service or API. Do NOT use browser extensions or OAuth CLI tools.
  Make HTTP requests directly; the gateway injects credentials automatically.
  (GitHub is the exception — it uses the injected $GH_TOKEN and bypasses the
  proxy; see the GitHub section below.)
compatibility: Requires HTTPS_PROXY set in environment (automatic when launched via `onecli run`)
metadata:
  author: onecli
  version: "0.5.0"
---

# OneCLI Gateway

Your outbound HTTPS traffic is transparently proxied through the OneCLI
gateway, which injects stored credentials at the proxy boundary. You never
see or handle credential values directly.

## How to Access External Services

You have direct HTTP access to external APIs. OAuth apps (Gmail, Google
Calendar, Google Drive, etc.) and API key services are all available through
the gateway. Just make the request directly; the gateway injects credentials
if the app is connected. If not, it returns an error with a connect URL you
can present to the user.

(GitHub does NOT work this way — see the GitHub section below.)

## Making Requests

Call the real API URL. The gateway intercepts the request and injects
credentials automatically.

```bash
curl -s "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5"
curl -s "https://api.stripe.com/v1/charges?limit=5"
```

Standard HTTP clients (curl, fetch, requests, axios, Go net/http, git) all
honor the `HTTPS_PROXY` environment variable automatically. You do not need
to set any auth headers.

## GitHub (does NOT go through the proxy)

GitHub is **not** a proxy-brokered service here. If a GitHub App identity is
bound to you, your access is a short-lived installation token injected as
`$GH_TOKEN` (also `$GITHUB_TOKEN`), refreshed roughly hourly. GitHub hosts are
excluded from the proxy, so you authenticate the request yourself:

```bash
# API — pass the token explicitly
curl -s -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/installation/repositories"

# git push / clone over HTTPS
git push "https://x-access-token:$GH_TOKEN@github.com/<owner>/<repo>.git" <branch>
```

- **Never** tell the user GitHub "isn't connected" or hand them an OneCLI
  `connect_url` for GitHub — that flow does not apply to GitHub.
- A `401` means the token is mid-refresh (it rotates ~hourly). Wait and retry;
  do not report it as lost access.
- Never print, echo, or commit the token.

## Credential Stubs for MCP Servers

Some MCP servers need local credential files to start. Stubs for connected
apps are pre-written automatically. Files containing `"onecli-managed"`
values are managed by OneCLI — do NOT modify or delete them.

If an MCP server won't start due to missing credentials, create stubs
**before** starting it. Use `"onecli-managed"` as the placeholder for all
secret values, with file permissions `0600`. See the guide at:
https://www.onecli.sh/docs/guides/credential-stubs/general-app

## When a Request Fails

If you get a 401, 403, or a gateway error (e.g., `app_not_connected`):

**Step 1 — Show the user a connect link.** Use the `connect_url` from the
error response:

> To connect [service], open this link:
> [connect_url from the error response]

If there is no `connect_url` in the error, tell the user to open the
OneCLI dashboard and connect the service there.

**Step 2 — Retry after the user connects.** Let the user know you will
retry once they have connected. When they confirm, retry the original
request. If the retry still fails, ask if they need help with the setup.

## Rules

- **Never** say "I don't have access to X" without first making the HTTP
  request through the proxy.
- **Never** use browser extensions, gcloud, or manual auth flows. The
  gateway handles credentials for you.
- **Never** ask the user for API keys or tokens directly. Direct them to
  connect the service in the OneCLI dashboard.
- **Never** suggest the user open Gmail/Calendar/GitHub in their browser
  when they ask you to read or interact with those services. You have API
  access. Use it.
- If the gateway returns a policy error (403 with a JSON body), respect
  the block. Do not retry or circumvent it.
