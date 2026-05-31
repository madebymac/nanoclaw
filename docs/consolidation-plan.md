# Consolidation + OneCLI Removal — Design

Status: **draft for approval**. Nothing in here is implemented yet except
Phase 1 (the GitHub App token broker, already in PR #53).

## Goal

Move from **two NanoClaw instances (each with its own OneCLI gateway)** to a
leaner setup where OneCLI is gone, credentials are managed in-tree, and each
agent group can carry its own GitHub App bot identity (and, later, its own
Telegram bot). The two instances only ever existed to give each agent a
separate OneCLI console; once OneCLI is gone, that reason goes with it.

## Why OneCLI is being dropped

- The self-hosted GitHub App **bot identity** is a OneCLI Pro feature — paywalled.
- OneCLI is a heavy dependency: a per-instance Docker Compose stack (gateway +
  Postgres), an SDK (`@onecli-sh/sdk`), a credential proxy, an approvals bridge,
  a web UI whose default-project behaviour needs a 398-line reconcile script
  (`scripts/onecli-reconcile-connections.sh`) to keep connections visible to the
  agent. That's a lot of surface for "inject a token into a request."

## Key finding that reshapes the plan

The original prompt assumed "separate Telegram channels per agent is fully
supported in a single instance — each agent group has its own bot token." **That
is not true today.** The Telegram adapter reads a single `TELEGRAM_BOT_TOKEN`
from the instance `.env` and is instantiated **once per host** in the channel
registry (`src/channels/channel-registry.ts`), producing one shared adapter for
the whole instance. One instance = one Telegram bot.

So there's a genuine tension between two of the goals:

- "One instance hosting multiple agent groups," **and**
- "Each agent maintains its own Telegram bot (separate BotFather token)."

Without new code, you can have one of these, not both. The decisions below
resolve that tension explicitly.

## Decisions (confirmed with the operator)

1. **Telegram: keep two instances for now.** We do *not* build per-group
   multi-bot Telegram support in this round. Consolidate everything that doesn't
   require a separate bot identity; accept that distinct Telegram bots still
   imply distinct instances until multi-bot support lands later. (A later phase
   can refactor the registry to run one adapter per group — see "Deferred".)
2. **Per-group credentials live in `container_configs`.** Extend the existing
   per-agent-group config table with a per-group env/secret map, materialized at
   spawn — rather than inventing a new on-disk `.env`-per-group convention. This
   reuses NanoClaw's own plumbing (`src/db/container-configs.ts`,
   `src/container-config.ts`).
3. **GitHub bot identity uses the token broker** (`scripts/github-app-token.mjs`,
   Phase 1), not OneCLI. Per-group App ID / private-key path / installation ID
   come from the per-group config in (2).

> Note on (1): because Telegram stays multi-instance for now, "consolidate to a
> single instance" is partially deferred. This doc treats consolidation and
> OneCLI removal as **separable** — OneCLI removal does not depend on collapsing
> instances, and is the higher-value, lower-risk half. Recommended order below
> reflects that.

## What "an instance" actually is (so consolidation is concrete)

From `instances.conf` (`INSTANCES="review general"`, `ONECLI_BASE_PORT=10354`,
`ONECLI_PORT_STRIDE=100`) and `src/config.ts`: when `NCL_INSTANCE` is set, each
instance is fully isolated —

- central + session DBs under `instances/<name>/`,
- its own `groups/` tree,
- its own `instances/<name>/.env` (channel tokens, `ONECLI_URL`, `ONECLI_API_KEY`),
- its own systemd unit (slugged from CWD+name in the `Makefile`),
- its own OneCLI gateway (compose project `onecli-<name>`, port triple derived
  from `instances.conf`).

Multiple agent groups inside one instance is **already supported** — agent
groups are rows in the central DB + folders under `groups/`, each spawning its
own container. So the only thing forcing two instances today is the
one-Telegram-bot-per-instance limit (and, previously, separate OneCLI consoles).

## OneCLI removal — surface to excise

Full map (from research). Each item is "remove or replace":

**Delete outright**
- `setup/onecli.ts` (install orchestrator)
- `setup/onecli/docker-compose.yml.template`
- `scripts/onecli-reconcile-connections.sh`
- `container/skills/onecli-gateway/` (the container skill that teaches the agent
  about the injecting proxy)
- `.claude/skills/init-onecli/` (operational skill)

**Refactor**
- `src/container-runner.ts` — drop the `@onecli-sh/sdk` import + client, and the
  `ensureAgent` / `ensureAgentSecretModeAll` / `applyContainerConfig` /
  `fixProxyGatewayPort` block. Replace with the native credential proxy +
  per-group env injection (below).
