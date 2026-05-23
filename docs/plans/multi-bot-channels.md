# Multi-Bot Channels (Sub-Typed)

**Status:** Planning — not yet implemented.
**Branch:** `claude/github-multiple-agents-maJCw`
**Companion doc:** [`multi-onecli.md`](./multi-onecli.md)

## Goal

Allow multiple GitHub bots (review-bot, worker-bot, cleanup-bot) to operate concurrently in nanoclaw, each presenting as a distinct GitHub identity in PR threads. Combined with `multi-onecli.md`, this gives end-to-end multi-bot support without modifying the upstream GitHub channel adapter source.

## Non-goals

- A general-purpose multi-credential channel registry. We deliberately pick the cheap "sub-typed channels" approach and defer the full registry refactor.
- Supporting >5 GitHub bots per host. Past that, the sub-typed approach gets cramped — see "When to upgrade."
- Multi-bot support for non-GitHub channels in this phase. The pattern transfers, but each channel needs its own skill rewrite. Defer.

## Why sub-typed (vs full registry refactor)

The full registry refactor — making the channel registry credential-aware (`channel_type` × `credential_id` → adapter), threading a credential selector through `InboundMessage` and `deliver()`, updating every channel adapter — is the architecturally correct shape. It's also ~1 week of work touching the adapter interface (upstream surface), the messaging-groups schema, the router, and every adapter.

Sub-typed channels treat each bot as a distinct `channel_type` string (`github-review`, `github-worker`, etc.), each its own singleton adapter with its own env vars and webhook path. The existing channel registry already handles N channel types — we just add more entries.

Tradeoff: bot identity bleeds into the channel-type taxonomy. At 3 bots fine, at 10 ugly. Accept the ceiling because (a) you don't need 10, (b) the sub-typed approach is *forward-compatible* with the registry refactor when you do, and (c) shipping a working 3-bot system this week beats a perfect 10-bot system in two months.

## Architecture

