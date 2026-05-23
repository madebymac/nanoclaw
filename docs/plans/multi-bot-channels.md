# Multi-Bot Channels (Sub-Typed)

**Status:** Planning — not yet implemented.
**Branch:** `claude/github-multiple-agents-maJCw`
**Companion doc:** [`multi-onecli.md`](./multi-onecli.md)

## Goal

Allow multiple GitHub bots (review-bot, worker-bot, cleanup-bot) to operate concurrently in nanoclaw, each presenting as a distinct GitHub identity in PR threads. Combined with `multi-onecli.md`, this gives end-to-end multi-bot support without modifying the upstream GitHub channel adapter source.

## Non-goals

- A general-purpose multi-credential channel registry. We deliberately pick the cheap "sub-typed channels" approach and defer the full registry refactor.
- Supporting >5 GitHub bots per host. At ~5 bots, the sub-typed approach starts to feel cramped and the full registry refactor becomes warranted; see "When to upgrade" at the bottom.
- Multi-bot support for non-GitHub channels in this phase. The pattern transfers (sub-typed Slack, sub-typed Discord), but each channel needs its own `/add-<channel> <bot-name>` skill rewrite. Defer.

## Why sub-typed (vs full registry refactor)

The full registry refactor — `Map<channel_type, Map<credential_id, adapter>>`, `messaging_groups.adapter_credential_id`, `InboundMessage.credentialId`, `deliver()` carrying a credential selector — is the architecturally correct shape. It's also ~1 week of work touching the adapter interface (which lives in upstream), the messaging-groups schema, the router, and every channel adapter.

Sub-typed channels treat each bot as a distinct `channel_type` string (`github-review`, `github-worker`, etc.), each its own singleton adapter with its own env vars and webhook path. The existing channel registry already handles N channel types — we just add more entries.

Tradeoff: bot identity bleeds into the channel-type taxonomy. At 3 bots this is fine. At 10 bots it's ugly. We accept the ceiling because (a) you don't need 10 bots, (b) when you do, the full refactor is a clean migration from sub-typed (collapse `github-*` types into one type + credential_id), (c) shipping a working 3-bot system this week beats a perfect 10-bot system in two months.

## Architecture

```
┌─ src/channels/ ─────────────────────────────────────────┐
│                                                         │
│  github.ts                                              │
│    [UPSTREAM — DO NOT MODIFY]                           │
│    exports: createGithubAdapter(config) ────┐           │
│    self-registers: channel_type='github'    │           │
│                  (the legacy default bot)   │           │
│                                             │           │
│  github-review.ts        ◄── GENERATED ─────┤           │
│    imports createGithubAdapter from github  │           │
│    self-registers: channel_type='github-review'         │
│    reads GITHUB_TOKEN_REVIEW, etc.                      │
│                                             │           │
│  github-worker.ts        ◄── GENERATED ─────┤           │
│  github-cleanup.ts       ◄── GENERATED ─────┘           │
│                                                         │
│  index.ts                                               │
│    imports all of the above                             │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

Each generated wrapper file is small (~20 lines), produced by the `/add-github <bot-name>` skill, and never edited by hand. The upstream `github.ts` stays exactly as shipped on the `channels` branch.

## The wrapper-file pattern

### Prerequisite: upstream github.ts must export its factory

Today's upstream `src/channels/github.ts` (copied in by `/add-github`) reads env vars at module load and self-registers. We need it to *also* export the construction function so wrappers can call it with different configs.

The smallest possible upstream change:

```diff
// src/channels/github.ts
+ export interface GithubAdapterConfig {
+   token: string;
+   webhookSecret: string;
+   botUsername: string;
+   channelType?: string;   // default: 'github'
+   webhookPath?: string;   // default: '/webhook/github'
+ }
+
+ export function createGithubAdapter(config: GithubAdapterConfig): ChannelAdapter {
+   // (existing construction logic, parameterized)
+ }

  // Existing self-registration moves to the bottom, calling createGithubAdapter:
  registerChannelAdapter({
    channelType: 'github',
    webhookPath: '/webhook/github',
    factory: () => createGithubAdapter({
      token: env.GITHUB_TOKEN,
      webhookSecret: env.GITHUB_WEBHOOK_SECRET,
      botUsername: env.GITHUB_BOT_USERNAME,
    }),
  });
