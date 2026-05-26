# AGENTS.md — Dual-Instance NanoClaw

This host runs **two NanoClaw instances from a single checkout**: `review` and `general`. Multi-instance is the only supported mode here — there is no single-install fallback. If you're touching deploys, channels, or per-instance state, read this first.

For the underlying architecture (entity model, two-DB session split, central DB, channels, OneCLI), see [CLAUDE.md](CLAUDE.md) and `docs/`. This file only covers what's different because there are two of them.

## The shape

```
nanoclaw/                       ← one checkout, one git working tree
├── instances.conf              ← INSTANCES="review general" + port base/stride
├── Makefile                    ← every target loops over INSTANCES
├── src/, container/, ...       ← shared code, built once
└── instances/
    ├── example/.env.example    ← template
    ├── review/                 ← instance "review"
    │   ├── .env                ← rendered from template; channel tokens land here
    │   ├── data/v2.db          ← review's central DB
    │   ├── data/v2-sessions/   ← review's per-session DBs
    │   ├── groups/             ← review's agent groups
    │   └── store/
    └── general/                ← instance "general"
        └── ... (same layout)
```

Per-instance host processes are completely isolated at the data layer. They share:

- the source tree and `node_modules/`
- the built host bundle (`pnpm build` → `dist/`)
- the agent container image tag (one `./container/build.sh` covers both)
- the mount allowlist + sender allowlist under `~/.config/nanoclaw/` (host-global, not instance-scoped)

## How `NCL_INSTANCE` works

Every host process is launched with `NCL_INSTANCE=<name>` in its environment. That single env var fans out into:

- **Filesystem paths** (`src/config.ts`): `STORE_DIR`, `GROUPS_DIR`, `DATA_DIR`, `ENV_FILE_PATH` all resolve under `instances/<name>/` when set.
- **Install slug** (`src/install-slug.ts`): slug becomes `sha1("<projectRoot>:<instance>")[:8]`, which produces a distinct systemd unit (`nanoclaw-v2-<slug>`) and orphan-cleanup label per instance.
- **OneCLI gateway**: each instance gets its own gateway on an auto-derived port triple — i-th instance (0-indexed in `INSTANCES`) binds `(BASE + i*STRIDE, +1, +2)`. With the defaults (`BASE=10354`, `STRIDE=100`): review → 10354/10355/10356, general → 10454/10455/10456.

The value is validated in exactly one place (`src/instance-name.ts`): `^[a-z0-9][a-z0-9_-]{0,31}$`. The same regex is duplicated in `scripts/render-instance-env.sh`. Keep them in lock-step — anything the bash side accepts must also pass the TS validator.

Two refusals worth knowing about:

- Launching the host from inside `instances/<name>/` throws at startup. Always `cd` to the repo root and set `NCL_INSTANCE` in the env.
- `make` targets fail loudly if `INSTANCES` is empty or `instances.conf` is missing. There is no implicit single-install path.

## Daily operations

Everything goes through `make`:

```bash
make deploy      # pull → install → bootstrap missing instances → build → restart all
make restart     # restart every instance unit
make logs        # tail every instance's journal
make status      # systemctl status per instance
```

`make deploy` is the only command you actually need. It is **self-bootstrapping and idempotent**:

1. `git pull --ff-only`
2. `pnpm install --frozen-lockfile`
3. For each instance in `INSTANCES`:
   - render `instances/<name>/.env` if missing (`scripts/render-instance-env.sh`)
   - bring up the OneCLI gateway compose project if not running
   - register the per-instance systemd user unit if missing
4. `pnpm build`
5. `./container/build.sh` (one image, both instances use it)
6. Restart every instance unit (tolerant — one failure logs WARN and the loop continues; deploy exits non-zero overall)

The whole deploy is serialized by `flock` on `/tmp/nanoclaw-build-<cwd-hash>.lock`. Self-upgrade ticks from both instances' hosts all fire `make deploy` — the loser blocks, then no-ops through every idempotent step. The lock is scoped to `CURDIR`, so unrelated nanoclaw checkouts on the same host don't block each other.

## Adding or removing an instance

1. Edit `INSTANCES` in `instances.conf`.
2. Run `make deploy` (or wait for the next self-upgrade tick). The missing `.env`, OneCLI compose project, and systemd unit get created inline.
3. From a Claude Code session **with `NCL_INSTANCE=<name>` exported**, wire channels with `/add-telegram`, `/add-slack`, etc. Tokens land in `instances/<name>/.env` because the `set-env` setup step is instance-aware.

