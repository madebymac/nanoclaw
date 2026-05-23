import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Multi-instance OneCLI groundwork.
 *
 * `onecli_instances` holds per-instance install metadata (ports, dir, API key,
 * CA cert path). `agent_groups.onecli_instance_id` is nullable — NULL means
 * "use the legacy env-var singleton" so existing installs keep working without
 * a migration of their own.
 *
 * Referential integrity for `onecli_instance_id` is enforced at the
 * application layer (instance removal refuses if any agent_group references
 * it). SQLite doesn't enforce REFERENCES clauses added via ALTER TABLE, so the
 * column is plain TEXT here.
 */
export const migration016: Migration = {
  version: 16,
  name: 'onecli-instances',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE onecli_instances (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        app_port      INTEGER NOT NULL,
        gateway_port  INTEGER NOT NULL,
        postgres_port INTEGER NOT NULL,
        install_dir   TEXT NOT NULL,
        api_url       TEXT NOT NULL,
        api_key       TEXT,
        ca_cert_path  TEXT,
        version       TEXT,
        health_status TEXT NOT NULL DEFAULT 'unknown',
        last_checked  TEXT,
        created_at    TEXT NOT NULL,
        UNIQUE(app_port),
        UNIQUE(gateway_port),
        UNIQUE(postgres_port),
        UNIQUE(install_dir)
      );

      ALTER TABLE agent_groups ADD COLUMN onecli_instance_id TEXT;
    `);
  },
};
