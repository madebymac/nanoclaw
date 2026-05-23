# Multi-Instance OneCLI

**Status:** Planning — not yet implemented.
**Branch:** `claude/github-multiple-agents-maJCw`
**Companion doc:** [`multi-bot-channels.md`](./multi-bot-channels.md)

## Goal

Run N OneCLI gateway instances side-by-side on a single host, one per bot identity. Each agent group is pinned to one instance. Outbound API calls from that agent group's container are proxied through its instance's gateway, which injects credentials from that instance's vault.

This sidesteps OneCLI's `@@unique([projectId, provider])` constraint on `AppConfig` (one GitHub App per project) without forking OneCLI or waiting on an upstream PR.

## Non-goals

- Forking OneCLI. The upstream gateway and CLI binaries are reused as-is.
- Cross-instance credential sharing. Each instance is its own vault.
- Multi-tenancy within a single instance. We already have that (per-agent selective secret mode); the problem is it can't hold two GitHub Apps.

## Architecture

```
┌─ nanoclaw host process ──────────────────────────────────┐
│                                                          │
│  central DB (data/v2.db)                                 │
│    onecli_instances ─┬─ review-bot   :10256 / :10257     │
│                      ├─ worker-bot   :10258 / :10259     │
│                      └─ cleanup-bot  :10260 / :10261     │
│                                                          │
│  agent_groups.onecli_instance_id ──┐                     │
│                                    │                     │
│  container-runner ───── getOneCLIForAgent(agentGroup) ──┐│
│                                                         ││
└─────────────────────────────────────────────────────────┼┘
                                                          │
   ┌──────────────────────────────────────────────────────┘
   │
   ▼
┌─ docker compose project: onecli-review-bot ──────────┐
│  app (Next.js UI)  → 127.0.0.1:10256                 │
│  gateway (Rust)    → 127.0.0.1:10257                 │
│  postgres          → 127.0.0.1:15432                 │
│  volumes: ~/.onecli-review-bot/{db,certs,config}     │
└──────────────────────────────────────────────────────┘
```

Each instance is a standard upstream OneCLI deployment with overridden ports and install dir. Containers spawned for agent groups bound to that instance get `HTTPS_PROXY=http://127.0.0.1:<gateway_port>` and the instance's CA cert mounted in.

## DB schema

New migration in `src/db/migrations/`:

```sql
CREATE TABLE IF NOT EXISTS onecli_instances (
  id                 TEXT PRIMARY KEY,    -- slug, e.g. "review-bot"
  name               TEXT NOT NULL,       -- display name
  install_dir        TEXT NOT NULL,       -- e.g. ~/.onecli-review-bot
  app_port           INTEGER NOT NULL UNIQUE,
  gateway_port       INTEGER NOT NULL UNIQUE,
  postgres_port      INTEGER NOT NULL UNIQUE,
  api_key            TEXT NOT NULL,       -- this instance's onecli auth key
  ca_cert_path       TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'unknown', -- healthy | down | unknown
  last_health_check  TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

ALTER TABLE agent_groups ADD COLUMN onecli_instance_id TEXT
  REFERENCES onecli_instances(id);
-- Nullable. NULL means "use the default singleton" (back-compat for existing
-- installs that haven't created any explicit instances).
```

Migration is additive and idempotent; matches the pattern in `src/db/migrations/module-approvals-pending-approvals.ts`.

**Back-compat behavior:** existing installs have one OneCLI from the original `setup/onecli.ts` flow. The migration leaves `onecli_instance_id` NULL on all existing agent groups; `getOneCLIForAgent` returns the legacy env-var singleton when the column is NULL. No data migration required, no behavior change for existing installs.

## New files

### `src/onecli-instances.ts`

The whole multi-instance brain lives here. Keeping it in one new file is the primary merge-conflict mitigation — upstream nanoclaw doesn't touch this file.

Public surface:

```typescript
export interface OnecliInstance {
  id: string;
  name: string;
  installDir: string;
  appPort: number;
  gatewayPort: number;
  postgresPort: number;
  apiKey: string;
  caCertPath: string;
  url: string;            // http://127.0.0.1:<appPort>
  gatewayUrl: string;     // http://127.0.0.1:<gatewayPort>
}

export function listInstances(): OnecliInstance[];
export function getInstance(id: string): OnecliInstance | null;

// Returns the right OneCLI SDK client for this agent group.
// Falls back to the env-based singleton when onecli_instance_id is NULL
// (back-compat for installs predating this feature).
export function getOneCLIForAgent(agentGroup: AgentGroup): OneCLI;

// Provision a new instance: pick free ports, run upstream installer with
// overrides, generate API key, write row.
export function installInstance(args: {
  id: string;
  name: string;
}): Promise<OnecliInstance>;

// Tear down: docker compose down, drop volumes, delete row.
// Refuses if any agent_group still references this instance.
export function removeInstance(id: string): Promise<void>;

export function healthCheck(id: string): Promise<'healthy' | 'down'>;
export function healthCheckAll(): Promise<Record<string, 'healthy' | 'down'>>;
```

Internals:
- Module-level `Map<string, OneCLI>` cache of SDK clients, populated lazily on first `getOneCLIForAgent` call.
- The fallback singleton is constructed exactly once from `ONECLI_URL`/`ONECLI_API_KEY` env vars (the same values `container-runner.ts:50` reads today).
- `installInstance` finds the next free port triple by scanning `onecli_instances`, then templates a docker-compose.yml (see "Install wrapper" below).
- `removeInstance` runs `docker compose -p onecli-<id> down -v` and deletes the install dir.

### `src/cli/resources/onecli-instances.ts`

Standard `ncl` resource definition. Verbs: `list`, `get`, `install`, `remove`, `status`, `repair`.

```
ncl onecli-instances list
ncl onecli-instances get --id review-bot
ncl onecli-instances install --id review-bot --name "Review Bot"
ncl onecli-instances remove --id review-bot
ncl onecli-instances status                # health-check all
ncl onecli-instances repair --id review-bot # restart docker stack
```

### `src/cli/resources/bots.ts`

The unified per-bot view discussed in the planning thread. Joins `onecli_instances` ⋈ `agent_groups` ⋈ `messaging_groups` to show a complete picture per bot. Read-only resource; verbs: `list`, `get`.

### `.claude/skills/add-onecli-instance/SKILL.md`

Operator skill that walks through:
1. Pick a slug (lowercase, hyphens) and display name.
2. Run `ncl onecli-instances install --id <slug> --name "<name>"`.
3. Open `http://127.0.0.1:<port>` and register the GitHub App (paste App ID, Client ID, Client Secret, Private Key).
4. Verify with `ncl bots get --id <slug>`.
5. Pointer to `/add-github <slug>` for wiring a channel.

### `src/onecli-install-wrapper.ts`

The thin install wrapper. Keeps install logic out of `onecli-instances.ts` for readability. Exposes one function:

```typescript
export function runInstaller(args: {
  installDir: string;
  appPort: number;
  gatewayPort: number;
  postgresPort: number;
  composeProject: string;
}): { ok: boolean; stdout: string };
```

See "Install wrapper" section below for what it actually does.

## Diffs to existing files

These are the only upstream-overlapping changes. All other work is in new files.

### `src/container-runner.ts` (~3 lines touched)

```diff
- import { OneCLI } from '@onecli-sh/sdk';
- ...
- const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });
+ import { getOneCLIForAgent } from './onecli-instances.js';

  // (at the existing call site around line 426)
  if (agentIdentifier) {
+   const onecli = getOneCLIForAgent(agentGroup);
    await onecli.ensureAgent({ name: agentGroup.name, identifier: agentIdentifier });
+ } else {
+   var onecli = getOneCLIForAgent(agentGroup);
  }
  const onecliApplied = await onecli.applyContainerConfig(args, { addHostMapping: false, agent: agentIdentifier });
```

Cleaner version that avoids the `var` hoist:

```diff
+ const onecli = getOneCLIForAgent(agentGroup);
  if (agentIdentifier) {
    await onecli.ensureAgent({ name: agentGroup.name, identifier: agentIdentifier });
  }
  const onecliApplied = await onecli.applyContainerConfig(args, { addHostMapping: false, agent: agentIdentifier });
```

**Conflict footprint:** the deleted module-level singleton (line 50) and a 1-line addition at the existing OneCLI call site (around line 426). If upstream nanoclaw renames or moves these, we get a small mechanical conflict; the logic stays in the new file.

### `src/modules/approvals/onecli-approvals.ts` (~5 lines touched)

Current code registers one manual-approval callback against the singleton OneCLI client. We need one callback per instance, because each instance has its own pending-approvals queue.

