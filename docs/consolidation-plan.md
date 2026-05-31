# Instance-per-Agent + OneCLI Removal — Design

Status: **draft for approval**. Nothing here is implemented yet except Phase 1
(the GitHub App token broker, already in PR #53).

## Goal

Run **multiple fully independent agents, each with its own channel identity**
(its own Telegram BotFather @handle, its own GitHub App bot identity), on one
Raspberry Pi — without OneCLI.

## Chosen architecture: instance-per-agent, made lightweight

Confirmed with the operator:

- Each agent needs its **own Telegram bot @handle** (a distinct bot users see).
- Agents are **fully independent** — no shared memory, no cross-agent messaging,
  never co-located in the same chat.
- **Lean effort** — do the least code that delivers this.

Given those three, the answer is **instance-per-agent**: one NanoClaw instance
(Node process + systemd unit + its own DB/groups/`.env` on the shared checkout)
per agent. This **already** gives each agent its own bot @handle today, because
each instance reads its own `TELEGRAM_BOT_TOKEN`. The only reason it currently
feels heavy is **OneCLI** — a per-instance Docker Compose stack (gateway +
Postgres) plus a 398-line reconcile script. Remove OneCLI and adding agent #N
becomes: add a line to `instances.conf`, drop in a bot token, `make deploy`.

### Why not the single-instance multi-bot refactor (Path A)

The channel pipeline is keyed by channel *type*, not channel *instance*:
`channel-registry.ts` builds exactly one adapter per type from a single
`TELEGRAM_BOT_TOKEN` (`telegram.ts:201`), `activeAdapters` is
`Map<channelType, adapter>`, and `delivery.ts` resolves the outbound adapter by
`channel_type` alone. Running N bots in one process would require refactoring
the registry, the adapter, inbound routing, outbound delivery, the schema, and
setup — a multi-week change to the channel core. It only buys something the
operator explicitly does **not** need (shared state / bots co-existing in one
chat). So it's **out of scope**; recorded under "Deferred" in case the
requirements change.

## Why OneCLI is being dropped

- The self-hosted GitHub App **bot identity** is a OneCLI Pro feature — paywalled.
- OneCLI is heavy: a per-instance Docker Compose stack (gateway + Postgres), an
  SDK (`@onecli-sh/sdk`), a credential proxy, an approvals bridge, and a web UI
  whose default-project behaviour needs a 398-line reconcile script
  (`scripts/onecli-reconcile-connections.sh`) to keep connections visible to the
  agent. That's a lot of surface for "inject a token into a request" — and it's
  the single thing making instance-per-agent expensive.

## What "an instance" is (so the plan is concrete)

From `instances.conf` (`INSTANCES="review general"`, `ONECLI_BASE_PORT=10354`,
`ONECLI_PORT_STRIDE=100`) and `src/config.ts`: when `NCL_INSTANCE` is set, each
instance is fully isolated —

- central + session DBs under `instances/<name>/`,
- its own `groups/` tree,
- its own `instances/<name>/.env` (channel tokens, `ONECLI_URL`, `ONECLI_API_KEY`),
- its own systemd unit (slugged from CWD+name in the `Makefile`),
- its own OneCLI gateway (compose project `onecli-<name>`, port triple derived
  from `instances.conf`).

Post-OneCLI, an instance collapses to: a DB dir, a groups dir, a `.env`, and a
systemd unit. That's the lightweight unit-of-agent we want.

## Per-agent credentials (post-OneCLI)

Two credential surfaces, two homes:

1. **Instance-level secrets** (Anthropic key, the agent's Telegram bot token)
   live in `instances/<name>/.env`, read at spawn — exactly where channel tokens
   already live. The Anthropic key flows to the container via the **native
   credential proxy** (see below) so it never sits in the container env or the
   LLM context.
2. **GitHub App bot identity** uses the token broker (`scripts/github-app-token.mjs`,
   Phase 1): App ID + installation ID in `instances/<name>/.env`, private-key
   **path** pointing at a `chmod 600` `.pem` on the host outside the repo. The
   broker mints short-lived installation tokens; invoked from a pre-agent script
   or as a git credential helper, neither key nor token enters the context.

> The earlier idea of a per-group env map in `container_configs` is **not needed
> for instance-per-agent** — isolation is already at the instance `.env` level.
> It only becomes relevant if we ever do Path A (multiple agents in one
> instance). Keeping the simpler `.env`-per-instance model.

## OneCLI removal — surface to excise

**Delete outright**
- `setup/onecli.ts`
- `setup/onecli/docker-compose.yml.template`
- `scripts/onecli-reconcile-connections.sh`
- `container/skills/onecli-gateway/`
- `.claude/skills/init-onecli/`

**Refactor**
- `src/container-runner.ts` — drop the `@onecli-sh/sdk` import + client and the
  `ensureAgent` / `ensureAgentSecretModeAll` / `applyContainerConfig` /
  `fixProxyGatewayPort` block; replace with the native credential proxy.
- `src/config.ts` — drop `ONECLI_URL` / `ONECLI_API_KEY`.
- `src/modules/approvals/onecli-approvals.ts` — delete; keep the generic
  approvals primitive (`src/modules/approvals/primitive.ts`).
- `setup/auth.ts` — Anthropic credential moves from vault to `.env` (proxy reads it).
- `Makefile` — drop the per-instance OneCLI install + reconcile steps. This is
  also where adding an instance gets cheap.
- `scripts/render-instance-env.sh` + `instances/example/.env.example` — drop the
  `__ONECLI_URL__` placeholder and `ONECLI_*` lines.
- `setup/verify.ts` — drop OneCLI health checks.
- `instances.conf` comments — rewrite away from the OneCLI port-triple framing.

**Dependency**
- Remove `@onecli-sh/sdk` from `package.json` (respect the supply-chain policy).

## Replacement: native credential proxy

NanoClaw ships a `use-native-credential-proxy` skill — reuse it per the
operator's "use existing functionality wherever possible." It installs
`src/credential-proxy.ts`: a local HTTP forward proxy that reads creds from
`.env` (via `readEnvFile`, which deliberately does not pollute `process.env`)
and injects `Authorization` headers at the proxy boundary. Containers get
`HTTPS_PROXY=...` at spawn and never see raw credentials — the same security
property OneCLI gave us, without the gateway/Postgres/UI stack. Per instance,
the proxy just serves that instance's `.env` creds.

## On the GitHub broker: is host-side injection even necessary?

The operator asked us to check. **For the GitHub-App-bot case, no heavyweight
injection layer is needed.** The broker reads the private key from disk and
emits a short-lived (~1h) installation token; invoked from a pre-agent script or
a git credential helper (not run by the agent with its stdout read back), the
token never enters the context. The private key stays on the host filesystem
(`chmod 600`, outside the repo). The native credential proxy still earns its
place for the Anthropic key and any API call the agent issues itself — but
GitHub-as-bot is cleanly handled by broker + credential helper.

## Migration posture

Downtime is acceptable — agents can be torn down and set back up. So the cutover
is a cold one: stop the instances, excise OneCLI, rebuild the container image,
bring instances back up, re-pair channels / re-seed owners as needed. No
zero-downtime dance, no live DB surgery.

## Phasing

- **Phase 1 — GitHub App token broker.** ✅ Done, PR #53.
- **Phase 2 — Native credential proxy.** Run `use-native-credential-proxy` on a
  branch; verify the Anthropic key reaches a container through the proxy with no
  OneCLI in the path. Reviewable in isolation.
- **Phase 3 — OneCLI removal.** Excise the surface above once Phase 2 covers
  credential injection. The big mechanical PR. Includes making `make deploy` /
  `instances.conf` the lightweight "add an agent" path.
- **Phase 4 — Docs + add-an-agent runbook.** Update setup/CLAUDE.md so spinning
  up agent #N is a documented one-liner-plus-token flow.

## Deferred / open

- **Single-instance multi-bot (Path A).** The channel-core refactor described
  above. Only worth it if agents ever need shared state or to share a chat.
- **Approvals for credentialed actions.** OneCLI's server-side "hold + ask" has
  no native equivalent; rebuild on the generic approvals primitive if still
  wanted. Flagged as a known capability loss, not silently dropped.
- **Existing connected apps (Gmail/GCal/etc. via OneCLI).** Need a migration
  path before Phase 3 deletes the gateway; enumerate before cutover.