```

This is a pure refactor: external behavior unchanged, but the factory is now reusable. Send it upstream as a small PR — likely accepted because it's a tidy generalization.

**If upstream won't accept the PR:** copy the adapter once into `src/channels/github-impl.ts`, import everything from there, and accept the manual sync cost on that one file. The `/update-nanoclaw` skill already handles file-by-file sync; flag `github-impl.ts` as "diff against upstream `github.ts` on each update." Acceptable but not preferred.

### What a wrapper file looks like

`/add-github review-bot` generates:

```typescript
// src/channels/github-review.ts
// GENERATED by /add-github — safe to delete and regenerate.
// Do not edit by hand. Edits should go in src/channels/github.ts (upstream)
// or in the /add-github skill template.

import { createGithubAdapter } from './github.js';
import { registerChannelAdapter } from './registry.js';
import { env } from '../env.js';

registerChannelAdapter({
  channelType: 'github-review',
  webhookPath: '/webhook/github-review',
  factory: () => createGithubAdapter({
    token: env.GITHUB_TOKEN_REVIEW,
    webhookSecret: env.GITHUB_WEBHOOK_SECRET_REVIEW,
    botUsername: env.GITHUB_BOT_USERNAME_REVIEW,
    channelType: 'github-review',
    webhookPath: '/webhook/github-review',
  }),
});
```

Twenty lines. Generated from a template by the skill. Adding `worker-bot` produces `github-worker.ts` with `_WORKER` env-var suffixes. Removing a bot deletes the wrapper file.

### `src/channels/index.ts`: one-line append per bot

```typescript
// Existing
import './github.js';
// Added by /add-github review-bot
import './github-review.js';
// Added by /add-github worker-bot
import './github-worker.js';
```

Adding a bot appends one line. Removing deletes the line. The skill does this idempotently.

**Conflict risk:** if upstream restructures `src/channels/index.ts` (e.g., switches to dynamic registration), the appended imports may need rework. Today index.ts is just a list of imports; upstream is unlikely to churn it.

## Env-var convention

Each bot gets env vars suffixed with `_<UPPER_SNAKE_BOT_NAME>`:

```
GITHUB_TOKEN_REVIEW=github_pat_...
GITHUB_WEBHOOK_SECRET_REVIEW=...
GITHUB_BOT_USERNAME_REVIEW=review-bot-mac

GITHUB_TOKEN_WORKER=github_pat_...
GITHUB_WEBHOOK_SECRET_WORKER=...
GITHUB_BOT_USERNAME_WORKER=worker-bot-mac

GITHUB_TOKEN_CLEANUP=...
```

The default bot keeps the unsuffixed names (`GITHUB_TOKEN`, etc.) — unchanged for existing installs.

**Why env vars and not the OneCLI vault?** Because there are two distinct outbound code paths and they need different credential sources:

1. **Channel adapter posting (host-side).** When the agent produces a reply, the channel adapter (running in the nanoclaw host process) is what actually calls `api.github.com` to post the comment. The Chat SDK GitHub adapter reads its token at construction time, not per-request, so it can't easily route through the OneCLI proxy. Its token is the bot's primary identity — what appears in PR threads as "review-bot commented." That's `GITHUB_TOKEN_<BOT>` in env.

2. **Agent in-container API calls.** When the agent inside its container makes its own GitHub API calls (via `curl`, the GitHub MCP tool, `gh` CLI, etc.), those calls go through `HTTPS_PROXY` → the agent group's pinned OneCLI gateway → credential injection from that instance's vault. This is what `multi-onecli.md` is about. The env-var token from path #1 plays no part here.

The webhook secret is also host-side (used to verify GitHub's incoming webhook signature), so it must live on the host — it isn't an outbound API credential at all.

These paths don't compete: the channel adapter's reply posting and the agent's in-container API use are different operations against different credentials, and a bot can use both at once without confusion. Each bot's GitHub App therefore needs both its env-var PAT (for the adapter) and its registration in the bot's OneCLI instance (for the agent's in-container calls). The OneCLI re-architecture and the channel sub-typing are complementary, not redundant.

**Future:** if/when the Chat SDK gains support for per-request token resolution (or we accept the cost of rewriting that part of the adapter), the env-var PAT could be replaced with a refreshable GitHub App installation token fetched via OneCLI. Out of scope for this plan — we ship with both PATs and OneCLI in their current shapes.

## Webhook routing

Each bot gets its own webhook path: `/webhook/github-review`, `/webhook/github-worker`, etc. The `registerChannelAdapter` call sets this. nanoclaw's webhook server already routes by path → channel-type → adapter *dynamically*: `src/webhook-server.ts:85-101` uses a `Map<adapterName, adapter>` populated by `registerWebhookAdapter()` and matches incoming requests against `/webhook/{adapterName}`. **No upstream-server change is required** to add new bot paths — registering `channel_type='github-review'` auto-exposes `/webhook/github-review`.

When the operator creates the GitHub App on github.com, they set the webhook URL to `https://<host>/webhook/github-<bot-name>`. Each App posts to its own path. No cross-bot ambiguity.