```diff
- handle = onecli.configureManualApproval(async (request) => { ... });
+ for (const instance of listInstances()) {
+   const client = getOneCLI(instance.id);
+   handles.push(client.configureManualApproval(async (request) => { ... }));
+ }
+ // Also handle the default singleton for back-compat (NULL instance_id agents)
+ handles.push(defaultOneCLI.configureManualApproval(async (request) => { ... }));
```

The approval-handling logic (resolving approver, sending DM) is unchanged — only the registration loops.

### `src/cli/dispatch.ts` (1-2 lines added)

Register the two new resources:

```diff
  import { registerResource } from './crud.js';
+ import { onecliInstancesResource } from './resources/onecli-instances.js';
+ import { botsResource } from './resources/bots.js';
  ...
+ registerResource(onecliInstancesResource);
+ registerResource(botsResource);
```

Pure additions; mergeable.

### `src/index.ts` (1 line added, optional)

Start the health-check loop on boot:

```diff
+ import { startHealthCheckLoop } from './onecli-instances.js';
  ...
+ startHealthCheckLoop({ intervalMs: 60_000 });
```

Optional — if we skip this, `status` only updates when `ncl onecli-instances status` is invoked manually. Adding it gets us "down" state surfaced in `ncl bots list` without a manual command.

### Summary of upstream touch

| File | Lines changed | Conflict risk |
|---|---|---|
| `src/container-runner.ts` | 3-4 | Low (small change in hot file) |
| `src/modules/approvals/onecli-approvals.ts` | 5 | Low (wrapping existing logic in a loop) |
| `src/cli/dispatch.ts` | 2 | Very low (pure addition) |
| `src/index.ts` | 1 | Very low (optional) |

Everything else is new files. **Total upstream touch: ~12 lines across 4 files.**

## Install wrapper

The upstream install script (`onecli.sh/install`) is curl-piped shell that does `docker compose up`. Its env-var overrides — `ONECLI_BIND_HOST`, `ONECLI_APP_PORT`, `ONECLI_GATEWAY_PORT`, `POSTGRES_PORT`, `ONECLI_VERSION` — get us most of the way there. The hardcoded bits are `INSTALL_DIR=~/.onecli` and compose project name `onecli`.

Two viable wrapper strategies:

**Option 1: env-override + sed-patch.**
Run the upstream script with overrides, then patch `INSTALL_DIR` and compose project name post-hoc. Fragile if upstream changes the script's variable names.

**Option 2: download upstream's docker-compose.yml ourselves and run `docker compose` directly.**
The upstream installer's whole job is `docker compose up -d` with overrides. We can do that ourselves. The compose.yml is small and pinned via `ONECLI_VERSION`. We never run upstream's shell script for additional instances; the first OneCLI (created by `setup/onecli.ts`) still uses the upstream script unchanged.

**Recommended: Option 2.** Pseudo-code:

```typescript
async function runInstaller(args): Promise<Result> {
  // 1. Fetch upstream compose.yml (pinned to ONECLI_GATEWAY_VERSION from setup/onecli.ts)
  const composeYml = await fetchUpstreamCompose(ONECLI_GATEWAY_VERSION);

  // 2. Template port + volume overrides into a copy in args.installDir
  await fs.mkdir(args.installDir, { recursive: true });
  const patched = applyPortOverrides(composeYml, {
    appPort: args.appPort,
    gatewayPort: args.gatewayPort,
    postgresPort: args.postgresPort,
    volumePrefix: args.installDir,
  });
  await fs.writeFile(path.join(args.installDir, 'docker-compose.yml'), patched);

  // 3. docker compose -p <project> -f <path> up -d --wait
  await execa('docker', ['compose', '-p', args.composeProject,
                          '-f', path.join(args.installDir, 'docker-compose.yml'),
                          'up', '-d', '--wait']);

  // 4. Poll the new instance's /api/health
  await pollHealth(`http://127.0.0.1:${args.appPort}`, 30_000);

  // 5. Generate or fetch the instance's API key via its CLI/admin endpoint
  // 6. Read out the CA cert path
  return { ok: true, ... };
}
```

This pins us to upstream's compose schema, not its install script. The compose schema is fundamentally stable.

**Sync risk:** if upstream OneCLI changes its compose.yml shape (renames services, restructures volumes), our patcher breaks. Mitigation: smoke-test on each `ONECLI_GATEWAY_VERSION` bump and pin to known-good versions.

## Approvals fan-out

`onecli.configureManualApproval` long-polls one OneCLI's `/api/approvals/pending` queue and fires the callback when a pending approval shows up. With N instances, we need N concurrent long-polls.

Implementation:
- `onecli-approvals.ts` registers a callback per instance + one for the default singleton.
- Each callback shares the same handler (resolves an approver via `pickApprover`, DMs them, awaits decision).
- On instance install/remove, we re-register: tear down the removed instance's handle, add the new one.
- A simple Map<instanceId, ManualApprovalHandle> tracked in the approvals module.

No new types needed — the SDK's `ManualApprovalHandle` is already per-client.

## `ncl bots list` implementation

Joins three sources:

1. `onecli_instances` (local DB) — the instance + its health
2. Per-instance: `GET http://127.0.0.1:<appPort>/api/v1/app-connections` (with the instance's API key in `Authorization: Bearer`) — the registered GitHub App identity
3. `agent_groups` + `messaging_groups` (local DB) — which agent group binds to this instance and which channels are wired