```
┌─ src/channels/ ─────────────────────────────────────────┐
│                                                         │
│  github.ts          [UPSTREAM — DO NOT MODIFY]          │
│    exports: createGithubAdapter(config) ────┐           │
│    self-registers as channel_type='github'  │           │
│                                             │           │
│  github-review.ts        ◄── GENERATED ─────┤           │
│  github-worker.ts        ◄── GENERATED ─────┤           │
│  github-cleanup.ts       ◄── GENERATED ─────┘           │
│    each imports the upstream factory,                   │
│    self-registers as channel_type='github-<bot>',       │
│    reads bot-suffixed env vars                          │
│                                                         │
│  index.ts — appends one import per generated wrapper    │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

Each generated wrapper is a small file produced by the `/add-github <bot-name>` skill, never edited by hand. The upstream `github.ts` stays exactly as shipped on the `channels` branch.

## The wrapper-file pattern

**Prerequisite:** the upstream GitHub adapter currently self-registers at module load. We need it to *also* export a factory function so wrappers can instantiate it with different per-bot configs. That's a small refactor to upstream `src/channels/github.ts` — pure rearrangement, no behavior change. Send it upstream as a small PR; likely accepted.

**Fallback if upstream rejects:** copy the adapter once into a fork-only `src/channels/github-impl.ts`. All wrappers import from there. Cost: re-port any upstream `github.ts` changes on each `/update-nanoclaw`, and any wrapper's import path must shift to `./github-impl.js` (handled by re-running the skill, never by hand-editing).

**Wrapper file responsibility:** import the factory, register a per-bot `channelType` and webhook path, pass the per-bot env-var token / webhook secret / bot username into the adapter. That's it — small, regenerable, no shared state between wrappers.

## Env-var convention

Each bot's host-side credentials live in env vars suffixed with `_<UPPER_SNAKE_BOT_NAME>` — for example `GITHUB_TOKEN_REVIEW`, `GITHUB_WEBHOOK_SECRET_REVIEW`, `GITHUB_BOT_USERNAME_REVIEW`. The default bot keeps the unsuffixed names for back-compat.

**Why env vars, not the OneCLI vault?** Two distinct outbound paths, two credential sources:

1. **Channel adapter posting (host-side).** The adapter (running in the nanoclaw host process) posts the reply on github.com — that's the bot's PR-thread identity. The Chat SDK GitHub adapter reads its token at construction time, not per-request, so it can't easily route through the OneCLI proxy. Token lives in env.
2. **Agent in-container API calls.** When the agent calls `api.github.com` itself (via `curl`, GitHub MCP tool, `gh` CLI), the call routes through `HTTPS_PROXY` → that agent group's pinned OneCLI gateway → vault-injected credential. This is what `multi-onecli.md` covers.

These are complementary, not competing. A bot needs both its env-var PAT (for the adapter) and its OneCLI registration (for in-container API access).

The webhook secret is also host-side (used to verify GitHub's webhook signature) and must live on the host regardless.

## Webhook routing

Each bot gets its own webhook path: `/webhook/github-review`, `/webhook/github-worker`, etc. **Already supported by the existing webhook server** (`src/webhook-server.ts:85-101`): it routes `/webhook/{adapterName}` dynamically via a Map populated by `registerWebhookAdapter()`. Registering a new channel adapter automatically exposes its path; no upstream-server change needed.

The operator pastes the per-bot URL into each GitHub App's webhook settings.

## Mention detection

Each wrapper passes its own bot username into the adapter. The adapter checks for `@<botUsername>` in incoming comments and decides whether to trigger. Each bot independently checks for its own username — no cross-bot logic needed.

## messaging_groups stays the same

The `messaging_groups` schema doesn't change. The relevant constraint is `UNIQUE(channel_type, platform_id)` (`src/db/schema.ts:34`). Each repo wired to a bot creates one row with the per-bot `channel_type` (e.g. `github-review`) and the upstream-conventional `platform_id` (`github:owner/repo`, unchanged across bots).

Bot identity lives **only** in `channel_type` — never duplicated into `platform_id`. The same repo can be wired to multiple bots simultaneously; the constraint allows it because the tuple differs on `channel_type`.

## The `/add-github <bot-name>` skill

Rewritten from today's `/add-github`. Backward-compatible: `/add-github` with no arg installs the default channel as today; `/add-github <slug>` generates a wrapper file, appends one import to `src/channels/index.ts`, prompts for the suffixed env vars, prints the webhook URL to paste into GitHub App settings, and runs the build. Idempotent.

## Migration from single-bot to multi-bot

Existing installs keep working unchanged. To add a second bot, run `/add-github <new-bot-name>`. To convert the existing un-suffixed `github` channel into a named bot (so it shows up in `ncl bots list` consistently), update `messaging_groups.channel_type` for those rows and remove the un-suffixed wrapper/env vars — mechanical SQL. Phase 2 may wrap this as a single command.

## Existing-file changes

Three categories:

- **`src/channels/github.ts`** — upstream-PR'd factory refactor (~one small change, no behavior delta). If upstream rejects, copy to `github-impl.ts` and accept per-update sync cost on that one file.
- **`src/channels/index.ts`** — one import line appended per bot. Pure addition; conflicts only if upstream rewrites the file.
- **`.claude/skills/add-github/SKILL.md`** — full rewrite; fork-only file, no merge-conflict risk.

Wrapper files (`github-*.ts`) are net-new and generated; they don't appear in upstream.

## Sync-with-upstream risk + mitigations

**Best case (upstream PR lands):** sync cost is the per-bot import line in `index.ts`. Nothing else changes.

**Worst case (PR rejected, we maintain `github-impl.ts`):** re-port upstream `github.ts` changes on each `/update-nanoclaw`. Manageable because the github adapter doesn't change often.

Mitigations applied:
1. **Wrapper files are generated, not hand-written.** Regenerable from the skill. Bug across all bots → fix the template, re-run.
2. **No shared mutable state between wrappers.** Each registers independently.
3. **The skill never edits `github.ts`.** Only generates wrappers around it.
4. **Regular env-var naming.** No bespoke per-bot config.

**Re-port checklist when `/update-nanoclaw` runs:**
- If upstream `github.ts` changed: does our `createGithubAdapter` factory still exist there? If upstream re-merged the factory, great. If they moved it, port the import path in each wrapper.
- Verify `src/channels/index.ts` still has the bot imports.
- Wrapper files and the `/add-github` skill are fork-only artifacts and preserved.
- **If adopting the `github-impl.ts` fallback mid-life:** every wrapper imports from `./github.js` — re-run the skill for every existing bot to regenerate the import paths against `./github-impl.js`. Never hand-edit.

---

## Runbook

### Adding a new bot (channel side)

Assumes the OneCLI instance is already provisioned (see `multi-onecli.md`).

1. Run `/add-github <bot-name>`.
2. Provide the bot's PAT, webhook secret, and github.com username when prompted.
3. The skill writes the wrapper file, appends to `index.ts`, builds.
4. Paste the printed webhook URL (and the secret) into the GitHub App's webhook settings on github.com.
5. Sync env to the container env file (the container reads from `data/env/env`, not `.env`): `cp .env data/env/env`. **Skipping this is the most common cause of "the new bot doesn't respond" — see diagnosis below.**
6. Restart nanoclaw.
7. Wire repos: create messaging_groups with `channel_type='github-<bot-name>'`.

### Removing a bot (channel side)

Delete the relevant messaging_groups rows, delete the wrapper file, remove its import from `index.ts`, clear the bot's env vars, rebuild, restart. Optionally remove the GitHub App on github.com.

### Diagnosis: "I added a bot but it doesn't show up"

Walk the path: did the build succeed? Is the wrapper's import line in `index.ts`? Are the env vars in *both* `.env` and `data/env/env`? Did you restart nanoclaw? Is the webhook URL set on the GitHub App? Each step is verifiable in seconds.

### Diagnosis: "Wrong bot is responding"

Either the bot-username env vars are crossed (copy-paste error in `.env`), or the agent group is bound to the wrong OneCLI instance (check `multi-onecli.md` runbook for instance-level diagnosis).

### Invariants

- **Never hand-edit a generated `github-*.ts` wrapper.** Regenerate via the skill. Hand-edits get overwritten on the next re-run.
- **Bot-name slugs are immutable once used.** Renaming means deleting and recreating, which loses webhook-subscription state on github.com.
- **One GitHub App per channel_type.** Two Apps multiplexed onto one `channel_type` defeats the whole purpose.
- **The default `github` channel stays untouched.** Even after named bots are added, the un-suffixed setup keeps working for back-compat. Don't delete it without converting existing messaging_groups first.

---

## Test plan

- **Unit:** skill template renders correctly for a given bot name (slug validation rejects invalid chars, no shell injection from bot-name).
- **Integration (manual):** fresh nanoclaw → confirm default channel works; add `review-bot` → confirm wrapper registers; create messaging_group with `channel_type='github-review'`; webhook to `/webhook/github-review` → confirm it lands in inbound.db; add `worker-bot` → confirm coexistence; re-run `/add-github review-bot` → confirm idempotence.
- **Smoke after upstream sync:** all wrapper files still build; `index.ts` imports survived the merge.

---

## When to upgrade to the full registry refactor

Triggers:
- More than ~5 GitHub bots — `channel_type` taxonomy gets cluttered, env-var sprawl gets painful.
- Need to add bots dynamically at runtime (sub-typed requires a `pnpm run build` per bot).
- Multi-credential support needed for other channels (Slack workspaces, Discord bots) — per-channel skill copy-paste compounds.

**Migration path** (sub-typed → registry): introduce `messaging_groups.adapter_credential_id`, backfill from existing `channel_type='github-<bot>'` rows, collapse the `github-*` wrapper files into a single config-driven registration, delete the wrappers, update the skill to write credential rows instead of files. The sub-typed slugs become the credential ids — forward-compatible by design.

---

## Open questions

- **Upstream PR acceptance.** Is the channels-branch maintained actively enough to accept the factory-extraction PR quickly? If not, go straight to `github-impl.ts`.
- ~~**Webhook server path acceptance.**~~ **Resolved** — `src/webhook-server.ts:85-101` already routes dynamically per adapter name.