- `src/config.ts` — drop `ONECLI_URL` / `ONECLI_API_KEY`.
- `src/modules/approvals/onecli-approvals.ts` — delete; keep the generic
  approvals primitive (`src/modules/approvals/primitive.ts`) which is not
  OneCLI-specific and is still used for self-mod / command approvals.
- `setup/auth.ts` — Anthropic credential currently registered in the vault;
  move to `.env` read by the native proxy.
- `Makefile` — drop the per-instance OneCLI install + reconcile steps.
- `scripts/render-instance-env.sh` + `instances/example/.env.example` — drop the
  `__ONECLI_URL__` placeholder and `ONECLI_*` lines.
- `setup/verify.ts` — drop OneCLI health checks.

**Dependency**
- Remove `@onecli-sh/sdk` from `package.json` (respect the supply-chain policy;
  no lockfile shortcuts).

## Replacement: native credential proxy + per-group env

NanoClaw already ships a `use-native-credential-proxy` skill. Per the operator's
"reuse existing functionality wherever possible," that's the base:

- The skill installs `src/credential-proxy.ts`: a local HTTP forward proxy that
  reads creds from `.env` (via `readEnvFile`, which deliberately does *not*
  pollute `process.env`) and injects `Authorization` headers into outbound
  requests at the proxy boundary. Containers get `HTTPS_PROXY=...` at spawn and
  never see raw credentials — same security property OneCLI provided.
- We extend it with the **per-group env/secret map** from `container_configs`,
  so different groups can present different upstream credentials (e.g. each
  group's GitHub App identity).

This keeps the "no raw credential in the LLM context" guarantee that OneCLI gave
us, without the gateway/Postgres/UI stack.

## On the GitHub broker: is host-side injection even necessary?

The operator asked us to check. Answer: **for the GitHub-App-bot use case, a
heavyweight injection layer is not necessary.** The broker
(`scripts/github-app-token.mjs`) reads the private key from disk and emits a
short-lived (~1h) installation token. As long as it's invoked from a
**pre-agent script** or wired as a **git credential helper** — not run by the
agent with its stdout read back into the conversation — the token never enters
the context window. The private key stays on the host filesystem
(`chmod 600`, outside the repo). That satisfies the requirement with no proxy
interception for GitHub specifically.

The native credential proxy is still useful for APIs where the agent itself
issues the HTTP call (so we can inject without the agent holding the key), but
GitHub-as-bot is cleanly handled by the broker + credential helper. Recommended:
use the broker for GitHub, use the proxy for the Anthropic key and any
agent-issued API calls.

## Migration posture

Downtime during migration is acceptable — agents can be torn down and set back
up. This removes the need for any zero-downtime dance: Phase 4 can stop both
instances, excise OneCLI, rebuild the container image, and bring the surviving
instance(s) back up cold. Likewise the per-group config migration (Phase 3) and
any DB changes can run against a stopped host rather than live. Re-pairing
channels and re-seeding the owner after the cutover is expected, not a failure.

## Recommended phasing

- **Phase 1 — GitHub App token broker.** ✅ Done, PR #53. Self-contained.
- **Phase 2 — Native credential proxy.** Run the `use-native-credential-proxy`
  skill on a branch; verify the Anthropic key flows to a container through the
  proxy with no OneCLI in the path. Reviewable in isolation.
- **Phase 3 — Per-group env in `container_configs`.** Add the env/secret map
  column + CRUD + materialization + `ncl groups config` surface; wire the proxy
  to select per-group creds; wire the GitHub broker's per-group inputs.
- **Phase 4 — OneCLI removal.** Excise the surface mapped above once Phases 2–3
  cover everything OneCLI did. This is the big, mechanical PR.
- **Phase 5 (deferred) — Telegram multi-bot, then collapse to one instance.**
  Only after which the "single instance, multiple bots" end-state is reachable.

## Deferred / open

- **Telegram multi-bot.** Refactor `channel-registry.ts` to instantiate one
  Telegram adapter per agent group, each reading its own token from the
  per-group config. Non-trivial (poller lifecycle, routing). Needed before the
  instances can actually collapse to one.
- **Approvals for credentialed actions.** OneCLI's server-side "hold + ask"
  policy has no native equivalent. If credential-use approval is still wanted,
  it must be rebuilt on the generic approvals primitive. Flagging as a known
  capability loss, not silently dropping it.
- **Existing connected apps (Gmail/GCal/etc. via OneCLI).** Anything currently
  authed through the OneCLI vault/app-connections needs a migration path before
  Phase 4 deletes the gateway. Out of scope until those integrations are
  enumerated.
