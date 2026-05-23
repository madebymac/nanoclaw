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
│  container-runner ───── resolve client per agent ───────┐│
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

Each instance is a standard upstream OneCLI deployment with overridden ports and install dir. Containers spawned for agent groups bound to that instance get an `HTTPS_PROXY` pointing at that instance's gateway, plus the instance's CA cert mounted in. The agent never sees a credential — it just calls the API and OneCLI injects the right token.

## Entity-model changes

- **New table `onecli_instances`** keyed by a slug (e.g. `review-bot`) and holding the per-instance ports, install dir, API key, CA cert path, and health status.
- **New nullable column `agent_groups.onecli_instance_id`** referencing `onecli_instances`. NULL means "use the legacy env-var singleton" — that's the back-compat path for existing installs.
- Referential integrity is enforced at the **application layer** (instance removal refuses if any agent_group references it), not by the SQLite schema. SQLite doesn't enforce `REFERENCES` clauses added via `ALTER TABLE ADD COLUMN`; the clause stays for documentation.

## New code

- **`src/onecli-instances.ts`** — the multi-instance brain. Responsibilities: list/get instances, resolve the right OneCLI SDK client for a given agent group (with default-singleton fallback for NULL `onecli_instance_id`), provision new instances, tear them down, run health checks. Concrete API shapes are an implementation concern; the architecturally-load-bearing contract is "agent group in, SDK client out, default fallback preserved."
- **`src/onecli-install-wrapper.ts`** — encapsulates the docker-compose orchestration so `onecli-instances.ts` stays small.
- **CLI resources: `onecli-instances` and `bots`.** `onecli-instances` is the lifecycle resource (list, install, remove, status, repair). `bots` is the unified read-only view that joins instances ⋈ agent_groups ⋈ messaging_groups so an operator can see "which bot is wired to what" in a single command without juggling N OneCLI dashboards.
- **`/add-onecli-instance` skill** — operator walkthrough for provisioning + registering the GitHub App in that instance's web UI.

## Existing-file changes

Five existing files are touched, all small:

- `src/container-runner.ts` — replace the module-level OneCLI singleton with a per-agent lookup at the spawn site.
- `src/modules/approvals/onecli-approvals.ts` — fan out the manual-approval callback so each instance gets one (with a guard against double-registering the legacy singleton; see "Approvals fan-out" below).
- `src/cli/dispatch.ts` — register the two new resources.
- `src/index.ts` — start the health-check loop on boot (optional).
- `src/db/migrations/index.ts` — register the new migration. **This is the highest-conflict file** because upstream adds new migration entries here frequently; resolving is mechanical ("keep both entries").