**Why not a single webhook URL?** Possible (use the App ID from the payload to dispatch), but means the adapter has to learn about all bots and pick one — i.e., starts looking like the full registry refactor. Per-bot URLs are simpler and align with one-App-per-bot anyway.

## Mention detection per bot

Each generated wrapper passes its own `botUsername` to `createGithubAdapter`. The adapter checks for `@<botUsername>` in incoming comments to decide whether to trigger. Each bot independently checks for its own username. No cross-bot logic needed.

Side benefit: someone can write `@review-bot ping @worker-bot` in one comment and both bots trigger independently (each fires its own webhook from its own GitHub App; nanoclaw treats them as two independent message arrivals).

## messaging_groups stays the same

The `messaging_groups` schema doesn't change. The relevant constraint is `UNIQUE(channel_type, platform_id)` (`src/db/schema.ts:34`). `platform_id` stays in the upstream-conventional format — `github:owner/repo` — regardless of which bot the row belongs to. The bot identity lives entirely in `channel_type`. Each repo wired to a bot creates one row:

```sql
INSERT INTO messaging_groups (id, channel_type, platform_id, name, ...)
VALUES (
  'mg-review-acme-backend',
  'github-review',              -- not 'github'!
  'github:acme/backend',        -- upstream convention, unchanged per bot
  'acme/backend (review)',
  ...
);
```

The same repo can be wired to both `github-review` and `github-worker` simultaneously — the tuple `('github-review', 'github:acme/backend')` differs from `('github-worker', 'github:acme/backend')`, so the UNIQUE constraint is satisfied. Crucially, the bot identity appears in exactly one column (`channel_type`); there's no second copy in `platform_id` to drift out of sync.

`messaging_group_agents` (wiring to agent groups) doesn't change; it operates on `messaging_group_id`.

## The `/add-github <bot-name>` skill

Rewritten from the current `/add-github` skill. Backward-compatible:

- `/add-github` (no arg) — installs the default `github` channel (today's behavior). Reads upstream `github.ts` and the standard env-var names.
- `/add-github <bot-name>` (with arg) — generates a wrapper file, appends to `src/channels/index.ts`, prompts for the suffixed env vars.

Skill flow with arg:

1. Validate bot-name (lowercase, hyphens only, must not collide with existing channel_type).
2. Check that `src/channels/github.ts` exists (if not, run `/add-github` no-arg first to install the upstream adapter).
3. Generate `src/channels/github-<bot-name>.ts` from the template.
4. Append `import './github-<bot-name>.js';` to `src/channels/index.ts` if not already present.
5. Prompt for `GITHUB_TOKEN_<BOT>`, `GITHUB_WEBHOOK_SECRET_<BOT>`, `GITHUB_BOT_USERNAME_<BOT>`. Append to `.env`.
6. Print the webhook URL (`https://<host>/webhook/github-<bot-name>`) to paste into the GitHub App settings.
7. Build: `pnpm run build`.
8. Print "next steps": run `ncl onecli-instances install --id <bot-name>` (if not done), then wire to an agent group.

Idempotent — re-running with the same bot-name regenerates the wrapper, no-ops on the import line, prompts only for missing env vars.

## Migration from single-bot to multi-bot

Existing installs run one bot via `channel_type='github'`. After this feature ships:

- That setup keeps working identically. No migration required.
- To add a second bot, just `/add-github <new-bot-name>`. The original keeps running as `github`; the new one runs as `github-<name>`.
- To convert the existing `github` into a named bot (e.g., rename it `default-bot` so it shows up in `ncl bots list` consistently): re-run `/add-github default-bot` (generates the wrapper), then bulk-update messaging_groups:
  ```sql
  UPDATE messaging_groups
     SET channel_type = 'github-default-bot'
   WHERE channel_type = 'github';
  ```
  `platform_id` does not need to change (no bot identity is encoded in it — see the section above). Finally, delete the wrapper/imports/env vars for the now-unused `github` channel. Probably wrap the whole thing as `ncl bots rename-default --to <bot-name>` in phase 2.

Until that migration is run, the default `github` channel coexists fine with the named ones.

## Diffs to existing files

The whole point of this design is to minimize this section.

### `src/channels/github.ts` (upstream — one-time refactor)

The factory-extraction described above. ~30 lines refactored (no behavior change). **Goal: upstream this.** If upstream rejects, this becomes a per-update sync hassle on one file.

### `src/channels/index.ts` (upstream — append-only)

One line appended per bot. The skill does this:

```diff
  import './github.js';
+ import './github-review.js';
+ import './github-worker.js';
```

Pure append. Conflict only if upstream rewrites the file.

### `.claude/skills/add-github/SKILL.md` (nanoclaw fork)

Rewritten to support the `<bot-name>` arg. This is a skill — lives in the fork; not synced from upstream. Zero merge-conflict risk on this file.

### Summary

| File | Lines changed | Where | Conflict risk |
|---|---|---|---|
| `src/channels/github.ts` | ~30 (refactor) | Upstream PR | Eliminated if PR lands; otherwise one-file diff to maintain |
| `src/channels/index.ts` | 1 per bot (appends) | Upstream-ish, but additions | Very low |
| `src/channels/github-<bot>.ts` | ~20 each | Generated, new file | None (new files don't conflict) |
| `.claude/skills/add-github/SKILL.md` | Full rewrite | Fork-only | None |

**Total upstream touch (assuming PR lands):** 1 line in `index.ts` per bot.

## Sync-with-upstream risk + mitigations

**Best case (upstream PR lands):** sync cost is just the per-bot append in `index.ts`. Nothing else upstream changes.

**Worst case (upstream rejects the factory extraction):** we maintain a fork of `github.ts` (renamed `github-impl.ts` so the upstream version can sit alongside without conflict). Cost: re-port any upstream github.ts changes on each `/update-nanoclaw`. Manageable because the github adapter doesn't change often.

**Mitigations applied:**

1. **Wrapper files are generated, not hand-written.** Regenerable from the skill template. If a bug is found across all bots, fix the skill template and re-run for each.
2. **Wrapper files have no shared mutable state.** Each registers its own channel_type independently. Adding/removing one doesn't affect the others.
3. **The skill never edits `github.ts`.** Only generates wrappers around it.
4. **Env-var naming is regular** (`<NAME>_<BOT>`). No manual config-file editing per bot.
5. **`/update-nanoclaw` is aware of the wrapper pattern.** Add to the skill: "preserve any `src/channels/github-*.ts` files during upstream sync."

**Re-port checklist** (when `/update-nanoclaw` runs):
- [ ] If upstream `github.ts` changed: does our `createGithubAdapter` factory still exist? If upstream re-merged the factory, great. If they moved it elsewhere, port the import path in each wrapper.
- [ ] `src/channels/index.ts`: re-add any bot imports that got dropped during the merge.
- [ ] Wrapper files (`github-*.ts`): preserved (they're nanoclaw-fork artifacts, not in upstream).
- [ ] `.claude/skills/add-github/`: kept (fork-only).
- [ ] **If adopting the `github-impl.ts` fallback mid-life** (i.e., upstream rejects the factory PR and we copy the adapter into a fork-only file): every existing wrapper imports `from './github.js'` — those imports must be updated to `from './github-impl.js'`. Don't hand-edit; instead, **regenerate every wrapper file via the `/add-github <bot-name>` skill** so the templated import path stays consistent. The skill template lives in `.claude/skills/add-github/`; update it once to emit `./github-impl.js` imports when the impl file is detected, then re-run for each existing bot. Audit: `grep "from './github\.js'" src/channels/github-*.ts` should return zero matches after the regeneration.

---

## Runbook

### Adding a new bot (channel side)

Assumes the OneCLI instance is already provisioned (see `multi-onecli.md` runbook).

1. Run `/add-github <bot-name>` (e.g. `/add-github review-bot`).
2. The skill prompts for:
   - `GITHUB_TOKEN_<BOT>` (the bot account's PAT, scoped to needed repos)
   - `GITHUB_WEBHOOK_SECRET_<BOT>` (generated, e.g. `openssl rand -hex 20`)
   - `GITHUB_BOT_USERNAME_<BOT>` (the bot account's GitHub username — used for `@`-mention detection)
3. The skill writes a new wrapper file, appends to `index.ts`, runs `pnpm run build`.
4. Skill prints the webhook URL: `https://<host>/webhook/github-<bot-name>`. Paste this into the GitHub App → Webhook → Payload URL, and the secret from step 2 into Webhook → Secret.
5. Sync the new env vars to the container env file (the container reads from `data/env/env`, not `.env` directly):
   ```bash
   cp .env data/env/env
   ```
   Skipping this step is the most common cause of "I added a bot but it doesn't show up" — see the diagnosis section below.
6. Restart nanoclaw:
   ```bash
   source setup/lib/install-slug.sh
   launchctl kickstart -k gui/$(id -u)/$(launchd_label)   # macOS
   systemctl --user restart $(systemd_unit)               # Linux
   ```
7. Wire repos: create messaging_groups with `channel_type='github-<bot-name>'` (use `/manage-channels` or insert manually — see template in skill output).

### Removing a bot (channel side)

```bash
# 1. Delete messaging_groups for this bot
pnpm exec tsx scripts/q.ts data/v2.db "DELETE FROM messaging_groups WHERE channel_type='github-<bot-name>';"

# 2. Delete the wrapper file
rm src/channels/github-<bot-name>.ts

# 3. Remove the import line from src/channels/index.ts (manually, or re-run the skill in remove mode)

# 4. Clear env vars in .env (manually delete the GITHUB_*_<BOT> lines)

# 5. Rebuild
pnpm run build

# 6. Restart nanoclaw (see above)

# 7. (optional) Delete the GitHub webhook from the App settings, or remove the App entirely
```

### Diagnosis: "I added a bot but it doesn't show up"

1. **Did the build succeed?**
   ```bash
   pnpm run build
   ```
   If the wrapper file has a syntax error (typo in bot name?), the build fails and the new channel never registers.

2. **Is the import in `index.ts`?**
   ```bash
   grep "github-<bot-name>" src/channels/index.ts
   ```
   If missing, the skill didn't append it. Add manually.

3. **Are the env vars in `.env` AND `data/env/env`?**
   The container reads env from `data/env/env`. Sync after editing `.env`:
   ```bash
   cp .env data/env/env
   ```

4. **Did you restart nanoclaw?**
   The adapter registers at module-load time. Old process won't pick up the new bot until restart.

5. **Is the webhook URL set on the GitHub App?**
   Test by sending a test webhook from the GitHub App settings UI. Should appear in `logs/nanoclaw.log`.

### Diagnosis: "Wrong bot is responding"

If `@review-bot` is being answered by worker-bot, check the mention-detection wiring:

1. `GITHUB_BOT_USERNAME_REVIEW` in `.env` matches the actual github.com username of the review-bot account.
2. `GITHUB_BOT_USERNAME_WORKER` matches the worker-bot account.
3. They're not accidentally identical (copy-paste error).

If the bots are commenting from the wrong identity (right one detects the mention but posts as the wrong user), check that each agent group is bound to the right OneCLI instance (see `multi-onecli.md` runbook).

### Invariants

- **Never hand-edit a `github-*.ts` wrapper file.** Regenerate from the skill or fix the template. Edits get overwritten on the next `/add-github` re-run.
- **Bot-name slugs are immutable once used.** Renaming means deleting and recreating, which loses webhook-subscription state on github.com. Choose carefully.
- **One GitHub App per channel_type.** Don't try to multiplex two Apps into `github-review`. If you need two, name them.
- **The default `github` channel stays untouched.** Even after you've added named bots, the un-suffixed `GITHUB_TOKEN` / `channel_type='github'` setup keeps working for back-compat. Don't delete it without converting existing messaging_groups first.

---

## Test plan

**Unit:**
- The skill template renders correctly for a given bot name (no shell injection from bot-name, slug validation rejects invalid chars).
- `src/channels/github-test-bot.ts` (generated in a test fixture) compiles standalone with `tsc --noEmit`.

**Integration (manual):**
1. Fresh nanoclaw, `/add-github` (no arg) → confirm default `github` channel works as today.
2. `/add-github review-bot` → confirm wrapper file appears, import added, build succeeds, restart picks up the new channel.
3. Create a messaging_group with `channel_type='github-review'`, wire to an agent group.
4. Send a webhook to `/webhook/github-review` with a test payload → confirm it lands in inbound.db with `messaging_group_id` resolved correctly.
5. `/add-github worker-bot` → both bots coexist; messages to one don't trigger the other.
6. `/add-github invalid_name!` → skill rejects (slug validation).
7. `/add-github review-bot` again → idempotent (no errors, no duplicate imports).

**Smoke after upstream sync:**
- After `/update-nanoclaw`, verify all wrapper files still build.
- Verify `src/channels/index.ts` imports survived the merge.

---

## When to upgrade to the full registry refactor

Triggers to graduate from sub-typed channels to the full `Map<channel_type, Map<credential_id, adapter>>` registry:

- **>5 GitHub bots.** The channel_type taxonomy gets cluttered (`github-review`, `github-worker`, `github-cleanup`, `github-staging`, `github-prod-alerts`, …) and the env-var sprawl is painful.
- **Dynamic bot provisioning needed.** Sub-typed channels require a build step (`pnpm run build`) per bot. If you need to add bots programmatically at runtime (e.g., a multi-tenant SaaS use case), the registry refactor is required.
- **Multi-credential support for other channels.** If you want two Slack workspaces or two Discord bots with similar isolation, the per-channel skill copy-paste burden compounds; refactor pays off.

**Migration path from sub-typed to full registry:**
1. Add `messaging_groups.adapter_credential_id` (nullable).
2. Backfill: for each `messaging_groups` row with `channel_type='github-<bot>'`, set `channel_type='github'` and `adapter_credential_id='<bot>'`.
3. Collapse all `github-*` wrapper files into a single config-driven registration in the registry.
4. Delete the sub-typed wrappers.
5. Update `/add-github <name>` to write a credential row instead of a wrapper file.

The sub-typed approach is *forward-compatible* with the registry refactor — every bot is identified by a stable slug that becomes the credential_id later.

---

## Open questions

- **Upstream PR for `createGithubAdapter` factory extraction.** Is upstream channels-branch maintained actively enough to accept the PR quickly? If yes, we wait for it before generating wrappers. If no, we go the `github-impl.ts` route immediately.
- ~~**Webhook server routing.**~~ **Resolved.** `src/webhook-server.ts:85-101` routes `/webhook/{adapterName}` dynamically via a `Map<adapterName, adapter>` populated by `registerWebhookAdapter()`. Registering a new channel adapter with `channelType: 'github-review'` automatically exposes `/webhook/github-review` — no upstream-server change needed. The sub-typed channels approach is unblocked on this front.
- **Sub-typed vs first-class label.** Should the bot identity be encoded in `channel_type` (as proposed) or in a separate `messaging_groups.bot_label` column with `channel_type='github'` for all of them? The latter is closer to the full registry refactor; the former is cheaper to implement. Going with the former (channel_type encoding) for phase 1; revisit in phase 2 if it causes pain.
