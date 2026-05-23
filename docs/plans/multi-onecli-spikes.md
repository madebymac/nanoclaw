# Multi-OneCLI Phase-1 Spike Findings

**Status:** Spike report — feeds `multi-onecli.md` phase 1.
**Branch:** `claude/beautiful-faraday-ZZ7CP`

Two open questions from `multi-onecli.md` needed de-risking before committing to phase-1 shapes:

1. How do we read "which GitHub App is registered" from a OneCLI instance for `ncl bots list`?
2. Should the install wrapper wrap upstream `onecli.sh/install` (Option 1) or fetch a raw `compose.yml` and run `docker compose` ourselves (Option 2)?

---

## Spike 1 — App-connections read path

### What the installed SDK exposes

`@onecli-sh/sdk@0.5.0` is pinned (`pnpm-lock.yaml`). Its public surface (`node_modules/@onecli-sh/sdk/lib/index.d.ts:70-83`) is small:

```
getGatewaySkill, getContainerConfig, applyContainerConfig,
createAgent, ensureAgent, provisionUser, configureManualApproval
```

Every HTTP path the SDK touches (grep against `lib/index.mjs`):

```
/api/agents
/api/approvals/
/api/approvals/pending
/api/container-config
/api/gateway-url
/api/skill/gateway
/api/team/provisions
```

**There is no SDK method and no documented REST endpoint for listing registered GitHub Apps / `AppConfig` rows.** The web UI at `:10254` clearly reads this data, so an internal endpoint exists, but it isn't exposed via the SDK we depend on.

### Options for `ncl bots list`

1. **Reverse-engineer the web-UI endpoint.** Run a OneCLI instance locally, hit its UI, inspect the network tab. Likely lives under `/api/app-configs` or `/api/projects/<id>/connections`. Cheap to do, but coupling to an undocumented endpoint means upstream can break us silently. Acceptable if we feature-detect with a single GET and degrade gracefully.
2. **Read Postgres directly.** Each instance owns its own Postgres volume (per the multi-onecli plan invariant — "Each instance owns its own Postgres volume"). We install the instance, we control the volume. Connect to `127.0.0.1:<pg-port>` and query the `AppConfig` table. Stable across UI changes; brittle across schema migrations.
3. **Defer `ncl bots list` to phase 2 entirely.** Phase 1 lists instances + bound agent groups (data we already own in our central DB) without joining the OneCLI-side App identity. Operator can confirm the App separately via the per-instance web UI.

### Recommendation

**Phase 1: ship option 3.** `ncl onecli-instances list` and `ncl bots list` both work off our central DB only — instance slug, ports, health, bound agent groups, bound messaging groups. No OneCLI introspection in phase 1. The operator's first question ("which bot is which?") is answered by the agent-group name they assigned at install time, not by the App identity on github.com.

**Phase 2: layer option 1 on top.** Spike the web-UI endpoint on a real install, wire it behind a feature flag. If the endpoint is unstable, fall back to option 2 (direct Postgres). Either is additive — `ncl bots list` gains an "App identity" column once it works.

This unblocks phase 1 without committing to either fragile path. Decision can wait until we have a running multi-instance setup to spike against.

---

## Spike 2 — Install wrapper

### Current single-instance install (what we already do)

`setup/onecli.ts:157` runs:

```bash
export ONECLI_VERSION=1.23.0 && curl -fsSL onecli.sh/install | sh
```

The only env var we pass is `ONECLI_VERSION`. The script:

- Creates a docker-compose project hardcoded to the name `onecli` (`setup/onecli.ts:129` filters on `label=com.docker.compose.project=onecli`).
- Puts state under `~/.onecli/` (inferred — the codebase never references the path, and the install dir is set by the upstream installer without our help).
- Exposes ports `10254` (web UI / app) and presumably `10255` (gateway). `setup/onecli.ts:278` polls `${url}/api/health` against the configured `ONECLI_URL`.

There is **no env-var hook in our current code** for ports, install dir, or compose project name. The upstream installer's accepted overrides are not documented in this repo and we did not find any reference to them in `node_modules/@onecli-sh/sdk/`.

### What we couldn't verify from this sandbox

The container's egress policy blocks `onecli.sh` (`curl https://onecli.sh/install` returns `403 host_not_allowed`). We can't directly read the upstream install script from here to enumerate its env-var overrides. **The user (or a real host) needs to fetch and read it to confirm:**

- Whether the script reads `ONECLI_INSTALL_DIR`, `ONECLI_APP_PORT`, `ONECLI_GATEWAY_PORT`, `ONECLI_POSTGRES_PORT`, or `COMPOSE_PROJECT_NAME`.
- Whether it generates a `compose.yml` on the fly or uses a published one.
- Whether `~/.onecli/.env` is sourced before `docker compose up`.

Until those answers exist, Option 1's "small wrapper" claim is unverified — it could be 30 lines or it could require post-processing a generated compose file.

### Option 2 — direct compose.yml

The plan doc already flags this (`multi-onecli.md:77`): "there is no documented stable raw-compose URL on `onecli.sh`." Nothing in this sandbox contradicts that. If a stable URL existed we'd expect the SDK README or `setup/onecli.ts` to reference it; neither does.

Building our own pinned `compose.yml` against `onecli/onecli-gateway:<tag>` images is feasible but the image names and required env-var set are also undocumented locally. Same problem as Option 1: needs a real install to inspect.

### Recommendation

**Step 1 — one-shot diagnostic on a real host (5 min):**

```bash
# Fetch and read the install script
curl -fsSL https://onecli.sh/install > /tmp/onecli-install.sh
less /tmp/onecli-install.sh

# Enumerate accepted env vars
grep -nE '^\s*(export\s+)?ONECLI_[A-Z_]+=|^\s*:\s*"\$\{ONECLI_[A-Z_]+' /tmp/onecli-install.sh

# Find the compose.yml source (URL or heredoc)
grep -nE 'compose\.ya?ml|docker compose|COMPOSE_PROJECT_NAME' /tmp/onecli-install.sh
```

Outputs determine the choice:

- **If the script accepts port + install-dir overrides** → Option 1 is genuinely small. Wrap it, pass per-instance env vars, done.
- **If it generates compose.yml from a heredoc with no port hooks** → either post-process the generated file (brittle) or extract the heredoc into our own pinned compose.yml (Option 2 emerges naturally).
- **If it fetches a stable compose.yml URL** → grab that URL, Option 2 becomes the obvious choice.

**Step 2 — proceed with whichever the diagnostic points to.** Don't pick blind.

In the meantime, phase 1 of `multi-onecli.md` can begin on the parts that don't depend on the wrapper internals: the `onecli_instances` schema, the `agent_groups.onecli_instance_id` column, the resolver in `src/onecli-instances.ts` with NULL→singleton fallback, the `container-runner.ts` swap, and the `ncl onecli-instances` CRUD shell (minus the actual `install` verb body). The install verb itself stays a stub until the diagnostic returns.

---

## Net effect on phase 1

- **Spike 1 → resolved by deferral.** Phase 1 `ncl bots list` reads only the central DB; OneCLI-side App identity lands in phase 2.
- **Spike 2 → resolved by a 5-min diagnostic on a real host.** Everything else in phase 1 can proceed in parallel; only the body of `installInstance` waits on it.

Net: no architectural blockers. The plan as written stands.