Conflict surface is deliberately minimized: all real complexity lives in new files (which can't conflict), and existing files get the smallest possible per-call-site changes.

## Install wrapper strategy

**Recommended (phase 1): wrap the upstream installer.** Run `onecli.sh/install` with the documented env-var overrides for the port triple and version, then relocate `~/.onecli` to a per-instance install dir and rename the compose project. Pragmatic, reuses the upstream artifact path that `setup/onecli.ts` already trusts.

**Deferred: direct compose.yml fetch + `docker compose up` ourselves.** Cleaner — pins us against the compose schema rather than the install script's quirks — but there is no documented stable raw-compose URL on `onecli.sh`. Promote to default only after the phase-1 spike confirms a stable URL or we ship our own pinned compose.yml against public images.

Either way, the *interface* (`installInstance({ id, name })` returns a usable instance row) stays the same; the swap is internal.

## Approvals fan-out

`onecli.configureManualApproval` long-polls one OneCLI's pending-approval queue. With N instances, we register one callback per instance.

**Hazard to avoid:** once phase-2 `import-default` writes the legacy singleton as a row in `onecli_instances`, it's reachable both as a listed instance *and* as the default singleton. Without a guard, every pending approval would fire two callbacks against the same gateway long-poll, duplicating admin DMs and pending-approvals rows. The architectural rule: **register the default-singleton callback only when the singleton isn't already represented as an instance row.**

The approval-handling logic itself (resolving approver, sending DM) is unchanged — only the registration loops.

## `ncl bots list`

Joins three sources: local `onecli_instances` (instance + health), per-instance app-connections (the registered GitHub App identity), and local `agent_groups` + `messaging_groups` (which agent group is wired and which channels are attached). Output is a single per-bot row.

The exact app-connections read path on the OneCLI side is unverified — phase-1 spike either confirms a stable REST endpoint or commits to reading the instance's Postgres directly (acceptable because we own the install). Phase 2 plans against whichever the spike settles.

## Phased delivery

**Phase 1 — minimum viable multi-instance** (~2-3 days):
- Schema migration + `agent_groups.onecli_instance_id`
- Core of `src/onecli-instances.ts` (lookups + back-compat fallback)
- Install wrapper (Option 1 by default)
- `container-runner.ts` integration
- `ncl onecli-instances` resource (list/get/install/remove)
- Manual instructions for the GitHub App registration via the per-instance web UI
- **Spikes (half-day each):** (a) app-connections read endpoint shape; (b) install-wrapper choice (Option 1 vs Option 2)

After phase 1, two bots run end-to-end.

**Phase 2 — operational polish** (~1-2 days):
- `ncl bots list` / `ncl bots get` against whichever data source phase 1 settled on
- Approvals fan-out
- Health-check loop
- `/add-onecli-instance` skill
- `ncl onecli-instances import-default` to convert the legacy singleton into a managed instance
- Detach support on `ncl groups update`

**Phase 3 — deferred:**
- Programmatic GitHub App registration (if OneCLI ever exposes a CLI/API verb for it)
- Auto-restart on instance crash
- Cross-instance secret import

## Sync-with-upstream risk + mitigations

Five files touched in `src/`. The design pushes complexity into new files (which can't conflict) and keeps existing-file touches to a single call-site each.

Specific mitigations:
1. **Hide complexity in new files.** `src/onecli-instances.ts` and `src/onecli-install-wrapper.ts` are net-new; upstream never touches them.
2. **Single-call-site changes.** `container-runner.ts` keeps one OneCLI call site; we just change how it gets the client.
3. **Additive schema changes.** New table + nullable column. Doesn't conflict with upstream schema work unless upstream renames `agent_groups`.
4. **No channel-adapter changes.** Multi-OneCLI is orthogonal to the channel layer.
5. **No OneCLI fork.** We use the upstream installer or compose.yml as-is.

**Highest-risk file:** `src/db/migrations/index.ts` — upstream adds new migration entries there regularly, so any sync between forks is likely to produce a list-conflict at the migration registration. Resolution is mechanical (keep both entries).

**Upstreaming option:** the whole feature is generic (multi-bot deployments). Once stable locally, send it as an upstream PR. If accepted, sync cost goes to zero.

---

## Runbook

### Adding a new bot (happy path)

1. Create the GitHub App on github.com. Save App ID, Client ID, Client Secret, Private Key file.
2. Run `/add-onecli-instance <slug>` — provisions a new OneCLI on the next free port triple.
3. Open the instance's web UI (the skill prints the URL). Connect a service → GitHub. Paste the App credentials.
4. Create an agent group bound to this instance.
5. Wire a channel via `/add-github <slug>` (see `multi-bot-channels.md`).
6. Verify with `ncl bots get <slug>`.

### Removing a bot cleanly

Order matters — detach agent groups from the instance before removing it, otherwise removal refuses.

1. Find what's bound to this instance with `ncl bots get <slug>`.
2. Detach or delete every agent group that points at it.
3. Remove the instance (`ncl onecli-instances remove --id <slug>`) — runs `docker compose down`, drops volumes, deletes the row.
4. Optionally delete the GitHub App on github.com if no longer needed.

### Renaming a bot

Three names should stay in sync: the OneCLI instance slug, the agent group name, and the GitHub App name on github.com. Renaming the instance slug isn't supported in phase 1 (it would invalidate ports, install dir, and compose project name). Phase 2 should add this; until then, choose carefully.

### Rotating a GitHub App private key

Generate a new key on github.com → App Settings, paste it into the instance's web UI, restart the agent group's container so the next API call sees the new credential injection. Revoke the old key after verifying.

### Diagnosis: "Bot isn't responding to mentions"

Walk the path top to bottom:
1. Is the webhook reaching nanoclaw? (Check `logs/nanoclaw.log`.)
2. Is the inbound message landing in `inbound.db`?
3. Is the container's `HTTPS_PROXY` pointing at the right OneCLI instance?
4. Is the GitHub App credential assigned to this agent in OneCLI's selective-secret mode?
5. Is the OneCLI instance itself healthy?

### Diagnosis: "OneCLI instance is down"

Symptoms: `OneCLI gateway not applied — refusing to spawn container` in nanoclaw logs, plus 401s or connection-refused errors from agent API calls. Recovery: try `ncl onecli-instances repair`, then inspect `docker compose -p onecli-<slug> logs`. If Postgres is corrupt, backing up the volume before recreating is prudent — re-registering the GitHub App is a manual step.

### Migrating from single-instance to multi-instance

Existing installs run one OneCLI from `setup/onecli.ts`. After this feature ships, that singleton keeps working through the NULL fallback in `agent_groups.onecli_instance_id` — no migration required. To explicitly manage the legacy singleton (so it appears in `ncl bots list`), phase 2 ships `ncl onecli-instances import-default`.

### Invariants

- **One OneCLI instance per bot identity.** Never multiplex two GitHub Apps into one vault — that defeats the constraint we're working around.
- **`onecli_instance_id` is per-agent-group, never per-session.** Sessions inherit their agent group's instance. `container-runner.ts` resolves the agent group from the session at spawn time, then asks for the right client. Future code paths holding only a session id must do the same join — do **not** add a `getOneCLIForSession` shortcut.
- **Each instance owns its own Postgres volume.** Never share volumes between instances.
- **The default-fallback path stays alive.** Don't delete the legacy singleton code path until all existing installs have migrated. NULL `onecli_instance_id` must keep working for at least one major version.
- **Ports are unique per host.** Allocation failures must fail loud — silently falling back risks two instances clobbering each other on restart.

---

## Test plan

- **Unit:** port-allocation logic, client-resolution logic (NULL → default; non-NULL → keyed lookup).
- **Integration (manual, on a real host):** fresh install → confirm legacy single-instance still works; install two managed instances → confirm distinct ports and credentials; bind an agent group to one and verify its container's `HTTPS_PROXY` points at the right gateway; remove an instance → confirm clean teardown.
- **Smoke after upstream sync:** rerun the integration tests after every `/update-nanoclaw`.

---

## Open questions

- **Programmatic GitHub App registration.** If OneCLI ever exposes a CLI verb for registering an App non-interactively, step 3 of bot setup can be scripted.
- **`ONECLI_GATEWAY_VERSION` pinning per instance.** Today one version is pinned for all instances. Phase 3 may want per-instance pinning so old bots can stay on a known-good version while new ones get the latest.
- App-connections read endpoint and install-wrapper choice are no longer open — they're phase-1 spike deliverables (see "Phased delivery").
