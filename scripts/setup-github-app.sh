#!/usr/bin/env bash
set -euo pipefail

# setup-github-app.sh — bind a self-hosted GitHub App bot identity to an agent.
#
# Wraps the whole flow: store the App private key on the host (chmod 600),
# register it via `ncl github-apps create`, teach the agent how to use the
# injected GH_TOKEN as its bot identity (CLAUDE.local.md), and restart the
# agent so the token is minted+injected on next wake. Optionally validates the
# credentials by minting a real installation token first (--verify).
#
# This is the free, non-OneCLI path: the private key never enters the DB or any
# LLM context — only its on-disk path is stored; the host mints a short-lived
# (~1h) installation token at spawn and injects it as GH_TOKEN / GITHUB_TOKEN.
#
# Usage:
#   scripts/setup-github-app.sh \
#     --agent-group-id <uuid> \
#     --app-id <n> \
#     --installation-id <n> \
#     --key <path-to-downloaded.pem> \   # OR --key-stdin to paste it directly \
#     --bot-login '<app-slug>[bot]' \
#     [--slug <name>]          # key filename + label; default: agent folder \
#     [--api-url <url>]        # GitHub Enterprise; default api.github.com \
#     [--secrets-dir <dir>]    # default: ~/.nanoclaw-secrets \
#     [--verify]               # mint a test token to validate creds first \
#     [--replace]              # delete any existing identity for this group \
#     [--no-restart]           # skip the agent restart \
#     [--no-note]              # skip writing CLAUDE.local.md guidance
#
# Re-run with --replace to rotate a key or fix a typo.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

die() { echo "error: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

AGENT_GROUP_ID="" APP_ID="" INSTALLATION_ID="" KEY_SRC="" BOT_LOGIN=""
SLUG="" API_URL="https://api.github.com" SECRETS_DIR="$HOME/.nanoclaw-secrets"
VERIFY=0 REPLACE=0 RESTART=1 WRITE_NOTE=1 KEY_STDIN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --agent-group-id) AGENT_GROUP_ID="$2"; shift 2 ;;
    --app-id)         APP_ID="$2"; shift 2 ;;
    --installation-id) INSTALLATION_ID="$2"; shift 2 ;;
    --key)            KEY_SRC="$2"; shift 2 ;;
    --key-stdin)      KEY_STDIN=1; shift ;;
    --bot-login)      BOT_LOGIN="$2"; shift 2 ;;
    --slug)           SLUG="$2"; shift 2 ;;
    --api-url)        API_URL="$2"; shift 2 ;;
    --secrets-dir)    SECRETS_DIR="$2"; shift 2 ;;
    --verify)         VERIFY=1; shift ;;
    --replace)        REPLACE=1; shift ;;
    --no-restart)     RESTART=0; shift ;;
    --no-note)        WRITE_NOTE=0; shift ;;
    -h|--help)        sed -n '5,40p' "$0"; exit 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

[ -n "$AGENT_GROUP_ID" ]  || die "--agent-group-id is required"
[ -n "$APP_ID" ]          || die "--app-id is required"
[ -n "$INSTALLATION_ID" ] || die "--installation-id is required"
if [ "$KEY_STDIN" = "1" ]; then
  [ -z "$KEY_SRC" ] || die "use either --key <path> or --key-stdin, not both"
elif [ -n "$KEY_SRC" ]; then
  [ -f "$KEY_SRC" ] || die "key file not found: $KEY_SRC"
else
  die "provide the App private key: --key <path-to.pem>, or --key-stdin (paste it)"
fi
have ncl                  || die "ncl not on PATH — run on the host with the service up"
have node                 || die "node not on PATH"

# Resolve the agent group's folder (for slug default + CLAUDE.local.md path).
GROUP_JSON="$(ncl groups get --id "$AGENT_GROUP_ID" 2>/dev/null || true)"
FOLDER="$(printf '%s' "$GROUP_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log((JSON.parse(s).folder)||"")}catch{console.log("")}})')"
[ -n "$FOLDER" ] || die "no agent group found for id '$AGENT_GROUP_ID' (check: ncl groups list)"
[ -n "$SLUG" ] || SLUG="$FOLDER"

# 1. Store the private key (chmod 600) in the host secrets dir. The key must
#    persist here — the host re-reads it on every spawn to mint a fresh token.
mkdir -p "$SECRETS_DIR"; chmod 700 "$SECRETS_DIR"
KEY_DEST="$SECRETS_DIR/${SLUG}-github-app.pem"
if [ "$KEY_STDIN" = "1" ]; then
  echo "• paste the App private key (.pem), then press Ctrl-D:" >&2
  ( umask 077; cat > "$KEY_DEST" )
  [ -s "$KEY_DEST" ] || { rm -f "$KEY_DEST"; die "no key read from stdin"; }
  grep -q 'BEGIN .*PRIVATE KEY' "$KEY_DEST" || { rm -f "$KEY_DEST"; die "stdin did not look like a PEM private key"; }