Pseudo-code:

```typescript
async function listBots(): Promise<BotSummary[]> {
  const instances = listInstances();
  const summaries = await Promise.all(instances.map(async (inst) => {
    const health = await healthCheck(inst.id);
    const apps = health === 'healthy'
      ? await fetchAppConnections(inst)
      : [];
    const agentGroup = findAgentGroupByInstance(inst.id);
    const wirings = agentGroup ? listWirings(agentGroup.id) : [];
    return { instance: inst, health, apps, agentGroup, wirings };
  }));
  return summaries;
}
```

**Unknown to verify when implementing:** the exact path of OneCLI's app-connections list endpoint. The schema has `app_connections` and the web UI lists them, so an API exists — but we haven't confirmed it's exposed at a stable URL. If it isn't, fallback options are (a) read directly from the instance's Postgres (ugly but possible since we own the install), or (b) open an upstream issue requesting a stable read endpoint.

## Phased delivery

**Phase 1 — minimum viable multi-instance** (~2-3 days):
- Migration + `onecli_instances` table + `agent_groups.onecli_instance_id`
- `src/onecli-instances.ts` core (list, get, `getOneCLIForAgent`)
- `installInstance` via Option 2 wrapper
- `container-runner.ts` diff
- `ncl onecli-instances` resource (list, get, install, remove)
- Manual instructions for the GitHub App registration (open web UI, paste fields)

After phase 1, you can run two bots end-to-end.

**Phase 2 — operational polish** (~1-2 days):
- `ncl bots list` + `ncl bots get` (unified view)
- Approvals fan-out
- Health-check loop
- `/add-onecli-instance` skill
- Runbook entries

**Phase 3 — nice-to-haves** (deferred):
- Programmatic GitHub App registration (if OneCLI exposes a CLI/API verb for it)
- Auto-restart on instance crash
- Cross-instance secret import (move a credential from one vault to another)

## Sync-with-upstream risk + mitigations

**Total upstream surface:** 4 files, ~12 lines. Designed deliberately to be small.

**Specific mitigations applied:**

1. **Hide complexity in new files.** `src/onecli-instances.ts` and `src/onecli-install-wrapper.ts` are net-new. Upstream doesn't touch them.
2. **Single-call-site changes.** `container-runner.ts` keeps one OneCLI call site; we just changed how it gets the client. If upstream rewrites that block, we re-port a 1-line `getOneCLIForAgent` call.
3. **Additive-only schema changes.** New table + nullable column. Doesn't conflict with upstream schema work as long as upstream doesn't rename `agent_groups`.
4. **No changes to channel adapter files.** Multi-OneCLI is orthogonal to the channel layer (channel changes are documented in `multi-bot-channels.md`).
5. **No changes to upstream OneCLI source.** We use the published compose.yml; no fork.

**Re-port checklist** (when running `/update-nanoclaw`):
- [ ] `src/container-runner.ts` — verify the `onecli.ensureAgent`/`applyContainerConfig` calls still go through `getOneCLIForAgent`. If upstream restructured the spawn flow, port the 2-line call site.
- [ ] `src/modules/approvals/onecli-approvals.ts` — verify the registration is still wrapped in the `for (instance of listInstances())` loop.
- [ ] `src/cli/dispatch.ts` — verify both new resources are registered.
- [ ] Schema migrations — verify nothing upstream renamed `agent_groups`.
- [ ] Run smoke test: spawn an agent group with `onecli_instance_id` set; verify HTTPS_PROXY in the container points at the right port.

