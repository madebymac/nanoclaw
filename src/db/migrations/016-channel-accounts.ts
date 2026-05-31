import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Channel accounts + GitHub App identities.
 *
 * `channel_accounts` is the single-instance, multi-bot dimension. The channel
 * pipeline keys everything on `channel_type` (a string), so each standalone bot
 * is modelled as its OWN channel_type value of the form `<family>#<slug>` (e.g.
 * `telegram#andy`). The family ('telegram') drives user-id namespacing and
 * per-platform behaviour; the full value is the unique routing/delivery key, so
 * the same person DMing bot A vs bot B lands in two distinct messaging groups.
 *
 * A channel account binds a host-side bot credential (e.g. the Telegram bot
 * token — read by the host to run the adapter, never injected into a container)
 * to an agent group. On pairing, the messaging group is created under the
 * account's channel_type and auto-wired to that agent.
 *
 * `github_app_identities` is the "second secrets store" for credentials OneCLI
 * cannot broker on the free plan — chiefly self-hosted GitHub App bot identity.
 * Only the App/installation ids and a filesystem PATH to a chmod-600 private
 * key live in the DB; the key never enters the DB or any LLM context. The host
 * mints short-lived installation tokens at container spawn (see
 * src/github-app-broker.ts).
 */
export const migration016: Migration = {
  version: 16,
  name: 'channel-accounts',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS channel_accounts (
        id             TEXT PRIMARY KEY,   -- the channel_type value, e.g. 'telegram#andy'
        family         TEXT NOT NULL,      -- channel family, e.g. 'telegram'
        label          TEXT,               -- human label / bot @username
        agent_group_id TEXT REFERENCES agent_groups(id) ON DELETE SET NULL,
        bot_token      TEXT,               -- host-side secret (bot token); never injected into containers
        created_at     TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_channel_accounts_family ON channel_accounts(family);
      CREATE INDEX IF NOT EXISTS idx_channel_accounts_agent  ON channel_accounts(agent_group_id);

      CREATE TABLE IF NOT EXISTS github_app_identities (
        id               TEXT PRIMARY KEY,
        agent_group_id   TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        app_id           TEXT NOT NULL,
        installation_id  TEXT NOT NULL,
        private_key_path TEXT NOT NULL,    -- absolute path to a chmod-600 .pem on the host, outside the repo
        api_url          TEXT,             -- defaults to https://api.github.com at mint time
        created_at       TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_github_app_identities_agent
        ON github_app_identities(agent_group_id);
    `);
  },
};