else
  install -m 600 "$KEY_SRC" "$KEY_DEST"
fi
chmod 600 "$KEY_DEST"
echo "✓ key stored at $KEY_DEST (chmod 600)"

# 2. Optional: validate by minting a real installation token (mirrors
#    src/github-app-broker.ts). Prints success only — never the token.
if [ "$VERIFY" = "1" ]; then
  echo "• verifying credentials (minting a test token)…"
  APP_ID="$APP_ID" INSTALLATION_ID="$INSTALLATION_ID" KEY_DEST="$KEY_DEST" API_URL="$API_URL" node -e '
    const { createSign } = require("crypto"); const fs = require("fs");
    const appId = process.env.APP_ID, instId = process.env.INSTALLATION_ID;
    const key = fs.readFileSync(process.env.KEY_DEST, "utf8").trim();
    const apiUrl = process.env.API_URL.replace(/\/+$/, "");
    const b64u = s => Buffer.from(s).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
    const now = Math.floor(Date.now()/1000);
    const head = b64u(JSON.stringify({ alg:"RS256", typ:"JWT" }));
    const body = b64u(JSON.stringify({ iat: now-60, exp: now+600, iss: appId }));
    const sig = createSign("RSA-SHA256").update(head+"."+body).sign(key,"base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
    const jwt = `${head}.${body}.${sig}`;
    fetch(`${apiUrl}/app/installations/${instId}/access_tokens`, {
      method:"POST",
      headers:{ Authorization:`Bearer ${jwt}`, Accept:"application/vnd.github+json", "X-GitHub-Api-Version":"2022-11-28" },
    }).then(async r => {
      if (!r.ok) { console.error("  ✗ mint failed:", r.status, (await r.text()).slice(0,200)); process.exit(1); }
      const j = await r.json();
      console.error("  ✓ token minted (expires " + j.expires_at + ")");
    }).catch(e => { console.error("  ✗ mint error:", e.message); process.exit(1); });
  ' || die "credential verification failed — check App ID, Installation ID, and key"
fi

# 3. Register (one identity per agent group). --replace clears any existing one.
if [ "$REPLACE" = "1" ]; then
  EXISTING="$(pnpm exec tsx scripts/q.ts data/v2.db \
    "SELECT id FROM github_app_identities WHERE agent_group_id='$AGENT_GROUP_ID'" 2>/dev/null || true)"
  if [ -n "$EXISTING" ]; then
    echo "• replacing existing identity $EXISTING"
    ncl github-apps delete --id "$EXISTING" >/dev/null
  fi
fi

ncl github-apps create \
  --agent-group-id "$AGENT_GROUP_ID" \
  --app-id "$APP_ID" \
  --installation-id "$INSTALLATION_ID" \
  --private-key-path "$KEY_DEST" \
  $( [ "$API_URL" != "https://api.github.com" ] && printf -- '--api-url %s' "$API_URL" )
echo "✓ registered GitHub App identity for agent group $AGENT_GROUP_ID"

# 4. Teach the agent how to act as the bot (idempotent — keyed by a marker).
if [ "$WRITE_NOTE" = "1" ] && [ -n "$BOT_LOGIN" ]; then
  NOTE="groups/$FOLDER/CLAUDE.local.md"
  MARKER="<!-- github-app-identity -->"
  if [ ! -f "$NOTE" ] || ! grep -qF "$MARKER" "$NOTE"; then
    mkdir -p "groups/$FOLDER"
    {
      echo ""
      echo "$MARKER"
      echo "## GitHub identity"
      echo ""
      echo "You act as the GitHub App bot **\`$BOT_LOGIN\`**. A short-lived installation"
      echo "token is injected into your environment as \`\$GH_TOKEN\` (also \`\$GITHUB_TOKEN\`)."
      echo "Use it explicitly — there is no proxy auto-injecting it:"
      echo ""
      echo "- GitHub API: send header \`Authorization: Bearer \$GH_TOKEN\`."
      echo "- git push: use \`https://x-access-token:\$GH_TOKEN@github.com/<owner>/<repo>.git\`."
      echo "- Comments/PRs/reviews you post appear as \`$BOT_LOGIN\`, not the operator."
      echo "- Never print, echo, or commit the token. It rotates (~1h) on each wake."
    } >> "$NOTE"
    echo "✓ wrote bot-identity guidance to $NOTE"
  else
    echo "• $NOTE already has GitHub identity guidance (left as-is)"
  fi
fi

# 5. Restart so the token is minted + injected on the next wake.
if [ "$RESTART" = "1" ]; then
  ncl groups restart --id "$AGENT_GROUP_ID" >/dev/null && echo "✓ agent restarted — token injects on next message"
fi

echo
echo "Done. Verify after the agent next wakes:"
echo "  grep 'GitHub App token injected' logs/nanoclaw.log | tail -1"