**Upstreaming option:** the whole feature is generic (multi-bot deployments) and not nanoclaw-fork-specific. After it's stable locally, send the change as an upstream PR. If accepted, sync cost goes to zero.

---

## Runbook

### Adding a new bot (happy path)

1. Create the GitHub App on github.com. Save App ID, Client ID, Client Secret, Private Key file.
2. `/add-onecli-instance review-bot` — provisions a new OneCLI on the next free port triple.
3. Open `http://127.0.0.1:<app_port>` (the skill prints the URL). Click "Connect a service" → GitHub. Paste the App credentials.
4. Create an agent group bound to this instance:
   ```
   ncl groups create --name review-bot --onecli-instance review-bot
   ```
5. Wire a channel: `/add-github review-bot` (see `multi-bot-channels.md`).
6. Verify: `ncl bots get review-bot` shows instance healthy, GitHub App present, agent group bound, channel wired.

### Removing a bot cleanly

Order matters — unwire from agent groups before removing the instance, or the instance refuses removal.

```bash
# 1. Find what's bound to this instance
ncl bots get review-bot

# 2. Unwire or delete agent groups that point at it
ncl groups update --id <agent-group-id> --onecli-instance ''   # detach
# or
ncl groups delete --id <agent-group-id>

# 3. Remove the instance (docker compose down + drop volumes + delete row)
ncl onecli-instances remove --id review-bot

# 4. (optional) Delete the GitHub App from github.com if you don't need it
```

### Renaming a bot

There are three names that should usually stay in sync — keep them consistent or you'll confuse yourself in three months:

- OneCLI instance id (e.g. `review-bot`) — slug; affects port assignments, install dir, compose project name
- Agent group name (e.g. `review-bot`) — what appears in chat
- GitHub App name (e.g. "Review Bot") — what appears in PR comments

To rename:
```bash
ncl onecli-instances rename --id old-name --to new-name      # if implemented; else remove + reinstall
ncl groups update --id <ag> --name new-name --onecli-instance new-name
# GitHub App name is changed on github.com → App Settings
```

If `ncl onecli-instances rename` isn't implemented in phase 1, the workaround is remove + reinstall, which loses the OneCLI's stored credentials. So phase 2 should add rename. Until then, choose names carefully.

### Rotating a GitHub App private key

1. Generate a new private key in github.com → App Settings → Generate a new private key. Save the .pem.
2. Open the relevant OneCLI's web UI (`ncl bots get <bot>` shows the URL).
3. Navigate to the GitHub App connection. Paste the new private key. Save.
4. Restart the agent group's container so the next API call picks up the new credential injection:
   ```
   ncl groups restart --id <agent-group-id>
   ```
5. Optionally revoke the old key on github.com after confirming the new one works.

### Diagnosis: "Bot isn't responding to mentions"

Decision tree, top to bottom:

1. **Is the webhook reaching nanoclaw?**
   Check `logs/nanoclaw.log` for an entry matching the GitHub repo. If no entry, the webhook isn't firing — verify GitHub App webhook URL + secret in App Settings.

2. **Is the message landing in `inbound.db`?**
   ```
   ncl sessions list                    # find the session for that repo/PR
   pnpm exec tsx scripts/q.ts data/v2-sessions/<session>/inbound.db "SELECT * FROM messages_in ORDER BY seq DESC LIMIT 5;"
   ```
   If empty, the channel adapter rejected the message (wrong bot username on mention detection? wrong webhook secret?).

3. **Is the container's `HTTPS_PROXY` pointing at the right OneCLI?**
   ```
   docker exec <container-name> env | grep PROXY
   ```
   Should match `ncl bots get <bot>` → `gateway_url`. If it's the wrong one, the agent group's `onecli_instance_id` is wrong:
   ```
   ncl groups get --id <ag-id>
   ncl groups update --id <ag-id> --onecli-instance <correct-bot>
   ncl groups restart --id <ag-id>
   ```

4. **Is the GitHub App credential assigned to this agent?**
   Open the instance's web UI. Check the agent's secret-mode (`selective` vs `all`). If selective, verify the GitHub credential is assigned to this agent.

5. **Is the OneCLI instance itself healthy?**
   ```
   ncl onecli-instances status
   docker compose -p onecli-<bot> ps
   ```

### Diagnosis: "OneCLI instance is down"

Symptoms in nanoclaw logs: `OneCLI gateway not applied — refusing to spawn container` and 401/connection-refused errors.

