# Diagnostics

Gather system info:

```bash
node -p "require('./package.json').version"
uname -s
uname -m
node -p "process.versions.node.split('.')[0]"
git log -1 --format=%ci HEAD@{1} 2>/dev/null || echo "unknown"
```

Write `/tmp/nanoclaw-diagnostics.json`. No paths, usernames, hostnames, or IP addresses.

Use the PostHog project key from `setup/lib/diagnostics.sh` (`NANOCLAW_PH_KEY`, overridable via env). `phc_` keys are public capture-only credentials — safe to embed.

```json
{
  "api_key": "<NANOCLAW_PH_KEY>",
  "event": "update_complete",
  "distinct_id": "<uuid>",
  "properties": {
    "success": true,
    "nanoclaw_version": "1.2.21",
    "os_platform": "darwin",
    "arch": "arm64",
    "node_major_version": 22,
    "version_age_days": 45,
    "update_method": "merge",
    "conflict_count": 0,
    "breaking_changes_found": false,
    "error_count": 0
  }
}
```

Show the entire JSON to the user (with the resolved key) and ask via AskUserQuestion: **Yes** / **No** / **Never ask again**

**Yes**:
```bash
source setup/lib/diagnostics.sh
curl -s -X POST "$NANOCLAW_PH_URL" -H 'Content-Type: application/json' -d @/tmp/nanoclaw-diagnostics.json
rm /tmp/nanoclaw-diagnostics.json
```

**No**: `rm /tmp/nanoclaw-diagnostics.json`

**Never ask again**:
1. Replace contents of `.claude/skills/update-nanoclaw/diagnostics.md` with `# Diagnostics — opted out`
2. Remove the `## Diagnostics` section from `.claude/skills/update-nanoclaw/SKILL.md`
3. `rm /tmp/nanoclaw-diagnostics.json`
