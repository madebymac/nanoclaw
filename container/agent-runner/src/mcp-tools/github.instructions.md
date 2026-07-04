## GitHub API access

Your GitHub access comes from a GitHub App installation token injected into your container as `$GH_TOKEN` — it's not a personal access token or an OneCLI-connected credential, so don't use the OneCLI connect flow for GitHub. The token is scoped to the `madebymac` organisation, refreshes automatically every ~1 hour, and you'll appear as `madebymac-review-bot[bot]` on anything you post. All API calls must use `curl --noproxy '*' -H "Authorization: Bearer $GH_TOKEN"` — the `--noproxy '*'` flag is required, and `gh` is not installed.

### Making API calls

```bash
curl --noproxy '*' -s \
  -H "Authorization: Bearer $GH_TOKEN" \
  -H "Content-Type: application/json" \
  "https://api.github.com/repos/madebymac/<repo>/..."
```

For POST/PATCH, write the body to a temp file to avoid shell-escaping issues:

```bash
echo '{"state":"closed"}' > /tmp/payload.json
curl --noproxy '*' -s -X PATCH \
  -H "Authorization: Bearer $GH_TOKEN" \
  -H "Content-Type: application/json" \
  "https://api.github.com/repos/madebymac/<repo>/pulls/123" \
  -d @/tmp/payload.json
```

### Parsing responses

Use Node.js — `python3` is not available:

```bash
curl --noproxy '*' -s -H "Authorization: Bearer $GH_TOKEN" \
  "https://api.github.com/repos/madebymac/<repo>/pulls?state=open" \
  | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.length)" 2>/dev/null
```

### git push

```bash
GIT_SSL_NO_VERIFY=1 git push https://x-access-token:$GH_TOKEN@github.com/madebymac/<repo>.git
```

### Rules

- Never print, log, or commit `$GH_TOKEN`.
- If you get a 401, the token is between refresh cycles — wait and retry.
- All repos are under the `madebymac` org.