Removing: drop the name from `INSTANCES`, stop and disable its systemd unit manually (the Makefile won't reap it for you), then `rm -rf instances/<name>/`.

## Per-instance channels and tokens

Channel install skills (`/add-*`) are instance-aware via `NCL_INSTANCE`. The same skill run twice with different `NCL_INSTANCE` values produces two independent channel wirings — each writing tokens into its own `instances/<name>/.env`, each registering bots/adapters against its own central DB.

This means **review and general can have entirely different channel sets and identities**. Same Slack workspace, different bot users; different Telegram bot tokens; one running iMessage, the other not — all fine.

Anything that reads channel tokens via `readEnvFile()` **must** pass `ENV_FILE_PATH` from `src/config.ts`. Bare `readEnvFile()` falls back to `process.cwd()` and silently crosses instance boundaries.

## Operating an `ncl` session against a specific instance

`ncl` connects to the host's Unix socket. The socket path is derived from the install slug, so you must export `NCL_INSTANCE` before running `ncl` on the host — otherwise it talks to whichever socket happens to match the empty-instance slug (usually nothing, and you get a connection error).

```bash
NCL_INSTANCE=review  ncl groups list
NCL_INSTANCE=general ncl wirings list
```

Inside a container, `ncl` uses the session-DB transport — the instance is implicit in which session you're in, no env var needed.

## Container image: shared, not per-instance

`CONTAINER_IMAGE_BASE` is intentionally **not** mixed with `NCL_INSTANCE` (see the comment block at the top of `src/install-slug.ts`). Both instances pull from the same `nanoclaw-agent:<slug>` tag. One `./container/build.sh` rebuilds for both. The per-spawn `--label nanoclaw-install=<slug>` does include the instance, so orphan cleanup still only reaps containers belonging to the right instance.

If you find yourself wanting per-instance container images (e.g. different package sets), don't fork the build — use per-agent-group container config (`ncl groups config update`, see CLAUDE.md → Container Config). That's what it's there for.

## Common gotchas

- **Forgot `NCL_INSTANCE` when running setup steps or `ncl`** → setup writes into the root-level `.env` / `data/` / `groups/` instead of `instances/<name>/`. There's a guard for launching the host from inside `instances/`, but not for running setup at the root with no instance set. Always export it.
- **Editing tokens by hand in `instances/<name>/.env`** → fine for `ASSISTANT_NAME`, `TZ`. For channel tokens, prefer running the install skill again so both the env file and the central-DB wiring stay in sync.
- **`make deploy` from two shells at once** → safe, `flock` serializes them. Don't try to "work around" the lock; the second run is a no-op by design.
- **Restarting only one instance** → `systemctl --user restart nanoclaw-v2-<slug>`. Get the slug from `make status` or compute it: `printf %s "$PWD:<name>" | sha1sum | cut -c1-8`.
- **OneCLI port collisions** with other services on the host → bump `ONECLI_PORT_STRIDE` in `instances.conf` and re-run `make deploy`. Existing `.env` files won't be re-rendered (the script refuses to overwrite, to preserve tokens) — edit `ONECLI_URL` in each `instances/<name>/.env` by hand, or delete and re-render only the env file.
- **Mount allowlist changes** apply host-wide. Both instances share `~/.config/nanoclaw/mount-allowlist.json`. If you need different mount policies per instance, that's not supported today.

## Where to look when something breaks

| Symptom | First place |
|---------|-------------|
| One instance won't start | `journalctl --user -u nanoclaw-v2-<slug>` (get slug from `make status`) |
| Channel messages going to the wrong instance | `instances/<name>/.env` — check which bot token is where |
| `make deploy` hangs | another deploy holds `/tmp/nanoclaw-build-<hash>.lock`; wait, don't kill |
| Container can't reach OneCLI | wrong port for the instance — verify `ONECLI_URL` in `instances/<name>/.env` matches the auto-derived triple |
| Orphan containers from a removed instance | `docker ps -a --filter label=nanoclaw-install=<old-slug>` then prune |

For everything else (host logs, session DBs, setup logs), the paths in [CLAUDE.md → Troubleshooting](CLAUDE.md#troubleshooting) all live under `instances/<name>/` now instead of the repo root.