Recovery:
```bash
# 1. Try restart
ncl onecli-instances repair --id review-bot

# 2. If that fails, inspect logs
docker compose -p onecli-review-bot logs -f --tail 200

# 3. If Postgres volume is corrupt:
docker compose -p onecli-review-bot down
docker volume rm onecli-review-bot_postgres-data    # destroys credentials!
docker compose -p onecli-review-bot up -d
# You'll need to re-register the GitHub App in the web UI after this.
```

**Important:** dropping the Postgres volume loses the vault. If you can avoid it, back up the volume first:
```bash
docker run --rm -v onecli-review-bot_postgres-data:/data -v "$PWD":/backup \
  alpine tar czf /backup/onecli-review-bot-pg-backup.tar.gz /data
```

### Migrating from single-instance to multi-instance

Existing installs have one OneCLI from `setup/onecli.ts`. After this feature ships:

1. The existing OneCLI keeps working with no changes. Existing agent groups have `onecli_instance_id IS NULL` and `getOneCLIForAgent` returns the legacy singleton.
2. To convert the existing OneCLI into a managed instance (so it shows up in `ncl bots list`):
   ```
   ncl onecli-instances import-default --id default
   ```
   This reads `ONECLI_URL` + `ONECLI_API_KEY` from `.env`, writes an `onecli_instances` row pointing at it, and bulk-updates existing `agent_groups.onecli_instance_id = 'default'`.
3. New bots: follow "Adding a new bot."

`import-default` is a phase-2 nice-to-have. Until it exists, the legacy singleton just continues to work via the NULL fallback.

### Invariants (do not violate)

- **One OneCLI instance per bot identity.** Never multiplex two GitHub Apps into one vault — that's the upstream constraint we're working around. Putting two Apps in one instance defeats the whole point.
- **`onecli_instance_id` is per-agent-group, never per-session.** Sessions inherit their agent group's instance.
- **Each instance owns its own Postgres volume.** Never share volumes between instances; you'd corrupt both.
- **The "default" fallback path stays alive.** Don't delete the legacy singleton code path until all existing installs have migrated. NULL `onecli_instance_id` must keep working forever (or at least one major version).
- **Ports are unique per host.** The schema enforces this with UNIQUE constraints. If port allocation fails, fail loud — don't fall back to "first available," because that would silently let two instances clobber each other on restart.

---

## Test plan

**Unit:**
- `src/onecli-instances.test.ts` — port allocation picks next free triple; `getOneCLIForAgent` returns singleton for NULL instance and correct client for non-NULL.
- `src/onecli-install-wrapper.test.ts` — compose templating produces expected YAML for given port triple.

**Integration (manual, on a real host with Docker):**
1. Fresh install nanoclaw → confirm legacy single-instance still works.
2. Run `ncl onecli-instances install --id test-1 --name "Test 1"` → confirm new ports/containers come up healthy.
3. Run `ncl onecli-instances install --id test-2 --name "Test 2"` → confirm ports auto-increment.
4. Bind an agent group to `test-1`, spawn a session → confirm container HTTPS_PROXY points at test-1's gateway, not the default singleton.
5. Send a message that triggers an API call → confirm credentials from test-1's vault are injected (and test-2's are NOT).
6. `ncl onecli-instances remove --id test-2` → confirm clean teardown (containers stopped, volumes dropped, row deleted).

**Smoke after upstream sync:**
- Run the same integration tests after merging an upstream nanoclaw release.

---

## Open questions

- **OneCLI's app-connections read API.** The web UI lists registered Apps, but is there a stable REST endpoint? Need to verify before implementing `ncl bots list`. Fallback is reading Postgres directly.
- **GitHub App registration via CLI.** If OneCLI's `secrets create --type github-app` accepts client_id + private_key fields, we can fully script step 3 of bot setup. Currently unknown — verify when implementing phase 2.
- **Health-check interval.** 60s feels right; faster would noisy-poll N instances. Adjust based on real usage.
- **What happens if an agent group's pinned instance is removed?** Options: (a) refuse to remove (current proposal — refuses if `agent_groups` references it); (b) auto-detach and fall back to default singleton; (c) auto-detach and leave the group broken. Going with (a) for safety.
- **Upgrade path when `ONECLI_GATEWAY_VERSION` bumps.** Right now `setup/onecli.ts` pins one version. Multi-instance probably wants per-instance version pinning so old bots can stay on a known version while new ones use the latest. Phase 3 concern.
